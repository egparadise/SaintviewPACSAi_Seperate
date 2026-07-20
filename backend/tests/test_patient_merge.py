"""환자 병합(Merge/Unmerge) — 귀속 이동·원복·가드 4종·권한·목록·감사 로그.

merged 플래그: B2 레인이 워크리스트 응답 필드로 구현한다 — 응답에 필드가 있으면
그것을 검증하고, 아직 없으면 Study.merged_from/PatientMerge 상태로 직접 판정해
레인 독립성을 유지한다(_merged_flag 헬퍼).
"""
from __future__ import annotations


# ════════════════════════════════ 헬퍼 (test_examctl 패턴 복제) ════════════════════════════════
def _mk_hospital(client, auth_headers, code, name="병합병원"):
    r = client.post("/api/admin/hospitals", headers=auth_headers,
                    json={"code": code, "name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mk_account(client, auth_headers, username, role, hid):
    r = client.post("/api/admin/accounts", headers=auth_headers, json={
        "username": username, "password": "testpass123", "role": role, "hospital_id": hid,
    })
    assert r.status_code == 200, r.text
    tok = client.post("/api/auth/login", json={"username": username, "password": "testpass123"})
    assert tok.status_code == 200, tok.text
    return {"Authorization": f"Bearer {tok.json()['token']}"}


def _seed_study(db, hid, tag, patient_key, patient_name="병합^환자"):
    """검사 시드 — 병합은 환자 귀속만 다루므로 트리는 최소(시리즈 없이)로 만든다."""
    from app.services.study_service import register_study

    study = register_study(
        db, study_uid=f"1.2.826.0.1.777.pm.{tag}", patient_key=patient_key,
        patient_name=patient_name, study_date="20260701", modality="CT",
        study_desc=f"Merge {tag}",
    )
    study.hospital_id = hid
    db.commit()
    return study.id


def _rows(client, headers, hid):
    """examctl 검사 목록(=search_worklist 행) — id → row 딕셔너리."""
    r = client.get(f"/api/examctl/studies?hid={hid}&limit=500", headers=headers)
    assert r.status_code == 200, r.text
    return {it["id"]: it for it in r.json()["items"]}


def _merged_flag(db, row):
    """merged 판정 — 응답 필드가 있으면 사용(B2), 없으면 DB 상태로 직접 판정(§A 정의).

    §A: merged = merged_from IS NOT NULL 또는 해당 환자가 활성 병합의 master.
    """
    if row.get("merged") is not None:
        return bool(row["merged"])
    from sqlalchemy import select

    from app.models import PatientMerge, Study

    db.expire_all()
    st = db.get(Study, row["id"])
    if st.merged_from is not None:
        return True
    masters = {pid for (pid,) in db.execute(
        select(PatientMerge.master_patient_id)
        .where(PatientMerge.undone_at.is_(None))).all()}
    return st.patient_id in masters


def _merge(client, headers, master_sid, slave_sid):
    return client.post("/api/examctl/merge", headers=headers,
                       json={"master_study_id": master_sid, "slave_study_id": slave_sid})


def _unmerge(client, headers, **body):
    return client.post("/api/examctl/unmerge", headers=headers, json=body)


# ════════════════════════════════ ①② 병합 → master 표시 + merged 플래그 ════════════════════════════════
def test_merge_moves_slave_studies_to_master(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "MRGH1", "병합병원1")
    master_sid = _seed_study(db, hid, "m1", "PMG.MA1", "마스터^환자")
    slave_sid = _seed_study(db, hid, "s1", "PMG.SL1", "슬레이브^환자")
    slave_sid2 = _seed_study(db, hid, "s1b", "PMG.SL1")  # slave 환자의 두 번째 검사

    r = _merge(client, auth_headers, master_sid, slave_sid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["merge_id"] > 0
    assert body["moved"] == 2  # slave 환자의 '전' 검사가 이동

    # ① slave 검사들이 워크리스트에서 master 환자 이름/key 로 표시 + merged=True
    rows = _rows(client, auth_headers, hid)
    for sid in (slave_sid, slave_sid2):
        assert rows[sid]["patient_key"] == "PMG.MA1"
        assert rows[sid]["patient_name"] == "마스터^환자"
        assert _merged_flag(db, rows[sid]) is True
    # ② master 쪽 검사도 merged=True (활성 병합의 master)
    assert rows[master_sid]["patient_key"] == "PMG.MA1"
    assert _merged_flag(db, rows[master_sid]) is True

    # study_detail 도 동일 귀속
    r = client.get(f"/api/studies/{slave_sid}", headers=auth_headers)
    assert r.status_code == 200 and r.json()["patient_key"] == "PMG.MA1"

    # DB 상태: 이동 검사에 merged_from 마킹
    from app.models import Study

    db.expire_all()
    assert db.get(Study, slave_sid).merged_from == body["merge_id"]
    assert db.get(Study, master_sid).merged_from is None  # master 검사는 이동된 것이 아님


# ════════════════════════════════ ③ Unmerge 원복 (3가지 해석 경로) ════════════════════════════════
def test_unmerge_restores_slave_patient(client, auth_headers, db):
    from app.models import Study

    hid = _mk_hospital(client, auth_headers, "MRGH2", "병합병원2")
    master_sid = _seed_study(db, hid, "m2", "PMG.MA2", "마스터2^환자")
    slave_sid = _seed_study(db, hid, "s2", "PMG.SL2", "슬레이브2^환자")

    # (a) 이동된 검사 study_id 로 unmerge
    assert _merge(client, auth_headers, master_sid, slave_sid).status_code == 200
    r = _unmerge(client, auth_headers, study_id=slave_sid)
    assert r.status_code == 200, r.text
    assert r.json() == {"restored": 1}

    rows = _rows(client, auth_headers, hid)
    assert rows[slave_sid]["patient_key"] == "PMG.SL2"
    assert rows[slave_sid]["patient_name"] == "슬레이브2^환자"
    assert _merged_flag(db, rows[slave_sid]) is False
    assert _merged_flag(db, rows[master_sid]) is False
    db.expire_all()
    assert db.get(Study, slave_sid).merged_from is None

    # 활성 병합이 없으면 404
    assert _unmerge(client, auth_headers, study_id=slave_sid).status_code == 404

    # (b) master 환자의 검사 study_id 로도 병합을 찾는다
    assert _merge(client, auth_headers, master_sid, slave_sid).status_code == 200
    r = _unmerge(client, auth_headers, study_id=master_sid)
    assert r.status_code == 200 and r.json()["restored"] == 1
    assert _rows(client, auth_headers, hid)[slave_sid]["patient_key"] == "PMG.SL2"

    # (c) merge_id 직접 지정
    mid = _merge(client, auth_headers, master_sid, slave_sid).json()["merge_id"]
    r = _unmerge(client, auth_headers, merge_id=mid)
    assert r.status_code == 200 and r.json()["restored"] == 1
    assert _rows(client, auth_headers, hid)[slave_sid]["patient_key"] == "PMG.SL2"

    # 빈 body 400 / 병합 무관 검사 404 / 미존재 검사로 merge 404
    assert _unmerge(client, auth_headers).status_code == 400
    assert _unmerge(client, auth_headers, study_id=master_sid).status_code == 404
    assert _merge(client, auth_headers, master_sid, 99999999).status_code == 404


# ════════════════════════════════ ④ 가드 — 동일환자·UNASSIGNED·활성병합 충돌·병원 불일치 ════════════════════════════════
def test_merge_guards_return_400(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "MRGH3", "병합병원3")
    hid2 = _mk_hospital(client, auth_headers, "MRGH3B", "병합병원3B")
    a_sid = _seed_study(db, hid, "g.a", "PMG.GA", "가드A^환자")
    a_sid2 = _seed_study(db, hid, "g.a2", "PMG.GA")
    b_sid = _seed_study(db, hid, "g.b", "PMG.GB", "가드B^환자")
    c_sid = _seed_study(db, hid, "g.c", "PMG.GC", "가드C^환자")
    d_sid = _seed_study(db, hid2, "g.d", "PMG.GD", "가드D^환자")

    # 가드1: 동일 환자
    r = _merge(client, auth_headers, a_sid, a_sid2)
    assert r.status_code == 400 and "동일 환자" in r.json()["detail"]

    # 가드2: UNASSIGNED 버킷 (양방향)
    from app.services.examctl_service import bucket_study

    bucket = bucket_study(db, hid)
    db.commit()
    assert _merge(client, auth_headers, a_sid, bucket.id).status_code == 400
    assert _merge(client, auth_headers, bucket.id, a_sid).status_code == 400

    # 기준 병합: A(master) ← B(slave)
    assert _merge(client, auth_headers, a_sid, b_sid).status_code == 200
    # 병합 후 slave 환자(B)로 새 검사가 들어온 상황(환자 행은 남아 있다)
    nb_sid = _seed_study(db, hid, "g.nb", "PMG.GB")

    # 가드3: slave 가 활성 병합의 master(A) 또는 slave(B)
    assert _merge(client, auth_headers, c_sid, a_sid).status_code == 400
    assert _merge(client, auth_headers, c_sid, nb_sid).status_code == 400
    # 가드4: master 가 활성 병합의 slave(B)
    assert _merge(client, auth_headers, nb_sid, c_sid).status_code == 400

    # 허용: master(A)가 여러 병합의 master 인 것은 가능 — A ← C
    r = _merge(client, auth_headers, a_sid, c_sid)
    assert r.status_code == 200, r.text
    assert _unmerge(client, auth_headers, merge_id=r.json()["merge_id"]).status_code == 200

    # 가드5(서버): 두 검사 hospital_id 불일치 — 시스템 관리자도 400
    r = _merge(client, auth_headers, d_sid, c_sid)
    assert r.status_code == 400 and "병원" in r.json()["detail"]


# ════════════════════════════════ ⑤ 권한·병원 접근 가드 ════════════════════════════════
def test_merge_permission_and_hospital_access(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "MRGH4", "병합병원4")
    hid_other = _mk_hospital(client, auth_headers, "MRGH4B", "병합병원4B")
    m_sid = _seed_study(db, hid, "p.m", "PMG.PM", "권한M^환자")
    s_sid = _seed_study(db, hid, "p.s", "PMG.PS", "권한S^환자")

    # staff: study.match/unmatch 권한 없음 → 403
    staff_h = _mk_account(client, auth_headers, "mrg_staff1", "staff", hid)
    assert _merge(client, staff_h, m_sid, s_sid).status_code == 403
    assert _unmerge(client, staff_h, study_id=s_sid).status_code == 403

    # 타 병원 소속 technologist: 권한은 있으나 병원 접근 가드 403
    tech_other = _mk_account(client, auth_headers, "mrg_tech_o1", "technologist", hid_other)
    assert _merge(client, tech_other, m_sid, s_sid).status_code == 403

    # 자기 병원 technologist: merge/unmerge 정상 동작
    tech_h = _mk_account(client, auth_headers, "mrg_tech1", "technologist", hid)
    r = _merge(client, tech_h, m_sid, s_sid)
    assert r.status_code == 200, r.text
    # 타 병원 소속은 남의 병합을 unmerge 할 수 없다
    assert _unmerge(client, tech_other, merge_id=r.json()["merge_id"]).status_code == 403
    assert _unmerge(client, tech_h, study_id=s_sid).status_code == 200


# ════════════════ ⑤b 병원 스코프 — 전역 patient_key 공유 시 타 병원 검사 미이동 ════════════════
def test_merge_scoped_to_hospital_shared_patient_key(client, auth_headers, db):
    """patients.patient_key 는 전역 UNIQUE — 두 병원이 같은 PatientID 로 한 환자 행을
    공유해도 병합은 병합 병원(master 검사 병원) 검사만 이동한다(타 병원 오귀속 금지)."""
    from app.models import Patient, Study

    hid1 = _mk_hospital(client, auth_headers, "MRGH7", "병합병원7")
    hid2 = _mk_hospital(client, auth_headers, "MRGH7B", "병합병원7B")
    master_sid = _seed_study(db, hid1, "x.m", "PMG.XM", "교차M^환자")
    slave_h1 = _seed_study(db, hid1, "x.s1", "PMG.XS", "교차S^환자")
    slave_h2 = _seed_study(db, hid2, "x.s2", "PMG.XS")  # 같은 환자키 — 타 병원 검사

    r = _merge(client, auth_headers, master_sid, slave_h1)
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == 1, "병합 병원(H1) 검사만 이동해야 한다"

    db.expire_all()
    st2 = db.get(Study, slave_h2)
    assert st2.merged_from is None, "타 병원(H2) 검사에 merged_from 이 찍히면 안 된다"
    assert db.get(Patient, st2.patient_id).patient_key == "PMG.XS", \
        "타 병원 검사는 원래 환자 소속을 유지해야 한다"
    # H2 워크리스트에도 원 환자로 표시
    assert _rows(client, auth_headers, hid2)[slave_h2]["patient_key"] == "PMG.XS"

    # unmerge — H1 검사만 원복(타 병원 검사는 애초에 불변)
    r = _unmerge(client, auth_headers, study_id=slave_h1)
    assert r.status_code == 200 and r.json()["restored"] == 1


# ═══════════ ⑤c 활성 병합 중 slave 앞 신규 검사 — master 자동 귀속(분열 방지) ═══════════
def test_new_slave_study_during_active_merge_follows_master(client, auth_headers, db):
    from app.models import Patient, PatientMerge, Study

    master_sid = _seed_study(db, None, "n.m", "PMG.NM", "신규M^환자")
    slave_sid = _seed_study(db, None, "n.s", "PMG.NS", "신규S^환자")
    r = _merge(client, auth_headers, master_sid, slave_sid)
    assert r.status_code == 200, r.text
    mid = r.json()["merge_id"]

    # 활성 병합 중 slave patient_key 로 신규 검사 수신 → master 로 자동 귀속 + 기록
    new_sid = _seed_study(db, None, "n.new", "PMG.NS")
    db.expire_all()
    st = db.get(Study, new_sid)
    assert st.patient_id == db.get(Study, master_sid).patient_id
    assert st.merged_from == mid
    assert new_sid in db.get(PatientMerge, mid).moved_study_ids

    # unmerge — 신규 검사도 함께 slave 환자로 원복
    r = _unmerge(client, auth_headers, merge_id=mid)
    assert r.status_code == 200 and r.json()["restored"] == 2
    db.expire_all()
    st = db.get(Study, new_sid)
    assert st.merged_from is None
    assert db.get(Patient, st.patient_id).patient_key == "PMG.NS"


# ════════════════════════════════ ⑥⑦ 병합 목록 + 감사 로그 ════════════════════════════════
def test_merges_list_and_audit_log(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "MRGH5", "병합병원5")
    hid_other = _mk_hospital(client, auth_headers, "MRGH5B", "병합병원5B")
    m_sid = _seed_study(db, hid, "l.m", "PMG.LM", "목록M^환자")
    s_sid = _seed_study(db, hid, "l.s", "PMG.LS", "목록S^환자")

    mid = _merge(client, auth_headers, m_sid, s_sid).json()["merge_id"]

    # ⑥ 활성 병합 목록 — 환자 스냅샷 + 이동 검사 id + 생성 시각
    r = client.get(f"/api/examctl/merges?hid={hid}", headers=auth_headers)
    assert r.status_code == 200, r.text
    item = next(it for it in r.json()["items"] if it["id"] == mid)
    assert item["master"]["patient_key"] == "PMG.LM"
    assert item["master"]["patient_name"] == "목록M^환자"
    assert item["slave"]["patient_key"] == "PMG.LS"
    assert item["slave"]["patient_name"] == "목록S^환자"
    assert item["moved_study_ids"] == [s_sid]
    assert item["created_at"]

    # 병원 스코프: 다른 병원으로 조회하면 미노출
    r = client.get(f"/api/examctl/merges?hid={hid_other}", headers=auth_headers)
    assert all(it["id"] != mid for it in r.json()["items"])

    # Unmerge 후 활성 목록에서 사라진다
    assert _unmerge(client, auth_headers, merge_id=mid).status_code == 200
    r = client.get(f"/api/examctl/merges?hid={hid}", headers=auth_headers)
    assert all(it["id"] != mid for it in r.json()["items"])

    # ⑦ 감사 로그 — examctl_merge/examctl_unmerge 적재 + merge_id 기록
    from sqlalchemy import select

    from app.models import AuditLog

    logs = db.execute(
        select(AuditLog).where(AuditLog.action.in_(["examctl_merge", "examctl_unmerge"]))
    ).scalars().all()
    actions = {a.action for a in logs}
    assert {"examctl_merge", "examctl_unmerge"} <= actions
    assert any(a.detail.get("merge_id") == mid for a in logs if a.action == "examctl_merge")
    assert any(a.detail.get("merge_id") == mid for a in logs if a.action == "examctl_unmerge")
