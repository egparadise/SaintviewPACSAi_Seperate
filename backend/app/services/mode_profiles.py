"""05 제품 모드 프로파일(S7 applyMode) — Core 기능은 동일, 화면 구성만 제품별 전환.

`mode.profiles` 전역 설정의 기본값. 관리자가 설정 화면(JSON 편집)에서 덮어쓸 수 있고,
설정이 없으면 본 기본값이 그대로 노출된다(07 A.7 ModeProfile 스키마의 v1 구현).

뷰어 프로파일(ty/infi)은 Client 뷰어 레지스트리(frontend lib/viewerConfig.ts CLIENT_VIEWERS)와
짝을 이룬다 — viewer.client_viewer 로 어떤 뷰어 구현을 띄울지까지 전환한다.
"""
from __future__ import annotations

_DEFAULT_COLUMNS = [
    "status", "ai", "patient_key", "patient_name", "sex", "study_date",
    "modality", "body_part", "study_desc", "impression", "series_count", "instance_count", "priority",
]
_DEFAULT_FIND_FIELDS = ["pid", "pname", "sex", "modality", "date", "desc", "status", "finding", "emergency"]

# 표기·순서 규약: SaintView → I-View → T-View (선택 뷰어 콤보·설정 트리와 동일).
# 키(saintvidw/infi/ty)는 사용자 viewer.prefs.mode_key 에 저장돼 있으므로 변경 금지 — 라벨만 규약을 따른다.
DEFAULT_MODE_PROFILES: dict = {
    "profiles": {
        "saintvidw": {
            "label": "SaintView",
            "worklist": {
                "columns": _DEFAULT_COLUMNS,
                "find_fields": _DEFAULT_FIND_FIELDS,
                "dbl_action": "viewer2d",
            },
            "viewer": {
                "paletteSide": "left", "thumbSide": "left",
                "thumbMode": "series", "reportDock": True,
            },
        },
        # infi — 신규 개발 뷰어(I-View) 레이아웃 저장소. 새 뷰어의 레이아웃을
        # 설정 화면 [현재 화면을 프로파일에 저장]으로 여기에 채워 넣는다.
        "infi": {
            "label": "I-View",
            "worklist": {
                "columns": ["status", "patient_name", "patient_key", "sex", "study_date",
                            "accession_no", "modality", "series_count", "instance_count",
                            "body_part", "impression"],
                "find_fields": _DEFAULT_FIND_FIELDS,
                "dbl_action": "viewer2d",
            },
            "viewer": {
                "client_viewer": "infi",
                "paletteSide": "top", "thumbSide": "bottom",
                "thumbMode": "series", "reportDock": False,
            },
        },
        # TY — 현행 자체 뷰어(Viewer2D) 레이아웃. 선택+적용 시 이 레이아웃으로 전환된다.
        "ty": {
            "label": "T-View",
            "worklist": {
                "columns": _DEFAULT_COLUMNS,
                "find_fields": _DEFAULT_FIND_FIELDS,
                "dbl_action": "viewer2d",
            },
            "viewer": {
                "client_viewer": "ty",
                "paletteSide": "left", "thumbSide": "left",
                "thumbMode": "series", "reportDock": True,
            },
        },
    },
}
