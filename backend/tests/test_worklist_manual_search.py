"""워크리스트 '수동 갱신' 계약 + 자동완성 오염 차단 회귀.

계약(커밋 7c5d360 메시지 본문 = 기획 원문):
    "· 기본 **수동** — SEARCH 를 눌러야만 갱신된다. Live 도 같은 규칙을 따른다.
      … 수동의 뜻은 '내가 SEARCH 를 누를 때만 바뀐다' 이므로 여기서 목록을 바꾸면 약속을 깨는 것"

기획도 주석도 이 계약을 두 번 적어 놨는데, 정작 조회 useEffect 만 그걸 안 지켰다 —
의존성에 filters/searchText(입력 상태)가 들어 있어서 SEARCH 칸에 한 글자만 쳐도 곧바로
/api/worklist 가 나가고 그리드가 바뀌었다. 그래서 이 파일은 두 층으로 막는다.

  (1) 순수 규칙: 조회 파라미터를 만드는 함수(frontend/src/lib/worklistQuery.ts)를 Node 로
      **원본 그대로 실행**한다 — 모킹도 사본도 없다.
  (2) 배선 가드: 순수 함수가 아무리 옳아도 effect 가 입력 상태를 다시 물면 계약은 깨진다.
      React 컴포넌트라 실행 검증이 어려우므로, 되살아나면 안 되는 배선을 원문에서 확인한다.

두 번째 축은 'SEARCH 칸에 Sample01 이 자동입력' 사고다. 원인은 앱 코드가 그 값을 넣은 게
아니라 (a) 로그인 폼 병원ID 칸이 시드값 SAMPLE01 로 프리필돼 브라우저가 자격증명으로 저장하고
(b) 문서에 이름 없는 텍스트 필드 + form 밖 type=password 가 공존해 크롬이 문서 전체를
'주인 없는 합성 로그인 폼'으로 묶었기 때문이다. 셋 다 코드 조건이므로 여기서 고정한다.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
PAGES = FRONTEND / "src" / "pages"
NODE_TEST = FRONTEND / "tests" / "worklist_query.test.mjs"


def _src(rel: str) -> str:
    return (FRONTEND / "src" / rel).read_text(encoding="utf-8")


# ════════════════════════ (1) 순수 규칙 — 실제 실행 ════════════════════════
@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규칙 테스트 생략")
def test_worklist_query_rules_run_for_real():
    """committed(확정 조건)만으로 조회 파라미터가 만들어지는지 진리표 검증."""
    assert NODE_TEST.exists(), f"규칙 테스트 파일이 없다: {NODE_TEST}"
    p = subprocess.run([shutil.which("node"), str(NODE_TEST)], cwd=str(FRONTEND),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 0, f"워크리스트 질의 규칙 위반:\n{p.stdout}\n{p.stderr}"


# ════════════════════════ (2) 배선 가드 — 계약이 조회 경로까지 ════════════════════════
def test_worklist_fetch_effect_does_not_depend_on_input_state():
    """목록 조회 effect 의 의존성에 filters/searchText(입력 상태)가 있으면 안 된다.

    있으면 '타이핑 한 글자 = 재조회' 가 되살아나고, 그 순간 수동 갱신 계약은 죽는다.
    조회는 committed(SEARCH 로 확정된 조건) + refreshKey 로만 트리거돼야 한다.
    """
    src = _src("pages/Worklist.tsx")
    # api.worklist(...) 호출이 들어 있는 effect 의 닫는 의존성 배열을 찾는다
    i = src.index("api.worklist(queryParams)")
    dep = re.search(r"\}, \[([^\]]*)\]\);", src[i:])
    assert dep, "조회 effect 의 의존성 배열을 찾지 못했다 — 구조가 바뀌었으면 이 테스트를 갱신하라"
    deps = [d.strip() for d in dep.group(1).split(",") if d.strip()]
    assert "filters" not in deps and "searchText" not in deps, (
        f"조회 effect 가 입력 상태를 다시 의존한다 → 타건마다 재조회된다: {deps}")
    assert "queryParams" in deps and "refreshKey" in deps, f"조회 트리거가 사라졌다: {deps}"


def test_query_params_are_built_from_committed_only():
    """queryParams(=목록·카운트 공용 파라미터)는 committed 에서만 파생돼야 한다."""
    src = _src("pages/Worklist.tsx")
    m = re.search(r"const queryParams = useMemo\((.{0,900}?)\);", src, re.S)
    assert m, "queryParams useMemo 를 찾지 못했다"
    body = m.group(1)
    assert "buildWorklistQuery(committed)" in body, "공용 순수 함수를 쓰지 않는다(따로 만들면 또 갈린다)"
    assert re.search(r"\[\s*committed\s*\]", body), f"의존성이 committed 하나가 아니다: {body!r}"


def test_settings_save_does_not_refetch_the_list():
    """설정 저장(sv-settings-saved)은 컬럼·패널만 다시 해석하고 목록은 건드리지 않는다.

    예전에는 저장 신호에서 setRefreshKey 를 함께 불러, 아무것도 안 바꾸고 [저장]만 눌러도
    목록이 재조회되고 default_status 재주입으로 사용자의 상태필터까지 되돌아갔다.
    """
    src = _src("pages/Worklist.tsx")
    m = re.search(r"const onSettingsSaved = \(\) => \{(.*?)\};", src, re.S)
    assert m, "onSettingsSaved 핸들러를 찾지 못했다"
    assert "setRefreshKey" not in m.group(1), "설정 저장이 목록을 재조회한다(행 구성이 바뀐다)"
    assert "loadWlPrefs()" in m.group(1) and "setSettingsTick" in m.group(1)


def test_default_status_latch_compares_the_value_not_a_once_flag():
    """default_status 재주입 판정은 공용 순수 함수(defaultStatusInjection)에 맡긴다.

    이 자리는 양쪽으로 한 번씩 기울어 두 번 지적을 받았다 —
      · 매번 주입 → 아무것도 안 바꾼 [저장]에 사용자의 상태필터가 병원 기본값으로 되돌아감
      · '최초 1회' 래치 → 설정에서 값을 실제로 바꿔 저장해도 그 세션엔 아무 일도 안 일어남
    진리표는 frontend/tests/worklist_query.test.mjs ⑤ 가 **실행해서** 고정한다. 여기서는
    Worklist 가 그 함수를 쓰고 있는지(=판정을 컴포넌트 안에서 다시 만들지 않았는지)만 본다.
    """
    src = _src("pages/Worklist.tsx")
    assert "prefsStatusInitRef" not in src, (
        "'최초 1회' 래치가 되살아났다 — 설정에서 기본 상태 필터를 바꿔도 새로고침 전까진 안 먹는다")
    assert "defaultStatusInjection(lastDefaultStatusRef.current, v.default_status)" in src, (
        "default_status 주입 판정이 공용 순수 함수를 거치지 않는다(따로 만들면 또 한쪽으로 기운다)")
    # 주입할 때는 커밋까지 함께 — 필터바 표시와 실제 목록이 어긋나면 안 된다
    m = re.search(r"if \(ds\.inject\) \{(.*?)\n      \}", src, re.S)
    assert m, "ds.inject 분기를 찾지 못했다 — 구조가 바뀌었으면 이 테스트를 갱신하라"
    assert "setFilters(nf)" in m.group(1) and "setCommitted(" in m.group(1), (
        f"주입이 입력 상태만 바꾸고 커밋하지 않는다(필터바는 바뀌는데 목록은 그대로): {m.group(1)!r}")


def test_filter_bar_inputs_never_trigger_a_fetch():
    """필터바의 **모든** onChange 는 입력 상태만 바꾼다 — 조회를 일으키면 안 된다.

    ⚠ 이 테스트의 성격: 과거 버그의 재현이 아니라 **전방 가드**다. 실제 버그는 조회 effect 의
      의존성에 있었고 그건 test_worklist_fetch_effect_does_not_depend_on_input_state 가 잡는다.
      (이전 판은 `set()` 한 줄만 봤는데, 그 한 줄은 애초에 깨진 적이 없어 수정 전 소스에서도
       통과하는 공허한 가드였다.)
      여기서 막는 회귀는 다른 것이다 — '조건 변경됨' 표시가 성가시다는 이유로 onChange 를
      set 대신 onSearch/applyAndSearch 로 바꿔 버리는 것. 그러면 effect 의존성은 그대로여도
      '내가 SEARCH 를 누를 때만 목록이 바뀐다' 는 계약이 필터바에서 무너진다.
    """
    src = _src("pages/Worklist.tsx")
    i = src.index("function FilterBar(")
    body = src[i:src.index("/* ── [C-좌]", i)]
    m = re.search(r"const set = \(k: string, v: string\) =>(.*?);\n", body, re.S)
    assert m, "FilterBar 의 set 헬퍼를 찾지 못했다"
    assert "setRefreshKey" not in m.group(1) and "onSearch" not in m.group(1), (
        "필터 입력이 곧바로 조회를 일으킨다 — SEARCH 를 눌러야 적용되는 계약 위반")
    # 렌더 블록의 onChange 핸들러 본문 전수 검사(중괄호 없는 화살표 한 줄 형태를 전제)
    handlers = re.findall(r"onChange=\{(.*?)\}\s*(?:onKeyDown|/>|>|\n)", body, re.S)
    assert len(handlers) >= 10, f"onChange 핸들러를 제대로 못 찾았다({len(handlers)}개) — 정규식 갱신 필요"
    for h in handlers:
        assert not re.search(r"\bonSearch\b|\bapplyAndSearch\b|\bsetRefreshKey\b", h), (
            f"필터 입력 onChange 가 조회를 부른다 — 타건/셀렉트 변경만으로 목록이 바뀐다: {h!r}")


def test_refresh_means_the_same_thing_in_all_three_skins():
    """'새로고침' 은 세 스킨 모두 **커밋된 조건을 다시 본다** — SEARCH 와 뜻이 달라야 한다.

    한때 SaintView 상태바 ⟳ 와 Live 수동모드 배너 [지금 갱신] 만 runSearch(=applyAndSearch,
    커밋) 로 바뀌어, 필터바에 타이핑만 해 둔 미커밋 조건이 ⟳ 한 번에 함께 적용됐다.
    같은 조작을 I-View/T-View 의 🔄(doAction("refresh")) 로 하면 목록이 그대로였다 —
    같은 이름의 버튼이 스킨마다 다른 뜻이 됐고, '누른 건 ⟳ 인데 결과 집합이 바뀐다' 는
    이번 회차 계약(SEARCH 를 눌러야 목록이 바뀐다)과도 정면으로 어긋났다.
    """
    src = _src("pages/Worklist.tsx")
    m = re.search(r"const reloadList = useCallback\(\(\) => \{(.*?)\}, \[\]\);", src, re.S)
    assert m, "reloadList(공용 새로고침) 를 찾지 못했다"
    assert "setRefreshKey" in m.group(1) and "setPendingChange(false)" in m.group(1), (
        f"새로고침이 재조회/알림 해제를 하지 않는다: {m.group(1)!r}")
    assert "setCommitted" not in m.group(1) and "applyAndSearch" not in m.group(1), (
        "새로고침이 미커밋 입력까지 커밋한다 — 그건 SEARCH 의 일이다")
    # 세 경로가 모두 같은 함수를 쓴다
    assert "onRefresh={reloadList}" in src, "SaintView 상태바 ⟳ 가 공용 새로고침을 쓰지 않는다"
    # 라벨은 i18n 래핑(tr("지금 갱신"))일 수도, 원문일 수도 있다 — 계약은 reloadList 사용이다
    assert re.search(r'onClick=\{reloadList\}>(?:\{tr\("지금 갱신"\)\}|지금 갱신)', src), \
        "Live 수동모드 배너의 [지금 갱신] 이 공용 새로고침을 쓰지 않는다"
    assert re.search(r'case "refresh": reloadList\(\);', src), \
        "I-View/T-View 의 🔄(doAction refresh) 가 공용 새로고침을 쓰지 않는다"


# ════════════════════════ (3) 자동완성 오염 차단 ════════════════════════
def test_login_forms_do_not_prefill_seed_credentials():
    """운영 로그인 화면에 시드 계정(SAMPLE01/admin)을 프리필하지 않는다.

    프리필 → 브라우저가 자격증명으로 저장 → 같은 문서의 이름 없는 텍스트 칸(워크리스트 SEARCH)에
    자동완성으로 흘러들어감. 값의 출처가 앱 코드가 아니라 비밀번호관리자였다.
    """
    src = _src("pages/ClientLogin.tsx")
    # 문자열 리터럴로 존재하면 안 된다(주석의 사고 설명은 남겨 둔다 — '왜' 를 지우면 또 되돌아간다)
    assert '"SAMPLE01"' not in src and "'SAMPLE01'" not in src, "ClientLogin 이 시드 병원ID 를 프리필한다"
    assert re.search(r'useState\(remembered \? \(localStorage\.getItem\("sv_client_user"\) \?\? ""\) : ""\)', src), \
        "ClientLogin 이 개별 ID 를 기본값('admin' 등)으로 채운다"


def test_credential_fields_declare_their_role():
    """로그인 칸은 name + autoComplete 역할을 명시해야 저장 자격증명이 로그인 폼에만 바인딩된다."""
    for rel in ("pages/ClientLogin.tsx", "App.tsx"):
        src = _src(rel)
        assert 'autoComplete="username"' in src, f"{rel}: username 역할 미지정"
        assert 'autoComplete="current-password"' in src, f"{rel}: 비밀번호 역할 미지정"


def test_search_inputs_are_named_and_autocomplete_off():
    """워크리스트 SEARCH·필터 입력은 name + autoComplete=off — 이름 없는 칸이 자동완성 표적이다."""
    src = _src("pages/Worklist.tsx")
    assert 'name="wl-q"' in src and 'name="wl-nlq"' in src, "SEARCH/AI 검색 칸에 name 이 없다"
    assert re.search(r'name: `wl-f-\$\{k\}`,\s*autoComplete: "off"', src), \
        "필터바 입력에 name/autoComplete 가 없다"
    # SEARCH 칸 자체에 autoComplete 가 붙어 있는지
    i = src.index('name="wl-q"')
    assert 'autoComplete="off"' in src[i:i + 120], "SEARCH 칸에 autoComplete=off 가 없다"


@pytest.mark.parametrize("rel", ["pages/SettingsModal.tsx", "pages/WebPacsBrowser.tsx"])
def test_stray_password_fields_are_isolated_in_their_own_form(rel: str):
    """form 밖의 type=password 는 문서 전체를 '합성 로그인 폼'으로 만든다 — 자체 form 으로 격리.

    이게 SEARCH 칸 오염의 필수 조건이었다(설정 모달이나 WebPACS ⚙ 를 한 번 열면 재현).
    autocomplete="off" 만으로는 크롬을 확실히 못 막으므로, 폼 격리 + 역할 명시가 실효 수단이다.
    """
    src = _src(rel)
    for m in re.finditer(r'<input[^>]*type="password"', src, re.S):
        # 이 input 앞쪽에서 가장 가까운 <form ...> 이 닫히지 않았는지(= 폼 안인지) 본다
        head = src[:m.start()]
        assert head.count("<form") > head.count("</form>"), (
            f"{rel}: form 밖 type=password 가 남아 있다 (문서 전체가 로그인 폼으로 합성된다)")
        seg = src[m.start():m.start() + 260]
        assert "autoComplete=" in seg, f"{rel}: 비밀번호 칸에 autoComplete 역할이 없다"


def test_isolated_forms_do_not_submit_the_page():
    """격리용 form 안의 버튼이 submit 이면 페이지가 리로드된다 — type=button + onSubmit 차단 확인."""
    for rel in ("pages/SettingsModal.tsx", "pages/WebPacsBrowser.tsx"):
        src = _src(rel)
        assert 'onSubmit={(e) => e.preventDefault()}' in src, f"{rel}: 격리 form 의 submit 을 막지 않았다"
