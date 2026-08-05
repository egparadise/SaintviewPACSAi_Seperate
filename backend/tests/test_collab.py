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


# ═══════════════════ ⓪ 디렉터리 — 검색에 사람이 보여야 한다 ═══════════════════
def test_directory_finds_remote_pacs_mirror_accounts(client, db, duo):
    """원격 PACS(A) 로그인으로 만들어진 **미러 계정**이 친구 검색에 나와야 한다.

    실제 증상: Live 모드 서버에서 "Sunshin_lee" 를 검색해도 "결과가 없습니다".
    원인: ensure_mirror(auth.py webpacs-login)가 hospital_id 를 넘기지 않아 미러 행은
         hospital_id=NULL 인데, directory 가 hospital_id IS NOT NULL 로 걸렀다.
         → A 계정으로 로그인한 사용자끼리는 서로를 **절대** 찾을 수 없었다.
    (이 저장소의 '인자는 받는데 아무도 안 넘김' 유형 — register_study(body_part=…) 와 같다)
    """
    from app.services.account_mirror import ensure_mirror
    from app.services.collab_service import directory

    mirror = ensure_mirror(db, user_id="Sunshin_lee", name="이순신",
                           role="doctor", a_user_idx=4242)
    db.commit()
    assert mirror.hospital_id is None, "전제 — 미러는 병원 미소속으로 만들어진다"

    got = directory(db, duo["host"], q="Sunshin")
    assert any(u["username"] == "Sunshin_lee" for u in got), \
        f"A 미러 계정이 검색되지 않는다 — {[u['username'] for u in got]}"
    # 대소문자 무관하게 찾혀야 한다(사용자는 소문자로 친다)
    assert any(u["username"] == "Sunshin_lee" for u in directory(db, duo["host"], q="sunshin"))
    # 이름(한글)으로도 찾힌다
    assert any(u["username"] == "Sunshin_lee" for u in directory(db, duo["host"], q="이순신"))


def test_directory_predicate_tolerates_null_enabled():
    """enabled 가 NULL 인 레거시 계정도 검색에 나와야 한다 — SQL 조건으로 확인한다.

    auth_service.authenticate 는 **명시적 False 만** 거부하고 NULL 은 활성으로 본다
    (컬럼 추가 전 계정 보호 — 그 컬럼은 db._sync_columns 의 ALTER 로 붙어 nullable 이다).
    directory 가 `IS TRUE` 로 걸면 '로그인은 되는데 친구 검색에는 영원히 안 보이는' 계정이 된다.

    ⚠ 행으로 재현할 수 없다: 새 스키마의 accounts.enabled 는 NOT NULL 이라
      NULL 을 넣는 순간 DB 가 거부한다. NULL 은 **레거시 DB 에만** 있는 상태다.
      그래서 '무엇으로 거르는가'(조건식)를 직접 본다 — 이 규칙이 갈리는 것이 사고였다.
    """
    from app.models import Account
    from app.services.collab_service import directory
    import inspect

    src = inspect.getsource(directory)
    assert "enabled.isnot(False)" in src, "NULL 을 활성으로 보지 않는다(auth_service 와 갈린다)"
    assert "enabled.is_(True)" not in src
    # 조건식 자체가 NULL 을 통과시키는지 SQL 로 확인
    sql = str(Account.enabled.isnot(False).compile(compile_kwargs={"literal_binds": True}))
    assert "IS NOT" in sql.upper(), sql


def test_directory_still_excludes_disabled_and_system_admin(client, db, duo):
    """열되 열지 말아야 할 것은 그대로 — 비활성 계정과 병원 미소속 **시스템 관리자**."""
    from app.services.collab_service import directory

    off = _account(db, "collab_disabled", duo["ha"].id)
    off.enabled = False
    db.commit()
    names = [u["username"] for u in directory(db, duo["host"], q="collab_")]
    assert "collab_disabled" not in names, "비활성 계정이 검색된다"

    from app.models import Account
    sysadmin = db.execute(
        select(Account).where(Account.username == "admin")).scalar_one_or_none()
    if sysadmin is not None:
        assert sysadmin.hospital_id is None
        assert "admin" not in [u["username"] for u in directory(db, duo["host"], q="admin")], \
            "병원 미소속 시스템 관리자는 협진 상대가 아니다"


def _reset_a_cache():
    from app.services import collab_service as svc

    svc._a_users_cache.update({"at": 0.0, "rows": []})


def test_directory_merges_sv70_registered_users(client, db, duo, monkeypatch):
    """Live 브리지가 켜져 있으면 **A(sv70) 등록 사용자**가 검색의 원천이다.

    실증상: sv70 배치에서 협진 찾기 목록이 실제 A 등록·로그인 사용자와 다르고,
    아직 우리 뷰어에 로그인한 적 없는 동료는 검색조차 안 됐다 — 로컬 accounts 만
    보고 있었기 때문이다(로컬에는 'A 로그인을 한 번 한 사람'의 미러만 생긴다).
    """
    from sqlalchemy import select as _sel

    from app.models import Account
    from app.services import collab_service as svc

    a_rows = [
        {"user_id": "Sunshin_lee9", "user_name": "이순신", "user_type": "RP",
         "group_level": 1, "user_idx": 9101, "user_status": "A"},
        {"user_id": "blocked_a_user", "user_name": "차단됨", "user_type": "R",
         "group_level": 1, "user_idx": 9102, "user_status": "D"},
        {"user_id": "a_chief_admin", "user_name": "관리자급", "user_type": "MP",
         "group_level": 99, "user_idx": 9103, "user_status": "A"},
    ]
    monkeypatch.setattr(svc, "_fetch_a_users", lambda _db: list(a_rows))
    _reset_a_cache()

    got = svc.directory(db, duo["host"], q="")
    names = {u["username"] for u in got}
    assert "Sunshin_lee9" in names, f"A 등록 사용자가 목록에 없다 — {sorted(names)}"
    assert "blocked_a_user" not in names, "차단(user_status=D) 사용자가 목록에 올랐다"
    assert "a_chief_admin" in names, \
        "A 관리자급(group_level>=98) 미러는 실사용자다 — 시스템 관리자 제외 규칙에 걸리면 안 된다"

    # 실명으로 보인다(아이디가 아니라) — 커서 라벨·메시지 발신자와 같은 표시 원천
    row = next(u for u in got if u["username"] == "Sunshin_lee9")
    assert row["name"] == "이순신", f"실명이 아니라 {row['name']!r} 로 보인다"

    # 목록에 올린 사람은 미러 행이 **커밋까지** 되어 있어야 한다 — 이 id 로 친구 요청이 성립해야 하므로
    db.expire_all()
    acc = db.execute(_sel(Account).where(Account.username == "Sunshin_lee9")).scalar_one()
    assert acc.a_user_idx == 9101 and acc.password_hash == "", "미러 계약(빈 해시) 위반"
    r = client.post("/api/collab/friends/request", headers=duo["hh"],
                    json={"target_id": row["id"]})
    assert r.status_code == 200, f"목록의 id 로 친구 요청이 안 된다: {r.text}"

    # 검색어(아이디 소문자·실명)로도 걸러진다
    assert any(u["username"] == "Sunshin_lee9"
               for u in svc.directory(db, duo["host"], q="sunshin_lee9"))
    assert any(u["username"] == "Sunshin_lee9"
               for u in svc.directory(db, duo["host"], q="이순신"))


def test_directory_a_merge_is_idempotent(client, db, duo, monkeypatch):
    """같은 목록으로 두 번 검색해도 미러 행은 1개, 응답에도 1번만."""
    from sqlalchemy import select as _sel

    from app.models import Account
    from app.services import collab_service as svc

    a_rows = [{"user_id": "dup_check_user", "user_name": "중복확인", "user_type": "RP",
               "group_level": 1, "user_idx": 9201, "user_status": "A"}]
    monkeypatch.setattr(svc, "_fetch_a_users", lambda _db: list(a_rows))
    _reset_a_cache()
    svc.directory(db, duo["host"], q="dup_check")
    got = svc.directory(db, duo["host"], q="dup_check")
    assert [u["username"] for u in got].count("dup_check_user") == 1
    db.expire_all()
    rows = db.execute(_sel(Account).where(Account.username == "dup_check_user")).scalars().all()
    assert len(rows) == 1, "미러 행이 중복 생성됐다"


def test_directory_survives_a_outage(client, db, duo, monkeypatch):
    """A 가 죽어도 검색은 로컬 결과로 계속된다 — 협진이 A 가용성의 볼모가 아니다."""
    from app.services import collab_service as svc

    monkeypatch.setattr(svc, "_fetch_a_users", lambda _db: None)   # 실패/브리지 꺼짐 계약
    _reset_a_cache()
    got = svc.directory(db, duo["host"], q="collab_guest")
    assert any(u["username"] == "collab_guest" for u in got), "로컬 검색까지 죽었다"


def test_directory_serves_stale_a_list_while_down(client, db, duo, monkeypatch):
    """A 순단 중에는 마지막 성공 목록(stale)으로 응답한다."""
    from app.services import collab_service as svc

    a_rows = [{"user_id": "stale_kept_user", "user_name": "스테일", "user_type": "RP",
               "group_level": 1, "user_idx": 9301, "user_status": "A"}]
    monkeypatch.setattr(svc, "_fetch_a_users", lambda _db: list(a_rows))
    _reset_a_cache()
    svc.directory(db, duo["host"], q="stale_kept")          # 캐시 채움
    monkeypatch.setattr(svc, "_fetch_a_users", lambda _db: None)  # A 다운
    svc._a_users_cache["at"] = 0.0                           # TTL 만료 강제
    got = svc.directory(db, duo["host"], q="stale_kept")
    assert any(u["username"] == "stale_kept_user" for u in got), "stale 목록이 버려졌다"


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


# ═══════════════ ④-2 다학제 — 동시 작업 · 세션 주석 ═══════════════
def _third(db, duo):
    """세 번째 참가자 — 다학제(3명)의 최소 구성. 영상의 목표 상태와 같다."""
    return _account(db, "collab_third", duo["hb"].id)


def test_multiple_participants_hold_the_same_cap_at_once(client, db, duo):
    """여러 명이 **동시에** collab.annotate 를 가질 수 있어야 한다 — 이게 다학제다.

    예전 모델(talking stick)은 한 명에게 주는 순간 나머지 caps 를 비웠다. 그 상태로는
    영상처럼 세 사람이 각자 색으로 동시에 그리는 일이 성립하지 않는다.
    """
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    third = _third(db, duo)
    code = _open_and_join(client, duo, _study(db, "mdt1", duo["ha"].id).id)
    _befriend_pair(client, db, duo["host"], third, duo["hh"], _headers(db, third))
    client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"],
                json={"target_id": third.id})
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        svc.join(s, sess, s.get(Account, third.id))
        host = s.get(Account, duo["host"].id)
        svc.set_caps(s, sess, host, duo["guest"].id, ["collab.annotate", "collab.text"])
        svc.set_caps(s, sess, host, third.id, ["collab.annotate"])
        # 둘 다 동시에 그릴 수 있어야 한다
        assert svc.can_control(s, sess, duo["guest"].id, "collab.annotate") is True
        assert svc.can_control(s, sess, third.id, "collab.annotate") is True
        # 발표자(뷰포트)는 여전히 1명 — 그건 배타가 맞다
        assert svc.can_control(s, sess, duo["guest"].id, "collab.viewport") is False
        assert svc.can_control(s, sess, third.id, "collab.viewport") is False


def test_set_caps_does_not_touch_other_participants(client, db, duo):
    """한 사람의 권한을 바꿔도 남의 권한은 그대로여야 한다."""
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    third = _third(db, duo)
    code = _open_and_join(client, duo, _study(db, "mdt2", duo["ha"].id).id)
    _befriend_pair(client, db, duo["host"], third, duo["hh"], _headers(db, third))
    client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"],
                json={"target_id": third.id})
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        svc.join(s, sess, s.get(Account, third.id))
        host = s.get(Account, duo["host"].id)
        svc.set_caps(s, sess, host, duo["guest"].id, ["collab.annotate"])
        svc.set_caps(s, sess, host, third.id, ["collab.text"])
        svc.set_caps(s, sess, host, third.id, [])          # third 만 회수
        assert svc.can_control(s, sess, duo["guest"].id, "collab.annotate") is True, \
            "남의 권한 조정이 내 권한을 지웠다"
        assert svc.can_control(s, sess, third.id, "collab.text") is False


def test_grant_control_no_longer_wipes_everyone_else(client, db, duo):
    """발표자 전환이 다른 사람의 주석 권한까지 빼앗으면 안 된다(예전 동작의 회귀 방어)."""
    from app.db import SessionLocal
    from app.models import Account
    from app.services import collab_service as svc

    third = _third(db, duo)
    code = _open_and_join(client, duo, _study(db, "mdt3", duo["ha"].id).id)
    _befriend_pair(client, db, duo["host"], third, duo["hh"], _headers(db, third))
    client.post(f"/api/collab/sessions/{code}/invite", headers=duo["hh"],
                json={"target_id": third.id})
    with SessionLocal() as s:
        sess = svc.get_session(s, code)
        svc.join(s, sess, s.get(Account, third.id))
        host = s.get(Account, duo["host"].id)
        svc.set_caps(s, sess, host, third.id, ["collab.annotate"])
        svc.grant_control(s, sess, host, duo["guest"].id, caps=["collab.viewport"])
        assert svc.can_control(s, sess, third.id, "collab.annotate") is True, \
            "발표자를 넘겼더니 제3자의 주석 권한이 사라졌다"


def test_session_annotations_never_reach_the_database(client, db, duo):
    """세션 주석은 메모리에만 — 세션이 닫히면 DB 에 아무것도 남지 않는다."""
    from sqlalchemy import select as _sel

    from app.models import Annotation
    from app.services.collab_hub import hub

    code = _open_and_join(client, duo, _study(db, "mdt4", duo["ha"].id).id)
    before = len(db.execute(_sel(Annotation)).scalars().all())
    for i in range(3):
        assert hub.anno_add(code, {"kind": "arrow", "points": [[0.1, 0.1], [0.2, 0.2]],
                                   "text": f"fibrosis {i}"}, duo["guest"].id) is not None
    assert len(hub.annos(code)) == 3
    db.expire_all()
    assert len(db.execute(_sel(Annotation)).scalars().all()) == before, \
        "세션 주석이 DB 로 샜다"

    assert client.post(f"/api/collab/sessions/{code}/close", headers=duo["hh"]).status_code == 200
    assert hub.annos(code) == [], "세션이 닫혔는데 주석이 남아 있다"
    db.expire_all()
    assert len(db.execute(_sel(Annotation)).scalars().all()) == before


def test_session_annotation_author_cannot_be_forged(client, db, duo):
    """클라가 by/id 를 실어 보내도 서버가 자기 값으로 덮는다 — 남의 색·이름 사칭 방지."""
    from app.services.collab_hub import hub

    code = _open_and_join(client, duo, _study(db, "mdt5", duo["ha"].id).id)
    row = hub.anno_add(code, {"kind": "arrow", "points": [[0, 0], [1, 1]],
                              "by": duo["host"].id, "id": "s999"}, duo["guest"].id)
    assert row["by"] == duo["guest"].id, "작성자 위조가 통과했다"
    assert row["id"] != "s999", "id 위조가 통과했다"


def test_session_annotation_edit_is_own_only_and_capped(client, db, duo):
    from app.services.collab_hub import MAX_SESSION_ANNOS, hub

    code = _open_and_join(client, duo, _study(db, "mdt6", duo["ha"].id).id)
    mine = hub.anno_add(code, {"kind": "arrow", "points": [[0, 0], [1, 1]]}, duo["guest"].id)
    # 남의 것은 못 고치고 못 지운다
    assert hub.anno_update(code, mine["id"], {"kind": "arrow", "points": [[0, 0]]},
                           duo["host"].id) is None
    assert hub.anno_remove(code, mine["id"], duo["host"].id) is False
    # Master 정리(force)는 된다 — [채택] 후 목록에서 빼는 경로
    assert hub.anno_remove(code, mine["id"], duo["host"].id, force=True) is True

    for _ in range(MAX_SESSION_ANNOS):
        hub.anno_add(code, {"kind": "arrow", "points": [[0, 0], [1, 1]]}, duo["guest"].id)
    assert hub.anno_add(code, {"kind": "arrow", "points": [[0, 0], [1, 1]]},
                        duo["guest"].id) is None, f"세션 주석 상한({MAX_SESSION_ANNOS})이 안 걸렸다"


def test_master_adopt_saves_with_original_author_noted(client, db, duo):
    """[채택] — Master 이름으로 저장하되 원 작성자를 본문에 남긴다(책임 주체 유지)."""
    from sqlalchemy import select as _sel

    from app.models import Annotation
    from app.services.collab_hub import hub

    study = _study(db, "mdt7", duo["ha"].id)
    code = _open_and_join(client, duo, study.id)
    hub.anno_add(code, {"kind": "arrow", "points": [[0.3, 0.3], [0.4, 0.4]],
                        "text": "fibrosis", "sop_uid": "1.2.3"}, duo["guest"].id)
    r = client.post(f"/api/collab/sessions/{code}/adopt", headers=duo["hh"],
                    json={"target_id": duo["guest"].id})
    assert r.status_code == 200 and r.json()["adopted"] == 1, r.text

    db.expire_all()
    rows = db.execute(_sel(Annotation).where(Annotation.study_id == study.id)).scalars().all()
    saved = [a for a in rows if "fibrosis" in (a.text or "")]
    assert saved, "채택했는데 저장이 안 됐다"
    assert saved[0].created_by == duo["host"].username, "저장 책임 주체가 Master 가 아니다"
    assert "COLLAB_GUEST" in saved[0].text.upper() or "collab_guest" in saved[0].text.lower(), \
        f"원 작성자가 본문에 안 남았다: {saved[0].text}"
    assert hub.annos_of(code, duo["guest"].id) == [], "채택 후에도 세션 목록에 남아 중복 저장된다"


def test_only_master_can_adopt_or_set_caps(client, db, duo):
    code = _open_and_join(client, duo, _study(db, "mdt8", duo["ha"].id).id)
    r = client.post(f"/api/collab/sessions/{code}/adopt", headers=duo["gh"],
                    json={"target_id": duo["host"].id})
    assert r.status_code == 403
    r = client.post(f"/api/collab/sessions/{code}/caps", headers=duo["gh"],
                    json={"target_id": duo["host"].id, "caps": ["collab.viewport"]})
    assert r.status_code == 403


def test_caps_endpoint_filters_dangerous_keys(client, db, duo):
    code = _open_and_join(client, duo, _study(db, "mdt9", duo["ha"].id).id)
    r = client.post(f"/api/collab/sessions/{code}/caps", headers=duo["hh"],
                    json={"target_id": duo["guest"].id,
                          "caps": ["collab.annotate", "report.write", "study.delete"]})
    assert r.status_code == 200, r.text
    seat = next(p for p in r.json()["participants"] if p["id"] == duo["guest"].id)
    assert seat["caps"] == ["collab.annotate"], f"위험 권한이 통과했다: {seat['caps']}"


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


def test_ws_guest_can_type_and_send_dm(client, db, duo):
    """초대한 쪽/시스템 관리자만 채팅 가능한 것이 아니다 — 상대 계정도 같은 DM을 보낸다.

    실제 회귀: admin 발신은 저장됐지만 초대받은 병원 계정은 입력 UI가 흔들려 발신 기록이
    하나도 남지 않았다. UI 수정과 별개로 서버의 양방향 계약도 여기서 고정한다.
    """
    from app.services.collab_service import dm_room

    _befriend(client, duo)
    tok = duo["hh"]["Authorization"].split(" ", 1)[1]
    gtok = duo["gh"]["Authorization"].split(" ", 1)[1]
    room = dm_room(duo["host"].id, duo["guest"].id)
    with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", tok]) as host_ws:
        host_ws.receive_json()
        with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", gtok]) as guest_ws:
            guest_ws.receive_json()
            _drain_to_pong(host_ws)  # guest 접속 presence 소진
            guest_ws.send_json({"t": "chat", "room": room, "body": "guest says hello"})
            assert "chat" in _drain_to_pong(guest_ws), "발신자 확정 에코가 없다"
            assert "chat" in _drain_to_pong(host_ws), "상대 계정 메시지가 admin 쪽에 도착하지 않았다"


def test_ws_friends_can_relay_dm_webrtc_signals(client, db, duo):
    """1:1 대화에서도 서버가 SDP를 열지 않고 정확한 친구에게만 릴레이한다."""
    from app.services.collab_service import dm_room

    _befriend(client, duo)
    tok = duo["hh"]["Authorization"].split(" ", 1)[1]
    gtok = duo["gh"]["Authorization"].split(" ", 1)[1]
    room = dm_room(duo["host"].id, duo["guest"].id)
    with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", tok]) as host_ws:
        host_ws.receive_json()
        with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", gtok]) as guest_ws:
            guest_ws.receive_json()
            _drain_to_pong(host_ws)
            host_ws.send_json({"t": "rtc.offer", "to": duo["guest"].id,
                               "room": room, "d": {"type": "offer", "sdp": "opaque"}})
            _drain_to_pong(host_ws)  # 발신 소켓 FIFO 처리 확정
            guest_ws.send_json({"t": "ping"})
            received = []
            for _ in range(50):
                event = guest_ws.receive_json()
                if event["t"] == "pong":
                    break
                received.append(event)
            offer = next((e for e in received if e["t"] == "rtc.offer"), None)
            assert offer is not None, "DM WebRTC offer가 친구에게 도착하지 않았다"
            assert offer["from"] == duo["host"].id and offer["room"] == room
            assert offer["d"] == {"type": "offer", "sdp": "opaque"}


def test_dm_webrtc_survives_being_in_a_session(client, db, duo):
    """검사 협진 세션에 들어가 있어도 1:1 DM 통화 시그널은 살아 있어야 한다.

    실제 회귀: 릴레이 분기를 프레임의 room 이 아니라 **소켓의 세션 소속**으로 고르면,
    협진 초대를 수락한 창(워크리스트가 CollabGlobal 에서 session.enter 를 보낸다)은
    그 뒤로 친구와의 음성·화상·화면공유 시그널이 전부 세션 분기에 먹혀 조용히 버려졌다.
    오류도 안 나고 새로고침 전까지 회복되지 않아, 사용자에게는 '통화가 안 된다'로만 보인다.
    """
    from app.services.collab_service import dm_room

    code = _open_and_join(client, duo, _study(db, "dmsess", duo["ha"].id).id)
    tok = duo["hh"]["Authorization"].split(" ", 1)[1]
    gtok = duo["gh"]["Authorization"].split(" ", 1)[1]
    room = dm_room(duo["host"].id, duo["guest"].id)
    with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", tok]) as host_ws:
        host_ws.receive_json()
        host_ws.send_json({"t": "session.enter", "code": code})   # ← 이 소켓이 세션에 들어간다
        _drain_to_pong(host_ws)
        with client.websocket_connect("/api/collab/ws", subprotocols=["sv.bearer", gtok]) as guest_ws:
            guest_ws.receive_json()
            _drain_to_pong(host_ws)
            host_ws.send_json({"t": "rtc.offer", "to": duo["guest"].id,
                               "room": room, "d": {"type": "offer", "sdp": "opaque"}})
            _drain_to_pong(host_ws)
            guest_ws.send_json({"t": "ping"})
            received = []
            for _ in range(50):
                event = guest_ws.receive_json()
                if event["t"] == "pong":
                    break
                received.append(event)
            offer = next((e for e in received if e["t"] == "rtc.offer"), None)
            assert offer is not None, "세션에 들어간 소켓의 DM offer 가 친구에게 도달하지 않았다"
            # room 이 벗겨지면 수신측 mesh(signalRoom=dm:…)가 다시 버린다 — 반드시 실려야 한다
            assert offer["room"] == room, "DM 릴레이에서 room 이 유실됐다"


def test_dm_webrtc_guard_requires_friend_and_exact_room(db, duo):
    """room ID 위조나 비친구 계정으로는 화상 시그널을 보낼 수 없다."""
    from app.api.collab_ws import _can_relay_dm_rtc
    from app.services import collab_service as svc

    stranger = _account(db, "rtc_signal_stranger", duo["hb"].id)
    svc.unfriend(db, duo["host"], stranger.id)  # 재실행해도 항상 비친구에서 시작
    room = svc.dm_room(duo["host"].id, stranger.id)
    assert _can_relay_dm_rtc(duo["host"].id, stranger.id, room) is False

    svc.request_friend(db, duo["host"], stranger.id)
    svc.respond_friend(db, stranger, duo["host"].id, True)
    assert _can_relay_dm_rtc(duo["host"].id, stranger.id, room) is True
    assert _can_relay_dm_rtc(duo["host"].id, stranger.id,
                             svc.dm_room(duo["host"].id, stranger.id + 999)) is False


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
