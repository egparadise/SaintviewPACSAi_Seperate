"""Exam Control 서비스 — 관리자용 검사 QC(소프트 삭제·복구·미배정·재배정).

원칙(정직한 안내): Orthanc 원본·DICOM 태그는 불변이다. 삭제/이동은 전부 앱 DB 계층
(Series/Instance→Study 귀속)에서만 일어나고, 뷰어·워크리스트는 앱 DB 트리를 따르므로
즉시 반영된다.

- 소프트 삭제: deleted_at 마킹(휴지통) → 일반 worklist/seriesTree/뷰어 트리에서 제외,
  Exam Control 트리에는 deleted 플래그로 계속 표시. Recovery 로 복구.
- Unassign: 병원별 '미배정(UNASSIGNED)' 버킷 검사로 이동(없으면 생성).
- Assign: 대상 검사로 이동. sop 단위 이동 시 대상 검사에 소속 시리즈가 없으면
  시리즈 행을 생성(분할). series_uid 는 전역 UNIQUE 라 분할 행은 앱 내부 파생
  UID("{원UID}.m{대상검사id}")를 쓴다(DICOM 원본 UID 불변 — 앱 표시용).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Instance, Patient, PatientMerge, Series, Study

UNASSIGNED_PATIENT_KEY = "UNASSIGNED"
UNASSIGNED_DESC = "미배정 보관함"

# SQLite 파라미터 한도(999) 대비 IN 절 청크 크기
_IN_CHUNK = 400


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _chunks(seq: list, n: int = _IN_CHUNK):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ════════════════════════════════ 구체화(materialize) ════════════════════════════════
def materialize_tree(db: Session, study: Study) -> None:
    """Orthanc 물리 트리를 앱 DB(Series/Instance)로 구체화.

    이미 있는 행(uid 기준)은 절대 건드리지 않는다 — 이동/삭제 상태가 재동기화로
    되돌아가지 않게. Orthanc 미가용이면 조용히 건너뛴다(기존 DB 트리로 동작).
    """
    if not study.orthanc_id:
        return
    from app.dicom.orthanc import OrthancClient

    client = OrthancClient()
    try:
        if not client.alive():
            return
        tree = client.series_tree(study.orthanc_id)
    except Exception:  # noqa: BLE001 — 구체화 실패는 비치명(기존 DB 트리로 동작)
        return
    finally:
        client.close()

    changed = False
    for s in tree:
        uid = s.get("series_uid", "")
        if not uid:
            continue
        row = db.execute(select(Series).where(Series.series_uid == uid)).scalar_one_or_none()
        if row is None:
            row = Series(
                study_id=study.id,
                series_uid=uid,
                modality=s.get("modality", ""),
                series_desc=s.get("series_desc", ""),
                series_number=int(s.get("series_number") or 0),
                instance_count=len(s.get("instances", [])),
            )
            db.add(row)
            db.flush()
            changed = True
        for inst in s.get("instances", []):
            sop = inst.get("sop_uid", "")
            if not sop:
                continue
            irow = db.execute(
                select(Instance).where(Instance.sop_uid == sop)
            ).scalar_one_or_none()
            if irow is None:
                db.add(Instance(
                    series_id=row.id,
                    sop_uid=sop,
                    instance_number=int(inst.get("instance_number") or 0),
                    rows=int(inst.get("rows") or 0),
                    cols=int(inst.get("cols") or 0),
                    orthanc_id=inst.get("orthanc_id", ""),
                ))
                changed = True
            elif not irow.orthanc_id and inst.get("orthanc_id"):
                irow.orthanc_id = inst["orthanc_id"]  # 프리뷰 경로 보강(귀속은 불변)
                changed = True
    if changed:
        db.commit()


# ════════════════════════════════ 트리(Exam Control) ════════════════════════════════
def study_tree(db: Session, study: Study) -> dict:
    """Exam Control 트리 — deleted 포함 표시(플래그). 프리뷰는 기존 인스턴스 경로 재사용."""
    from app.config import get_settings

    materialize_tree(db, study)
    base = get_settings().orthanc_preview_base   # 클라이언트 브라우저용 썸네일(상대경로 기본, Vite 프록시)
    series_rows = db.execute(
        select(Series).where(Series.study_id == study.id)
        .order_by(Series.series_number, Series.id)
    ).scalars().all()
    out = []
    for s in series_rows:
        inst_rows = db.execute(
            select(Instance).where(Instance.series_id == s.id)
            .order_by(Instance.instance_number, Instance.id)
        ).scalars().all()
        out.append({
            "series_uid": s.series_uid,
            "series_number": s.series_number or 0,
            "series_desc": s.series_desc,
            "modality": s.modality,
            "deleted": s.deleted_at is not None,
            "instances": [
                {
                    "sop_uid": i.sop_uid,
                    "instance_number": i.instance_number or 0,
                    "rows": i.rows or 0,
                    "cols": i.cols or 0,
                    "deleted": i.deleted_at is not None,
                    "preview_url": (
                        f"{base}/instances/{i.orthanc_id}/preview" if i.orthanc_id else ""
                    ),
                }
                for i in inst_rows
            ],
        })
    return {"study_uid": study.study_uid, "series": out}


# ════════════════════════════════ 선택 해석 ════════════════════════════════
def load_selection(
    db: Session, series_uids: list[str], sop_uids: list[str]
) -> tuple[list[Series], list[Instance]]:
    series: list[Series] = []
    for chunk in _chunks([u for u in series_uids if u]):
        series += list(db.execute(select(Series).where(Series.series_uid.in_(chunk))).scalars())
    instances: list[Instance] = []
    for chunk in _chunks([u for u in sop_uids if u]):
        instances += list(db.execute(select(Instance).where(Instance.sop_uid.in_(chunk))).scalars())
    return series, instances


def affected_studies(db: Session, series: list[Series], instances: list[Instance]) -> list[Study]:
    """선택이 걸린 검사들(병원 가드·카운트 재계산 대상)."""
    study_ids = {s.study_id for s in series}
    series_ids = {i.series_id for i in instances}
    for chunk in _chunks(sorted(series_ids)):
        for (sid,) in db.execute(select(Series.study_id).where(Series.id.in_(chunk))).all():
            study_ids.add(sid)
    out = []
    for sid in sorted(study_ids):
        st = db.get(Study, sid)
        if st:
            out.append(st)
    return out


def sync_counts(db: Session, study: Study) -> None:
    """검사 시리즈/이미지 카운트를 앱 DB 트리(비삭제) 기준으로 재계산.

    Instance 행이 하나도 없는 시리즈는 아직 구체화되지 않은 것(Orthanc 미가용 등)이므로
    시리즈의 instance_count 컬럼(등록 시 값)으로 폴백한다 — 0 으로 붕괴 금지.
    (sop 이동으로 비워진 시리즈는 move_items 가 컬럼을 0 으로 갱신해 두므로 안전.)
    """
    from sqlalchemy import func

    db.flush()  # autoflush=False 세션 — 펜딩 삭제/이동을 먼저 반영하고 센다
    series_rows = db.execute(
        select(Series).where(Series.study_id == study.id, Series.deleted_at.is_(None))
    ).scalars().all()
    study.series_count = len(series_rows)
    n = 0
    for s in series_rows:
        has_rows = db.execute(
            select(Instance.id).where(Instance.series_id == s.id).limit(1)
        ).first() is not None
        if has_rows:
            live = db.execute(
                select(func.count()).select_from(Instance)
                .where(Instance.series_id == s.id, Instance.deleted_at.is_(None))
            ).scalar() or 0
            s.instance_count = live  # 구체화된 시리즈는 컬럼도 실측으로 동기
            n += live
        else:
            n += s.instance_count or 0  # 미구체화 — 등록 시 카운트 유지
    study.instance_count = n


# ════════════════════════════════ 소프트 삭제 / 복구 ════════════════════════════════
def soft_delete(db: Session, series: list[Series], instances: list[Instance]) -> tuple[int, int]:
    """소프트 삭제 — 시리즈 삭제는 하위 이미지 포함. 반환 (삭제 시리즈 수, 삭제 이미지 수)."""
    now = _utcnow()
    n_series = 0
    n_images = 0
    for s in series:
        if s.deleted_at is None:
            s.deleted_at = now
            n_series += 1
        for i in db.execute(select(Instance).where(Instance.series_id == s.id)).scalars():
            if i.deleted_at is None:
                i.deleted_at = now
                n_images += 1
    for i in instances:
        if i.deleted_at is None:
            i.deleted_at = now
            n_images += 1
    return n_series, n_images


def restore(db: Session, series: list[Series], instances: list[Instance]) -> tuple[int, int]:
    """복구 — 시리즈 복구는 하위 이미지 포함, 이미지 복구는 부모 시리즈도 살린다(가시성)."""
    n_series = 0
    n_images = 0
    for s in series:
        if s.deleted_at is not None:
            s.deleted_at = None
            n_series += 1
        for i in db.execute(select(Instance).where(Instance.series_id == s.id)).scalars():
            if i.deleted_at is not None:
                i.deleted_at = None
                n_images += 1
    for i in instances:
        if i.deleted_at is not None:
            i.deleted_at = None
            n_images += 1
        parent = db.get(Series, i.series_id)
        if parent is not None and parent.deleted_at is not None:
            parent.deleted_at = None
            n_series += 1
    return n_series, n_images


def trash_items(db: Session, hospital_id: int | None) -> list[dict]:
    """휴지통 목록 — 삭제 시리즈 + (시리즈는 살아있는데 개별 삭제된) 이미지."""
    q = (
        select(Series, Study, Patient)
        .join(Study, Series.study_id == Study.id)
        .join(Patient, Study.patient_id == Patient.id)
        .where(Series.deleted_at.is_not(None))
    )
    if hospital_id is not None:
        q = q.where(Study.hospital_id == hospital_id)
    items: list[dict] = []
    for s, st, p in db.execute(q).all():
        n_imgs = len([i for i in db.execute(
            select(Instance.id).where(Instance.series_id == s.id)).all()])
        items.append({
            "kind": "series",
            "study_id": st.id,
            "study_uid": st.study_uid,
            "study_desc": st.study_desc,
            "patient_key": p.patient_key,
            "series_uid": s.series_uid,
            "series_desc": s.series_desc,
            "modality": s.modality,
            "image_count": n_imgs,
            "deleted_at": s.deleted_at.isoformat() if s.deleted_at else "",
        })
    qi = (
        select(Instance, Series, Study, Patient)
        .join(Series, Instance.series_id == Series.id)
        .join(Study, Series.study_id == Study.id)
        .join(Patient, Study.patient_id == Patient.id)
        .where(Instance.deleted_at.is_not(None), Series.deleted_at.is_(None))
    )
    if hospital_id is not None:
        qi = qi.where(Study.hospital_id == hospital_id)
    for i, s, st, p in db.execute(qi).all():
        items.append({
            "kind": "image",
            "study_id": st.id,
            "study_uid": st.study_uid,
            "study_desc": st.study_desc,
            "patient_key": p.patient_key,
            "series_uid": s.series_uid,
            "sop_uid": i.sop_uid,
            "instance_number": i.instance_number or 0,
            "deleted_at": i.deleted_at.isoformat() if i.deleted_at else "",
        })
    return items


# ════════════════════════════════ Unassign / Assign ════════════════════════════════
def bucket_study(db: Session, hospital_id: int | None) -> Study:
    """병원별 미배정 버킷 검사 — 없으면 생성(patient_key='UNASSIGNED', hid 귀속)."""
    q = (
        select(Study)
        .join(Patient, Study.patient_id == Patient.id)
        .where(Patient.patient_key == UNASSIGNED_PATIENT_KEY)
    )
    q = (q.where(Study.hospital_id == hospital_id) if hospital_id is not None
         else q.where(Study.hospital_id.is_(None)))
    st = db.execute(q.limit(1)).scalar_one_or_none()
    if st:
        return st
    from app.services.study_service import get_or_create_patient

    patient = get_or_create_patient(db, UNASSIGNED_PATIENT_KEY, "미배정", "", "")
    st = Study(
        patient_id=patient.id,
        # 앱 내부 검사(비 DICOM) — 병원별 1개 고정 UID (2.25 = UUID 파생 루트, 앱 로컬)
        study_uid=f"2.25.999000.{hospital_id or 0}",
        study_desc=UNASSIGNED_DESC,
        modality="OT",
        hospital_id=hospital_id,
        status="received",
    )
    db.add(st)
    db.flush()
    return st


def _base_uid(series_uid: str) -> str:
    """분할 파생 UID 의 원(base) UID — 꼬리의 '.m<검사id>' 세그먼트를 전부 제거.

    DICOM UID 는 숫자·점만 허용되므로 'm' 세그먼트는 앱 파생 UID 에서만 나온다.
    """
    return re.sub(r"(?:\.m\d+)+$", "", series_uid)


def _find_or_create_target_series(db: Session, src: Series, target: Study) -> Series:
    """sop 단위 이동의 대상 시리즈 — 대상 검사에 같은 원(base) UID 시리즈가 있으면 재사용.

    base 비교라서 왕복 이동 시 원 시리즈로 되돌아간다(분할 행 증식 방지: 'X.m3.m2' 금지).
    없으면 분할 행 생성. series_uid 전역 UNIQUE 제약 때문에 분할 행은 파생 UID 를 쓴다.
    """
    base = _base_uid(src.series_uid)
    split_uid = f"{base}.m{target.id}"
    cands = [
        c for c in db.execute(select(Series).where(Series.study_id == target.id)).scalars()
        if _base_uid(c.series_uid) == base
    ]
    for cand in cands:
        if cand.deleted_at is None:
            return cand
    for cand in cands:
        if cand.series_uid == split_uid:
            return cand  # UNIQUE 제약 — 삭제 상태의 기존 분할 행 재사용(상태 유지)
    row = Series(
        study_id=target.id,
        series_uid=split_uid,
        modality=src.modality,
        series_desc=src.series_desc,
        series_number=src.series_number or 0,
        instance_count=0,
    )
    db.add(row)
    db.flush()
    return row


def move_items(
    db: Session, target: Study, series: list[Series], instances: list[Instance]
) -> int:
    """시리즈/이미지를 대상 검사로 이동(재귀속). 반환: 이동 항목 수.

    시리즈는 study_id 만 바꾸고(UID 불변), 이미지는 대상 검사의 시리즈로 붙인다
    (없으면 분할 행 생성). 카운트 재계산은 호출부(affected+target sync_counts) 몫.
    """
    from sqlalchemy import func

    def _live_count(series_id: int) -> int:
        db.flush()
        return db.execute(
            select(func.count()).select_from(Instance)
            .where(Instance.series_id == series_id, Instance.deleted_at.is_(None))
        ).scalar() or 0

    moved = 0
    for s in series:
        if s.study_id == target.id:
            continue
        s.study_id = target.id
        moved += 1
    for i in instances:
        src_series = db.get(Series, i.series_id)
        if src_series is None or src_series.study_id == target.id:
            continue
        tgt_series = _find_or_create_target_series(db, src_series, target)
        i.series_id = tgt_series.id
        moved += 1
        # 시리즈 카운트 컬럼 실측 동기 — sop 이동으로 비워진 시리즈가 sync_counts 의
        # 미구체화 폴백(컬럼값)으로 되살아나지 않게 이동 시점에 갱신한다
        src_series.instance_count = _live_count(src_series.id)
        tgt_series.instance_count = _live_count(tgt_series.id)
    return moved


def unassign_items(
    db: Session, series: list[Series], instances: list[Instance]
) -> tuple[int, int | None, list[Study]]:
    """미배정 버킷으로 이동 — 항목이 속한 검사의 병원별 버킷 사용.

    반환: (이동 수, 대표 버킷 study_id, 카운트 재계산 대상 버킷들).
    """
    moved = 0
    buckets: dict[int, Study] = {}
    first_bucket_id: int | None = None

    def _bucket_for(src_study_id: int) -> Study:
        nonlocal first_bucket_id
        src = db.get(Study, src_study_id)
        hid = src.hospital_id if src else None
        key = hid or 0
        if key not in buckets:
            buckets[key] = bucket_study(db, hid)
        if first_bucket_id is None:
            first_bucket_id = buckets[key].id
        return buckets[key]

    for s in series:
        b = _bucket_for(s.study_id)
        moved += move_items(db, b, [s], [])
    for i in instances:
        src_series = db.get(Series, i.series_id)
        if src_series is None:
            continue
        b = _bucket_for(src_series.study_id)
        moved += move_items(db, b, [], [i])
    return moved, first_bucket_id, list(buckets.values())


# ════════════════════════════════ 환자 병합(Merge) / 원복(Unmerge) ════════════════════════════════
def _patient_snapshot(p: Patient) -> dict:
    """Unmerge 원복·표시용 환자 스냅샷 — patient_name 은 원본 필드 name_masked(_study_row 동일 소스)."""
    return {
        "patient_key": p.patient_key,
        "patient_name": p.name_masked,
        "sex": p.sex,
        "birth_date": p.birth_date,
    }


def merge_patients(
    db: Session, master_study_id: int, slave_study_id: int, username: str = ""
) -> tuple[PatientMerge, int]:
    """환자 병합 — Slave 환자의 전 검사를 Master 환자로 귀속(앱 DB 계층만, DICOM 태그 불변).

    이동된 검사에는 merged_from=병합 id 를 찍는다(Unmerge 원복 근거).
    가드 실패는 ValueError(→400), 대상 미존재는 LookupError(→404)로 전파하고,
    커밋은 호출부 몫(감사 로그와 원자 커밋). 반환: (병합 행, 이동 검사 수).
    """
    master_study = db.get(Study, master_study_id)
    slave_study = db.get(Study, slave_study_id)
    if master_study is None or slave_study is None:
        raise LookupError("검사를 찾을 수 없습니다")
    master_p = db.get(Patient, master_study.patient_id)
    slave_p = db.get(Patient, slave_study.patient_id)
    if master_p is None or slave_p is None:
        raise LookupError("환자를 찾을 수 없습니다")

    # ── 가드(§A): 동일 환자 / UNASSIGNED 버킷 / 활성 병합 충돌 ──
    if master_p.id == slave_p.id:
        raise ValueError("동일 환자입니다 — 서로 다른 환자의 검사를 선택하세요")
    if UNASSIGNED_PATIENT_KEY in (master_p.patient_key, slave_p.patient_key):
        raise ValueError("미배정(UNASSIGNED) 보관함 검사는 병합할 수 없습니다")
    active = db.execute(
        select(PatientMerge).where(PatientMerge.undone_at.is_(None))
    ).scalars().all()
    for m in active:
        # Slave 가 이미 활성 병합의 master/slave 면 차단(체인 병합 금지)
        if slave_p.id in (m.master_patient_id, m.slave_patient_id):
            raise ValueError(
                "대상(Slave) 환자가 이미 활성 병합에 포함되어 있습니다 — 먼저 Unmerge 하세요")
        # Master 가 다른 활성 병합의 slave 면 차단(master 가 여러 병합의 master 인 것은 허용)
        if master_p.id == m.slave_patient_id:
            raise ValueError(
                "Master 환자가 이미 다른 병합의 Slave 입니다 — 먼저 Unmerge 하세요")

    merge = PatientMerge(
        hospital_id=master_study.hospital_id,
        master_patient_id=master_p.id,
        slave_patient_id=slave_p.id,
        master_info=_patient_snapshot(master_p),
        slave_info=_patient_snapshot(slave_p),
        created_by=username,
    )
    db.add(merge)
    db.flush()  # merge.id 확보 — 이동 검사의 merged_from 에 필요
    # 병원 필터(테넌시): patient_key 는 전역 UNIQUE 라 두 병원이 같은 PatientID 로
    # 한 Patient 행을 공유할 수 있다 — API 병원 가드(선택 두 검사만 검사)를 우회해
    # 타 병원 검사가 함께 이동하지 않도록 병합 병원(master 검사 병원) 검사만 이동한다.
    hospital_cond = (
        Study.hospital_id == master_study.hospital_id
        if master_study.hospital_id is not None
        else Study.hospital_id.is_(None)
    )
    moved_ids: list[int] = []
    for st in db.execute(
        select(Study).where(Study.patient_id == slave_p.id, hospital_cond)
    ).scalars():
        st.patient_id = master_p.id
        st.merged_from = merge.id
        moved_ids.append(st.id)
    merge.moved_study_ids = moved_ids
    return merge, len(moved_ids)


def find_active_merge(
    db: Session, study_id: int | None = None, merge_id: int | None = None
) -> PatientMerge | None:
    """활성(undone_at IS NULL) 병합 해석 — merge_id 직접 또는 study_id 역해석.

    study_id 는 ① 이동된 검사(merged_from) ② master 환자의 검사(여러 병합이면
    최신 병합 우선) 순으로 찾는다. 못 찾으면 None(호출부가 404 처리).
    """
    if merge_id is not None:
        m = db.get(PatientMerge, merge_id)
        return m if m is not None and m.undone_at is None else None
    if study_id is None:
        return None
    st = db.get(Study, study_id)
    if st is None:
        return None
    if st.merged_from is not None:
        m = db.get(PatientMerge, st.merged_from)
        if m is not None and m.undone_at is None:
            return m
    return db.execute(
        select(PatientMerge)
        .where(
            PatientMerge.undone_at.is_(None),
            PatientMerge.master_patient_id == st.patient_id,
        )
        .order_by(PatientMerge.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def unmerge_patients(
    db: Session, study_id: int | None = None, merge_id: int | None = None
) -> tuple[PatientMerge, int]:
    """병합 원복(Unmerge) — moved_study_ids 를 slave 환자로 되돌리고 병합을 종료.

    활성 병합을 못 찾으면 LookupError(→404). 커밋은 호출부 몫.
    반환: (종료된 병합 행, 원복 검사 수).
    """
    merge = find_active_merge(db, study_id=study_id, merge_id=merge_id)
    if merge is None:
        raise LookupError("활성 병합을 찾을 수 없습니다")
    restored = 0
    for sid in merge.moved_study_ids or []:
        st = db.get(Study, sid)
        # merged_from 이 이 병합을 가리키는 검사만 원복(방어적 — 상태 불일치 시 건너뜀)
        if st is not None and st.merged_from == merge.id:
            st.patient_id = merge.slave_patient_id
            st.merged_from = None
            restored += 1
    merge.undone_at = _utcnow()
    return merge, restored


def list_merges(db: Session, hospital_id: int | None = None) -> list[dict]:
    """활성 병합 목록 — master/slave 환자 스냅샷 + 이동 검사 id(최신 우선)."""
    q = select(PatientMerge).where(PatientMerge.undone_at.is_(None))
    if hospital_id is not None:
        q = q.where(PatientMerge.hospital_id == hospital_id)
    items: list[dict] = []
    for m in db.execute(q.order_by(PatientMerge.id.desc())).scalars():
        items.append({
            "id": m.id,
            "hospital_id": m.hospital_id,
            "master": dict(m.master_info or {}),
            "slave": dict(m.slave_info or {}),
            "moved_study_ids": list(m.moved_study_ids or []),
            "created_by": m.created_by,
            "created_at": m.created_at.isoformat() if m.created_at else "",
        })
    return items


# ════════════════════════════════ 뷰어/일반 조회 오버레이 ════════════════════════════════
def _instance_rows_by_sop(db: Session, sop_uids: list[str]) -> dict[str, Instance]:
    out: dict[str, Instance] = {}
    for chunk in _chunks([u for u in sop_uids if u]):
        for r in db.execute(select(Instance).where(Instance.sop_uid.in_(chunk))).scalars():
            out[r.sop_uid] = r
    return out


def overlay_viewer_tree(db: Session, study: Study, tree: list[dict]) -> list[dict]:
    """물리(Orthanc) 트리에 앱 DB 상태 오버레이 — 삭제·이동(Out) 제외, 이동(In) 추가.

    DB 에 행이 없는 시리즈/이미지는 그대로 통과한다(Exam Control 을 쓴 적 없으면 무회귀).
    """
    own_series = list(db.execute(select(Series).where(Series.study_id == study.id)).scalars())
    phys_sops = [i.get("sop_uid", "") for s in tree for i in s.get("instances", [])]
    if not own_series and not phys_sops:
        return tree

    inst_by_sop = _instance_rows_by_sop(db, phys_sops)
    series_by_uid: dict[str, Series] = {}
    phys_uids = [s.get("series_uid", "") for s in tree if s.get("series_uid")]
    for chunk in _chunks(phys_uids):
        for r in db.execute(select(Series).where(Series.series_uid.in_(chunk))).scalars():
            series_by_uid[r.series_uid] = r

    out: list[dict] = []
    rendered_sops: set[str] = set()
    for s in tree:
        row = series_by_uid.get(s.get("series_uid", ""))
        if row is not None and (row.deleted_at is not None or row.study_id != study.id):
            continue  # 삭제되었거나 다른 검사로 이동된 시리즈 — 이 트리에서 제외
        insts = []
        for inst in s.get("instances", []):
            r = inst_by_sop.get(inst.get("sop_uid", ""))
            if r is not None:
                if r.deleted_at is not None:
                    continue  # 소프트 삭제 이미지 제외
                if row is None or r.series_id != row.id:
                    continue  # 다른 시리즈/검사로 재귀속 — 아래 DB측 항목으로 렌더
            insts.append(inst)
            if inst.get("sop_uid"):
                rendered_sops.add(inst["sop_uid"])
        out.append({**s, "instances": insts})

    # 이동(In): 이 검사 소속 시리즈의 인스턴스 중 물리 트리에 없는 것(타 검사에서 온 것)
    for row in own_series:
        if row.deleted_at is not None:
            continue
        extra = [
            i for i in db.execute(select(Instance).where(
                Instance.series_id == row.id, Instance.deleted_at.is_(None))).scalars()
            if i.sop_uid not in rendered_sops and i.orthanc_id
        ]
        if not extra:
            continue
        entry = next((o for o in out if o.get("series_uid") == row.series_uid), None)
        if entry is None:
            entry = {
                "series_uid": row.series_uid,
                "modality": row.modality,
                "series_desc": row.series_desc,
                "series_number": row.series_number or 0,
                "instances": [],
            }
            out.append(entry)
        for i in sorted(extra, key=lambda x: x.instance_number or 0):
            entry["instances"].append({
                "orthanc_id": i.orthanc_id,
                "sop_uid": i.sop_uid,
                "instance_number": i.instance_number or 0,
                "rows": i.rows or 0,
                "cols": i.cols or 0,
                # 기하 태그는 앱 DB 에 없다 — 프론트가 px 폴백 처리(기존 계약)
                "pixel_spacing": [],
                "position": [],
                "orientation": [],
            })
    out.sort(key=lambda x: x.get("series_number") or 0)
    return out


def filter_visible_instances(db: Session, study: Study, items: list[dict]) -> list[dict]:
    """인스턴스 평면 목록(키이미지 UI 등)에 소프트 삭제·재귀속 반영 + 이동(In) 추가."""
    inst_by_sop = _instance_rows_by_sop(db, [i.get("sop_uid", "") for i in items])
    own_series_ids = {sid for (sid,) in db.execute(
        select(Series.id).where(Series.study_id == study.id, Series.deleted_at.is_(None))
    ).all()}
    out: list[dict] = []
    seen: set[str] = set()
    for it in items:
        r = inst_by_sop.get(it.get("sop_uid", ""))
        if r is not None and (r.deleted_at is not None or r.series_id not in own_series_ids):
            continue
        out.append(it)
        if it.get("sop_uid"):
            seen.add(it["sop_uid"])
    for chunk in _chunks(sorted(own_series_ids)):
        for r in db.execute(select(Instance).where(
                Instance.series_id.in_(chunk), Instance.deleted_at.is_(None))).scalars():
            if r.sop_uid not in seen and r.orthanc_id:
                out.append({
                    "orthanc_id": r.orthanc_id,
                    "sop_uid": r.sop_uid,
                    "instance_number": r.instance_number or 0,
                })
                seen.add(r.sop_uid)
    out.sort(key=lambda x: x.get("instance_number") or 0)
    return out
