from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.services.settings_service import WL_HOSPITAL_KEYS, get_setting, set_setting

router = APIRouter(prefix="/api/settings", tags=["settings"])

# 노출 허용 키 화이트리스트 (임의 키 남용 방지)
ALLOWED_KEYS = {
    "pdf.template",          # 기관/부서/푸터 (관리자)
    "ai.policy",             # 자동생성·vision 토글 (관리자)
    "worklist.prefs",        # 사용자 기본 필터·자동갱신·컬럼 구성(F-8)
    "viewer.prefs",          # 사용자 뷰어 환경(행잉·오버레이)
    "report.phrases",        # 상용구 사전 (화면분석 §5.6 Predefined Readings)
    "mode.profiles",         # 05 제품 모드 프로파일 JSON (S7 — 전역/관리자 전용)
    "worklist.tabs",         # 워크리스트 페이지 탭 (UBPACS-Z 최대 10페이지 패턴)
    "worklist.tree",         # 검색 폴더 트리 (탐색기형 — 조건 누적 병합)
    "dicom.nodes",           # SCP/SCU 장비 노드 목록 (AE Title/IP/Port — 전역/관리자)
    "viewer.hp",             # 행잉 프로토콜 규칙 (장비×부위×Projection → Series/Image layout)
    "report.prefs",          # 리포트 구성 (AI 패널 표시·자동 적용 — UBPACS Report Composition)
    "server.network",        # 서버 네트워크 (로컬 공유 디렉토리·웹서버 IP/Port/Name/AET — 전역)
    "report.phrases_local",  # 계정별 로컬 단축키·템플릿의 서버 백업(주기 — 설정>판독)
    # 관리자 콘솔 서버 섹션(14개 요구) — 가입 환경·AI 등록·DB 도구(전역/관리자 전용)
    "signup.fields.hospital",  # 가입 환경 — 병원 입력 항목 {fields:[{key,label,enabled,required}]}
    "signup.fields.client",    # 가입 환경 — Client 입력 항목
    "signup.fields.modality",  # 가입 환경 — Modality 입력 항목
    "ai.providers",            # AI 등록 항목(오픈소스+상업 API, RAG — placeholder) {items:[...]}
    "server.dbtool",           # DB 프로그램 열기 — 서버측 외부 도구 경로 {path}
    # 병원(hospital) 스코프 키 — 전용 엔드포인트(/api/hospitals/{hid}/...)로 읽고 쓴다
    "perm.matrix",           # 병원별 등급 권한 매트릭스 (GET|PUT /hospitals/{hid}/perm-matrix)
    "modality.nodes",        # 병원별 SCP Modality 등록 (GET|PUT /hospitals/{hid}/modalities)
    "hospital.scu",          # 병원 SCU IP/Port (GET|PUT /hospitals/{hid}/scu)
    # 병원 스코프 — EMR/장비 연동(레인 H, GET|PUT /api/hl7/hospitals/{hid}/config/{key})
    "hl7.config",            # MLLP 수신 {enabled, port, facility(MSH-5/6 매핑), oru:{host,port}}
    "remote.reading",        # 원격판독 입력 창구 {enabled, api_key}
    "mwl.config",            # MWL SCP {enabled, port, aet, registered_only}
    "testgen.config",        # 가상 환자 생성 규칙 {pid_prefix, acc_prefix, modalities …}
    # 전역 전용 — 인프라/보안 (레인 O·S)
    "infra.containers",      # 병원별 컨테이너 오케스트레이션 설정 (전역/관리자)
    "ddns.config",           # DDNS 설정 (전역/관리자)
    "security.policy",       # 보안 정책(로그인 잠금 등 — 전역/관리자)
}

# 전역(global) 스코프만 허용하는 키 — 관리자 전용 서버 설정(사용자 스코프 오염 방지)
GLOBAL_ONLY_KEYS = {
    "mode.profiles", "dicom.nodes", "server.network",
    "signup.fields.hospital", "signup.fields.client", "signup.fields.modality",
    "ai.providers", "server.dbtool",
    "infra.containers", "ddns.config", "security.policy",
}

# 계정별(user) 스코프만 허용하는 뷰어 설정 키 — 전역 저장·전역 폴백 금지(계정 간 누출 방지).
# 규칙: '뷰어에 따라 바꿀 수 있는 모든 값'(툴·레이아웃·글자크기·행잉·워크리스트 구성)은 계정에 귀속.
USER_ONLY_KEYS = {
    "viewer.prefs", "worklist.prefs", "report.prefs", "viewer.hp",
    "worklist.tree", "worklist.tabs", "report.phrases_local",
}


class SettingBody(BaseModel):
    value: dict
    scope: str = "user"  # user | global


@router.get("/{key}")
def read_setting(key: str, db: Session = Depends(get_db), user: dict = Depends(current_user)):
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=404, detail="알 수 없는 설정 키")
    if key in USER_ONLY_KEYS:
        # 뷰어 설정 — 계정(user) 스코프만 조회(전역 폴백 차단 → 계정 간 누출 방지)
        from sqlalchemy import select as _select

        from app.models import AppSetting
        row = db.execute(_select(AppSetting).where(
            AppSetting.scope == "user", AppSetting.scope_id == user["sub"], AppSetting.key == key
        )).scalar_one_or_none()
        if row is not None:
            return {"key": key, "value": row.value}
        # 계정 설정이 없으면 소속 병원 기본값 폴백(관리 콘솔 [뷰어·워크리스트 설정]) —
        # 자기 병원(hid)만 조회하므로 병원 간 누출 없음. 개인 설정 저장 시 그 값이 우선.
        hid = user.get("hid")
        if hid is not None and key in WL_HOSPITAL_KEYS:
            from app.services.settings_service import get_hospital_setting
            hv = get_hospital_setting(db, int(hid), key)
            if hv is not None:
                return {"key": key, "value": hv}
        return {"key": key, "value": {}}
    # 전역 전용 키는 user 스코프 무시 — 과거에 남은 user 사본이 전역 값을 가리는 것 방지
    value = get_setting(db, key, user="" if key in GLOBAL_ONLY_KEYS else user["sub"], default={})
    if key == "mode.profiles" and not value:
        from app.services.mode_profiles import DEFAULT_MODE_PROFILES

        value = DEFAULT_MODE_PROFILES
    return {"key": key, "value": value}


@router.put("/{key}")
def write_setting(
    key: str, body: SettingBody, db: Session = Depends(get_db), user: dict = Depends(current_user)
):
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=404, detail="알 수 없는 설정 키")
    if key in GLOBAL_ONLY_KEYS and body.scope != "global":
        raise HTTPException(status_code=400, detail=f"{key}는 전역(global) 설정만 허용")
    if key in USER_ONLY_KEYS and body.scope != "user":
        raise HTTPException(status_code=400, detail=f"{key}는 계정별(user) 설정만 허용 — 전역 저장 금지")
    if key == "worklist.tabs" and len(body.value.get("items", [])) > 10:
        raise HTTPException(status_code=400, detail="워크리스트 페이지는 최대 10개입니다 (UBPACS-Z 규격)")
    if body.scope == "global":
        if user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="전역 설정은 관리자만 변경할 수 있습니다")
        set_setting(db, key, body.value, scope="global")
    elif body.scope == "user":
        set_setting(db, key, body.value, scope="user", scope_id=user["sub"])
    else:
        raise HTTPException(status_code=400, detail="scope는 user|global")
    return {"ok": True, "key": key, "scope": body.scope}
