"""상용구(Predefined Readings) API — DB 정식 테이블 CRUD (화면분석 §5.6 + 단축키).

기존 app_setting(report.phrases) JSON에 저장돼 있던 항목은 최초 목록 조회 때
한 번 테이블로 이관한다(레거시 호환).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import AuditLog, Phrase

router = APIRouter(prefix="/api/phrases", tags=["phrases"])


def _out(p: Phrase) -> dict:
    return {
        "id": p.id, "name": p.name, "text": p.text, "modality": p.modality,
        "body_part": p.body_part, "category": p.category, "shortcut": p.shortcut,
        "kind": p.kind, "reading_text": p.reading_text,
        "created_by": p.created_by,
    }


def _category(modality: str, body_part: str) -> str:
    return "-".join(x for x in (modality, body_part) if x) or "공통"


def _migrate_legacy(db: Session) -> None:
    """report.phrases 설정 → phrases 테이블 1회 이관."""
    from app.services.settings_service import get_setting, set_setting

    legacy = get_setting(db, "report.phrases", default=None)
    if not legacy or not legacy.get("items"):
        return
    for it in legacy["items"]:
        db.add(Phrase(
            name=str(it.get("name", ""))[:128] or "(무제)",
            text=str(it.get("text", "")),
            modality=str(it.get("modality", ""))[:16],
            body_part=str(it.get("body_part", ""))[:64],
            category=str(it.get("group", "")) or _category(str(it.get("modality", "")), str(it.get("body_part", ""))),
            created_by="migrated",
        ))
    set_setting(db, "report.phrases", {"items": [], "migrated": True})
    db.commit()


@router.get("")
def list_phrases(
    modality: str = "", db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    if db.execute(select(Phrase.id).limit(1)).first() is None:
        _migrate_legacy(db)
    q = select(Phrase).order_by(Phrase.category, Phrase.name)
    rows = db.execute(q).scalars().all()
    items = [_out(p) for p in rows]
    if modality:  # 맞춤 필터(모달리티 일치 또는 공통)는 프론트에서도 가능 — 서버 필터 옵션 제공
        items = [p for p in items if not p["modality"] or p["modality"] == modality]
    return {"items": items}


class PhraseBody(BaseModel):
    name: str
    text: str = ""             # 결론(Conclusion) 본문
    reading_text: str = ""     # 판독(Reading) 본문
    modality: str = ""
    body_part: str = ""
    shortcut: str = ""
    kind: str = "phrase"       # phrase(단축키) | template(템플릿)


def _validate(body: PhraseBody, db: Session, *, exclude_id: int | None = None) -> None:
    if body.kind not in ("phrase", "template"):
        raise HTTPException(status_code=400, detail="kind는 phrase|template")
    if not body.name.strip() or not (body.text.strip() or body.reading_text.strip()):
        raise HTTPException(status_code=400, detail="이름과 본문(판독 또는 결론)은 필수입니다")
    if body.shortcut and body.kind == "phrase":
        if len(body.shortcut) != 1 or not body.shortcut.isalnum():
            raise HTTPException(status_code=400, detail="단축키는 영문/숫자 1글자 (Alt+키로 삽입)")
        dup = db.execute(
            select(Phrase).where(Phrase.shortcut == body.shortcut.upper())
        ).scalars().all()
        if any(p.id != exclude_id for p in dup):
            raise HTTPException(status_code=409, detail=f"단축키 '{body.shortcut.upper()}'는 이미 사용 중입니다")


@router.post("")
def create_phrase(body: PhraseBody, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    _validate(body, db)
    p = Phrase(
        name=body.name.strip()[:128], text=body.text, reading_text=body.reading_text,
        modality=body.modality.strip().upper()[:16], body_part=body.body_part.strip().upper()[:64],
        category=_category(body.modality.strip().upper(), body.body_part.strip().upper()),
        shortcut=(body.shortcut.strip().upper()[:8] if body.kind == "phrase" else ""),
        kind=body.kind, created_by=user["sub"],
    )
    db.add(p)
    db.add(AuditLog(action="phrase_create", target_type="phrase", target_id=p.name,
                    detail={"by": user["sub"]}))
    db.commit()
    return _out(p)


@router.put("/{phrase_id}")
def update_phrase(
    phrase_id: int, body: PhraseBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    p = db.get(Phrase, phrase_id)
    if not p:
        raise HTTPException(status_code=404, detail="상용구를 찾을 수 없습니다")
    _validate(body, db, exclude_id=phrase_id)
    p.name = body.name.strip()[:128]
    p.text = body.text
    p.reading_text = body.reading_text
    p.modality = body.modality.strip().upper()[:16]
    p.body_part = body.body_part.strip().upper()[:64]
    p.category = _category(p.modality, p.body_part)
    p.kind = body.kind
    p.shortcut = body.shortcut.strip().upper()[:8] if body.kind == "phrase" else ""
    db.add(AuditLog(action="phrase_update", target_type="phrase", target_id=str(phrase_id),
                    detail={"by": user["sub"]}))
    db.commit()
    return _out(p)


@router.delete("/{phrase_id}")
def delete_phrase(phrase_id: int, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    p = db.get(Phrase, phrase_id)
    if not p:
        raise HTTPException(status_code=404, detail="상용구를 찾을 수 없습니다")
    db.delete(p)
    db.add(AuditLog(action="phrase_delete", target_type="phrase", target_id=str(phrase_id),
                    detail={"by": user["sub"], "name": p.name}))
    db.commit()
    return {"ok": True}
