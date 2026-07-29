"""Compare 기준 — '환자 기준' 과 '판독의사 기준'.

비교할 과거 검사를 **어느 모집단에서 고르느냐**가 두 가지다.

  · **환자 기준**(항상 기본): 같은 환자의 과거 검사.
    "이 환자가 전에 어땠나" — 판독에서 비교의 대부분은 여기다.
  · **판독의사 기준**: **내가(로그인한 판독의) 판독했던** 과거 검사 전체.
    환자가 달라도 된다. 예) 지금 Chest CT 를 보는데 Modality·Bodypart 를 모두 체크하면
    내가 판독한 Chest CT 들이 나오고, Bodypart 만 체크하면 Chest X-ray·Chest MRI 까지 나온다.
    소견을 어떻게 썼는지 되짚는 용도다.

■ 왜 '판독의사 기준' 이 안전한가
모집단이 **그 의사가 이미 판독하며 본 검사**뿐이다. 새로 열어 주는 자료가 아니라
자기가 봤던 것을 다시 부르는 것이라, 다른 환자가 섞여도 새로운 노출이 아니다.
(그래서 '같은 병원의 확정 판독 전부' 같은 넓은 모집단은 쓰지 않는다 — 그건 본 적 없는
남의 환자를 열어 주는 것이라 성격이 전혀 다르다.)
다만 소속 병원(hid)이 정해진 사용자는 그 병원 것으로 한 번 더 좁힌다 — 여러 병원에서
판독하는 의사가 A 병원에 로그인한 채 B 병원 검사를 보게 되는 것을 막는다.

■ 좁히는 축 (둘 다 선택)
  · Modality  체크 → 지금 검사와 같은 모달리티만
  · Bodypart  체크 → 지금 검사와 같은 부위만
  · 아무것도 체크하지 않으면 모집단 전체(환자 기준이면 그 환자의 과거 검사 모두)

■ 기간
  prev  바로 직전 1건 · 1y/3y/5y  그 기간 이내 · all  전체
  기준점은 **지금 보는 검사의 검사일**이다(오늘이 아니다). 과거 검사를 되짚어 판독할 때
  '오늘로부터 1년' 은 의미가 없다.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

MAX_RESULTS = 50
PERIODS = ("prev", "1y", "3y", "5y", "all")
_YEARS = {"1y": 1, "3y": 3, "5y": 5}


def _norm(s: str | None) -> str:
    return (s or "").strip().upper()


def _cutoff(anchor: str, period: str) -> str:
    """기간 하한(YYYYMMDD 문자열). 'prev'·'all' 은 하한이 없다.

    study_date 가 'YYYYMMDD' 고정폭이라 문자열 비교로 날짜 비교가 그대로 성립한다.
    """
    years = _YEARS.get(period)
    if not years:
        return ""
    try:
        a = date(int(anchor[0:4]), int(anchor[4:6]), int(anchor[6:8]))
    except (ValueError, IndexError, TypeError):
        a = date.today()
    # 윤년에 2월 29일이 걸려도 죽지 않게 365일 단위로 뺀다(경계 하루 차이는 판독에 무해)
    return (a - timedelta(days=365 * years)).strftime("%Y%m%d")


def _shape(s, p) -> dict:
    return {
        "id": s.id,
        "study_uid": s.study_uid,
        "study_date": s.study_date,
        "modality": s.modality,
        "study_desc": s.study_desc,
        "status": s.status,
        "body_part": s.body_part,
        "patient_name": p.name_masked if p else "",
        "patient_key": p.patient_key if p else "",
    }


def candidates(db: Session, study_id: int, user: dict, *, basis: str = "patient",
               by_modality: bool = False, by_body_part: bool = False,
               period: str = "all", limit: int = MAX_RESULTS) -> list[dict]:
    """Compare 후보 목록. basis='patient'(기본) | 'reader'."""
    from app.models import Patient, Report, Study

    st = db.get(Study, study_id)
    if not st:
        return []
    if user.get("hid") and st.hospital_id and st.hospital_id != user["hid"]:
        return []
    if period not in PERIODS:
        period = "all"

    q = (select(Study, Patient)
         .join(Patient, Patient.id == Study.patient_id)
         .where(Study.id != st.id, Study.merged_from.is_(None)))

    if basis == "reader":
        me = str(user.get("sub") or "")
        if not me:
            return []
        # 내가 판독한 검사 = 내가 검토(확정)했거나 내가 직접 작성한 판독이 붙은 검사.
        # AI 초안(created_by='ai')만 있고 사람이 손대지 않은 검사는 '내가 판독한' 것이 아니다.
        q = q.join(Report, Report.study_id == Study.id).where(
            or_(Report.reviewed_by == me, Report.created_by == me))
        # 소속 병원이 정해져 있으면 그 병원으로 한 번 더 좁힌다(위 주석 참조)
        if user.get("hid"):
            q = q.where(Study.hospital_id == user["hid"])
    else:
        q = q.where(Study.patient_id == st.patient_id)
        # 같은 환자라도 원 검사와 같은 병원 것만 — 교차 병원 메타데이터 누출 차단
        # (study_service.related_exams 와 같은 규칙)
        q = q.where(Study.hospital_id == st.hospital_id)

    if by_modality:
        mod = _norm(st.modality)
        if not mod:
            return []      # 지금 검사의 모달리티를 모르면 '같은 모달리티'를 말할 수 없다
        q = q.where(Study.modality == st.modality)
    if by_body_part:
        part = _norm(st.body_part)
        if not part:
            return []      # 부위가 비어 있으면 아무거나 보여 주지 않는다
        q = q.where(Study.body_part == st.body_part)

    lo = _cutoff(st.study_date or "", period)
    if lo:
        q = q.where(Study.study_date >= lo)
    # 지금 검사보다 **과거**만. 같은 날 검사는 포함한다(오전/오후 촬영 비교가 흔하다).
    if st.study_date:
        q = q.where(Study.study_date <= st.study_date)

    q = q.order_by(Study.study_date.desc(), Study.id.desc())
    take = 1 if period == "prev" else max(1, limit)
    # reader 기준은 한 검사에 판독 버전이 여러 개면 행이 중복된다 → 넉넉히 뽑아 중복 제거
    rows = db.execute(q.limit(take * 8 if basis == "reader" else take)).all()

    out: list[dict] = []
    seen: set[int] = set()
    for s, p in rows:
        if s.id in seen:
            continue
        seen.add(s.id)
        out.append(_shape(s, p))
        if len(out) >= take:
            break
    return out


def live_candidates(db: Session, vid: int, user: dict, *, basis: str = "patient",
                    by_modality: bool = False, by_body_part: bool = False,
                    period: str = "all", limit: int = MAX_RESULTS) -> list[dict]:
    """Live(vid) Compare 후보.

    A 의 `/api/study/` 가 받는 필터는 patient_id·patient_name·study_modality·
    study_datetime_start/end·study_search 뿐이다. **부위 필터도, 판독의사 필터도 없다.**
    그래서 서버에서 좁힐 수 있는 것(환자·모달리티·기간)만 A 에 넘기고 나머지는 여기서 거른다.
    넉넉히 받아 거르므로 결과가 limit 에 못 미칠 수 있다 — 그 한계를 호출부가 알 수 있도록
    빈 목록도 그대로 돌려준다(조용히 다른 조건으로 바꿔치지 않는다).
    """
    import json

    from app.services import webpacs_live as live

    row = live.live_detail(db, vid, user, with_related=False)
    if period not in PERIODS:
        period = "all"
    anchor = str(row.get("study_date") or "")
    mod, part = _norm(row.get("modality")), _norm(row.get("body_part"))
    if by_modality and not mod:
        return []
    if by_body_part and not part:
        return []

    q: dict[str, str] = {
        "limit": str(max(1, limit) * 8),
        "order_json": json.dumps([{"key": "study_idx", "order": "desc"}]),
    }
    pidx = row.get("patient_idx")
    if basis == "patient":
        pid = str(row.get("patient_key") or "")
        if not pid:
            return []
        q["patient_id"] = pid
        if pidx not in (None, "", 0):
            q["patient_idx"] = str(pidx)
    if by_modality:
        q["study_modality"] = mod
    lo = _cutoff(anchor, period)
    if lo:
        q["study_datetime_start"] = lo
    if anchor:
        q["study_datetime_end"] = anchor

    client = live.live_client(db, user)
    try:
        rows = client.list_studies(q)
    except Exception:  # noqa: BLE001 — 후보 조회 실패가 판독 화면을 막지 않는다
        return []

    # 'A 에서 내 계정으로 판독한 것' 판정 — A 는 검사 행에 doctor_user_name 을 준다.
    # per-user A 세션이 있어야 내 A 계정명을 안다. 없으면(서비스 계정 폴백) 판독의사 기준을
    # 성립시킬 수 없으므로 **빈 목록**을 돌려준다 — 남의 판독을 내 것인 양 보여주면 안 된다.
    me_a = ""
    if basis == "reader":
        from app.services import webpacs_session

        sess = webpacs_session.get(user.get("sid", "")) or {}
        # 세션 키는 a_user_name(A 표시 이름)·a_user_id. A 검사 행의 doctor_user_name 과
        # 짝이 맞는 것은 표시 이름 쪽이다.
        me_a = str(sess.get("a_user_name") or "")
        if not me_a:
            return []

    out: list[dict] = []
    take = 1 if period == "prev" else max(1, limit)
    for o in rows:
        try:
            rid = live.to_vid(int(o.get("study_idx")))
        except (TypeError, ValueError):
            continue
        if rid == vid:
            continue
        # ★ 환자 기준인데 다른 환자가 섞이면 판독 사고다. A 의 patient_id 조회가 부분일치로
        #   도는 지점이 있어(짧은 차트번호가 긴 번호에 포함된다) 여기서 정확일치로 다시 거른다.
        #   실제 사고: '7139' 의 과거검사에 '10171393' 환자의 검사가 섞여 나왔다.
        if basis == "patient" and not live.same_patient(o, str(row.get("patient_key") or ""), pidx):
            continue
        if by_body_part and _norm(str(o.get("study_body_part") or "")) != part:
            continue
        if basis == "reader":
            doc = str(o.get("doctor_user_name") or "")
            if not me_a or doc != me_a:
                continue
        od, _ = live._split_datetime(str(o.get("study_datetime") or ""))   # noqa: SLF001
        status, _, _ = live._map_status(str(o.get("study_status") or ""))  # noqa: SLF001
        out.append({
            "id": rid,
            "study_uid": str(o.get("study_instance_uid") or ""),
            "study_date": od,
            "modality": str(o.get("study_modality") or ""),
            "study_desc": str(o.get("study_description") or ""),
            "status": status,
            "body_part": str(o.get("study_body_part") or ""),
            "patient_name": str(o.get("patient_name") or ""),
            "patient_key": str(o.get("patient_id") or ""),
        })
        if len(out) >= take:
            break
    return out
