"""로컬 서버 폴더 공유 — server.network.local_share_dir의 파일 목록/다운로드.

워크리스트 [Local Server] 버튼에서 사용. 경로 이탈(path traversal) 방지를 위해
공유 루트 안의 파일만 접근을 허용한다.
추가: /fs(관리자 전용 서버측 폴더 탐색 — 설정 화면 폴더 찾기), /config(현재 공유 설정 조회),
      ?sub= 하위 폴더 목록(이미지 데이터 폴더 구조 탐색).
"""
from __future__ import annotations

import os
import string
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user
from app.db import get_db
from app.services.settings_service import get_setting

router = APIRouter(prefix="/api/share", tags=["share"])

# 폴더 나열 상한 — 대형 디렉토리(수천 항목)에서 응답 지연 방지
_MAX_ENTRIES = 500


def _share_dir_raw(db: Session) -> str:
    cfg = get_setting(db, "server.network", default={}) or {}
    return str(cfg.get("local_share_dir", "") or "").strip()


def _share_root(db: Session) -> Path:
    raw = _share_dir_raw(db)
    if not raw:
        raise HTTPException(status_code=404, detail="공유 디렉토리가 설정되지 않았습니다 — 설정>서버 네트워크")
    root = Path(raw).resolve()
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"공유 디렉토리가 존재하지 않습니다: {raw}")
    return root


@router.get("/config")
def share_config(db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """현재 공유 디렉토리 설정 조회 — 미설정이어도 404가 아니다(설정 화면 초기 표시용)."""
    raw = _share_dir_raw(db)
    exists = bool(raw) and Path(raw).is_dir()
    return {"dir": raw, "exists": exists}


@router.get("/fs")
def share_fs(path: str = "", files: str = "",
             db: Session = Depends(get_db), user: dict = Depends(admin_user)):
    """서버측 폴더 탐색(관리자 전용) — 설정>서버 네트워크 [폴더 찾기]·DB 도구 [찾기]에서 사용.

    path 빈 값 → Windows 드라이브 목록(C:\\ D:\\ … 존재하는 것만) + 현재 공유 디렉토리.
    path 지정 → 해당 폴더의 하위 폴더 목록(폴더만, 접근 불가 폴더는 건너뜀).
    files 지정(확장자, 예 'exe') → 해당 확장자 파일 목록도 함께 반환(실행 파일 선택용).
    """
    raw = path.strip()
    ext = files.strip().lstrip(".").lower()
    if not raw:
        drives = [f"{c}:\\" for c in string.ascii_uppercase if Path(f"{c}:\\").is_dir()]
        return {
            "path": "",
            "parent": None,
            "dirs": [{"name": d, "path": d} for d in drives],
            "files": [],
            "exists": True,
            "share_dir": _share_dir_raw(db),
        }
    p = Path(raw).resolve()  # resolve — 심볼릭 링크 루프 방지·정규화
    if not p.is_dir():
        return {"path": str(p), "parent": None, "dirs": [], "files": [], "exists": False}
    parent = None if p.parent == p else str(p.parent)  # 드라이브 루트면 상위 없음
    dirs: list[dict] = []
    file_items: list[dict] = []
    try:
        with os.scandir(p) as it:
            for entry in it:
                if len(dirs) + len(file_items) >= _MAX_ENTRIES:
                    break
                try:
                    # follow_symlinks=False — 심볼릭 루프·네트워크 지연 방지
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append({"name": entry.name, "path": str(Path(p, entry.name))})
                    elif ext and entry.is_file(follow_symlinks=False) \
                            and entry.name.lower().endswith("." + ext):
                        file_items.append({"name": entry.name, "path": str(Path(p, entry.name))})
                except (PermissionError, OSError):
                    continue  # 접근 불가 항목은 건너뜀
    except (PermissionError, OSError):
        raise HTTPException(status_code=403, detail="폴더에 접근할 수 없습니다")
    dirs.sort(key=lambda d: d["name"].lower())
    file_items.sort(key=lambda d: d["name"].lower())
    return {"path": str(p), "parent": parent, "dirs": dirs, "files": file_items, "exists": True}


@router.get("")
def list_share(sub: str = "", db: Session = Depends(get_db), user: dict = Depends(current_user)):
    """공유 루트(또는 sub= 상대 하위 폴더)의 목록 — 이미지 데이터 폴더 구조 탐색 지원."""
    root = _share_root(db)
    base = root
    rel = ""
    if sub.strip():
        base = (root / sub).resolve()
        # root 이탈 방지 — /file 과 동일 가드(resolve 후 parents 검사)
        if root not in base.parents and base != root:
            raise HTTPException(status_code=400, detail="허용되지 않은 경로")
        if not base.is_dir():
            raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")
        rel = base.relative_to(root).as_posix() if base != root else ""
    def _safe_mtime(x: Path) -> float:
        # 정렬 키에서 stat()이 던지면(끊긴 심볼릭 링크·권한 거부) 목록 전체가 500 — 안전 폴백
        try:
            return x.stat().st_mtime
        except OSError:
            return 0.0

    items = []
    for p in sorted(base.iterdir(), key=_safe_mtime, reverse=True)[:200]:
        try:
            st = p.stat()
            items.append({
                "name": p.name,
                "is_dir": p.is_dir(),
                "size": st.st_size if p.is_file() else 0,
                "mtime": int(st.st_mtime),
            })
        except OSError:
            continue
    return {"dir": str(root), "sub": rel, "items": items}


@router.get("/file")
def get_share_file(name: str, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    root = _share_root(db)
    target = (root / name).resolve()  # name 은 상대 하위경로 허용(예: sub/폴더/파일)
    if root not in target.parents and target != root:
        raise HTTPException(status_code=400, detail="허용되지 않은 경로")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    return FileResponse(target, filename=target.name)
