"""검사 DICOM 내보내기 — 워크리스트에서 고른 검사를 원본 DICOM 으로 반출.

대상 3가지를 프론트가 고른다:
  · 로컬 폴더 / USB : 브라우저의 폴더 선택(File System Access) 후 **파일 단위**로 직접 기록.
                      manifest 로 목록을 받고 file 로 한 장씩 가져간다(진행률 표시 가능).
  · ZIP 다운로드    : package?format=zip — 서버가 묶어 스트리밍.
  · CD 굽기용 ISO   : package?format=iso — ISO9660 이미지를 만들어 내려준다.
                      ⚠ 웹 페이지는 광학 드라이브를 제어할 수 없다(브라우저 권한 밖).
                      그래서 **구울 수 있는 이미지까지** 만들어 주고, 굽기는 OS 기능을 쓴다
                      (윈도 탐색기: ISO 우클릭 → '디스크 이미지 굽기').

경로 규칙(표준 반출 관례):
    DICOM/<환자ID>/<검사일_모달리티>/S<시리즈번호>/<일련번호>.dcm
환자별·검사별로 갈라 두어야 받는 쪽에서 섞이지 않는다.

Live(vid) 검사도 같은 계약으로 처리한다 — 원본 bytes 를 A 에서 받아 그대로 내보낸다.
"""
from __future__ import annotations

import io
import re
import zipfile
from typing import Iterator

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import current_user, download_user
from app.db import get_db
from app.services import webpacs_live as live

router = APIRouter(prefix="/api/export", tags=["export"])

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe(s: str, fallback: str = "X") -> str:
    """경로 조각 정리 — 한글·공백·구분자가 섞여도 어느 OS 에서나 열리는 이름으로."""
    out = _SAFE.sub("_", str(s or "")).strip("._") or fallback
    return out[:48]


def _entries(db: Session, study_id: int, user: dict) -> tuple[dict, list[dict]]:
    """(검사 정보, 파일 목록). 파일 목록은 내보낼 상대경로 + 취득 정보."""
    if live.is_live_id(study_id):
        d = live.live_detail(db, study_id, user, with_related=False)
        tree = live.live_series_tree(db, study_id, user)
        src = "live"
    else:
        from app.api.worklist import _cached_series_tree
        from app.dicom.orthanc import OrthancClient
        from app.models import Study

        st = db.get(Study, study_id)
        if not st:
            raise HTTPException(status_code=404, detail=f"검사를 찾을 수 없습니다: {study_id}")
        if user.get("hid") and st.hospital_id and st.hospital_id != user["hid"]:
            raise HTTPException(status_code=403, detail="다른 병원의 검사입니다")
        # 환자 정보는 patients 테이블에 있다(studies 는 patient_id 만 갖는다)
        pt = st.patient
        d = {"id": st.id, "patient_key": pt.patient_key if pt else "",
             "patient_name": pt.name_masked if pt else "",
             "study_date": st.study_date, "modality": st.modality, "study_desc": st.study_desc,
             "study_uid": st.study_uid}
        tree = {"study_uid": st.study_uid,
                "series": _cached_series_tree(OrthancClient(), st.orthanc_id or "")}
        src = "orthanc"

    base = f"DICOM/{_safe(d.get('patient_key'), 'NOID')}/" \
           f"{_safe(d.get('study_date'), '00000000')}_{_safe(d.get('modality'), 'OT')}"
    files: list[dict] = []
    for s in tree.get("series", []):
        sn = int(s.get("series_number") or 0)
        for i, inst in enumerate(s.get("instances", []), start=1):
            files.append({
                "path": f"{base}/S{sn:03d}/{i:06d}.dcm",
                "src": src,
                "study_id": study_id,
                "study_uid": tree.get("study_uid", ""),
                "series_uid": s.get("series_uid", ""),
                "sop_uid": inst.get("sop_uid", ""),
                "orthanc_id": inst.get("orthanc_id", ""),
            })
    return d, files


def _read(db: Session, f: dict) -> bytes:
    if f["src"] == "live":
        client = live.service_client(db)
        return live.get_instance_bytes(client, f["study_uid"], f["series_uid"], f["sop_uid"])
    from app.dicom.orthanc import OrthancClient

    return OrthancClient().instance_file(f["orthanc_id"])


def _ids(study_ids: str) -> list[int]:
    out: list[int] = []
    for tok in (study_ids or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            out.append(int(tok))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"잘못된 검사 id: {tok}")
    if not out:
        raise HTTPException(status_code=400, detail="내보낼 검사를 선택하세요")
    if len(out) > 200:
        raise HTTPException(status_code=400, detail="한 번에 200건까지 내보낼 수 있습니다")
    return out


@router.get("/manifest")
def manifest(study_ids: str = Query(...), db: Session = Depends(get_db),
             user: dict = Depends(current_user)):
    """내보낼 파일 목록 — 폴더/USB 저장은 이 목록으로 한 장씩 받아 기록한다(진행률 표시)."""
    studies = []
    total = 0
    for sid in _ids(study_ids):
        d, files = _entries(db, sid, user)
        total += len(files)
        studies.append({
            "id": sid, "patient_key": d.get("patient_key"), "patient_name": d.get("patient_name"),
            "study_date": d.get("study_date"), "modality": d.get("modality"),
            "study_desc": d.get("study_desc"), "count": len(files),
            "files": [{"path": f["path"], "sop_uid": f["sop_uid"], "series_uid": f["series_uid"]}
                      for f in files],
        })
    return {"studies": studies, "total_files": total}


@router.get("/file")
def one_file(study_id: int, sop_uid: str, db: Session = Depends(get_db),
             user: dict = Depends(current_user)):
    """단일 DICOM — manifest 의 sop_uid 로 한 장씩. 폴더/USB 저장 경로가 쓴다."""
    _, files = _entries(db, study_id, user)
    f = next((x for x in files if x["sop_uid"] == sop_uid), None)
    if not f:
        raise HTTPException(status_code=404, detail="해당 영상을 찾을 수 없습니다")
    try:
        data = _read(db, f)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"영상 취득 실패: {str(e)[:120]}")
    return StreamingResponse(io.BytesIO(data), media_type="application/dicom",
                             headers={"Content-Disposition": f'attachment; filename="{f["path"].split("/")[-1]}"'})


def _index_txt(studies: list[dict]) -> bytes:
    lines = ["Saintview PACS AI — DICOM Export", ""]
    for s in studies:
        lines.append(f"{s['patient_name']} ({s['patient_key']})  {s['study_date']}  "
                     f"{s['modality']}  {s['study_desc'] or ''}  — {s['count']} images")
    lines += ["", "폴더 구조: DICOM/<환자ID>/<검사일_모달리티>/S<시리즈>/<일련번호>.dcm",
              "DICOM 뷰어로 DICOM 폴더를 열면 됩니다."]
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")


@router.get("/package")
def package(study_ids: str = Query(...), format: str = "zip",
            db: Session = Depends(get_db), user: dict = Depends(download_user)):
    """ZIP(스트리밍) 또는 CD 굽기용 ISO 이미지.

    인증은 download_user — 브라우저 내려받기는 Authorization 헤더를 못 붙이므로
    ?token= 도 받는다(검증 경로는 current_user 와 동일).
    """
    ids = _ids(study_ids)
    collected: list[tuple[dict, list[dict]]] = [_entries(db, sid, user) for sid in ids]
    infos = [{"patient_name": d.get("patient_name"), "patient_key": d.get("patient_key"),
              "study_date": d.get("study_date"), "modality": d.get("modality"),
              "study_desc": d.get("study_desc"), "count": len(fs)} for d, fs in collected]
    stamp = (infos[0]["study_date"] or "export") if len(infos) == 1 else "studies"
    base_name = f"saintview_{_safe(stamp)}_{len(ids)}"

    if format == "iso":
        try:
            import pycdlib  # noqa: F401
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="ISO 생성 모듈(pycdlib)이 설치돼 있지 않습니다. "
                       "서버에서 `pip install pycdlib` 후 다시 시도하거나, ZIP 으로 내보내세요.")
        return StreamingResponse(
            io.BytesIO(_build_iso(db, collected, infos)), media_type="application/x-iso9660-image",
            headers={"Content-Disposition": f'attachment; filename="{base_name}.iso"'})

    def gen() -> Iterator[bytes]:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:   # DICOM 은 이미 압축 — 재압축 무의미
            zf.writestr("INDEX.txt", _index_txt(infos))
            for _, files in collected:
                for f in files:
                    try:
                        zf.writestr(f["path"], _read(db, f))
                    except Exception:  # noqa: BLE001 — 한 장 실패가 전체를 막지 않는다
                        continue
                    if buf.tell() > 4 * 1024 * 1024:   # 4MB 마다 흘려보내 메모리 상한 유지
                        yield buf.getvalue()
                        buf.seek(0); buf.truncate(0)
        yield buf.getvalue()

    return StreamingResponse(gen(), media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{base_name}.zip"'})


_ISO_BAD = re.compile(r"[^A-Z0-9_]")


def _build_iso(db: Session, collected, infos) -> bytes:
    """ISO9660(Joliet) 이미지 — 굽기는 OS 가 한다(브라우저는 광학 드라이브를 못 만진다).

    이름이 두 벌인 이유: ISO9660 식별자는 **A-Z 0-9 _ 만** 허용한다. 환자ID의 하이픈 하나로도
    생성이 통째로 실패하므로, ISO9660 쪽에는 정리한 이름을, Joliet 쪽에는 원래 경로를 건다.
    실제로 어느 OS 든 Joliet 을 읽으므로 사용자가 보는 이름은 원래 경로 그대로다.
    """
    import pycdlib

    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, vol_ident="SAINTVIEW")

    iso_of: dict[str, str] = {"": ""}          # Joliet 경로 → ISO9660 경로
    used: dict[str, set[str]] = {"": set()}    # 부모별로 쓰인 ISO 이름(중복 방지)

    def iso_seg(name: str, parent: str) -> str:
        taken = used.setdefault(parent, set())
        base = _ISO_BAD.sub("_", name.upper())[:28] or "X"
        seg, n = base, 1
        while seg in taken:          # 정리 후 겹치면 뒤에 번호를 붙여 갈라 놓는다
            n += 1
            suf = str(n)
            seg = base[: 28 - len(suf)] + suf
        taken.add(seg)
        return seg

    def mkdirs(path: str) -> str:
        """중간 디렉터리를 만들고 파일이 들어갈 ISO9660 디렉터리 경로를 돌려준다."""
        jcur = ""
        for p in path.split("/")[:-1]:
            parent, jcur = jcur, f"{jcur}/{p}"
            if jcur in iso_of:
                continue
            icur = f"{iso_of[parent]}/{iso_seg(p, parent)}"
            iso_of[jcur] = icur
            iso.add_directory(iso_path=icur, joliet_path=jcur)
        return iso_of[jcur]

    idx = _index_txt(infos)
    iso.add_fp(io.BytesIO(idx), len(idx), iso_path="/INDEX.TXT;1", joliet_path="/INDEX.txt")
    n = 0
    for _, files in collected:
        for f in files:
            try:
                data = _read(db, f)
            except Exception:  # noqa: BLE001 — 한 장 실패가 전체를 막지 않는다
                continue
            n += 1
            idir = mkdirs(f["path"])
            iso.add_fp(io.BytesIO(data), len(data),
                       iso_path=f"{idir}/{n:08d}.DCM;1", joliet_path=f"/{f['path']}")
    out = io.BytesIO()
    iso.write_fp(out)
    iso.close()
    return out.getvalue()
