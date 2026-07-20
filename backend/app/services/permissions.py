"""역할(Role) 기반 권한 — 가입자 병원 운영 모델.

요청 사양: 관리자 · 의사 · 영상의학과 의사 · 방사선사 · 기타 의료인.
권한은 키 단위로 정의하고, 역할마다 허용 키 집합을 둔다(확장 용이).
관리자(admin)는 모든 권한을 가진다.

병원별 오버라이드: hospital 스코프 setting 'perm.matrix' 에 {"matrix": {role: [perm...]}}
형태로 저장하면 해당 병원 소속 사용자의 유효 권한이 기본 매트릭스 대신 적용된다
(effective_perms). admin 은 오버라이드 대상이 아니다(잠금 방지).
"""
from __future__ import annotations

from sqlalchemy.orm import Session

# 역할 키 → 표시명 (계정 생성/UI에 그대로 노출 — 기존 키 유지, 영문 등급 라벨 병기)
ROLES: dict[str, str] = {
    "admin": "시스템 관리자",
    "doctor": "의사(Doctor)",
    "radiologist": "영상의학과 의사(Radiologist)",
    "technologist": "방사선사(Radiographer)",
    "staff": "기타 의료인(Medician)",
}

# 병원 Client 계정 등급(관리자 제외) — 병원별 권한 매트릭스 편집 대상
CLIENT_ROLES: tuple[str, ...] = ("doctor", "radiologist", "technologist", "staff")

# 권한 키 → 설명
PERMISSIONS: dict[str, str] = {
    "users.manage": "계정 관리(생성·역할·소속)",
    "hospitals.manage": "가입자 병원 관리",
    "modalities.manage": "장비(SCU/SCP)·수신 관리",
    "server.manage": "서버 네트워크·백업 설정",
    "settings.global": "전역 설정 변경",
    "audit.view": "감사 로그 조회",
    "worklist.view": "워크리스트 조회",
    "study.import": "검사 수신·등록(영상 관리)",
    "report.read": "판독 조회",
    "report.write": "판독 작성·수정(초안)",
    "report.finalize": "판독 확정(서명)",
    "report.confirm2": "판독 2차 승인",
    # 영상(Study) 관리 — 병원별 등급 매트릭스 대상
    "study.delete": "영상 삭제",
    "study.move": "영상 이동(재귀속)",
    "study.match": "오더 매칭",
    "study.unmatch": "오더 언매칭",
    "study.copy": "영상 복제",
    "image.add": "영상 추가",
    "image.register": "영상 등록",
    "report.print": "판독 출력",
    "image.print": "영상 출력",
}

_ALL = set(PERMISSIONS.keys())

# 역할별 허용 권한(기본 매트릭스) — admin은 _ALL
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "admin": set(_ALL),
    # 영상의학과 의사: 판독의 — 작성·확정·2차 승인 + 판독/영상 출력
    "radiologist": {
        "worklist.view", "report.read", "report.write", "report.finalize", "report.confirm2",
        "report.print", "image.print",
    },
    # 의사(임상의): 조회·작성·확정(소속 진료과) + 판독/영상 출력
    "doctor": {
        "worklist.view", "report.read", "report.write", "report.finalize",
        "report.print", "image.print",
    },
    # 방사선사(Radiographer): 영상 수신·등록·추가·이동·매칭·복제 + 조회(판독 작성·확정 불가)
    "technologist": {
        "worklist.view", "study.import", "report.read",
        "image.add", "image.register", "study.move", "study.match", "study.unmatch",
        "study.copy", "image.print",
    },
    # 기타 의료인(Medician): 검색·조회 전용
    "staff": {
        "worklist.view", "report.read",
    },
}


def perms_for(role: str) -> set[str]:
    return ROLE_PERMISSIONS.get(role, set())


def effective_perms(db: Session | None, role: str, hospital_id: int | None) -> set[str]:
    """병원별 오버라이드('perm.matrix' hospital 스코프)를 반영한 유효 권한.

    - admin 은 항상 전체 권한(오버라이드로 관리자를 잠글 수 없다).
    - db 또는 hospital_id 가 없으면 전역 기본 매트릭스로 폴백.
    - 오버라이드에 없는 역할은 기본 매트릭스 유지(부분 오버라이드 허용).
    """
    if role == "admin":
        return set(_ALL)
    base = set(ROLE_PERMISSIONS.get(role, set()))
    if db is None or not hospital_id:
        return base
    try:
        from app.services.settings_service import get_hospital_setting

        stored = get_hospital_setting(db, hospital_id, "perm.matrix", default=None)
    except Exception:  # noqa: BLE001 — 설정 조회 실패는 기본 매트릭스로 우아 강등
        return base
    matrix = (stored or {}).get("matrix") if isinstance(stored, dict) else None
    if isinstance(matrix, dict) and role in matrix and isinstance(matrix[role], list):
        return {p for p in matrix[role] if p in PERMISSIONS}
    return base


def has_perm(role: str, perm: str, db: Session | None = None,
             hospital_id: int | None = None) -> bool:
    """권한 확인 — 기존 호출부(has_perm(role, perm)) 시그니처 호환 유지.

    db·hospital_id 를 주면 병원별 오버라이드를 반영한 유효 권한으로 검사한다
    (전역 검사는 기본 매트릭스 폴백).
    """
    if role == "admin":
        return True
    if db is not None and hospital_id:
        return perm in effective_perms(db, role, hospital_id)
    return perm in ROLE_PERMISSIONS.get(role, set())


def role_catalog() -> dict:
    """UI용 — 역할/권한 목록과 매트릭스."""
    return {
        "roles": [
            {"key": k, "label": v, "perms": sorted(perms_for(k))} for k, v in ROLES.items()
        ],
        "permissions": [{"key": k, "label": v} for k, v in PERMISSIONS.items()],
    }
