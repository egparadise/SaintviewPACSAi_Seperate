"""2D 행잉 우선순위 규정(뷰어 공통 vs 개별 뷰어) 회귀 — 프론트 순수 함수를 Node 로 실제 실행한다.

이 저장소의 프론트엔드에는 테스트 러너가 없다(package.json 에 vitest 없음). 그런데 이 규정은
설정 화면 문구가 기획 원문이고, 코드가 그 문구와 어긋난 채 배포된 적이 있다(양방향 폴백).
그래서 규정 구현(frontend/src/lib/viewerConfig.ts pickHang2d)을 Node 의 TS 타입 스트리핑으로
'원본 파일 그대로' import 해서 진리표를 검증한다 — 모킹도 사본도 없다.

규정: ① MG 는 언제나 2D 행잉 표 밖(맘모=뷰어 공통 mg_hang) ② 공통 체크 on 이면 공통 맵만
      ③ off 면 그 뷰어 맵만. 어느 쪽이든 폴백 없음(키 없으면 '설정 없음'=뷰어 자동 규칙).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
NODE_TEST = FRONTEND / "tests" / "hang2d_rule.test.mjs"
VIEWERS = ("Viewer2D.tsx", "ViewerInfi.tsx")


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음 — 프론트 규정 테스트 생략")
def test_hang2d_priority_rule_truth_table():
    """진리표 8행(체크 on/off × 공통만/뷰어별만/양쪽/양쪽없음) + MG 제외 + 미저장키=on."""
    assert NODE_TEST.exists(), f"규정 테스트 파일이 없다: {NODE_TEST}"
    p = subprocess.run([shutil.which("node"), str(NODE_TEST)], cwd=str(FRONTEND),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 0, f"2D 행잉 규정 위반:\n{p.stdout}\n{p.stderr}"


def test_viewers_share_the_single_rule_implementation():
    """세 뷰어가 규정 구현을 '따로' 갖지 못하게 막는다.

    Viewer2D(SaintView·T-View)와 ViewerInfi(I-View)는 엔진이 달라서, 규정을 각자 인라인으로
    적으면 같은 설정에 뷰어마다 다르게 반응한다(실제로 그 상태로 배포됐다: I-View 만 MG Image 가
    먹고, 공통 체크가 켜져 있어도 뷰어별 값이 defMap 에 주입됐다). 그래서 두 파일 모두
    pickHang2d 를 부르고, 옛 인라인 폴백 식이 되살아나지 않았는지 본문에서 확인한다.
    """
    banned = ("commonMap[m] ?? perVMap[m]", "perVMap[m] ?? commonMap[m]",
              "toE(commonH[mm]) ?? toE(perVH[mm])", "toE(perVH[mm]) ?? toE(commonH[mm])")
    for name in VIEWERS:
        src = (FRONTEND / "src" / "pages" / name).read_text(encoding="utf-8")
        assert "pickHang2d(" in src, f"{name} 이 공용 규정(pickHang2d)을 쓰지 않는다"
        for b in banned:
            assert b not in src, f"{name} 에 옛 양방향 폴백 식이 되살아났다: {b}"


def test_mg_row_is_not_editable_in_hanging_table():
    """맘모는 '뷰어 공통 단일 규정' — 2D 행잉 편집기(공통 1 + 뷰어별 3)에 MG 행이 있으면 안 된다.

    MG 행이 있으면 사용자가 만질 수 있는데 뷰어마다 다르게 반응하는 칸이 생긴다
    (Viewer2D 는 무시, ViewerInfi 만 Image 반영 → 맘모 2×2 페인이 다시 타일로 쪼개졌다).
    진짜 맘모 규정은 같은 화면의 전용 블록(mg_hang)이다.
    """
    cfg = (FRONTEND / "src" / "lib" / "viewerConfig.ts").read_text(encoding="utf-8")
    line = next(x for x in cfg.splitlines() if x.strip().startswith("export const HANG2D_MODS"))
    assert '"MG"' not in line, f"2D 행잉 편집기 모달리티 목록에 MG 가 있다: {line.strip()}"
    src = (FRONTEND / "src" / "pages" / "SettingsModal.tsx").read_text(encoding="utf-8")
    assert "HANG2D_MODS" in src, "설정 화면이 공용 모달리티 목록을 쓰지 않는다(표를 따로 만들면 또 갈린다)"
    assert "mg_hang" in src, "MG 전용 설정(mg_hang) 블록이 사라졌다"
