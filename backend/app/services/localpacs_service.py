"""Local Server 모드 — 서버(Orthanc/Postgres)와 완전 분리된 로컬 PACS 서비스.

루트 = server.network.local_share_dir (예: C:\\PACS\\share). 하위 구조(최초 사용 시 자동 생성):
  DB\\local.db  — sqlite3 표준 라이브러리로 독립 관리(서버 SQLAlchemy 세션과 무관,
                  루트 경로가 바뀌면 그 경로의 DB를 사용)
  Image\\       — DICOM 원본 배치: Image\\{PatientID}\\{StudyDate}_{Modality}\\{SOP}.dcm
  Temp\\        — 업로드 임시(처리 후 정리)

보안: iid/id 는 local.db 조회로만 경로를 해석한다(사용자 입력 경로 사용 금지 — traversal 원천 차단).
"""
from __future__ import annotations

import io
import json
import os
import re
import sqlite3
import uuid
from pathlib import Path

import numpy as np
import pydicom
from pydicom.uid import ImplicitVRLittleEndian, generate_uid

# ── 상수 ──────────────────────────────────────────────────────────────────
_DB_SUBDIR = "DB"
_IMAGE_SUBDIR = "Image"
_TEMP_SUBDIR = "Temp"
_DB_NAME = "local.db"
_CHUNK = 1024 * 1024  # 업로드 스트리밍 단위(1MB) — 대용량 안전

_SCHEMA = """
CREATE TABLE IF NOT EXISTS studies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_key  TEXT NOT NULL,
    patient_name TEXT NOT NULL DEFAULT '',
    sex          TEXT NOT NULL DEFAULT '',
    birth_date   TEXT NOT NULL DEFAULT '',
    study_uid    TEXT NOT NULL,
    study_date   TEXT NOT NULL DEFAULT '',
    modality     TEXT NOT NULL DEFAULT '',
    study_desc   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_studies_uid ON studies(study_uid);
CREATE TABLE IF NOT EXISTS series (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id      INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    series_uid    TEXT NOT NULL,
    series_number INTEGER NOT NULL DEFAULT 0,
    series_desc   TEXT NOT NULL DEFAULT '',
    modality      TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_series_uid ON series(series_uid);
CREATE TABLE IF NOT EXISTS instances (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id       INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    sop_uid         TEXT NOT NULL,
    instance_number INTEGER NOT NULL DEFAULT 0,
    rows            INTEGER NOT NULL DEFAULT 0,
    cols            INTEGER NOT NULL DEFAULT 0,
    rel_path        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_instances_sop ON instances(sop_uid);
"""


class LocalPacsNotConfigured(Exception):
    """local_share_dir 미설정 — API 계층에서 400으로 변환."""


# ── 루트/구조 ─────────────────────────────────────────────────────────────
def resolve_root(raw: str) -> Path:
    """설정값 → 루트 Path. 빈 값이면 LocalPacsNotConfigured."""
    raw = (raw or "").strip()
    if not raw:
        raise LocalPacsNotConfigured(
            "Local Server 루트가 설정되지 않았습니다 — 설정>서버 네트워크>local_share_dir"
        )
    return Path(raw).resolve()


def init_dirs(root: Path) -> dict:
    """DB/Image/Temp 폴더 구조 생성(idempotent)."""
    dirs = {}
    for sub in (_DB_SUBDIR, _IMAGE_SUBDIR, _TEMP_SUBDIR):
        p = root / sub
        p.mkdir(parents=True, exist_ok=True)
        dirs[sub] = str(p)
    _connect(root).close()  # 스키마도 함께 준비
    return {"ok": True, "root": str(root), "dirs": dirs}


def _connect(root: Path) -> sqlite3.Connection:
    """루트별 local.db 연결 + idempotent 스키마 생성. 호출자가 close 책임."""
    db_dir = root / _DB_SUBDIR
    db_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_dir / _DB_NAME)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(_SCHEMA)
    _migrate_examctl_columns(conn)
    _migrate_merge_schema(conn)
    return conn


def _migrate_examctl_columns(conn: sqlite3.Connection) -> None:
    """Exam Control 소프트 삭제용 deleted 컬럼 — 기존 local.db 에 idempotent ALTER."""
    for table in ("series", "instances"):
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if "deleted" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")


def _migrate_merge_schema(conn: sqlite3.Connection) -> None:
    """환자 병합용 patient_merges 테이블 + studies.merged_from — idempotent 마이그레이션.

    서버(examctl) 병합과 동형 의미론 — originals 는 {study_id: 환자 4필드 원값} JSON,
    moved_study_ids 는 이동된 검사 id 목록 JSON. undone=1 이면 해제된(비활성) 병합.
    """
    conn.execute(
        "CREATE TABLE IF NOT EXISTS patient_merges ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " master_key TEXT NOT NULL,"
        " master_name TEXT NOT NULL DEFAULT '',"
        " slave_key TEXT NOT NULL,"
        " slave_name TEXT NOT NULL DEFAULT '',"
        " originals TEXT NOT NULL DEFAULT '{}',"
        " moved_study_ids TEXT NOT NULL DEFAULT '[]',"
        " created_at TEXT NOT NULL DEFAULT (datetime('now')),"
        " undone INTEGER NOT NULL DEFAULT 0)"
    )
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(studies)").fetchall()}
    if "merged_from" not in cols:
        conn.execute("ALTER TABLE studies ADD COLUMN merged_from INTEGER")


# ── Import ────────────────────────────────────────────────────────────────
# Windows 예약 장치명 — 그대로 폴더/파일명으로 쓰면 생성 실패·오동작(CON, NUL 등)
_WIN_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def _sanitize(part: str) -> str:
    """경로 구성요소 정화 — 파일시스템 금지문자·경로조작 문자를 '_'로 치환.

    Windows 예약 장치명(CON, NUL, COM1…)은 '_' 접두로 무력화한다(확장자 앞부분 기준).
    """
    cleaned = "".join(c if c.isalnum() or c in "-._^ " else "_" for c in (part or ""))
    cleaned = cleaned.strip(" .")
    if cleaned.split(".")[0].upper() in _WIN_RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned or "UNKNOWN"


def save_upload_to_temp(root: Path, fileobj) -> Path:
    """업로드 파일을 Temp에 스트리밍 저장(대용량 안전) 후 경로 반환."""
    temp_dir = root / _TEMP_SUBDIR
    temp_dir.mkdir(parents=True, exist_ok=True)
    tmp = temp_dir / f"up_{uuid.uuid4().hex}.tmp"
    with open(tmp, "wb") as out:
        while True:
            chunk = fileobj.read(_CHUNK)
            if not chunk:
                break
            out.write(chunk)
    return tmp


def _has_dicm_signature(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            f.seek(128)
            return f.read(4) == b"DICM"
    except OSError:
        return False


def _dtext(ds, tag: str) -> str:
    """DICOM 텍스트 추출 — 문자셋 태그(0008,0005) 없는 한국 DICOM의 인코딩 폴백.

    pydicom 은 SpecificCharacterSet 부재 시 Latin-1 로 디코딩해 한글이 깨진다(mojibake).
    비ASCII 가 섞여 있고 문자셋 미지정이면 원바이트로 되돌려 UTF-8 → CP949 순으로 재해석하되,
    결과에 한글이 있을 때만 채택 — 정상 서양어(악센트) 텍스트의 오변환을 차단.
    """
    raw = getattr(ds, tag, "") or ""
    s = str(raw)
    scs = str(getattr(ds, "SpecificCharacterSet", "") or "")
    if not scs and any(ord(c) > 127 for c in s):
        try:
            b = s.encode("latin-1")
        except UnicodeEncodeError:
            return s
        for enc in ("utf-8", "cp949"):
            try:
                fixed = b.decode(enc)
            except UnicodeDecodeError:
                continue
            if any("가" <= c <= "힣" for c in fixed):
                return fixed
    return s


def _read_dataset(path: Path):
    """파일명 무관 — DICM 시그니처/파싱(force)으로 DICOM 여부 판정.

    반환: (dataset, sop_uid) — 비DICOM이면 (None, None).
    """
    has_sig = _has_dicm_signature(path)
    try:
        ds = pydicom.dcmread(str(path), force=True, stop_before_pixels=True)
    except Exception:  # noqa: BLE001 — 파싱 불가 = 비DICOM으로 스킵
        return None, None
    sop = str(getattr(ds, "SOPInstanceUID", "") or "").strip()
    if not sop:
        if not has_sig:
            return None, None  # 시그니처도 SOP UID도 없음 → 비DICOM
        sop = generate_uid()  # DICM 시그니처는 있으나 SOP 결측 → 생성 폴백
    return ds, sop


def _unique_target(dir_: Path, sop: str) -> Path:
    """{SOP}.dcm 배치 경로 — 충돌 시 _1, _2 … 접미사."""
    base = _sanitize(sop)
    target = dir_ / f"{base}.dcm"
    n = 1
    while target.exists():
        target = dir_ / f"{base}_{n}.dcm"
        n += 1
    return target


def import_temp_file(conn: sqlite3.Connection, root: Path, tmp: Path, ds, sop: str) -> int:
    """Temp의 검증된 DICOM 1건을 Image\\ 배치 + local.db 등록. 반환: study id."""
    pid = _sanitize(str(getattr(ds, "PatientID", "") or "").strip() or "UNKNOWN")
    study_date = str(getattr(ds, "StudyDate", "") or "").strip() or "UNKNOWN"
    modality = str(getattr(ds, "Modality", "") or "").strip() or "UNKNOWN"
    study_uid = str(getattr(ds, "StudyInstanceUID", "") or "").strip() or f"local.{sop}"
    series_uid = str(getattr(ds, "SeriesInstanceUID", "") or "").strip() or f"local.se.{sop}"

    dest_dir = root / _IMAGE_SUBDIR / pid / f"{_sanitize(study_date)}_{_sanitize(modality)}"
    dest_dir.mkdir(parents=True, exist_ok=True)

    # study upsert (study_uid 기준)
    row = conn.execute("SELECT id FROM studies WHERE study_uid=?", (study_uid,)).fetchone()
    if row is None:
        cur = conn.execute(
            "INSERT INTO studies(patient_key, patient_name, sex, birth_date, study_uid,"
            " study_date, modality, study_desc) VALUES(?,?,?,?,?,?,?,?)",
            (
                pid,
                _dtext(ds, "PatientName"),
                str(getattr(ds, "PatientSex", "") or ""),
                str(getattr(ds, "PatientBirthDate", "") or ""),
                study_uid,
                study_date if study_date != "UNKNOWN" else "",
                modality,
                _dtext(ds, "StudyDescription"),
            ),
        )
        study_id = int(cur.lastrowid)
    else:
        study_id = int(row["id"])

    # series upsert (series_uid 기준)
    row = conn.execute("SELECT id FROM series WHERE series_uid=?", (series_uid,)).fetchone()
    if row is None:
        try:
            series_no = int(getattr(ds, "SeriesNumber", 0) or 0)
        except (TypeError, ValueError):
            series_no = 0
        cur = conn.execute(
            "INSERT INTO series(study_id, series_uid, series_number, series_desc, modality)"
            " VALUES(?,?,?,?,?)",
            (study_id, series_uid, series_no,
             _dtext(ds, "SeriesDescription"), modality),
        )
        series_id = int(cur.lastrowid)
    else:
        series_id = int(row["id"])

    # instance — 동일 SOP 재수입 시 파일 교체(기존 rel_path 재사용)
    existing = conn.execute("SELECT id, rel_path FROM instances WHERE sop_uid=?", (sop,)).fetchone()
    if existing is not None:
        target = root / existing["rel_path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, target)
        return study_id

    target = _unique_target(dest_dir, sop)
    os.replace(tmp, target)  # Temp→Image 이동(같은 볼륨 — 원자적)
    rel = target.relative_to(root).as_posix()
    try:
        inst_no = int(getattr(ds, "InstanceNumber", 0) or 0)
    except (TypeError, ValueError):
        inst_no = 0
    conn.execute(
        "INSERT INTO instances(series_id, sop_uid, instance_number, rows, cols, rel_path)"
        " VALUES(?,?,?,?,?,?)",
        (series_id, sop, inst_no,
         int(getattr(ds, "Rows", 0) or 0), int(getattr(ds, "Columns", 0) or 0), rel),
    )
    return study_id


def import_files(root: Path, uploads: list) -> dict:
    """multipart files[] → Temp 저장→판정→배치→등록. 반환 {imported, skipped, studies}."""
    init_dirs(root)
    conn = _connect(root)
    imported = 0
    skipped = 0
    touched: list[int] = []
    try:
        for up in uploads:
            tmp = save_upload_to_temp(root, up.file)
            try:
                ds, sop = _read_dataset(tmp)
                if ds is None:
                    skipped += 1  # 비DICOM 스킵 카운트
                    continue
                study_id = import_temp_file(conn, root, tmp, ds, sop)
                imported += 1
                if study_id not in touched:
                    touched.append(study_id)
            finally:
                tmp.unlink(missing_ok=True)  # 배치 성공 시 이미 이동됨 — 잔여만 정리
        conn.commit()
        studies = [_study_row_to_dict(conn, sid) for sid in touched]
    finally:
        conn.close()
    return {"imported": imported, "skipped": skipped, "studies": studies}


# ── 조회 ──────────────────────────────────────────────────────────────────
def _study_row_to_dict(conn: sqlite3.Connection, study_id: int) -> dict:
    row = conn.execute("SELECT * FROM studies WHERE id=?", (study_id,)).fetchone()
    if row is None:
        return {}
    # 이미지 수는 소프트 삭제(examctl) 제외 실측 — 카운트 컬럼 없이 항상 동기
    images = conn.execute(
        "SELECT COUNT(*) AS n FROM instances i JOIN series s ON i.series_id=s.id"
        " WHERE s.study_id=? AND s.deleted=0 AND i.deleted=0",
        (study_id,),
    ).fetchone()["n"]
    n_series = conn.execute(
        "SELECT COUNT(*) AS n FROM series WHERE study_id=? AND deleted=0", (study_id,)
    ).fetchone()["n"]
    # merged = 이 검사가 병합으로 이동됨(merged_from) 또는 이 환자가 활성 병합의 master
    merged = row["merged_from"] is not None
    if not merged:
        merged = conn.execute(
            "SELECT 1 FROM patient_merges WHERE undone=0 AND master_key=? LIMIT 1",
            (row["patient_key"],),
        ).fetchone() is not None
    return {
        "id": row["id"],
        "study_uid": row["study_uid"],
        "patient_key": row["patient_key"],
        "patient_name": row["patient_name"],
        "sex": row["sex"],
        "study_date": row["study_date"],
        "modality": row["modality"],
        "study_desc": row["study_desc"],
        "images": int(images),
        # 서버 examctl(StudyRow) 동형 필드 — ExamControl S/I 컬럼이 그대로 소비
        "series_count": int(n_series),
        "instance_count": int(images),
        "merged": bool(merged),
    }


def list_studies(root: Path, q: str = "") -> dict:
    conn = _connect(root)
    try:
        sql = "SELECT id FROM studies"
        params: tuple = ()
        q = (q or "").strip()
        if q:
            like = f"%{q}%"
            sql += (" WHERE patient_name LIKE ? OR patient_key LIKE ?"
                    " OR study_desc LIKE ? OR modality LIKE ?")
            params = (like, like, like, like)
        sql += " ORDER BY study_date DESC, id DESC"
        ids = [r["id"] for r in conn.execute(sql, params).fetchall()]
        return {"items": [_study_row_to_dict(conn, sid) for sid in ids]}
    finally:
        conn.close()


def study_tree(root: Path, study_id: int) -> dict | None:
    """일반(뷰어/워크리스트) 트리 — 소프트 삭제된 시리즈/이미지는 제외."""
    conn = _connect(root)
    try:
        if conn.execute("SELECT 1 FROM studies WHERE id=?", (study_id,)).fetchone() is None:
            return None
        series_out = []
        for se in conn.execute(
            "SELECT * FROM series WHERE study_id=? AND deleted=0"
            " ORDER BY series_number, id",
            (study_id,),
        ).fetchall():
            instances = [
                {
                    "iid": r["id"],
                    "sop_uid": r["sop_uid"],
                    "instance_number": r["instance_number"],
                    "rows": r["rows"],
                    "cols": r["cols"],
                }
                for r in conn.execute(
                    "SELECT * FROM instances WHERE series_id=? AND deleted=0"
                    " ORDER BY instance_number, id",
                    (se["id"],),
                ).fetchall()
            ]
            if not instances and conn.execute(
                "SELECT 1 FROM instances WHERE series_id=? LIMIT 1", (se["id"],)
            ).fetchone() is None:
                # 구조적으로 빈 시리즈(sop 왕복 이동이 남긴 분할 행 등) — 일반/뷰어
                # 트리에서 숨김(서버 overlay_viewer_tree 와 동형: 빈 앱 전용 행 미노출).
                # 소프트 삭제로 비워진 시리즈(행은 존재)는 서버처럼 빈 목록으로 유지.
                continue
            series_out.append({
                "series_uid": se["series_uid"],
                "series_number": se["series_number"],
                "series_desc": se["series_desc"],
                "modality": se["modality"],
                "instances": instances,
            })
        return {"series": series_out}
    finally:
        conn.close()


def instance_path(root: Path, iid: int) -> Path | None:
    """iid → 파일 경로. DB의 rel_path 로만 해석하고 루트 이탈을 재검증한다."""
    conn = _connect(root)
    try:
        row = conn.execute("SELECT rel_path FROM instances WHERE id=?", (iid,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    target = (root / row["rel_path"]).resolve()
    if root != target and root not in target.parents:
        return None  # 루트 이탈 — DB 오염 시에도 차단
    return target if target.is_file() else None


# ── 렌더링(PNG) ───────────────────────────────────────────────────────────
def render_png(path: Path, wc: float | None = None, ww: float | None = None) -> bytes:
    """DICOM → 8bit PNG. W/L 기본값은 태그(없으면 min-max), wc/ww 쿼리 오버라이드.

    MONOCHROME1 반전·RGB 지원. Pillow 사용(requirements.txt 에 명시 — PNG 인코딩 표준 경로).
    """
    from PIL import Image  # 지연 import — 렌더링 외 경로는 Pillow 불필요

    ds = pydicom.dcmread(str(path), force=True)
    if not getattr(ds, "file_meta", None) or "TransferSyntaxUID" not in ds.file_meta:
        # force 로 읽힌 raw 파일 — 픽셀 해석을 위해 기본 전송구문 지정
        ds.file_meta = getattr(ds, "file_meta", None) or pydicom.dataset.FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    arr = ds.pixel_array

    photometric = str(getattr(ds, "PhotometricInterpretation", "") or "").upper()
    samples = int(getattr(ds, "SamplesPerPixel", 1) or 1)

    # RGB 판정은 SamplesPerPixel(=3) 기준 — 멀티프레임 그레이(ndim==3, 프레임 축)와 혼동 금지.
    # 멀티프레임이면 첫 프레임만 렌더(로컬 확인용 경량 뷰어 계약).
    is_rgb = samples == 3 or (arr.ndim == 3 and arr.shape[-1] == 3 and "MONOCHROME" not in photometric)
    if is_rgb:
        if arr.ndim == 4:  # (frames, rows, cols, 3) → 첫 프레임
            arr = arr[0]
    elif arr.ndim == 3:  # (frames, rows, cols) → 첫 프레임
        arr = arr[0]

    if is_rgb:
        # RGB — W/L 없이 8bit 정규화만
        rgb = arr.astype(np.float32)
        if rgb.max() > 255:
            rgb = rgb / rgb.max() * 255.0
        img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")
    else:
        data = arr.astype(np.float32)
        # Modality LUT(RescaleSlope/Intercept — CT HU 등) 적용
        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
        data = data * slope + intercept
        # W/L 결정: 쿼리 > 태그 > min-max
        if wc is None or ww is None:
            tag_wc, tag_ww = _tag_window(ds)
            if wc is None:
                wc = tag_wc
            if ww is None:
                ww = tag_ww
        if wc is None or ww is None or ww <= 0:
            lo, hi = float(data.min()), float(data.max())
            if hi <= lo:
                hi = lo + 1.0
        else:
            lo, hi = wc - ww / 2.0, wc + ww / 2.0
        norm = np.clip((data - lo) / (hi - lo), 0.0, 1.0)
        if photometric == "MONOCHROME1":
            norm = 1.0 - norm  # MONOCHROME1 — 밝기 반전
        img = Image.fromarray((norm * 255.0).astype(np.uint8), mode="L")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _tag_window(ds) -> tuple[float | None, float | None]:
    """WindowCenter/Width 태그 — 다중값이면 첫 값."""
    def _first(v):
        try:
            if v is None:
                return None
            if isinstance(v, (list, tuple)) or v.__class__.__name__ == "MultiValue":
                v = v[0] if len(v) else None
            return float(v) if v is not None else None
        except (TypeError, ValueError, IndexError):
            return None

    return _first(getattr(ds, "WindowCenter", None)), _first(getattr(ds, "WindowWidth", None))


# ── 삭제 ──────────────────────────────────────────────────────────────────
def delete_study(root: Path, study_id: int) -> dict | None:
    """로컬 검사 삭제 — 파일(인스턴스 전부)+DB 행. 반환: 삭제 요약(None=미존재)."""
    conn = _connect(root)
    try:
        st = conn.execute("SELECT * FROM studies WHERE id=?", (study_id,)).fetchone()
        if st is None:
            return None
        rows = conn.execute(
            "SELECT i.rel_path FROM instances i JOIN series s ON i.series_id=s.id"
            " WHERE s.study_id=?",
            (study_id,),
        ).fetchall()
        removed_files = 0
        for r in rows:
            target = (root / r["rel_path"]).resolve()
            if root != target and root not in target.parents:
                continue  # 루트 밖 경로는 절대 삭제하지 않음
            try:
                target.unlink(missing_ok=True)
                removed_files += 1
                # 빈 상위 폴더 정리(Image 하위 2단계까지 — 실패는 무시)
                for parent in (target.parent, target.parent.parent):
                    if parent != root and root in parent.parents and not any(parent.iterdir()):
                        parent.rmdir()
            except OSError:
                continue  # 파일 삭제 실패해도 DB 정리는 계속(고아 파일은 재삭제 가능)
        # FK CASCADE 는 PRAGMA 의존 — 명시 삭제로 확실히
        conn.execute(
            "DELETE FROM instances WHERE series_id IN (SELECT id FROM series WHERE study_id=?)",
            (study_id,),
        )
        conn.execute("DELETE FROM series WHERE study_id=?", (study_id,))
        conn.execute("DELETE FROM studies WHERE id=?", (study_id,))
        conn.commit()
        return {
            "ok": True,
            "study_id": study_id,
            "patient_key": st["patient_key"],
            "removed_files": removed_files,
        }
    finally:
        conn.close()


# ── Exam Control(로컬) — 소프트 삭제·복구·휴지통·미배정·재배정 ─────────────────
# 서버 examctl_service 와 동형 의미론: 파일/DICOM 원본은 불변, local.db 귀속만 변경.
UNASSIGNED_PATIENT_KEY = "UNASSIGNED"
UNASSIGNED_STUDY_UID = "local.unassigned"  # 로컬 버킷은 1개 고정(병원 개념 없음)
UNASSIGNED_DESC = "미배정 보관함"


def _base_uid(series_uid: str) -> str:
    """분할 파생 UID 의 원(base) UID — 꼬리의 '.m<검사id>' 세그먼트를 전부 제거.

    서버 examctl_service._base_uid 와 동일 규칙 — base 비교라서 sop 왕복 이동 시
    원 시리즈로 되돌아간다(분할 행 증식 'X.m3.m2' 방지).
    """
    return re.sub(r"(?:\.m\d+)+$", "", series_uid)


def _load_selection(
    conn: sqlite3.Connection, series_uids: list[str], sop_uids: list[str]
) -> tuple[list[sqlite3.Row], list[sqlite3.Row]]:
    """선택 uid → local.db 행(미존재 uid 는 조용히 무시, 중복 제거)."""
    series = []
    for uid in dict.fromkeys(u for u in (series_uids or []) if u):
        row = conn.execute("SELECT * FROM series WHERE series_uid=?", (uid,)).fetchone()
        if row is not None:
            series.append(row)
    instances = []
    for uid in dict.fromkeys(u for u in (sop_uids or []) if u):
        row = conn.execute("SELECT * FROM instances WHERE sop_uid=?", (uid,)).fetchone()
        if row is not None:
            instances.append(row)
    return series, instances


def examctl_tree(root: Path, study_id: int) -> dict | None:
    """Exam Control 트리 — 삭제 포함 표시(deleted 플래그). 서버 examctl 트리와 동형."""
    conn = _connect(root)
    try:
        st = conn.execute("SELECT study_uid FROM studies WHERE id=?", (study_id,)).fetchone()
        if st is None:
            return None
        series_out = []
        for se in conn.execute(
            "SELECT * FROM series WHERE study_id=? ORDER BY series_number, id", (study_id,)
        ).fetchall():
            instances = [
                {
                    "iid": r["id"],
                    "sop_uid": r["sop_uid"],
                    "instance_number": r["instance_number"],
                    "rows": r["rows"],
                    "cols": r["cols"],
                    "deleted": bool(r["deleted"]),
                }
                for r in conn.execute(
                    "SELECT * FROM instances WHERE series_id=? ORDER BY instance_number, id",
                    (se["id"],),
                ).fetchall()
            ]
            series_out.append({
                "series_uid": se["series_uid"],
                "series_number": se["series_number"],
                "series_desc": se["series_desc"],
                "modality": se["modality"],
                "deleted": bool(se["deleted"]),
                "instances": instances,
            })
        return {"study_uid": st["study_uid"], "series": series_out}
    finally:
        conn.close()


def examctl_delete(root: Path, series_uids: list[str], sop_uids: list[str]) -> dict | None:
    """소프트 삭제 — 시리즈 삭제는 하위 이미지 포함. None=선택 대상 미존재. idempotent."""
    conn = _connect(root)
    try:
        series, instances = _load_selection(conn, series_uids, sop_uids)
        if not series and not instances:
            return None
        n_series = 0
        n_images = 0
        for s in series:
            n_series += conn.execute(
                "UPDATE series SET deleted=1 WHERE id=? AND deleted=0", (s["id"],)
            ).rowcount
            n_images += conn.execute(
                "UPDATE instances SET deleted=1 WHERE series_id=? AND deleted=0", (s["id"],)
            ).rowcount
        for i in instances:
            n_images += conn.execute(
                "UPDATE instances SET deleted=1 WHERE id=? AND deleted=0", (i["id"],)
            ).rowcount
        conn.commit()
        return {"deleted_series": n_series, "deleted_images": n_images}
    finally:
        conn.close()


def examctl_restore(root: Path, series_uids: list[str], sop_uids: list[str]) -> dict | None:
    """복구 — 시리즈 복구는 하위 이미지 포함, 이미지 복구는 부모 시리즈도 살린다(가시성)."""
    conn = _connect(root)
    try:
        series, instances = _load_selection(conn, series_uids, sop_uids)
        if not series and not instances:
            return None
        n_series = 0
        n_images = 0
        for s in series:
            n_series += conn.execute(
                "UPDATE series SET deleted=0 WHERE id=? AND deleted=1", (s["id"],)
            ).rowcount
            n_images += conn.execute(
                "UPDATE instances SET deleted=0 WHERE series_id=? AND deleted=1", (s["id"],)
            ).rowcount
        for i in instances:
            n_images += conn.execute(
                "UPDATE instances SET deleted=0 WHERE id=? AND deleted=1", (i["id"],)
            ).rowcount
            n_series += conn.execute(
                "UPDATE series SET deleted=0 WHERE id=? AND deleted=1", (i["series_id"],)
            ).rowcount
        conn.commit()
        return {"restored_series": n_series, "restored_images": n_images}
    finally:
        conn.close()


def examctl_trash(root: Path) -> list[dict]:
    """휴지통 — 삭제 시리즈 + (시리즈는 살아있는데 개별 삭제된) 이미지. 서버 trash 동형."""
    conn = _connect(root)
    try:
        items: list[dict] = []
        for s in conn.execute(
            "SELECT se.*, st.id AS study_id_, st.patient_key AS pk, st.study_uid AS suid,"
            " st.study_desc AS sdesc FROM series se JOIN studies st ON se.study_id=st.id"
            " WHERE se.deleted=1 ORDER BY se.id"
        ).fetchall():
            n_imgs = conn.execute(
                "SELECT COUNT(*) AS n FROM instances WHERE series_id=?", (s["id"],)
            ).fetchone()["n"]
            items.append({
                "kind": "series",
                "study_id": s["study_id_"],
                "study_uid": s["suid"],
                "study_desc": s["sdesc"],
                "patient_key": s["pk"],
                "series_uid": s["series_uid"],
                "series_desc": s["series_desc"],
                "modality": s["modality"],
                "image_count": int(n_imgs),
            })
        for r in conn.execute(
            "SELECT i.*, se.series_uid AS seuid, st.id AS study_id_, st.patient_key AS pk,"
            " st.study_uid AS suid, st.study_desc AS sdesc"
            " FROM instances i JOIN series se ON i.series_id=se.id"
            " JOIN studies st ON se.study_id=st.id"
            " WHERE i.deleted=1 AND se.deleted=0 ORDER BY i.id"
        ).fetchall():
            items.append({
                "kind": "image",
                "study_id": r["study_id_"],
                "study_uid": r["suid"],
                "study_desc": r["sdesc"],
                "patient_key": r["pk"],
                "series_uid": r["seuid"],
                "sop_uid": r["sop_uid"],
                "instance_number": r["instance_number"] or 0,
            })
        return items
    finally:
        conn.close()


def _bucket_study_id(conn: sqlite3.Connection) -> int:
    """로컬 미배정 버킷 검사(1개 고정) — 없으면 생성."""
    row = conn.execute(
        "SELECT id FROM studies WHERE study_uid=?", (UNASSIGNED_STUDY_UID,)
    ).fetchone()
    if row is not None:
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO studies(patient_key, patient_name, study_uid, study_desc, modality)"
        " VALUES(?,?,?,?,?)",
        (UNASSIGNED_PATIENT_KEY, "미배정", UNASSIGNED_STUDY_UID, UNASSIGNED_DESC, "OT"),
    )
    return int(cur.lastrowid)


def _find_or_create_target_series(
    conn: sqlite3.Connection, src: sqlite3.Row, target_study_id: int
) -> int:
    """sop 단위 이동의 대상 시리즈 — 같은 원(base) UID 시리즈가 대상 검사에 있으면 재사용.

    base 비교라서 왕복 이동 시 원 시리즈로 복귀. 없으면 분할 행 생성
    (series_uid 전역 UNIQUE — 분할 행은 파생 UID '{base}.m{대상검사id}').
    """
    base = _base_uid(src["series_uid"])
    split_uid = f"{base}.m{target_study_id}"
    cands = [
        c for c in conn.execute(
            "SELECT * FROM series WHERE study_id=?", (target_study_id,)
        ).fetchall()
        if _base_uid(c["series_uid"]) == base
    ]
    for c in cands:
        if not c["deleted"]:
            return int(c["id"])
    for c in cands:
        if c["series_uid"] == split_uid:
            return int(c["id"])  # UNIQUE 제약 — 삭제 상태의 기존 분할 행 재사용(상태 유지)
    cur = conn.execute(
        "INSERT INTO series(study_id, series_uid, series_number, series_desc, modality)"
        " VALUES(?,?,?,?,?)",
        (target_study_id, split_uid, src["series_number"] or 0,
         src["series_desc"], src["modality"]),
    )
    return int(cur.lastrowid)


def _move_items(
    conn: sqlite3.Connection, target_study_id: int,
    series: list[sqlite3.Row], instances: list[sqlite3.Row],
) -> int:
    """시리즈/이미지를 대상 검사로 이동(재귀속). 반환: 이동 항목 수.

    시리즈는 study_id 만 변경(UID 불변), 이미지는 대상 검사의 시리즈로 붙인다.
    카운트는 조회 시 실측(_study_row_to_dict)이라 별도 동기 불필요.
    """
    moved = 0
    for s in series:
        if int(s["study_id"]) == int(target_study_id):
            continue  # 자기 자신으로의 이동은 무효(부작용 없음)
        conn.execute("UPDATE series SET study_id=? WHERE id=?", (target_study_id, s["id"]))
        moved += 1
    for i in instances:
        src = conn.execute("SELECT * FROM series WHERE id=?", (i["series_id"],)).fetchone()
        if src is None or int(src["study_id"]) == int(target_study_id):
            continue  # 같은 요청에서 부모 시리즈가 이미 이동됐으면 함께 간 것 — 중복 이동 방지
        tgt_series_id = _find_or_create_target_series(conn, src, target_study_id)
        conn.execute("UPDATE instances SET series_id=? WHERE id=?", (tgt_series_id, i["id"]))
        moved += 1
    return moved


def examctl_unassign(root: Path, series_uids: list[str], sop_uids: list[str]) -> dict | None:
    """선택 항목을 로컬 미배정 버킷 검사로 이동. None=선택 대상 미존재."""
    conn = _connect(root)
    try:
        series, instances = _load_selection(conn, series_uids, sop_uids)
        if not series and not instances:
            return None
        bucket_id = _bucket_study_id(conn)
        moved = _move_items(conn, bucket_id, series, instances)
        conn.commit()  # 버킷 생성 포함(재사용 계약)
        return {"moved": moved, "bucket_study_id": bucket_id}
    finally:
        conn.close()


def examctl_assign(
    root: Path, target_study_id: int, series_uids: list[str], sop_uids: list[str]
) -> dict:
    """선택 항목(미배정 포함)을 대상 로컬 검사로 이동 — local.db 귀속만 변경.

    반환: {"moved": n} 또는 {"error": "target_not_found" | "not_found" | "self_assign"}.
    """
    conn = _connect(root)
    try:
        if conn.execute(
            "SELECT 1 FROM studies WHERE id=?", (target_study_id,)
        ).fetchone() is None:
            return {"error": "target_not_found"}
        series, instances = _load_selection(conn, series_uids, sop_uids)
        if not series and not instances:
            return {"error": "not_found"}
        moved = _move_items(conn, target_study_id, series, instances)
        if moved == 0:
            return {"error": "self_assign"}  # 커밋 없음 — 부작용 0
        conn.commit()
        return {"moved": moved}
    finally:
        conn.close()


# ── Exam Control(로컬) — 환자 병합(Merge/Unmerge) ──────────────────────────
# 서버 examctl merge 와 동형 의미론: Slave 환자의 전 검사를 Master 환자로 귀속.
# 로컬 studies 는 환자 필드가 행에 인라인 → 환자 4필드 UPDATE + originals 스냅샷.
# 파일/DICOM 원본 불변 — local.db 계층만 변경(unmerge 로 완전 원복 가능).
def _is_unassigned_study(row: sqlite3.Row) -> bool:
    """로컬 미배정 버킷 검사(또는 그 환자) 여부 — 병합 금지 대상."""
    return (
        row["study_uid"] == UNASSIGNED_STUDY_UID
        or row["patient_key"] == UNASSIGNED_PATIENT_KEY
    )


def examctl_merge(root: Path, master_study_id: int, slave_study_id: int) -> dict:
    """환자 병합 — slave 환자의 전 검사 행을 master 환자 필드로 UPDATE + 스냅샷.

    반환: {"merge_id", "moved"} 또는
    {"error": "not_found" | "same_patient" | "unassigned" | "already_merged"}.
    """
    conn = _connect(root)
    try:
        master = conn.execute(
            "SELECT * FROM studies WHERE id=?", (master_study_id,)
        ).fetchone()
        slave = conn.execute(
            "SELECT * FROM studies WHERE id=?", (slave_study_id,)
        ).fetchone()
        if master is None or slave is None:
            return {"error": "not_found"}
        if _is_unassigned_study(master) or _is_unassigned_study(slave):
            return {"error": "unassigned"}
        master_key = master["patient_key"]
        slave_key = slave["patient_key"]
        if master_key == slave_key:
            return {"error": "same_patient"}
        # 중복 가드 — slave 환자가 활성 병합의 master/slave 이거나 master 환자가
        # 활성 병합의 slave 면 거부(master 가 여러 병합의 master 인 것은 허용).
        dup = conn.execute(
            "SELECT 1 FROM patient_merges WHERE undone=0"
            " AND (master_key=? OR slave_key=? OR slave_key=?) LIMIT 1",
            (slave_key, slave_key, master_key),
        ).fetchone()
        if dup is not None:
            return {"error": "already_merged"}
        # slave 환자의 전 검사 — 원값 스냅샷 후 master 환자 4필드로 UPDATE
        targets = conn.execute(
            "SELECT * FROM studies WHERE patient_key=?", (slave_key,)
        ).fetchall()
        originals = {
            str(r["id"]): {
                "patient_key": r["patient_key"],
                "patient_name": r["patient_name"],
                "sex": r["sex"],
                "birth_date": r["birth_date"],
            }
            for r in targets
        }
        moved_ids = [int(r["id"]) for r in targets]
        cur = conn.execute(
            "INSERT INTO patient_merges(master_key, master_name, slave_key, slave_name,"
            " originals, moved_study_ids) VALUES(?,?,?,?,?,?)",
            (
                master_key,
                master["patient_name"],
                slave_key,
                slave["patient_name"],
                json.dumps(originals, ensure_ascii=False),
                json.dumps(moved_ids),
            ),
        )
        merge_id = int(cur.lastrowid)
        for sid in moved_ids:
            conn.execute(
                "UPDATE studies SET patient_key=?, patient_name=?, sex=?, birth_date=?,"
                " merged_from=? WHERE id=?",
                (master_key, master["patient_name"], master["sex"],
                 master["birth_date"], merge_id, sid),
            )
        conn.commit()
        return {"merge_id": merge_id, "moved": len(moved_ids)}
    finally:
        conn.close()


def examctl_unmerge(
    root: Path, study_id: int | None = None, merge_id: int | None = None
) -> dict:
    """병합 해제 — originals 스냅샷으로 환자 필드 원복 + merged_from=NULL + undone=1.

    study_id 는 활성 병합의 master 환자 검사 또는 이동된(moved) 검사로 병합을 찾는다.
    반환: {"restored", "merge_id"} 또는 {"error": "not_found"}.
    """
    conn = _connect(root)
    try:
        merge = None
        if merge_id is not None:
            merge = conn.execute(
                "SELECT * FROM patient_merges WHERE id=? AND undone=0", (merge_id,)
            ).fetchone()
        elif study_id is not None:
            st = conn.execute(
                "SELECT * FROM studies WHERE id=?", (study_id,)
            ).fetchone()
            if st is not None:
                if st["merged_from"] is not None:  # 이동된 검사 → 그 병합
                    merge = conn.execute(
                        "SELECT * FROM patient_merges WHERE id=? AND undone=0",
                        (st["merged_from"],),
                    ).fetchone()
                if merge is None:  # master 환자의 검사 → 최신 활성 병합
                    merge = conn.execute(
                        "SELECT * FROM patient_merges WHERE undone=0 AND master_key=?"
                        " ORDER BY id DESC LIMIT 1",
                        (st["patient_key"],),
                    ).fetchone()
        if merge is None:
            return {"error": "not_found"}
        originals = json.loads(merge["originals"] or "{}")
        restored = 0
        for sid, orig in originals.items():
            restored += conn.execute(
                "UPDATE studies SET patient_key=?, patient_name=?, sex=?, birth_date=?,"
                " merged_from=NULL WHERE id=?",
                (
                    orig["patient_key"],
                    orig["patient_name"],
                    orig.get("sex", ""),
                    orig.get("birth_date", ""),
                    int(sid),
                ),
            ).rowcount
        conn.execute("UPDATE patient_merges SET undone=1 WHERE id=?", (merge["id"],))
        conn.commit()
        return {"restored": restored, "merge_id": int(merge["id"])}
    finally:
        conn.close()


def examctl_merges(root: Path) -> list[dict]:
    """활성(미해제) 병합 목록 — 서버 GET /api/examctl/merges 와 동형 항목."""
    conn = _connect(root)
    try:
        items: list[dict] = []
        for m in conn.execute(
            "SELECT * FROM patient_merges WHERE undone=0 ORDER BY id DESC"
        ).fetchall():
            items.append({
                "id": m["id"],
                "master": {"patient_key": m["master_key"], "patient_name": m["master_name"]},
                "slave": {"patient_key": m["slave_key"], "patient_name": m["slave_name"]},
                "moved_study_ids": json.loads(m["moved_study_ids"] or "[]"),
                "created_at": m["created_at"],
            })
        return items
    finally:
        conn.close()
