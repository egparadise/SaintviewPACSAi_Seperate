"""다중 모니터 뷰어 오픈 규칙 회귀 — 프론트 순수 로직을 Node 로 실제 실행 + 구조 가드.

규칙(사용자 확정 원문, 2026-07-29):
  ① 사이클 시작(살아 있는 뷰어 창이 0개)인 **첫 오픈** = 선택된 전 모니터에 같은 검사.
  ② 두 번째 오픈부터 = 모니터 번호순으로 대상 창 하나만 리로드, 나머지는 Exam 탭만 추가.

이 규칙은 커밋 109c2cb(전 모니터 오픈) + 6da23e0(라운드로빈)이 합쳐진 것이다. 6da23e0 이
109c2cb 의 forEach 를 통째로 라운드로빈 단일 오픈으로 바꾸면서 ①이 사라진 것이 회귀였다.

역할 분담(중요):
  · **의미 검증**은 frontend/tests/viewer_slots_rule.test.mjs 가 lib/viewerSlots.ts 의 원본
    planViewerOpen/openByPlan 을 실행해서 한다. 규칙 분기를 죽이면 그쪽이 빨개진다.
    (예전엔 그 테스트가 Worklist.openV2 의 결정부 '사본'을 검증해서, 제품 코드의 분기를 죽여도
     10개가 전부 초록이었다. 그래서 결정부를 lib 으로 빼고 사본을 지웠다.)
  · 아래 소스 가드는 **배선**만 본다 — 규칙 구현이 다시 화면 코드로 인라인되거나, 호출부가
    결과를 무시하거나, 삭제/생존 판정 경로가 통째로 사라지는 것을 막는 안전망이다.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
NODE_TEST = FRONTEND / "tests" / "viewer_slots_rule.test.mjs"
SRC = FRONTEND / "src"


def _read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


def _calls(src: str, fn: str) -> list[str]:
    """src 안의 `fn(...)` 호출 인자 텍스트를 괄호 균형으로 잘라 반환(주석·중첩 괄호 포함)."""
    out: list[str] = []
    for m in re.finditer(re.escape(fn) + r"\(", src):
        i = m.end()
        depth = 1
        while i < len(src) and depth:
            if src[i] == "(":
                depth += 1
            elif src[i] == ")":
                depth -= 1
            i += 1
        out.append(src[m.end():i - 1])
    return out


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규칙 테스트 생략")
def test_multimonitor_placement_rule_runs():
    """①첫 오픈=전 모니터 ②이후 2,3,…,1 순환 ③워크리스트 F5 후에도 순번 유지."""
    assert NODE_TEST.exists(), f"규칙 테스트 파일이 없다: {NODE_TEST}"
    p = subprocess.run([shutil.which("node"), str(NODE_TEST)], cwd=str(FRONTEND),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 0, f"다중 모니터 배치 규칙 위반:\n{p.stdout}\n{p.stderr}"


def test_rule_test_calls_the_real_implementation_not_a_copy():
    """규칙 테스트가 배치 결정부를 다시 구현하면 제품 코드를 되돌려도 초록이 된다.

    실제로 그랬다 — 옛 openStudy() 사본은 부트스트랩 분기 삭제·noteViewerSlot 삭제·순번 오프셋
    변경을 모두 통과시켰다. 원본(planViewerOpen/openByPlan)을 부르는지 여기서 고정한다.
    """
    t = NODE_TEST.read_text(encoding="utf-8")
    assert "planViewerOpen" in t and "openByPlan" in t, "규칙 테스트가 원본 구현을 부르지 않는다"
    # 결정 로직을 테스트 파일이 다시 들고 있으면(사본) 아래 지문이 남는다.
    # 주석에는 회귀 이력을 적어야 하므로 코드 형태로만 본다(문자열 조각 아닌 실제 표현식).
    code = "\n".join(ln for ln in t.splitlines()
                     if not ln.lstrip().startswith(("*", "/*", "//")))
    assert "writeViewerRoundRobin((rr" not in code, "테스트가 라운드로빈 계산을 다시 구현했다(사본)"
    assert "% names.length" not in code, "테스트가 대상 슬롯 선택을 다시 구현했다(사본)"
    assert "=== 0) {" not in code, "테스트가 사이클 시작 판정을 다시 구현했다(사본)"


def test_placement_rule_lives_in_one_pure_module():
    """①②규칙의 구현은 lib/viewerSlots 한 곳 — 화면 코드에 인라인으로 되돌아오면 안 된다."""
    lib = _read("lib/viewerSlots.ts")
    assert "export function planViewerOpen(" in lib, "배치 결정 순수 함수가 사라졌다"
    assert "export function openByPlan(" in lib, "계획 적용부(장부·순번 기록)가 사라졌다"
    assert '"bootstrap"' in lib and '"roundrobin"' in lib, "①/② 두 모드 구분이 사라졌다"
    # 부트스트랩 직후 순번은 slots[1] — 0 이면 둘째 검사가 1번 모니터를 덮어써 첫 영상이 사라진다
    assert "nextRr: 1 % slots.length" in lib, "부트스트랩 후 순번 시작값(=slots[1])이 없다"
    assert "noteViewerSlot(t.name, studyId)" in lib, \
        "연 창을 장부에 즉시 기록하지 않는다 — 첫 하트비트 전 오픈이 '창 0개'로 오판한다"
    wl = _read("pages/Worklist.tsx")
    assert "planViewerOpen(slots, liveHere, readViewerRoundRobin())" in wl, \
        "워크리스트가 규칙 모듈에 판정을 맡기지 않는다"
    assert "openByPlan(plan, d0.id," in wl, "워크리스트가 계획을 적용하지 않는다"
    # 규칙이 다시 openV2 안으로 복사되는 형태(예전 인라인 코드의 지문)
    assert "for (const s of slots)" not in wl, "배치 루프가 다시 워크리스트에 인라인됐다"
    assert "writeViewerRoundRobin(1 % slots.length)" not in wl, "순번 계산이 다시 워크리스트에 인라인됐다"
    # 팝업 차단 안내(109c2cb 에 있다가 6da23e0 에서 삭제됨) — 부트스트랩은 창을 n개 동시에 여는 유일한 지점
    assert "모니터에만 열렸습니다" in wl, "부분 오픈(팝업 차단) 안내 토스트가 없다"


def test_round_robin_counter_is_not_a_module_variable():
    """카운터가 Worklist 문서 수명에 매이면 F5 로 0 이 되어 1번 모니터를 덮어쓴다."""
    src = _read("pages/Worklist.tsx")
    assert "let viewerRoundRobin" not in src, "라운드로빈 카운터가 다시 모듈 변수가 됐다"
    assert "openedViewerWindows.size === 0" not in src, \
        "리셋 조건이 다시 워크리스트 문서의 Map 크기로 돌아갔다(창이 살아 있어도 0 이 된다)"
    assert "readViewerRoundRobin()" in src and "writeViewerRoundRobin(" in src


def test_liveness_uses_both_the_ledger_and_the_window_handles():
    """생존 판정이 슬롯 장부 하나에만 걸리면 두 배치에서 매 오픈이 '첫 오픈'이 된다.

    (1) VITE_VIEWER_BASE — 뷰어가 다른 오리진이면 하트비트가 워크리스트 오리진의 localStorage 에
        **보이지 않는다**. 6초 TTL 이 지나면 liveHere=0 → 매번 부트스트랩 → 전 모니터가 같은 검사로
        덮인다(라운드로빈 자체가 동작하지 않음). `w.closed` 는 교차 출처에서도 읽힌다.
    (2) 창이 오래 가려져 하트비트가 스로틀될 때도 같은 오판이 난다.
    """
    src = _read("pages/Worklist.tsx")
    assert "const liveHere = new Set<string>(liveViewerSlots().keys());" in src
    assert "if (!ow.closed) liveHere.add(nm);" in src, \
        "살아 있는 창 핸들이 생존 판정에 합쳐지지 않는다(교차 출처 배치에서 순번이 죽는다)"
    assert "if (w.closed) { openedViewerWindows.delete(nm); forgetViewerSlot(nm); }" in src, \
        "닫힌 창을 장부에서 즉시 지우지 않는다 — 브라우저 X 로 닫으면 TTL 동안 '살아있음'으로 남는다"
    lib = _read("lib/viewerSlots.ts")
    assert "교차 출처" in lib, "localStorage 장부의 오리진 한계가 주석에 남아 있지 않다"


def test_slot_ttl_survives_browser_timer_throttling():
    """Chrome 은 hidden 문서의 타이머를 5분 뒤 **1분에 1회**로 늦춘다(intensive throttling).

    TTL 이 6초였을 때는 멀쩡히 살아 있는 뷰어 창이 '죽은 것'으로 보여 ①부트스트랩이 선택된 전
    모니터를 같은 검사로 덮어썼다(= 사용자 신고 "첫 영상이 사라진다").
    """
    lib = _read("lib/viewerSlots.ts")
    m = re.search(r"SLOT_TTL_MS\s*=\s*([0-9_]+)", lib)
    assert m, "SLOT_TTL_MS 가 없다"
    assert int(m.group(1).replace("_", "")) > 60_000, "TTL 이 스로틀 주기(60s)보다 작다"
    # 가려졌다 돌아온 창은 타이머를 기다리지 말고 즉시 되살아나야 한다
    assert 'addEventListener("visibilitychange"' in lib, "하트비트가 visibilitychange 를 구독하지 않는다"
    assert 'addEventListener("pageshow"' in lib, "하트비트가 pageshow 를 구독하지 않는다"
    # TTL 을 늘린 대신 '진짜 닫힘'은 pagehide 유예로 즉시 만료시킨다(리로드는 살린다)
    assert "export function markViewerSlotUnloading(" in lib, "pagehide 표식 경로가 없다"
    assert "SLOT_UNLOAD_GRACE_MS" in lib


def test_addtab_broadcast_excludes_the_reloading_target_window():
    """탭 추가 브로드캐스트에 수신자 주소가 있어야 한다.

    없으면 'URL 로 통째로 리로드될 대상 창'까지 메시지를 받아, 곧 버려질 문서가 study+seriesTree 를
    왕복하고 sv_infi_exams 를 다시 써서 워크리스트 선등록(단일 기록자) 규약이 깨진다.
    """
    sync = _read("lib/sync.ts")
    assert "except?: string" in sync, "AddTabMsg 에 대상 창 제외 필드가 없다"
    assert "window.name === m.except" in sync, "수신측이 대상 창을 걸러내지 않는다"
    wl = _read("pages/Worklist.tsx")
    assert "postViewerAddTab(d0.id, d0.study_uid, tabLabel, plan.targets[0].name)" in wl, \
        "라운드로빈 경로가 대상 창을 제외하지 않고 브로드캐스트한다"
    assert 'if (plan.mode === "roundrobin") postViewerAddTab' in wl, \
        "부트스트랩(다른 창 없음)에서도 브로드캐스트한다 — 불필요한 왕복"


def test_window_name_convention_has_a_single_source():
    """창 이름 규약이 두 곳에 하드코딩되면 같은 모니터에 창이 두 개 생긴다(볼트 §5.1 경고)."""
    owner = _read("lib/viewerSlots.ts")
    assert "sv_viewer_slot${monitorIndex}" in owner, "규약 단일 출처(viewerSlotName)가 사라졌다"
    for rel in ("pages/Worklist.tsx", "lib/screens.ts"):
        src = _read(rel)
        assert "viewerSlotName(" in src, f"{rel} 이 공용 규약을 쓰지 않는다"
        assert "`sv_viewer_slot${" not in src, f"{rel} 에 창 이름 규약이 다시 하드코딩됐다"


def test_report_window_promotes_mm_when_a_monitor_wall_is_alive():
    """판독창 ◀▶·관련검사 오픈이 mm 없이 sv_viewer 를 새로 만들면, 그 창은 mm 미승격이라
    In-View 가 공유 Exam 레지스트리 전체를 페인에 깐다(= 다른 모니터 영상이 같이 보인다)."""
    src = _read("pages/ReportWindow.tsx")
    assert "viewerUrlFor(" in src, "판독창이 mm 판정을 거치지 않고 뷰어를 연다"
    assert 'mm=1' in src, "다중 모니터 벽에서 mm 승격을 싣지 않는다"
    assert "noteViewerSlot(" in src, "판독창 오픈이 슬롯 장부를 갱신하지 않는다"
    # 옛 경로(무조건 평문 URL)가 되살아나면 실패
    assert '?viewer=2d&study=${id}`, "sv_viewer"' not in src
    assert '&add=${e.id}`, "sv_viewer"' not in src


def test_max_open_cap_applies_only_to_the_round_robin_slots():
    """max_open('검사를 열 때 순환할 모니터 개수')은 라운드로빈 슬롯 수다 — 워크리스트 전용.

    한때 뷰어측(Compare·과거검사 '인접 모니터')에도 같은 캡을 넘겼는데, 그 캡은 정작 막고 싶던
    '라운드로빈이 쓰는 모니터를 Compare 가 덮는 것'을 하나도 막지 못하고(캡 안쪽이 바로 그 모니터다)
    놀고 있는 캡 밖 모니터만 못 쓰게 만들었다 — 3모니터·max_open=2 에서 비교 2건이 배치를 포기하고,
    max_open=1 이면 prior_mode="monitor" 가 **항상** Layout 폴백이 됐다.
    보호는 placeCompareSlaves 가 살아 있는 슬롯을 뒤로 미루는 방식으로 한다.
    """
    screens = _read("lib/screens.ts")
    assert "maxOpen = 0," in screens, "screenFeaturesList 에 캡 인자가 없다"
    assert "out.slice(0, cap)" in screens, "캡 적용이 사라졌다"

    wl = _read("pages/Worklist.tsx")
    assert "slots.slice(0, maxOpen)" not in wl, "워크리스트가 screenFeaturesList 밖에서 또 캡을 건다"
    wl_calls = _calls(wl, "screenFeaturesList")
    assert wl_calls and all("maxOpen" in c for c in wl_calls), \
        f"워크리스트가 라운드로빈 슬롯 목록에 캡을 넘기지 않는다: {wl_calls}"

    # 뷰어측은 **캡 없는 전체 목록** — 존재 검사가 아니라 '호출 인자'로 고정한다.
    # (예전 가드는 `assert "max_open" in src` 라서, prefs 타입 선언의 `max_open?: number` 때문에
    #  뷰어측 캡 전달을 통째로 되돌려도 통과하는 공허한 가드였다.)
    for rel in ("pages/Viewer2D.tsx", "pages/ViewerInfi.tsx"):
        calls = _calls(_read(rel), "screenFeaturesList")
        assert calls, f"{rel} 에 screenFeaturesList 호출이 없다"
        for c in calls:
            assert "max_open" not in c and "MaxOpen" not in c, \
                f"{rel} 이 Compare/과거검사 배치에까지 라운드로빈 캡을 넘긴다: {c!r}"

    # 라운드로빈이 쓰고 있는 모니터는 뒤로 — 비어 있는 모니터부터 쓴다(캡으로는 안 되던 보호)
    assert "liveViewerSlots()" in screens, "Compare 배치가 살아 있는 슬롯을 보지 않는다"
    assert "const order = [...cyc.filter((s) => !busy(s)), ...cyc.filter(busy)];" in screens, \
        "살아 있는 라운드로빈 슬롯 회피 정렬이 사라졌다"

    # 설정 문구도 같은 뜻이어야 한다
    st = _read("pages/SettingsModal.tsx")
    assert "순환 범위에만" in st, "max_open 의 적용 범위가 설정 문구에 없다"


def test_viewers_heartbeat_their_slot():
    """세 뷰어(SaintView·T-View=Viewer2D, I-View=ViewerInfi)가 모두 슬롯 생존을 알려야 한다.
    한쪽이 빠지면 그 모니터 창이 살아 있는데도 '창 0개'로 보여 부트스트랩이 다시 돌아 덮어쓴다."""
    for rel in ("pages/Viewer2D.tsx", "pages/ViewerInfi.tsx"):
        src = _read(rel)
        assert "startViewerSlotHeartbeat(" in src, f"{rel} 에 슬롯 하트비트가 없다"
        assert "releaseViewerSlot()" in src, f"{rel} 이 닫힐 때 슬롯을 반납하지 않는다"
        assert "clearViewerSlots()" in src, f"{rel} 의 All Close 가 슬롯 장부를 비우지 않는다"


def test_shared_tab_registry_has_a_single_writer_in_mm():
    """mm 창이 openTabs 전체를 덮어쓰면(각 창이 자기 검사를 맨 뒤로 옮긴 배열) 모니터마다 탭 순서가
    갈린다. mm 에서는 새 항목 append 만 — 순서의 출처는 워크리스트 선등록이다."""
    src = _read("pages/Viewer2D.tsx")
    assert "mergePersistedTabs(" in src, "mm 창의 append-only 기록 경로가 없다"
    assert "if (mmWin) mergePersistedTabs(openTabs); else savePersistedTabs(openTabs);" in src, \
        "mm 창이 다시 공유 탭 목록을 통째로 덮어쓴다"
    # append 는 '없는 항목만' — 순서 재배열이 되살아나면 모니터마다 탭 순서가 갈린다
    assert "const add = tabs.filter((t) => !seen.has(t.id));" in src


def test_closing_an_exam_tab_removes_it_from_the_shared_registry():
    """mm 창의 기록을 append-only 로 바꾸면서 **삭제 경로가 통째로 사라졌던** 회귀.

    증상: 3모니터 공유 탭 [A,B,C] 에서 B 를 ✕ → 그 창에서만 사라지고 sv_viewer_tabs 는 [A,B,C].
    다음 검사를 열면 라운드로빈 대상 창이 URL 로 리로드되고 복원부가 [A,B,C,D] 로 되살린다.
    게다가 ◀▶ 이동은 loadPersistedTabs 로 '이미 열린 검사'를 건너뛰므로 닫은 B 가 영구히 스킵됐다.
    (삭제는 배열 순서를 건드리지 않으므로 위 append-only 규약과 충돌하지 않는다.)
    """
    src = _read("pages/Viewer2D.tsx")
    assert "function dropPersistedTab(" in src, "공유 목록에서 단일 항목을 빼는 경로가 없다"
    assert "const next = cur.filter((t) => t.id !== id);" in src
    body = src[src.index("const closeTab = ("):]
    body = body[:body.index("\n  };")]
    assert "dropPersistedTab(id);" in body, "closeTab 이 공유 목록을 정리하지 않는다(다음 오픈에 되살아난다)"
    assert "postViewerDelTab(id)" in body, "다른 모니터 창에 ✕ 가 전파되지 않는다"
    # 수신 창도 자기 목록에서 빼야 한다 — 안 그러면 그 창의 다음 기록이 항목을 되살린다
    assert "onViewerDelTab((id) => closeTabRef.current(id, false))" in src, "삭제 수신 경로가 없다"
    sync = _read("lib/sync.ts")
    assert "viewer-deltab" in sync and "export function postViewerDelTab(" in sync
    assert "export function onViewerDelTab(" in sync


def test_settings_text_states_the_rule():
    """설정 화면 문구가 기획 원문이다 — 문구와 코드가 같은 규칙을 말해야 한다."""
    src = _read("pages/SettingsModal.tsx")
    assert "첫 영상" in src and "모든 모니터에 같은 검사" in src, "①규칙이 사용 방법 문구에 없다"
    assert "두 번째 영상부터는 모니터 번호순으로 한 대씩" in src, "②규칙이 사용 방법 문구에 없다"
