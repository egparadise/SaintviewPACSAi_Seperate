"""협진(Co-Reading) — 친구·메신저·세션·제어권·임시 열람권.

이 파일이 지키는 **핵심 보안 불변식** 은 셋이다:
  ① 협진 게스트는 어떤 상태에서도 판독 수정·영상 삭제를 할 수 없다(제어권을 쥐고 있어도).
  ② 임시 열람권은 세션이 열려 있고 참가 중인 동안, 해당 검사에만 유효하다.
  ③ 위임 목록(caps)에 기존 권한 키를 실어 보내도 통과하지 않는다.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select


# ════════════════════════════════ 헬퍼 ════════════════════════════════
def _hospital(db, code: str, name: str):
    from app.models import Hospital

    h = db.execute(select(Hospital).where(Hospital.code == code)).scalar_one_or_none()
    if h is None:
        h = Hospital(code=code, name=name, enabled=True)
        db.add(h)
        db.commit()
    return h


def _account(db, username: str, hospital_id: int, role: str = "radiologist"):
    from app.models import Account
    from app.services.auth_service import hash_password

    a = db.execute(select(Account).where(Account.username == username)).scalar_one_or_none()
    if a is None:
        a = Account(username=username, password_hash=hash_password("collab1234"),
                    role=role, hospital_id=hospital_id, enabled=True,
                    display_name=username.upper())
        db.add(a)
        db.commit()
    return a


def _headers(db, account):
    """그 계정의 Bearer 헤더 — 로그인 왕복 없이 토큰만 만든다(테스트 속도)."""
    from app.services.auth_service import create_token

    return {"Authorization": f"Bearer {create_token(account, hospital_id=account.hospital_id)}"}


def _study(db, tag: str, hospital_id: int):
    from app.models import Study
    from app.services.study_service import register_study

    s = register_study(db, study_uid=f"1.2.826.0.1.777.{tag}", patient_key=f"CO{tag}",
                       patient_name="협진^환자", study_date="20260731", modality="CR",
                       study_desc=f"Collab {tag}")
    s = db.get(Study, s.id)
    s.hospital_id = hospital_id
    db.commit()
    return s


@pytest.fixture()
def duo(db):
    """병원 A 의 호스트 + 병원 B 의 게스트 + A 소유 검사 1건 — 타 병원 협진의 기본 배치."""
    ha = _hospital(db, "COLLABA", "협진A병원")
    hb = _hospital(db, "COLLABB", "협진B병원")
    host = _account(db, "collab_host", ha.id)
    guest = _account(db, "collab_guest", hb.id)
    study = _study(db, "s1", ha.id)
    return {"ha": ha, "hb": hb, "host": host, "guest": guest, "study": study,
            "hh": _headers(db, host), "gh": _headers(db, guest)}


def _befriend(client, duo):
    """친구 상태 보장 — 멱등. 계정이 세션 스코프라 앞선 테스트의 관계가 남아 있을 수 있다."""
    r = client.post("/api/collab/friends/request", headers=duo["hh"],
                    json={"target_id": duo["guest"].id})
    assert r.status_code == 200, r.text
    if r.json()["result"] == "created":     # 새 요청일 때만 수락이 필요하다
        r = client.post("/api/collab/friends/respond", headers=duo["gh"],
                        json={"other_id": duo["host"].id, "accept": True})
        assert r.status_code == 200, r.text


def _open_and_join(client, duo, study_id: int | None = None):
    """세션 개설 → 초대 → 게스트 참가. 참가 시점에 임시 열람권이 발급된다.

    open_session 은 (host, study) 가 같으면 열린 세션을 재사용한다 — 실제 운용에서는
    버튼 두 번 눌러 세션이 둘 생기는 것을 막는 옳은 동작이지만, 테스트에서는 앞 테스트의
    제어권·참가 상태가 딸려 온다. 그래서 상태를 봐야 하는 테스트는 자기 검사를 넘긴다.
    """
    _befriend(client, duo)
    r = client.post("/api/collab/sessions", headers=duo["hh"],
                    json={"study_id": study_id or duo["study"].id, "title": "협진 테스트"})
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    r = client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"],
                    json={"target_id": duo["guest"].id})
    assert r.status_code == 200, r.text
    # 참가는 WS(session.enter)가 정식 경로지만, 서비스 함수를 직접 불러 같은 상태를 만든다
    from app.db import SessionLocal
    from app.services import collab_service as svc

    with SessionLocal() as s:
        from app.models import Account

        sess = svc.get_session(s, code)
        svc.join(s, sess, s.get(Account, duo["guest"].id))
    return code


# ═══════════════════ ① 친구 — 중복·양방향·차단 ═══════════════════
def test_friend_request_dedup_and_mutual_merge(client, db, duo):
    from app.models import CollabFriend

    r = client.post("/api/collab/friends/request", headers=duo["hh"],
                    json={"target_id": duo["guest"].id})
    assert r.json()["result"] == "created"
    # 같은 요청 반복 — 새 행이 생기면 안 된다
    r = client.post("/api/collab/friends/request", headers=duo["hh"],
                    json={"target_id": duo["guest"].id})
    assert r.json()["result"] == "exists"
    # 반대 방향 요청 = 사실상 수락 (교착 방지)
    r = client.post("/api/collab/friends/request", headers=duo["gh"],
                    json={"target_id": duo["host"].id})
    assert r.json()["result"] == "accepted"

    db.expire_all()
    rows = db.execute(select(CollabFriend)).scalars().all()
    pair = [x for x in rows if {x.low_id, x.high_id} == {duo["host"].id, duo["guest"].id}]
    assert len(pair) == 1, "정규화된 쌍은 어느 방향으로 요청해도 행이 1개여야 한다"
    assert pair[0].status == "accepted"


def test_self_request_rejected(client, duo):
    r = client.post("/api/collab/friends/request", headers=duo["hh"],
                    json={"target_id": duo["host"].id})
    assert r.status_code == 400


def test_blocked_user_cannot_be_invited(client, db, duo):
    _befriend(client, duo)
    r = client.post("/api/collab/sessions", headers=duo["hh"], json={"study_id": duo["study"].id})
    code = r.json()["code"]
    client.post("/api/collab/friends/block?blocked=true", headers=duo["hh"],
                json={"other_id": duo["guest"].id})
    r = client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"],
                    json={"target_id": duo["guest"].id})
    assert r.status_code == 403, "차단한 상대는 초대할 수 없어야 한다"
    client.post("/api/collab/friends/block?blocked=false", headers=duo["hh"],
                json={"other_id": duo["guest"].id})


def test_non_friend_cannot_be_invited(client, db, duo):
    """친구가 아닌 사용자는 초대 대상이 아니다 — 초대가 곧 PHI 열람권 부여이기 때문."""
    stranger = _account(db, "collab_stranger", duo["hb"].id)
    r = client.post("/api/collab/sessions", headers=duo["hh"], json={"study_id": duo["study"].id})
    code = r.json()["code"]
    r = client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"],
                    json={"target_id": stranger.id})
    assert r.status_code == 403


# ═══════════════════ ② 임시 열람권 — 세션 한정 ═══════════════════
def test_guest_reads_other_hospital_study_only_during_session(client, db, duo):
    sid = duo["study"].id
    # 세션 전 — 타 병원 검사는 404(존재 은닉)
    assert client.get(f"/api/studies/{sid}", headers=duo["gh"]).status_code == 404

    code = _open_and_join(client, duo)
    r = client.get(f"/api/studies/{sid}", headers=duo["gh"])
    assert r.status_code == 200, "협진 참가 중에는 그 검사를 볼 수 있어야 한다"

    # 세션 종료 → 즉시 회수
    assert client.post(f"/api/collab/sessions/{code}/close", headers=duo["hh"]).status_code == 200
    assert client.get(f"/api/studies/{sid}", headers=duo["gh"]).status_code == 404, \
        "세션이 닫히면 열람권은 즉시 무효여야 한다"


def test_grant_is_scoped_to_the_shared_study_only(client, db, duo):
    """열람권은 '그 검사'에만 붙는다 — 같은 병원의 다른 검사가 덤으로 열리면 안 된다."""
    other = _study(db, "s2", duo["ha"].id)
    _open_and_join(client, duo)
    assert client.get(f"/api/studies/{duo['study'].id}", headers=duo["gh"]).status_code == 200
    assert client.get(f"/api/studies/{other.id}", headers=duo["gh"]).status_code == 404


def test_leaving_session_revokes_grant(client, db, duo):
    code = _open_and_join(client, duo)
    sid = duo["study"].id
    assert client.get(f"/api/studies/{sid}", headers=duo["gh"]).status_code == 200
    assert client.post(f"/api/collab/sessions/{code}/leave", headers=duo["gh"]).status_code == 200
    assert client.get(f"/api/studies/{sid}", headers=duo["gh"]).status_code == 404


def test_host_switching_exam_grants_the_new_study(client, db, duo):
    """Master 가 Exam 탭을 바꾸면 그 검사 열람권이 나가고, 이전 검사도 계속 볼 수 있다."""
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    code = _open_and_join(client, duo)
    nxt = _study(db, "s3", duo["ha"].id)
    assert client.get(f"/api/studies/{nxt.id}", headers=duo["gh"]).status_code == 404

    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        granted = svc.set_share_study(s, sess, s.get(Account, duo["host"].id), nxt.id)
    assert duo["guest"].id in granted

    assert client.get(f"/api/studies/{nxt.id}", headers=duo["gh"]).status_code == 200
    assert client.get(f"/api/studies/{duo['study'].id}", headers=duo["gh"]).status_code == 200, \
        "비교를 위해 이전 검사도 세션 동안 계속 보여야 한다"


def test_host_cannot_share_another_hospitals_study(client, db, duo):
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    code = _open_and_join(client, duo)
    foreign = _study(db, "s4", duo["hb"].id)   # 게스트 병원 소유
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        with pytest.raises(PermissionError):
            svc.set_share_study(s, sess, s.get(Account, duo["host"].id), foreign.id)


def test_collab_read_is_audited(client, db, duo):
    from app.models import AuditLog

    _open_and_join(client, duo)
    client.get(f"/api/studies/{duo['study'].id}", headers=duo["gh"])
    db.expire_all()
    rows = db.execute(select(AuditLog).where(AuditLog.action == "collab_study_read")).scalars().all()
    assert any(r.target_id == str(duo["study"].id) and r.account_id == duo["guest"].id
               for r in rows), "타 병원 PHI 열람은 반드시 감사로그에 남아야 한다"


# ═══════════════════ ③ 쓰기 금지 — 요구사항의 핵심 방어선 ═══════════════════
def test_guest_can_read_report_but_never_write_it(client, db, duo):
    """게스트는 판독문을 **읽을 수 있고**(그게 협진의 목적) **쓸 수는 없다**.

    '판독 수정, 영상 삭제 등은 할 수 없다' 를 코드로 확인하는 지점이다.
    구조적 근거: 열람권은 조회 게이트에만 opt-in 으로 꽂혀 있고, 쓰기 경로는 협진을 아예 모른다.
    """
    from app.db import SessionLocal
    from app.models import Account, Study
    from app.services import collab_service as svc
    from app.services.report_service import save_draft_from_ai

    sid = duo["study"].id
    rep = save_draft_from_ai(db, db.get(Study, sid),
                             {"findings": [], "impression": []}, model="mock", sources={})
    rid = rep.id

    code = _open_and_join(client, duo)
    with SessionLocal() as s:   # 제어권까지 쥐여 준다 — 그래도 쓰기는 안 된다는 것이 요점
        sess = svc.get_session(s, code)
        svc.grant_control(s, sess, s.get(Account, duo["host"].id), duo["guest"].id,
                          caps=["collab.viewport", "collab.annotate"])
        assert svc.can_control(s, sess, duo["guest"].id, "collab.viewport") is True

    assert client.get(f"/api/studies/{sid}", headers=duo["gh"]).status_code == 200
    assert client.get(f"/api/studies/{sid}/reports", headers=duo["gh"]).status_code == 200, \
        "협진 게스트는 판독문을 읽을 수 있어야 한다"

    # 판독 수정 — 게스트가 radiologist(report.write 보유)여도 타 병원 검사라 막혀야 한다
    r = client.put(f"/api/reports/{rid}", headers=duo["gh"], json={"sr_json": {"hacked": 1}})
    assert r.status_code == 404, f"게스트 판독 수정이 통과했다: {r.status_code} {r.text}"
    r = client.post(f"/api/reports/{rid}/finalize", headers=duo["gh"])
    assert r.status_code in (403, 404), f"게스트 판독 확정이 통과했다: {r.status_code} {r.text}"

    # 영상 삭제
    r = client.post(f"/api/studies/{sid}/admin-action", headers=duo["gh"],
                    json={"action": "delete"})
    assert r.status_code in (403, 404), f"게스트 영상 삭제가 통과했다: {r.status_code} {r.text}"


def test_guest_cannot_reach_any_write_endpoint_sharing_the_study_gate(client, db, duo):
    """_require_study 를 공유하는 **쓰기 엔드포인트 전부**가 게스트에게 닫혀 있어야 한다.

    이 가드는 GET 과 PUT/POST 가 함께 쓴다. 협진 예외를 그 함수에 무조건 넣으면
    주석 덮어쓰기·응급 지정·GSPS 전송까지 한꺼번에 열린다(실제로 초안이 그랬다).
    그래서 예외는 opt-in 이고, 이 테스트가 그 결정을 고정한다.
    """
    sid = duo["study"].id
    _open_and_join(client, duo)
    assert client.get(f"/api/studies/{sid}", headers=duo["gh"]).status_code == 200  # 조회는 열려 있다

    # ⚠ 본문은 **반드시 유효해야** 한다. 422(본문 검증 실패)는 권한과 무관하게 나므로,
    #   틀린 본문을 보내면 권한 게이트가 통째로 사라져도 이 테스트가 초록으로 남는다
    #   (send-gsps 에 {} 를 보내 실제로 그런 상태였다 — 이 저장소의 '공허한 테스트' 유형).
    #   그래서 허용 코드에서 422 를 뺐다. 422 가 나면 그건 테스트가 잘못된 것이다.
    writes = [
        ("put", f"/api/studies/{sid}/annotations", {"items": []}),
        ("put", f"/api/studies/{sid}/bookmark", {"bookmark": True}),
        ("put", f"/api/studies/{sid}/memo", {"memo": "게스트 침입"}),
        ("put", f"/api/studies/{sid}/priority", {"emergency": True}),
        ("put", f"/api/studies/{sid}/key-images", {"items": []}),
        ("put", f"/api/studies/{sid}/presentation", {"series": {}}),
        ("post", f"/api/studies/{sid}/analyze", None),
        ("post", f"/api/studies/{sid}/send-gsps",
         {"images": [{"sop_uid": "1.2.3", "series_uid": "1.2", "rows": 1, "cols": 1}],
          "annotations": []}),
        ("post", f"/api/studies/{sid}/send-kos", {}),
    ]
    for method, path, body in writes:
        r = getattr(client, method)(path, headers=duo["gh"], **({"json": body} if body is not None else {}))
        assert r.status_code != 422, \
            f"{method.upper()} {path} 본문이 틀렸다 — 권한이 아니라 검증으로 막힌 공허한 단언이다: {r.text}"
        assert r.status_code in (403, 404), \
            f"게스트가 {method.upper()} {path} 를 통과했다: {r.status_code} {r.text}"


def test_caps_cannot_smuggle_real_permissions(client, db, duo):
    """caps 에 report.write·study.delete 를 실어 보내도 화이트리스트에서 걸러진다."""
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    code = _open_and_join(client, duo)
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        p = svc.grant_control(s, sess, s.get(Account, duo["host"].id), duo["guest"].id,
                              caps=["collab.viewport", "report.write", "study.delete",
                                    "report.finalize", "users.manage"])
        assert p.caps == ["collab.viewport"], f"위험한 권한이 섞여 들어갔다: {p.caps}"
        assert svc.can_control(s, sess, duo["guest"].id, "report.write") is False


def test_same_hospital_participant_keeps_their_own_rights(client, db, duo):
    """같은 병원 참가자는 협진 중에도 **원래 자기 권한 그대로**다 — 의도된 동작이다.

    협진이 지켜야 할 것은 "권한을 더해 주지 않는다"이지 "권한을 빼앗는다"가 아니다.
    같은 병원 동료는 협진을 켜지 않아도 그 검사를 열고 주석을 저장할 수 있는 사람이고,
    협진 창을 띄웠다는 이유로 평소 하던 일을 못 하게 되면 그게 오히려 사고다.
    (Slave 가 '위임받아' 할 수 있는 일의 범위는 caps 로 따로 통제된다 —
     test_caps_cannot_smuggle_real_permissions 참조.)
    """
    peer = _account(db, "collab_same", duo["ha"].id, role="radiologist")  # 호스트와 같은 병원
    ph = _headers(db, peer)
    sid = duo["study"].id
    before = client.put(f"/api/studies/{sid}/annotations", headers=ph, json={"items": []})
    assert before.status_code == 200, "협진 전에도 같은 병원 동료는 주석을 저장할 수 있다"

    _befriend_pair(client, db, duo["host"], peer, duo["hh"], ph)
    r = client.post("/api/collab/sessions", headers=duo["hh"], json={"study_id": sid})
    code = r.json()["code"]
    client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"], json={"target_id": peer.id})
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    with SessionLocal() as s:
        svc.join(s, svc.get_session(s, code), s.get(Account, peer.id))

    after = client.put(f"/api/studies/{sid}/annotations", headers=ph, json={"items": []})
    assert after.status_code == 200, "협진에 참가했다고 평소 권한이 사라지면 안 된다"


def _befriend_pair(client, db, a, b, ah, bh):
    r = client.post("/api/collab/friends/request", headers=ah, json={"target_id": b.id})
    assert r.status_code == 200, r.text
    if r.json()["result"] == "created":
        client.post("/api/collab/friends/respond", headers=bh, json={"other_id": a.id, "accept": True})


def test_room_key_format_matches_the_frontend():
    """룸 키 형식은 프론트(lib/collabState.dmRoom)와 **한 글자도** 달라선 안 된다.

    같은 리터럴을 양쪽 테스트에 박아 둔다 — 한쪽만 바꾸면 반드시 한쪽이 깨진다
    (프론트: frontend/tests/collab_mirror_rule.test.mjs 의 같은 이름 테스트).
    갈리면 증상이 고약하다: 보낸 사람에게만 보이는 대화방이 조용히 생긴다.
    """
    from app.services.collab_service import dm_peer, dm_room, parse_room, session_room

    assert dm_room(7, 3) == "dm:3:7"
    assert dm_room(3, 7) == dm_room(7, 3)
    assert session_room("abc123") == "sess:abc123"

    assert parse_room("dm:3:7") == ("dm", (3, 7))
    assert parse_room("sess:abc123") == ("sess", ("abc123",))
    # 형식이 아닌 것은 전부 None — 조작된 room 으로 남의 방에 끼어들 수 없다
    for bad in ["", "dm:3", "dm:3:7:9", "dm:a:b", "sess:", "nope:1:2", None, 123]:
        assert parse_room(bad) is None, f"{bad!r} 이 룸 키로 통과했다"

    assert dm_peer("dm:3:7", 3) == 7
    assert dm_peer("dm:3:7", 7) == 3
    assert dm_peer("dm:3:7", 9) is None, "당사자가 아닌데 상대가 나왔다"
    assert dm_peer("sess:x", 3) is None


def test_room_guard_rejects_forged_room_keys(client, db, duo):
    """조작된 room 으로 남의 DM 을 읽거나 쓸 수 없다."""
    other = f"dm:{duo['host'].id}:{duo['host'].id + 999}"   # 게스트가 당사자가 아닌 방
    r = client.get(f"/api/collab/messages?room={other}", headers=duo["gh"])
    assert r.status_code == 403
    for bad in ["dm:1:2:3", "sess:", "dm:a:b", "../etc"]:
        r = client.get("/api/collab/messages", headers=duo["gh"], params={"room": bad})
        assert r.status_code == 403, f"{bad!r} 이 통과했다"


def test_sanitize_collab_caps_rejects_everything_outside_whitelist():
    from app.services.permissions import (
        COLLAB_NEVER_DELEGATE,
        PERMISSIONS,
        sanitize_collab_caps,
    )

    assert sanitize_collab_caps(list(PERMISSIONS.keys())) == []
    assert sanitize_collab_caps(list(COLLAB_NEVER_DELEGATE)) == []
    assert sanitize_collab_caps(None) == []
    assert sanitize_collab_caps(["collab.viewport", "nope"]) == ["collab.viewport"]


# ═══════════════════ ④ 제어권 ═══════════════════
def test_control_is_exclusive_and_returns_to_host(client, db, duo):
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    code = _open_and_join(client, duo, _study(db, "ctl1", duo["ha"].id).id)
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        host = s.get(Account, duo["host"].id)
        # 개설 직후 제어권은 Master 에게 있다
        assert svc.controller_of(s, sess.id).account_id == duo["host"].id
        svc.grant_control(s, sess, host, duo["guest"].id, caps=["collab.viewport"])
        cur = svc.controller_of(s, sess.id)
        assert cur.account_id == duo["guest"].id, "제어권은 세션당 1명만 갖는다"
        assert svc.can_control(s, sess, duo["host"].id, "collab.viewport") is False
        svc.revoke_control(s, sess, host)
        assert svc.controller_of(s, sess.id).account_id == duo["host"].id


def test_guest_cannot_grant_control_to_itself(client, db, duo):
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    code = _open_and_join(client, duo)
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        with pytest.raises(PermissionError):
            svc.grant_control(s, sess, s.get(Account, duo["guest"].id), duo["guest"].id)


def test_expired_control_is_not_controller(client, db, duo):
    from datetime import datetime, timedelta, timezone

    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    code = _open_and_join(client, duo)
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        p = svc.grant_control(s, sess, s.get(Account, duo["host"].id), duo["guest"].id)
        p.control_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        s.commit()
        assert svc.can_control(s, sess, duo["guest"].id, "collab.viewport") is False, \
            "만료된 위임으로는 화면을 움직일 수 없어야 한다"


# ═══════════════════ ⑤ WebSocket — 인증·제어권 검증 ═══════════════════
def test_ws_rejects_missing_or_bad_token(client, duo):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/collab/ws"):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/collab/ws",
                                      subprotocols=["sv.bearer", "not-a-jwt"]):
            pass


def test_ws_hello_and_presence(client, db, duo):
    _befriend(client, duo)
    tok = duo["hh"]["Authorization"].split(" ", 1)[1]
    gtok = duo["gh"]["Authorization"].split(" ", 1)[1]
    with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", tok]) as w:
        hello = w.receive_json()
        assert hello["t"] == "hello"
        assert hello["me"]["username"] == "collab_host"
        # 친구가 접속하면 프레즌스가 온다
        with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", gtok]) as w2:
            assert w2.receive_json()["t"] == "hello"
            ev = w.receive_json()
            assert ev["t"] == "presence" and ev["id"] == duo["guest"].id and ev["online"] is True


def _drain_to_pong(ws) -> list[str]:
    """ping→pong 왕복으로 큐를 비우고, 그 사이 온 이벤트 타입 목록을 돌려준다.

    두 가지 목적이 있다:
      ① 프레즌스·joined 같은 정상 이벤트가 섞여 오므로 '다음 한 건'을 단정할 수 없다.
      ② **송신 소켓에서 먼저 왕복하면 그 소켓이 앞서 보낸 메시지가 서버에서 처리 완료됐음이
         보장된다**(한 소켓 안에서는 FIFO). 이걸 안 하고 바로 수신 측을 읽으면, 서버가 두
         소켓을 동시에 처리하는 바람에 아직 오지 않은 것을 '안 왔다'고 오판한다.
    """
    ws.send_json({"t": "ping"})
    seen: list[str] = []
    for _ in range(50):
        t = ws.receive_json()["t"]
        if t == "pong":
            return seen
        seen.append(t)
    raise AssertionError("pong 이 오지 않았다")


def test_ws_non_controller_state_is_dropped(client, db, duo):
    """제어권 없는 참가자가 보낸 화면 상태는 서버가 버린다(관전자가 화면을 흔들 수 없다)."""
    code = _open_and_join(client, duo, _study(db, "ws1", duo["ha"].id).id)
    tok = duo["hh"]["Authorization"].split(" ", 1)[1]
    gtok = duo["gh"]["Authorization"].split(" ", 1)[1]
    with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", tok]) as host_ws:
        host_ws.receive_json()                      # hello
        host_ws.send_json({"t": "session.enter", "code": code})
        assert host_ws.receive_json()["t"] == "session"
        with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", gtok]) as gw:
            gw.receive_json()                       # hello
            gw.send_json({"t": "session.enter", "code": code})
            assert gw.receive_json()["t"] == "session"
            _drain_to_pong(host_ws)                 # presence/joined 등 정상 이벤트 소진

            # ① 게스트(제어권 없음)가 상태를 쏜다 → 호스트에게 도달하면 안 된다
            gw.send_json({"t": "state", "d": {"zoom": 9}})
            _drain_to_pong(gw)                      # 서버가 그 state 를 처리했음을 보장(FIFO)
            assert "state" not in _drain_to_pong(host_ws), "관전자의 state 가 흘러들어왔다"

            # ② 제어권을 넘기면 같은 메시지가 이제는 도달해야 한다(게이트가 살아 있다는 증거)
            host_ws.send_json({"t": "ctl.grant", "target": duo["guest"].id,
                               "caps": ["collab.viewport"]})
            assert "ctl.granted" in _drain_to_pong(host_ws)
            _drain_to_pong(gw)
            gw.send_json({"t": "state", "d": {"zoom": 3}})
            _drain_to_pong(gw)                      # 위와 같은 이유 — 먼저 송신 소켓에서 왕복
            assert "state" in _drain_to_pong(host_ws), "제어권자의 state 는 전달되어야 한다"
