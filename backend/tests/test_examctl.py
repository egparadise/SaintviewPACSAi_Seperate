"""Exam Control — 소프트 삭제/복구 왕복 · 시리즈 캐스케이드 · Unassign 버킷 · Assign 분할 · 권한/병원 가드."""
from __future__ import annotations


# ════════════════════════════════ 헬퍼 ════════════════════════════════
def _mk_hospital(client, auth_headers, code, name="병원"):
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


def _seed_study(db, hid, tag, patient_key="EXC01", n_series=2, n_inst=2):
    """검사 + 앱 DB 트리(Series/Instance) 시드 — Orthanc 없이 examctl 흐름 검증용."""
    from app.models import Instance, Series
    from app.services.study_service import register_study

    study = register_study(
        db, study_uid=f"1.2.826.0.1.777.{tag}", patient_key=patient_key,
        patient_name="검사^환자", study_date="20260701", modality="CT",
        study_desc=f"ExamCtl {tag}",
    )
    study.hospital_id = hid
    for si in range(1, n_series + 1):
        s = Series(study_id=study.id, series_uid=f"1.2.826.0.1.777.{tag}.{si}",
                   modality="CT", series_desc=f"S{si}", series_number=si,
                   instance_count=n_inst)
        db.add(s)
        db.flush()
        for ii in range(1, n_inst + 1):
            db.add(Instance(series_id=s.id, sop_uid=f"1.2.826.0.1.777.{tag}.{si}.{ii}",
                            instance_number=ii, rows=512, cols=512,
                            orthanc_id=f"oid-{tag}-{si}-{ii}"))
    study.series_count = n_series
    study.instance_count = n_series * n_inst
    db.commit()
    return study.id


def _tree(client, headers, study_id):
    r = client.get(f"/api/examctl/studies/{study_id}/tree", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _series(tree, uid):
    return next(s for s in tree["series"] if s["series_uid"] == uid)


# ════════════════════════════════ 삭제 → 제외 → 복구 왕복 ════════════════════════════════
def test_image_delete_restore_roundtrip(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "EXH1", "QC병원1")
    sid = _seed_study(db, hid, "del1")
    sop = "1.2.826.0.1.777.del1.1.1"

    # 목록/트리 노출 확인
    r = client.get(f"/api/examctl/studies?hid={hid}", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert any(it["id"] == sid for it in r.json()["items"])
    tree = _tree(client, auth_headers, sid)
    assert len(tree["series"]) == 2
    assert all(not s["deleted"] for s in tree["series"])
    inst = _series(tree, "1.2.826.0.1.777.del1.1")["instances"][0]
    assert inst["sop_uid"] == sop and inst["rows"] == 512 and "preview" in inst["preview_url"]

    # 이미지 1장 소프트 삭제
    r = client.post("/api/examctl/delete", headers=auth_headers, json={"sop_uids": [sop]})
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted_series": 0, "deleted_images": 1}

    # examctl 트리: deleted 플래그로 계속 표시
    tree = _tree(client, auth_headers, sid)
    s1 = _series(tree, "1.2.826.0.1.777.del1.1")
    assert s1["deleted"] is False
    assert [i["deleted"] for i in s1["instances"]] == [True, False]
    # 검사 카운트 동기(4→3)
    r = client.get(f"/api/studies/{sid}", headers=auth_headers)
    assert r.json()["instance_count"] == 3

    # 휴지통에 이미지 단위로 노출
    r = client.get(f"/api/examctl/trash?hid={hid}", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert any(t["kind"] == "image" and t["sop_uid"] == sop for t in r.json()["items"])

    # 복구(Recovery) → 원상 복귀
    r = client.post("/api/examctl/restore", headers=auth_headers, json={"sop_uids": [sop]})
    assert r.status_code == 200, r.text
    assert r.json()["restored_images"] == 1
    tree = _tree(client, auth_headers, sid)
    assert all(not i["deleted"] for i in _series(tree, "1.2.826.0.1.777.del1.1")["instances"])
    r = client.get(f"/api/studies/{sid}", headers=auth_headers)
    assert r.json()["instance_count"] == 4
    r = client.get(f"/api/examctl/trash?hid={hid}", headers=auth_headers)
    assert not any(t.get("sop_uid") == sop for t in r.json()["items"])

    # 빈 선택 400 / 미존재 404
    assert client.post("/api/examctl/delete", headers=auth_headers, json={}).status_code == 400
    assert client.post("/api/examctl/delete", headers=auth_headers,
                       json={"sop_uids": ["9.9.9"]}).status_code == 404


def test_series_delete_cascades_children(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "EXH2", "QC병원2")
    sid = _seed_study(db, hid, "del2")
    suid = "1.2.826.0.1.777.del2.2"

    r = client.post("/api/examctl/delete", headers=auth_headers, json={"series_uids": [suid]})
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted_series": 1, "deleted_images": 2}

    # examctl 트리: 시리즈+하위 이미지 모두 deleted
    tree = _tree(client, auth_headers, sid)
    s2 = _series(tree, suid)
    assert s2["deleted"] is True and all(i["deleted"] for i in s2["instances"])

    # 일반 조회(study_detail)에서는 삭제 시리즈 제외
    r = client.get(f"/api/studies/{sid}", headers=auth_headers)
    body = r.json()
    assert suid not in [s["series_uid"] for s in body["series"]]
    assert body["series_count"] == 1 and body["instance_count"] == 2

    # 휴지통: 시리즈 단위 엔트리(이미지 수 포함)
    r = client.get(f"/api/examctl/trash?hid={hid}", headers=auth_headers)
    entry = next(t for t in r.json()["items"] if t["kind"] == "series" and t["series_uid"] == suid)
    assert entry["image_count"] == 2 and entry["study_id"] == sid

    # 시리즈 복구 → 하위 이미지 포함 원복
    r = client.post("/api/examctl/restore", headers=auth_headers, json={"series_uids": [suid]})
    assert r.json() == {"restored_series": 1, "restored_images": 2}
    r = client.get(f"/api/studies/{sid}", headers=auth_headers)
    assert r.json()["series_count"] == 2 and r.json()["instance_count"] == 4


# ════════════════════════════════ 뷰어 트리 오버레이(제외) ════════════════════════════════
def test_viewer_tree_overlay_excludes_deleted_and_moved(client, auth_headers, db):
    """물리(Orthanc) 트리 오버레이 — 삭제/이동(Out) 제외, 이동(In) 추가 (서비스 계층 검증)."""
    from app.models import Study
    from app.services.examctl_service import overlay_viewer_tree, soft_delete, load_selection

    hid = _mk_hospital(client, auth_headers, "EXH3", "QC병원3")
    sid_a = _seed_study(db, hid, "ovl.a")
    sid_b = _seed_study(db, hid, "ovl.b", patient_key="EXC02")

    def _phys(tag):
        return [
            {"series_uid": f"1.2.826.0.1.777.{tag}.{si}", "modality": "CT",
             "series_desc": f"S{si}", "series_number": si,
             "instances": [
                 {"orthanc_id": f"oid-{tag}-{si}-{ii}", "sop_uid": f"1.2.826.0.1.777.{tag}.{si}.{ii}",
                  "instance_number": ii, "rows": 512, "cols": 512,
                  "pixel_spacing": [], "position": [], "orientation": []}
                 for ii in (1, 2)
             ]}
            for si in (1, 2)
        ]

    study_a = db.get(Study, sid_a)
    # DB 행이 있어도 삭제/이동이 없으면 물리 트리 그대로(무회귀)
    out = overlay_viewer_tree(db, study_a, _phys("ovl.a"))
    assert [s["series_uid"] for s in out] == [f"1.2.826.0.1.777.ovl.a.{i}" for i in (1, 2)]
    assert sum(len(s["instances"]) for s in out) == 4

    # 삭제: 시리즈2 전체 + 시리즈1의 이미지 1장 → 뷰어 트리에서 제외
    series, instances = load_selection(
        db, ["1.2.826.0.1.777.ovl.a.2"], ["1.2.826.0.1.777.ovl.a.1.1"])
    soft_delete(db, series, instances)
    db.commit()
    out = overlay_viewer_tree(db, study_a, _phys("ovl.a"))
    assert [s["series_uid"] for s in out] == ["1.2.826.0.1.777.ovl.a.1"]
    assert [i["sop_uid"] for i in out[0]["instances"]] == ["1.2.826.0.1.777.ovl.a.1.2"]

    # 이동(Out→In): A의 시리즈1을 B로 Assign → A 트리에서 빠지고 B 트리에 DB측으로 추가
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid_b,
                          "series_uids": ["1.2.826.0.1.777.ovl.a.1"]})
    assert r.status_code == 200, r.text
    db.expire_all()
    out_a = overlay_viewer_tree(db, study_a, _phys("ovl.a"))
    assert out_a == [] or all(s["series_uid"] != "1.2.826.0.1.777.ovl.a.1" for s in out_a)
    study_b = db.get(Study, sid_b)
    out_b = overlay_viewer_tree(db, study_b, _phys("ovl.b"))
    moved_in = next(s for s in out_b if s["series_uid"] == "1.2.826.0.1.777.ovl.a.1")
    # 삭제된 1.1은 제외되고 1.2만 이동 표시, 프리뷰용 orthanc_id 유지
    assert [i["sop_uid"] for i in moved_in["instances"]] == ["1.2.826.0.1.777.ovl.a.1.2"]
    assert moved_in["instances"][0]["orthanc_id"] == "oid-ovl.a-1-2"


# ════════════════════════════════ Unassign — 버킷 생성·이동 ════════════════════════════════
def test_unassign_creates_bucket_and_moves(client, auth_headers, db):
    from app.models import Patient, Study
    from sqlalchemy import select

    hid = _mk_hospital(client, auth_headers, "EXH4", "QC병원4")
    sid = _seed_study(db, hid, "una1")
    suid = "1.2.826.0.1.777.una1.1"

    r = client.post("/api/examctl/unassign", headers=auth_headers, json={"series_uids": [suid]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["moved"] == 1 and body["bucket_study_id"]

    # 버킷 검사: patient_key=UNASSIGNED, 병원 귀속, 설명 '미배정 보관함'
    bucket = db.get(Study, body["bucket_study_id"])
    patient = db.get(Patient, bucket.patient_id)
    assert patient.patient_key == "UNASSIGNED"
    assert bucket.hospital_id == hid and bucket.study_desc == "미배정 보관함"

    # 원 검사 트리에서 빠지고 버킷 트리에 나타남 + 카운트 동기
    tree = _tree(client, auth_headers, sid)
    assert suid not in [s["series_uid"] for s in tree["series"]]
    btree = _tree(client, auth_headers, bucket.id)
    assert suid in [s["series_uid"] for s in btree["series"]]
    db.expire_all()
    src = db.get(Study, sid)
    assert src.series_count == 1 and src.instance_count == 2
    assert bucket.series_count == 1 and bucket.instance_count == 2

    # 같은 병원 재-unassign 은 같은 버킷 재사용 (sop 단위 → 분할 시리즈)
    r = client.post("/api/examctl/unassign", headers=auth_headers,
                    json={"sop_uids": ["1.2.826.0.1.777.una1.2.1"]})
    assert r.status_code == 200, r.text
    assert r.json()["bucket_study_id"] == bucket.id

    # 버킷에서 원 검사로 재배정(Assign) — 원 UID 시리즈는 그대로 복귀
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid, "series_uids": [suid]})
    assert r.status_code == 200 and r.json()["moved"] == 1
    tree = _tree(client, auth_headers, sid)
    assert suid in [s["series_uid"] for s in tree["series"]]


# ════════════════════════════════ Assign — 이동·시리즈 분할 ════════════════════════════════
def test_assign_sop_level_splits_series(client, auth_headers, db):
    hid = _mk_hospital(client, auth_headers, "EXH5", "QC병원5")
    sid_a = _seed_study(db, hid, "asg.a")
    sid_b = _seed_study(db, hid, "asg.b", patient_key="EXC03")
    sop = "1.2.826.0.1.777.asg.a.1.1"

    # 대상 검사에 소속 시리즈가 없으므로 분할 행 생성
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid_b, "sop_uids": [sop]})
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == 1

    tree_b = _tree(client, auth_headers, sid_b)
    split = next(s for s in tree_b["series"] if s["series_uid"].startswith("1.2.826.0.1.777.asg.a.1"))
    assert [i["sop_uid"] for i in split["instances"]] == [sop]
    assert split["series_desc"] == "S1"  # 원 시리즈 메타 복사
    # 원 검사에서는 해당 이미지만 빠짐
    tree_a = _tree(client, auth_headers, sid_a)
    s1 = _series(tree_a, "1.2.826.0.1.777.asg.a.1")
    assert [i["sop_uid"] for i in s1["instances"]] == ["1.2.826.0.1.777.asg.a.1.2"]

    # 두 번째 sop 이동은 기존 분할 시리즈 재사용(분할 행 증식 없음)
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid_b, "sop_uids": ["1.2.826.0.1.777.asg.a.1.2"]})
    assert r.status_code == 200 and r.json()["moved"] == 1
    tree_b = _tree(client, auth_headers, sid_b)
    splits = [s for s in tree_b["series"] if s["series_uid"].startswith("1.2.826.0.1.777.asg.a.1")]
    assert len(splits) == 1 and len(splits[0]["instances"]) == 2

    # 카운트 동기: A(빈 시리즈1 잔존 → 2시리즈/2장), B(분할 포함 3시리즈/6장)
    db.expire_all()
    ra = client.get(f"/api/studies/{sid_a}", headers=auth_headers).json()
    rb = client.get(f"/api/studies/{sid_b}", headers=auth_headers).json()
    assert (ra["series_count"], ra["instance_count"]) == (2, 2)
    assert (rb["series_count"], rb["instance_count"]) == (3, 6)

    # 대상 검사 미존재 404
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": 99999999, "sop_uids": [sop]})
    assert r.status_code == 404


# ════════════════════════════════ Assign 엣지 — 자기자신 차단·왕복 병합·미구체화 카운트 ════════════════════════════════
def test_assign_to_self_blocked(client, auth_headers, db):
    """자기 자신(이미 소속 검사)으로의 assign 은 400 — 침묵 no-op 금지."""
    hid = _mk_hospital(client, auth_headers, "EXH8", "QC병원8")
    sid = _seed_study(db, hid, "self1")
    for body in ({"series_uids": ["1.2.826.0.1.777.self1.1"]},
                 {"sop_uids": ["1.2.826.0.1.777.self1.1.1"]}):
        r = client.post("/api/examctl/assign", headers=auth_headers,
                        json={"target_study_id": sid, **body})
        assert r.status_code == 400, r.text
    # 부작용 없음 — 트리·카운트 불변
    tree = _tree(client, auth_headers, sid)
    assert len(tree["series"]) == 2
    r = client.get(f"/api/studies/{sid}", headers=auth_headers).json()
    assert (r["series_count"], r["instance_count"]) == (2, 4)


def test_assign_sop_roundtrip_returns_to_original_series(client, auth_headers, db):
    """sop A→B→A 왕복 — 원 시리즈로 복귀(분할 행 'X.mB.mA' 증식 금지), 카운트 합 보존."""
    hid = _mk_hospital(client, auth_headers, "EXH9", "QC병원9")
    sid_a = _seed_study(db, hid, "rt.a")
    sid_b = _seed_study(db, hid, "rt.b", patient_key="EXC05")
    sop = "1.2.826.0.1.777.rt.a.1.1"

    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid_b, "sop_uids": [sop]})
    assert r.status_code == 200 and r.json()["moved"] == 1
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid_a, "sop_uids": [sop]})
    assert r.status_code == 200 and r.json()["moved"] == 1

    # A: 원 트리 그대로(2 시리즈, 분할 행 없음), 이미지가 원 시리즈로 복귀
    tree_a = _tree(client, auth_headers, sid_a)
    assert sorted(s["series_uid"] for s in tree_a["series"]) == [
        "1.2.826.0.1.777.rt.a.1", "1.2.826.0.1.777.rt.a.2"]
    s1 = _series(tree_a, "1.2.826.0.1.777.rt.a.1")
    assert sorted(i["sop_uid"] for i in s1["instances"]) == [
        "1.2.826.0.1.777.rt.a.1.1", "1.2.826.0.1.777.rt.a.1.2"]
    # B: 빈 분할 행만 잔존(이미지 0) — 인스턴스 수 합 보존
    db.expire_all()
    ra = client.get(f"/api/studies/{sid_a}", headers=auth_headers).json()
    rb = client.get(f"/api/studies/{sid_b}", headers=auth_headers).json()
    assert ra["instance_count"] == 4 and rb["instance_count"] == 4


def test_unassign_unmaterialized_series_keeps_counts(client, auth_headers, db):
    """Instance 행이 없는(미구체화 — Orthanc 미가용 등) 검사의 unassign 후에도
    남은 시리즈 카운트가 0 으로 붕괴하지 않는다(시리즈 컬럼 폴백)."""
    from app.models import Series, Study
    from app.services.study_service import register_study

    hid = _mk_hospital(client, auth_headers, "EXHA", "QC병원A")
    study = register_study(
        db, study_uid="1.2.826.0.1.777.unmat", patient_key="EXC06",
        patient_name="검사^환자", study_date="20260701", modality="CT",
        study_desc="ExamCtl unmat",
    )
    study.hospital_id = hid
    for si in (1, 2):
        db.add(Series(study_id=study.id, series_uid=f"1.2.826.0.1.777.unmat.{si}",
                      modality="CT", series_desc=f"S{si}", series_number=si,
                      instance_count=2))
    study.series_count, study.instance_count = 2, 4
    db.commit()
    sid = study.id

    r = client.post("/api/examctl/unassign", headers=auth_headers,
                    json={"series_uids": ["1.2.826.0.1.777.unmat.1"]})
    assert r.status_code == 200, r.text
    bucket_id = r.json()["bucket_study_id"]

    db.expire_all()
    src = db.get(Study, sid)
    bucket = db.get(Study, bucket_id)
    assert (src.series_count, src.instance_count) == (1, 2)      # 남은 시리즈 카운트 유지
    assert bucket.instance_count >= 2                            # 버킷도 등록 카운트 반영


# ════════════════════════════════ 권한·병원 가드 ════════════════════════════════
def test_permission_and_hospital_guards(client, auth_headers, db):
    hid1 = _mk_hospital(client, auth_headers, "EXH6", "QC병원6")
    hid2 = _mk_hospital(client, auth_headers, "EXH7", "QC병원7")
    sid1 = _seed_study(db, hid1, "grd1")
    sid2 = _seed_study(db, hid2, "grd2", patient_key="EXC04")

    staff_h = _mk_account(client, auth_headers, "exc_staff1", "staff", hid1)
    tech_h = _mk_account(client, auth_headers, "exc_tech1", "technologist", hid1)

    # staff: 삭제/복구/unassign/assign 전부 403 (조회 전용 기본 매트릭스)
    for path, extra in (("delete", {}), ("restore", {}), ("unassign", {}),
                        ("assign", {"target_study_id": sid1})):
        r = client.post(f"/api/examctl/{path}", headers=staff_h,
                        json={"series_uids": ["1.2.826.0.1.777.grd1.1"], **extra})
        assert r.status_code == 403, f"{path}: {r.text}"

    # technologist: study.delete 권한 없음 → 삭제 403, unassign(study.unmatch)은 자기 병원 OK
    r = client.post("/api/examctl/delete", headers=tech_h,
                    json={"series_uids": ["1.2.826.0.1.777.grd1.1"]})
    assert r.status_code == 403
    r = client.post("/api/examctl/unassign", headers=tech_h,
                    json={"sop_uids": ["1.2.826.0.1.777.grd1.1.1"]})
    assert r.status_code == 200, r.text

    # 타 병원 검사 접근 가드: h1 소속이 h2 검사 항목을 만지면 403
    r = client.post("/api/examctl/unassign", headers=tech_h,
                    json={"series_uids": ["1.2.826.0.1.777.grd2.1"]})
    assert r.status_code == 403
    r = client.get(f"/api/examctl/studies/{sid2}/tree", headers=tech_h)
    assert r.status_code == 403

    # 타 병원으로의 assign 은 시스템 관리자만: h1 항목 → h2 검사 (technologist=403)
    r = client.post("/api/examctl/assign", headers=tech_h,
                    json={"target_study_id": sid2,
                          "series_uids": ["1.2.826.0.1.777.grd1.2"]})
    assert r.status_code == 403
    # 시스템 관리자는 가능
    r = client.post("/api/examctl/assign", headers=auth_headers,
                    json={"target_study_id": sid2,
                          "series_uids": ["1.2.826.0.1.777.grd1.2"]})
    assert r.status_code == 200 and r.json()["moved"] == 1

    # 병원 사용자 목록/휴지통은 자기 병원으로 스코프(다른 병원 검사 미노출)
    r = client.get("/api/examctl/studies", headers=tech_h)
    assert r.status_code == 200
    ids = [it["id"] for it in r.json()["items"]]
    assert sid1 in ids and sid2 not in ids

    # 감사 로그 적재 확인
    from sqlalchemy import select
    from app.models import AuditLog

    actions = {a for (a,) in db.execute(select(AuditLog.action).where(
        AuditLog.action.like("examctl_%"))).all()}
    assert {"examctl_unassign", "examctl_assign"} <= actions
