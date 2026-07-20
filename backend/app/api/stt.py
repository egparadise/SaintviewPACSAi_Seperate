"""음성 판독(STT) 서버 엔진 — Whisper 오픈소스(로컬) 또는 상용 API.

Setting>AI 정책(stt_engine)에서 선택:
- browser      : 브라우저 내장(Web Speech) — 서버 미사용(기본)
- whisper_local: OpenAI Whisper 오픈소스 (faster-whisper 권장, openai-whisper 폴백) — PHI 안전(온프레미스)
- openai_api   : 상용 OpenAI API(whisper-1) — ⚠ 음성이 외부로 전송됨, 키는 환경변수 OPENAI_API_KEY(절대 규칙 4)
"""
from __future__ import annotations

import logging
import os
import tempfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.services.settings_service import get_setting

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/stt", tags=["stt"])

_MAX_BYTES = 25 * 1024 * 1024
_model_cache: dict[str, object] = {}


def _whisper_local(data: bytes, model_name: str) -> str:
    """faster-whisper 우선, openai-whisper 폴백. 모델은 프로세스 캐시."""
    path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
            f.write(data)
            path = f.name
        try:
            from faster_whisper import WhisperModel  # type: ignore

            key = f"fw:{model_name}"
            if key not in _model_cache:
                _model_cache[key] = WhisperModel(model_name, device="cpu", compute_type="int8")
            m = _model_cache[key]
            segments, _info = m.transcribe(path, language="ko")  # type: ignore[attr-defined]
            return " ".join(s.text.strip() for s in segments).strip()
        except ImportError:
            pass
        try:
            import whisper  # type: ignore  # openai-whisper (ffmpeg 필요)

            key = f"ow:{model_name}"
            if key not in _model_cache:
                _model_cache[key] = whisper.load_model(model_name)
            r = _model_cache[key].transcribe(path, language="ko")  # type: ignore[attr-defined]
            return str(r.get("text", "")).strip()
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="Whisper 미설치 — `pip install faster-whisper`(권장) 또는 `pip install openai-whisper`(+ffmpeg) 후 사용",
            )
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _openai_api(data: bytes, filename: str, content_type: str, model_name: str) -> str:
    import httpx

    key = os.getenv("OPENAI_API_KEY", "")
    if not key:
        raise HTTPException(status_code=501, detail="OPENAI_API_KEY 환경변수가 설정되지 않았습니다 (키는 env로만 — 절대 규칙 4)")
    r = httpx.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {key}"},
        data={"model": model_name or "whisper-1", "language": "ko"},
        files={"file": (filename or "dictation.webm", data, content_type or "audio/webm")},
        timeout=120,
    )
    if r.status_code != 200:
        logger.error("OpenAI STT 실패: %s %s", r.status_code, r.text[:200])
        raise HTTPException(status_code=502, detail=f"OpenAI STT 실패 (HTTP {r.status_code})")
    return str(r.json().get("text", "")).strip()


def _engine_available() -> dict:
    """설치·설정 상태 프로브 — 관리자 패널이 어떤 STT 엔진을 쓸 수 있는지 표시."""
    fw = ow = False
    try:
        import faster_whisper  # type: ignore  # noqa: F401

        fw = True
    except ImportError:
        pass
    try:
        import whisper  # type: ignore  # noqa: F401

        ow = True
    except ImportError:
        pass
    return {
        "faster_whisper": fw,          # 권장 로컬 엔진
        "openai_whisper": ow,          # 폴백 로컬 엔진(ffmpeg 필요)
        "whisper_local": fw or ow,     # 로컬 Whisper 사용 가능 여부
        "openai_api_key": bool(os.getenv("OPENAI_API_KEY")),
    }


@router.get("/status")
def stt_status(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """현재 STT 엔진 설정 + 서버 설치/키 상태. 관리자 설정·Client 마이크 UI 가 소비."""
    policy = get_setting(db, "ai.policy", default={}) or {}
    engine = str(policy.get("stt_engine", "browser") or "browser")
    avail = _engine_available()
    # 선택 엔진이 실제 구동 가능한지
    ready = (
        engine == "browser"
        or (engine == "whisper_local" and avail["whisper_local"])
        or (engine == "openai_api" and avail["openai_api_key"])
    )
    return {
        "engine": engine,
        "model": str(policy.get("stt_model", "") or ""),
        "ready": ready,
        "available": avail,
    }


@router.post("")
async def transcribe(
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: dict = Depends(current_user),
):
    policy = get_setting(db, "ai.policy", default={}) or {}
    engine = policy.get("stt_engine", "browser")
    model_name = str(policy.get("stt_model", "") or "")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="오디오가 비어 있습니다")
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=400, detail="오디오는 25MB 이하")

    if engine == "whisper_local":
        text = _whisper_local(data, model_name or "base")
    elif engine == "openai_api":
        text = _openai_api(data, audio.filename or "", audio.content_type or "", model_name)
    else:
        raise HTTPException(
            status_code=400,
            detail="서버 STT 비활성 — 설정>AI 정책에서 엔진(Whisper 로컬/OpenAI API)을 선택하세요",
        )

    from app.models import AuditLog

    db.add(AuditLog(action="stt_transcribe", target_type="stt", target_id=engine,
                    detail={"by": user["sub"], "bytes": len(data), "chars": len(text)}))
    db.commit()
    return {"text": text, "engine": engine}
