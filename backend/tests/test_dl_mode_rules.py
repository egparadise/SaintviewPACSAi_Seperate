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
  6. 용량 초과 자동 삭제의 **호출자가 실재한다**(pump 밖에도 있고, 보호 집합을 실제로 넘긴다).
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
NODE_TEST = FRONTEND / "tests" / "dl_path_rule.test.mjs"
NODE_TEST_EVICT = FRONTEND / "tests" / "dl_evict_rule.test.mjs"
NODE_TEST_LOOP = FRONTEND / "tests" / "dl_evict_loop.test.mjs"
NODE_TEST_PROTECT = FRONTEND / "tests" / "dl_protect_rule.test.mjs"


def _run_node(path: Path) -> None:
    assert path.exists(), f"규정 테스트 파일이 없다: {path}"
    p = subprocess.run([shutil.which("node"), str(path)], cwd=str(FRONTEND),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 0, f"다운로드 모드 규정 위반:\n{p.stdout}\n{p.stderr}"


def _src(rel: str) -> str:
    return (FRONTEND / "src" / rel).read_text(encoding="utf-8")


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규정 테스트 생략")
def test_dl_path_and_key_rules():
    """저장 경로·캐시 키 규정(검사 폴더 충돌·kind·소스·형식 태그) — 원본 모듈을 그대로 실행."""
    assert NODE_TEST.exists(), f"규정 테스트 파일이 없다: {NODE_TEST}"
    p = subprocess.run([shutil.which("node"), str(NODE_TEST)], cwd=str(FRONTEND),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 0, f"다운로드 모드 저장 규정 위반:\n{p.stdout}\n{p.stderr}"


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규정 테스트 생략")
def test_dl_eviction_order_rules():
    """규정 6-a — 축출 순서(과거 검사일부터·보호·nodate 후순위)를 원본 함수로 검증."""
    _run_node(NODE_TEST_EVICT)


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규정 테스트 생략")
def test_dl_eviction_converges():
    """규정 6-f — 축출이 **수렴한다**(다운로드→삭제 트레드밀 금지).

    축출한 검사를 doneUids 에서 빼고 failUntil 백오프만 걸면, 백오프가 만료되는 순간 '용량이
    없어서 지운 바로 그 검사' 가 다시 최우선 후보가 된다. 큐가 실효 상한보다 크면 종료 조건이
    없는 순환이 되어 원격 A 를 세션 내내 두들긴다(측정: 400분에 다운로드 400건·재다운로드 379건,
    전송 80GB 중 78GB 폐기, 보관 상태는 재큐잉이 없을 때와 동일).
    """
    _run_node(NODE_TEST_LOOP)


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규정 테스트 생략")
def test_dl_protection_sources_are_real():
    """규정 6-g — 보호 집합 **산출부**를 원본으로 검증한다.

    dl_evict_rule 의 ② 는 손으로 만든 배열을 planEvictions 에 넘기므로 '보호 집합을 만드는 쪽'의
    구멍(In-View 전 경로 누락·큐에서 빠진 prior·만료 없는 장부)을 구조적으로 못 잡는다.
    """
    _run_node(NODE_TEST_PROTECT)


def test_prune_has_callers_outside_pump():
    """규정 6-b — 정리(prune)의 호출자가 '성공 저장 N건마다' 하나뿐이면 안 된다.

    예전에는 pump 안 한 곳뿐이라 (1) 상한을 낮춰도 (2) 큐를 다 받아 idle 이어도 (3) 모드를
    live 로 되돌려도 정리가 **한 번도 돌지 않았다**. 초과분이 로그아웃까지 남는다.
    """
    src = _src("lib/dlScheduler.ts")
    m = re.search(r"async function maintain\(", src)
    assert m, "상한 유지 루틴(maintain)이 없다"
    # dlConfigure(설정 저장 직후) · loop(진입·idle 틱) 두 경로에서 반드시 불려야 한다
    cfgm = re.search(r"export function dlConfigure\(.*?\n\}", src, re.S)
    assert cfgm and "maintain(" in cfgm.group(0), \
        "설정 저장 직후 정리가 없다 — 상한을 20GB→2GB 로 낮춰도 아무 일도 일어나지 않는다"
    loopm = re.search(r"async function loop\(.*?\n\}", src, re.S)
    assert loopm and loopm.group(0).count("maintain(") >= 2, \
        "loop(진입/idle 틱)에서 정리가 돌지 않는다 — 저장이 없으면 영원히 안 돈다"
    # 주기 기준이 '파일 N건' 이면 40KB 썸네일과 20MB 프레임이 동급이 된다(바이트로 통제되지 않는다)
    assert "sinceBytes" in src and "PRUNE_BYTES" in src, \
        "정리 주기가 누적 바이트 기준이 아니다(파일 건수 기준이면 초과분이 통제되지 않는다)"


def test_prune_receives_real_protected_uids():
    """규정 6-c — 보호 집합이 실제로 넘어간다(빈 배열 하드코딩 금지).

    보호 통로를 만들어 놓고 호출부가 [] 를 넘기면 보호가 조용히 무동작이 된다 — 이 저장소가
    두 번 겪은 유형이다. 보호가 없으면 '보고 있는 검사'가 정확히 1순위 희생자가 되고,
    상한보다 큰 검사 하나면 받는 중인 검사를 스스로 지우고 다시 받는 무한 루프가 된다.
    """
    src = _src("lib/dlScheduler.ts")
    m = re.search(r"opfsPrune\((.*?)\n\s*\}\);", src, re.S)
    assert m, "opfsPrune 호출을 찾지 못했다"
    call = m.group(1)
    assert "protectedUids" in call, "정리에 보호 집합을 넘기지 않는다"
    assert not re.search(r"protectedUids\s*:\s*\[\s*\]", call), \
        "보호 집합에 빈 배열을 하드코딩했다(보호가 영구 무동작)"
    fn = re.search(r"function protectedUids\(\).*?\n\}", src, re.S)
    assert fn, "보호 집합 산출 함수가 없다"
    body = fn.group(0)
    assert "curUid" in body, "받는 중인 검사를 보호하지 않는다(축출→재다운로드 무한 루프)"
    assert "recentUid" in body, \
        "방금 받은 검사를 한 주기 더 보호하지 않는다 — 게이트 진입에서 curUid 가 비는 순간 자기삭제가 난다"
    assert "liveViewerSlots" in body, "살아 있는 뷰어 창이 물고 있는 검사를 보호하지 않는다"
    assert "liveHeldStudyUids" in body, \
        "뷰어가 직접 남긴 uid 장부(dlHeld)를 보호 출처로 쓰지 않는다 — 큐에서 빠진 prior 가 1순위 희생자가 된다"
    # ★ 만료 없는 장부를 보호 출처로 쓰면 안 된다. sv_viewer_tabs 는 Viewer2D 전용(=In-View 에서는
    #   항상 빈 배열)인 데다 항목이 빠지는 경로가 ✕/All Close 뿐이라, 브라우저 X 로 닫으면 최대 8건이
    #   무기한 축출 불가로 남아 상한 게이트를 잠갔다(안내는 '창을 닫으면 이어받습니다' 였다).
    assert "sv_viewer_tabs" not in body, \
        "만료 없는 탭 장부를 보호 출처로 되돌렸다 — 닫힌 창의 검사가 영구 보호되어 게이트가 잠긴다"
    # 보호 출처는 전부 TTL 이 있어야 한다(dlHeld/viewerSlots).
    held = _src("lib/dlHeld.ts")
    assert "HELD_TTL_MS" in held and "heldStudyUids" in held, "뷰어 장부에 만료 규칙이 없다"
    # 뷰어 **두 종 모두** 같은 장부에 uid 를 남겨야 한다 — 한쪽만 쓰면 그 조합에서 보호가 통째로 빈다.
    for name in ("Viewer2D.tsx", "ViewerInfi.tsx"):
        vs = _src(f"pages/{name}")
        assert "startHeldStudiesHeartbeat(" in vs, \
            f"{name} 이 축출 보호 장부에 자기 검사 uid 를 남기지 않는다"
        held_src = re.search(r"heldUidsRef\.current = (.*?);\n", vs, re.S)
        assert held_src, f"{name} 에 장부 내용(heldUidsRef) 계산이 없다"
        assert "study_uid" in held_src.group(1) or ".uid" in held_src.group(1), \
            f"{name} 이 장부에 studyId 만 남긴다 — uid 가 없으면 큐 없이는 보호로 이어지지 않는다"


def test_eviction_postprocess_is_terminal_and_scoped():
    """규정 6-d — 축출 후처리는 **종결**이고, 무효화는 **검사 단위**다.

    예전 후처리는 `doneUids.delete(uid)` + `failUntil.set(uid, now+600_000)` 였다. 후보 선택이
    `!done && failUntil<=now` 뿐이라 10분 뒤 그 검사가 다시 최우선 후보가 됐다 = 다운로드→삭제
    트레드밀(수렴 검증은 dl_evict_loop.test.mjs). 진행률의 정직함은 표시(doneCount)가 담당한다.

    무효화도 마찬가지다. dlInvalidateCache() 는 열려 있는 **모든** 뷰어 창의 blob URL 캐시(최대
    1200 프레임)를 통째로 버린다. 상한에 붙어 있으면 축출은 매번 일어나므로, 판독 내내 10~30초
    주기로 화면이 서버 렌더로 되돌아갔다 복구되기를 반복했다.
    """
    src = _src("lib/dlScheduler.ts")
    m = re.search(r"if \(r\.evicted\.length\) \{(.*?)\n    \}", src, re.S)
    assert m, "축출 후처리 블록을 찾지 못했다"
    body = m.group(1)
    assert "applyEviction" in body, "축출을 종결 상태로 기록하지 않는다(dlQueueRule.applyEviction)"
    assert "doneUids.delete" not in body and "done.delete" not in body, \
        "축출한 검사를 완료 목록에서 뺐다 — 그 순간 다시 최우선 후보가 되어 트레드밀이 된다"
    assert "failUntil.set" not in body, \
        "용량 축출을 실패 백오프로 표현했다 — 만료되면 다시 받는다(지연일 뿐 종결이 아니다)"
    assert "dlInvalidateStudies" in body, "축출 후 뷰어 창 blob 캐시를 비우지 않는다"
    assert "dlInvalidateCache(" not in body, \
        "축출 1건마다 blob 캐시를 통째로 비운다 — 판독 중 화면이 주기적으로 서버 렌더로 되돌아간다"
    # 진행률은 evicted 를 빼고 센다(모순 화면을 큐 되살리기로 풀지 않는다)
    prog = re.search(r"export function dlProgress\(\).*?\n\}", src, re.S)
    assert prog and "doneCount(" in prog.group(0), \
        "진행률이 축출분을 빼지 않는다 — 그걸 doneUids 로 풀면 재큐잉이 되살아난다"
    # 종결 해제 계기는 셋뿐 — 설정 변경 / 비우기·리셋 / 사용자 오픈
    for fn in ("dlConfigure", "dlForgetDone", "dlReset", "dlPromote"):
        f = re.search(r"export function " + fn + r"\(.*?\n\}", src, re.S)
        assert f and "releaseEvicted" in f.group(0), f"{fn} 에 축출 종결 해제가 없다"
    cfg = re.search(r"export function dlConfigure\(.*?\n\}", src, re.S).group(0)
    assert "evictConfigKey" in cfg, \
        "dlConfigure 가 무조건 종결을 푼다 — 마운트·설정 저장마다 불리므로 트레드밀이 되살아난다"
    # 무효화가 검사 단위로 가능하려면 조회 캐시가 key→검사 소속을 알아야 한다
    cache = _src("lib/dlCache.ts")
    assert "dlInvalidateStudies" in cache and "keyUid" in cache, \
        "dlCache 가 key→studyUid 를 모른다 — 무효화 범위를 좁힐 수 없다"
    assert "opfsGetRec" in cache and "opfsGetRec" in _src("lib/opfsStore.ts"), \
        "저장본 조회가 소속 검사를 함께 돌려주지 않는다"
    # 자동 삭제 OFF 는 반드시 '상한 도달 시 중지' 와 세트여야 한다
    assert "overLimit" in src, "자동 삭제를 끄면 상한을 넘긴 채 계속 받는다(할당량이 터진다)"
    assert "dryRun" in src, "자동 삭제 OFF 에서 사용량 판정 경로가 없다"


def test_near_limit_warning_is_not_permanent():
    """규정 6-h — 자동 삭제가 정상 작동 중인 '상한 100%' 는 경보가 아니다.

    planEvictions 는 `total - freed <= limit` 에서 멈추므로 축출 직후 사용량은 늘 (limit-1건, limit]
    에 착지한다. 임계 90%·재무장 85% 에서는 그 상태가 **영구 경보**가 되어, 저장소를 한 번 채운
    사용자는 워크리스트를 띄울 때마다 빨간 ⚠ 를 본다(기능은 정상인데 오류처럼 보인다).
    """
    src = _src("lib/dlScheduler.ts")
    fn = re.search(r"function warnCheck\(.*?\n\}", src, re.S)
    assert fn, "근접 알림 함수를 찾지 못했다"
    assert "shouldWarnNearLimit" in fn.group(0), "알림 판정이 순수 함수(dlQueueRule)를 지나지 않는다"
    rule = _src("lib/dlQueueRule.ts")
    w = re.search(r"export function shouldWarnNearLimit\(.*?\n\}", rule, re.S)
    assert w and "autoEvict" in w.group(0) and "blocked" in w.group(0), \
        "자동 삭제 상태·게이트 여부를 보지 않는다 — 정상 착지값을 경보로 띄운다"
    # 게이트 안내는 '창을 닫으세요' 만으로 끝나면 안 된다(이미 다 닫았는데 안 풀리는 상황이 있었다)
    assert "지금 비우기" in src, \
        "보호만으로 상한을 넘은 상태의 복구 수단(설정 '지금 비우기'/상한 상향)을 안내하지 않는다"
    # 설정 화면 문구도 실제 의미로 바뀌어야 한다(문구가 곧 정책이다)
    st = _src("pages/SettingsModal.tsx")
    assert "곧 중지될 때만" in st or "곧 중지" in st, \
        "'상한 근접 알림' 설명이 '무조건 알림' 으로 남아 있다(문구와 동작이 어긋난다)"


def test_evict_settings_are_persisted_and_passed():
    """규정 6-e — 설정 키 저장 + dlConfigure 전달. 어느 한쪽이 빠지면 UI 가 장식이 된다."""
    st = _src("pages/SettingsModal.tsx")
    for key in ("dl_auto_evict", "dl_evict_by", "dl_warn_near", "dl_warn_pct"):
        assert key in st, f"설정 저장 목록에 {key} 가 없다(모달을 다시 열면 기본값으로 돌아온다)"
    # 문구가 곧 정책이면 되돌림이 조용히 일어난다 — 문구는 evictBy 에서 유도돼야 한다
    assert "dl.evictBy ===" in st, "삭제 기준 문구가 설정값에서 유도되지 않는다(하드코딩 문구)"
    assert "보고 있는 검사와 받는 중인 검사는 삭제하지 않습니다" in st, \
        "보호 규칙이 설정 화면에 명시돼 있지 않다"
    wl = _src("pages/Worklist.tsx")
    m = re.search(r"dlConfigure\(\{(.*?)\n\s*\}\);", wl, re.S)
    assert m, "Worklist 의 dlConfigure 호출을 찾지 못했다"
    args = m.group(1)
    for field in ("autoEvict", "evictBy", "warnNearLimit", "warnAtPct"):
        assert field in args, f"dlConfigure 인자에 {field} 가 없다(스케줄러가 영영 기본값으로 돈다)"
    # 뷰어 2종은 mode 만 보지만 규약(readDlPrefs 경유)은 유지한다 — v.dl_* 직접 읽기 금지
    for name in ("Viewer2D.tsx", "ViewerInfi.tsx"):
        vs = _src(f"pages/{name}")
        assert "readDlPrefs" in vs, f"{name} 이 설정 해석을 우회한다"
        assert not re.search(r"\.value\s*\)\s*\.dl_", vs), f"{name} 이 dl_* 원시 키를 직접 읽는다"


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
