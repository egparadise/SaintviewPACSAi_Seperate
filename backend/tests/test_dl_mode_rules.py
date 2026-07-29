"""다운로드 모드(설정>환경 '영상 취득') 규정 회귀 — 프론트 순수 함수 실행 + 접합점 소스 검증.

이 회차의 지적은 전부 '함수는 있는데 그 함수가 실제로는 아무 일도 하지 않는' 형태였다.
그런 결함은 타입 검사도 빌드도 잡지 못한다(전부 통과했는데 실서버에서 났다). 그래서
① 규칙을 순수 함수로 뺀 것은 Node 로 원본 그대로 실행하고,
② 함수로 뺄 수 없는 접합점(뷰어 게이트·401 순서·창 간 신호)은 소스에서 직접 확인한다.

지키는 규정
  1. 저장 URL 은 관리자 영상 형식 설정을 따른다 — accept=image/jpeg 하드코딩 금지.
  2. SSE 무효화는 ID 공간(vid)을 맞춰 넘긴다 — 안 맞으면 낡은 영상이 영원히 히트한다.
  3. 무효화는 창을 넘는다 — 뷰어는 별도 창이라 그 창의 blob 캐시를 비울 경로가 있어야 한다.
  4. 로그아웃·세션 만료(401)에서 저장본이 확실히 사라진다(삭제 완료 후 리로드 + 스케줄러 정지).
  5. 조회 측에도 Live 게이트가 있다 — 미러 배치의 로컬 검사에 A 저장본이 나오면 안 된다.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
NODE_TEST = FRONTEND / "tests" / "dl_path_rule.test.mjs"


def _src(rel: str) -> str:
    return (FRONTEND / "src" / rel).read_text(encoding="utf-8")


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규정 테스트 생략")
def test_dl_path_and_key_rules():
    """저장 경로·캐시 키 규정(검사 폴더 충돌·kind·소스·형식 태그) — 원본 모듈을 그대로 실행."""
    assert NODE_TEST.exists(), f"규정 테스트 파일이 없다: {NODE_TEST}"
    p = subprocess.run([shutil.which("node"), str(NODE_TEST)], cwd=str(FRONTEND),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 0, f"다운로드 모드 저장 규정 위반:\n{p.stdout}\n{p.stderr}"


def test_download_url_follows_admin_image_format():
    """규정 1 — 저장 URL 에 형식을 하드코딩하지 않는다.

    accept=image/jpeg&quality=90 을 박아 두면 관리자가 '무손실 PNG'(진단 품질 정책)로 설정한
    병원에서 다운로드 모드를 켜는 순간 화면이 **아무 표시 없이 손실 JPEG 으로 강등**된다.
    회선 자동판정만 배제하고(fixedRenderedParams) 관리자 설정은 따라야 한다.
    """
    src = _src("lib/dlScheduler.ts")
    m = re.search(r"function fullUrl\((.*?)\n\}", src, re.S)
    assert m, "fullUrl 을 찾지 못했다"
    body = m.group(1)
    assert "accept=image/jpeg" not in body, "저장 URL 이 형식을 하드코딩한다(관리자 PNG 설정이 무시된다)"
    assert "fixedRenderedParams" in body, "저장 URL 이 관리자 설정에서 유도되지 않는다"
    # 워크리스트가 IMG_FMT 를 채워야 fixedRenderedParams 가 의미를 갖는다(뷰어와 같은 호출)
    wl = _src("pages/Worklist.tsx")
    assert "hospImageFormat" in wl and "setImageFormat" in wl, \
        "워크리스트가 병원 영상 형식을 안 읽으면 스케줄러는 늘 기본값(JPEG q90)으로 받는다"


def test_sse_invalidation_uses_vid_id_space():
    """규정 2 — changed_studies(A study_idx) 를 vid 로 올려서 넘긴다.

    그대로 넘기면 dlInvalidate 의 `ids.has(q.studyId)` 가 구조적으로 절대 참이 될 수 없어
    무효화가 영구 무동작이 된다(= A 에서 픽셀이 교체돼도 낡은 영상이 만료 없이 계속 뜬다).
    """
    src = _src("pages/Worklist.tsx")
    assert "freshChangedVids" in src, "무효화 대상 산출 규칙(freshChangedVids)을 쓰지 않는다"
    assert "VID_BASE" in src, "ID 공간 변환(VID_BASE)이 사라졌다"
    m = re.search(r"dlInvalidate\(([^)]*)\)", src)
    assert m, "dlInvalidate 호출을 찾지 못했다(무효화 호출자가 0 이 되면 안 된다)"
    assert "changed_studies" not in m.group(1), \
        "SSE 원본 목록을 그대로 넘긴다(ID 공간 불일치 + 누적 200건 재폐기 폭주)"


def test_invalidation_crosses_windows():
    """규정 3 — 무효화가 뷰어 창까지 도달한다.

    뷰어는 언제나 window.open 으로 뜬 별도 창이라 모듈 상태가 따로 논다. 워크리스트 창에서
    OPFS 파일만 지우면 뷰어의 urlCache 가 낡은 blob URL 을 계속 반환한다.
    """
    cache = _src("lib/dlCache.ts")
    assert "onDlInvalidate" in cache and "postDlInvalidate" in cache, \
        "dlCache 가 창 간 무효화 신호를 주고받지 않는다"
    sched = _src("lib/dlScheduler.ts")
    assert "dlInvalidateCache" in sched, "스케줄러 무효화가 blob 캐시를 건드리지 않는다"
    # 설정 '지금 비우기' — 저장소만 비우고 스케줄러/캐시를 그대로 두면 세션 내내 재다운로드가 없다
    st = _src("pages/SettingsModal.tsx")
    assert "dlForgetDone" in st and "dlInvalidateCache" in st, \
        "'지금 비우기' 가 스케줄러 완료 표시·blob 캐시를 비우지 않는다(0GB 인데 진행률 N/N)"


def test_session_expiry_wipes_before_reload():
    """규정 4 — 401 은 저장본 삭제를 기다린 뒤 리로드하고, 다운로더를 먼저 세운다.

    기다리지 않으면 리로드가 JS 컨텍스트를 내리며 삭제가 중간에 끊겨 공용 판독 PC 의 OPFS 에
    환자 영상이 남는다. 세션 만료는 로그아웃 버튼보다 흔한 경로다.
    """
    api = _src("api.ts")
    m = re.search(r"if \(res\.status === 401\) \{(.*?)\n    \}", api, re.S)
    assert m, "401 처리기를 찾지 못했다"
    body = m.group(1)
    assert "opfsWipeDone" in body, "삭제 완료를 기다리지 않고 리로드한다(파일이 남을 수 있다)"
    assert re.search(r"setToken\(null\);\s*\n\s*window\.location\.reload\(\)", body) is None, \
        "setToken(null) 직후 즉시 리로드한다(삭제가 끊긴다)"
    assert "sv-auth-cleared" in api, "다운로더 정지 신호를 발행하지 않는다(삭제 뒤 재기록 가능)"
    assert "sv-auth-cleared" in _src("lib/dlScheduler.ts"), "스케줄러가 정지 신호를 받지 않는다"
    # 파일 먼저 → 인덱스 나중(끊겨도 '인덱스만 남음' 으로 실패해야 자가 정리된다)
    store = _src("lib/opfsStore.ts")
    w = re.search(r"export async function opfsWipe\(\).*?\n\}", store, re.S)
    assert w, "opfsWipe 를 찾지 못했다"
    assert w.group(0).index("removeEntry") < w.group(0).index("clear()"), \
        "인덱스를 먼저 지운다 — 중간에 끊기면 '앱엔 없는데 OPFS 엔 환자 영상' 이 된다"
    assert "hasAuthToken" in store, "자격 소멸 후 재기록을 막는 가드가 없다(opfsPut 레이스)"


def test_viewer_read_path_is_live_gated():
    """규정 5 — 조회 측에도 Live 게이트가 있다.

    쓰기 측(스케줄러)은 liveMode 게이트인데 읽기 측에 게이트가 없으면, 미러 배치(로컬 Orthanc +
    Live 병행, SOP UID 동일)에서 LOCAL 모드 화면에 A 가 렌더한 저장본이 그대로 뜬다.
    """
    for name in ("Viewer2D.tsx", "ViewerInfi.tsx"):
        src = _src(f"pages/{name}")
        assert re.search(r"isLiveStudyUid\(stu\)\s*\?\s*opfsFrameUrl", src), \
            f"{name} 이 Live 검사 여부를 확인하지 않고 저장본을 히트시킨다"
    live = _src("lib/liveUids.ts")
    assert re.search(r"if \(live && sopUid\)", live), \
        "previewUrlOf 의 로컬 썸네일 폴백에 Live 게이트가 없다"
