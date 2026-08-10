"""A 계정 목록 미러링 — **아이디·이름·역할만**. 인증은 여전히 A 가 한다.

■ 무엇을 하고 무엇을 안 하나
  · 한다  : A 의 `GET /api/user/` 목록을 받아 우리 accounts 테이블에 같은 사용자명을 만든다.
            워크리스트 담당자 지정·판독 귀속 표시·권한 매트릭스 편집 대상이 생긴다.
  · 안 한다: **비밀번호를 가져오지 않는다.** 가져올 수도 없다 —
            ① A 는 목록 응답에서 user_passwd 를 빼고 준다(router/User.py:35)
            ② 설령 있어도 A 는 `sha256(salt+pw)+'.'+salt` 단방향이라 원문 복원이 불가능하다

■ 그래서 미러 계정은 **로컬 비밀번호로 로그인할 수 없다**
  password_hash 를 빈 문자열로 둔다. auth_service.verify_password 는 argon2 해시가 아닌 값에
  VerifyMismatchError 가 아닌 예외가 나도 False 를 돌려주므로(auth_service.py:22-28)
  어떤 입력을 넣어도 통과할 수 없다. 이건 우연이 아니라 **이 설계가 기대는 계약**이라
  tests/test_account_mirror.py 가 되돌리면 실패하도록 고정한다.
  로그인은 `/api/auth/webpacs-login`(A 가 검증) 으로만 된다.

■ 사라진 계정
  A 에서 없어졌거나 차단(user_status='D')된 사용자는 **지우지 않고 비활성**(enabled=False)한다.
  판독 기록이 그 계정을 참조하므로 지우면 이력이 끊긴다. 되살아나면 다시 활성화된다.

■ 손으로 만든 계정은 건드리지 않는다
  a_user_idx 가 있는(=미러로 생긴) 계정만 이 동기화의 대상이다. 관리자가 직접 만든 로컬 계정을
  'A 에 없다'는 이유로 잠그면 관리자가 자기 시스템에서 잠길 수 있다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

# A 의 user_type 은 R(remote)·M(manage)·P(pacs) 조합 문자열이고, group_level 은 등급이다.
# 우리 역할(permissions.ROLES)로 옮기는 규칙 — 넘겨짚지 않고 **좁게** 잡는다.
#   · 관리자급(group_level>=98)만 admin — A 의 판독권한 게이트와 같은 기준(router/User.py:88)
#   · 그 외 P(pacs) 포함 = 판독을 보는 사람 → radiologist
#   · P 가 없으면 우리 화면에서 할 일이 없다 → staff(최소 권한)
ADMIN_LEVEL = 98


@dataclass
class MirrorResult:
    created: int = 0
    updated: int = 0
    disabled: int = 0
    skipped: int = 0
    names: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"created": self.created, "updated": self.updated,
                "disabled": self.disabled, "skipped": self.skipped,
                "accounts": self.names}


def map_role(user_type: str | None, group_level: int | None) -> str:
    """A 사용자 구분 → 우리 역할. 모르면 최소 권한으로 떨어뜨린다(넓게 주지 않는다)."""
    if (group_level or 0) >= ADMIN_LEVEL:
        return "admin"
    return "radiologist" if "P" in str(user_type or "").upper() else "staff"


def is_active(row: dict) -> bool:
    """A 에서 쓰는 계정인가. user_status 'A'=사용 / 'D'=차단."""
    return str(row.get("user_status") or "A").upper() != "D"


def apply_doctor_profile(account, *, name: str, license_no: str, major_no: str = "") -> bool:
    """A 의사 정보 → 판독의 등록(설정>판독>기본 설정: 이름·면허번호·전문의 번호) **자동 채움**.

    2026-08-07·10 사용자 확정: 의사가 자기 A 계정(ID/PW)으로 로그인하면 확정 서명에 쓰는
    이름·의사면허번호·전문의 번호가 자동으로 채워지고, **번호가 없는 계정은 공란**이어야 한다.

    ⚠ **미러 계정만** 건드린다(a_user_idx 있는 행) — 손으로 만든 로컬 계정의 프로필을
      A 값으로 덮으면 관리자 표시명이 바뀌는 사고가 된다(ensure_mirror 의 보호 계약과 동일).
    A 가 방금 인증해 준 값이므로 매 로그인 갱신이 맞다(A 가 진실의 원천).
    번호 두 개는 값이 비어도 **공란으로 덮어쓴다** — A 에서 번호가 삭제된 계정에 이전
    로그인의 스테일 번호가 남으면 서명이 거짓이 된다. 이름만은 비면 유지(표시명 보호).
    반환: 실제로 값을 바꿨는가."""
    if getattr(account, "a_user_idx", None) is None:
        return False
    if name:
        account.display_name = str(name)[:64]
    account.license_no = str(license_no or "")[:32]
    account.major_no = str(major_no or "")[:32]
    return True


def ensure_mirror(db: Session, *, user_id: str, name: str, role: str,
                  a_user_idx: int = 0, hospital_id: int | None = None) -> "Account":
    """A 로그인 **성공 직후** 그 계정 하나의 미러 행을 보장한다(멱등).

    ⚠ 왜 필요한가(실제 사고): 협진(친구·메신저·세션)은 Account.id 기반이다. A 계정으로
      로그인한 사용자는 미러 행이 없으면 /api/collab/* 가 실패하는데, 그것이 401 로 나가던
      시절 프론트 전역 처리기가 '세션 만료' 로 오인해 **강제 로그아웃**시켰다 —
      "협진 버튼을 누르면 화면이 튕겨 나간다" 가 그 증상이다.
      A 가 방금 신원을 검증해 줬으므로 이 시점의 미러 생성은 sync_accounts 와 같은 성격이다
      (아이디·이름·역할만, password_hash="" 로 로컬 로그인 불가 — 모듈 주석의 계약 동일).

    ⚠ sync_accounts 를 1건짜리 목록으로 재사용하면 안 된다 — 그 함수는 '목록에 없는 미러를
      비활성' 하므로 나머지 미러 전원이 꺼진다.

    손으로 만든 동명 로컬 계정(a_user_idx 없음)은 **건드리지 않고 그대로 쓴다** —
    미러로 바꾸면 관리자가 자기 계정에서 잠길 수 있다(sync_accounts 와 같은 규칙).
    """
    from app.models import Account

    acc = db.execute(select(Account).where(Account.username == user_id)).scalar_one_or_none()
    if acc is not None:
        if getattr(acc, "a_user_idx", None):
            # 미러 행 — 이름·활성만 따라간다. 역할은 관리자가 손봤을 수 있어 덮지 않는다.
            if name and acc.title != name:
                acc.title = name
            # 실명 표시용 — 비어 있을 때만 채운다(관리자가 손본 표시명은 존중).
            # 없으면 협진 목록·커서 라벨·메시지 발신자가 전부 로그인 아이디로 나온다.
            if name and not acc.display_name:
                acc.display_name = name
            if not acc.enabled:
                acc.enabled = True          # A 가 방금 인증했다 — 차단이 풀린 계정이다
            if a_user_idx and not acc.a_user_idx:
                acc.a_user_idx = a_user_idx
        return acc
    acc = Account(username=user_id, password_hash="", role=role, hospital_id=hospital_id,
                  enabled=True, title=name, display_name=name, a_user_idx=a_user_idx or 0)
    db.add(acc)
    db.flush()
    return acc


def sync_accounts(db: Session, rows: list[dict], *, hospital_id: int | None = None,
                  dry_run: bool = False) -> MirrorResult:
    """A 사용자 목록 → accounts 미러(멱등). 같은 목록을 두 번 넣어도 결과가 같다."""
    from app.models import Account

    res = MirrorResult()
    seen: set[str] = set()

    for row in rows:
        uid = str(row.get("user_id") or "").strip()
        if not uid:
            res.skipped += 1
            continue
        seen.add(uid)
        name = str(row.get("user_name") or "").strip()
        role = map_role(row.get("user_type"), row.get("group_level"))
        active = is_active(row)
        try:
            a_idx = int(row.get("user_idx"))
        except (TypeError, ValueError):
            a_idx = 0

        acc = db.execute(select(Account).where(Account.username == uid)).scalar_one_or_none()
        if acc is None:
            if dry_run:
                res.created += 1
                res.names.append(uid)
                continue
            acc = Account(
                username=uid,
                # ★ 빈 해시 = 로컬 비밀번호 로그인 불가. 위 모듈 주석의 계약이다.
                password_hash="",
                role=role,
                hospital_id=hospital_id,
                enabled=active,
                title=name,
                display_name=name,   # 협진 목록·커서 라벨이 실명으로 보이게(ensure_mirror 동일)
                a_user_idx=a_idx,
            )
            db.add(acc)
            res.created += 1
            res.names.append(uid)
            continue

        # 손으로 만든 로컬 계정은 건드리지 않는다(미러가 아니다)
        if not getattr(acc, "a_user_idx", 0):
            res.skipped += 1
            continue
        changed = False
        for attr, val in (("role", role), ("enabled", active), ("title", name),
                          ("a_user_idx", a_idx or acc.a_user_idx)):
            if getattr(acc, attr) != val:
                if not dry_run:
                    setattr(acc, attr, val)
                changed = True
        # 실명 표시 백필 — 비어 있을 때만(관리자가 손본 표시명은 존중, ensure_mirror 동일 규칙)
        if name and not acc.display_name:
            if not dry_run:
                acc.display_name = name
            changed = True
        if changed:
            res.updated += 1
            res.names.append(uid)

    # A 목록에서 사라진 미러 계정 → 비활성(삭제하지 않는다 — 판독 이력이 참조한다)
    gone = db.execute(
        select(Account).where(Account.a_user_idx.isnot(None), Account.a_user_idx != 0,
                              Account.enabled.is_(True))
    ).scalars().all()
    for acc in gone:
        if acc.username in seen:
            continue
        if not dry_run:
            acc.enabled = False
        res.disabled += 1
        res.names.append(acc.username)

    if not dry_run:
        db.commit()
    return res
