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
