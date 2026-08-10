/* 판독창 전체화면 + 하단 Worklist 뷰어 + 설정 모달 드래그(2026-08-10 사용자 확정) — 소스 계약.
 *
 *  · 판독창 크기 결정은 lib/screens.openReportWindow **한 곳** — 예전엔 4곳이 제각각
 *    고정 폭(440/980/1280)으로 열어 "작은 화면으로 뜬다"가 났다. 항상 그 모니터 전체 크기.
 *  · 판독창 상단 'Worklist 뷰어' 체크 → 하단 도크(상하 스플리터) — report.prefs.worklist_viewer
 *    계정 로밍, Setting>판독>판독창 설정과 **같은 키**라 양방향이다.
 *  · 설정 모달은 제목줄 좌클릭 드래그로 이동.
 *
 * 실행: node --test frontend/tests/report_dock_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("판독창 크기 — openReportWindow 한 곳, 항상 모니터 전체(고정 소형 폭 금지)", () => {
  const scr = src("src/lib/screens.ts");
  assert.match(scr, /export async function openReportWindow/, "공통 헬퍼");
  assert.match(scr, /availWidth/, "폴백도 현재 모니터 전체 크기");
  assert.match(scr, /moveTo\(m\.left, m\.top\); w\.resizeTo\(m\.width, m\.height\)/,
               "재사용 창은 open 좌표가 무시된다 — 직접 이동/리사이즈");

  for (const f of ["src/pages/Worklist.tsx", "src/pages/Viewer2D.tsx"]) {
    const s = src(f);
    assert.ok(!/sv_report", features\)/.test(s), `${f} — 판독창 직접 open 금지(헬퍼만)`);
    assert.ok(!s.includes("width=440,height=1020"), `${f} — 440px 소형 창(작은 화면 증상) 금지`);
    assert.ok(!s.includes("width=980,height=800") && !s.includes("width=1280,height=860"),
              `${f} — 고정 소형 폴백 금지`);
    assert.ok(s.includes("openReportWindow("), `${f} — 헬퍼 사용`);
  }
});

test("판독창 하단 Worklist 뷰어 — 체크·상하 조절·계정 저장·더블클릭 전환", () => {
  const s = src("src/pages/ReportWindow.tsx");
  assert.match(s, /checked=\{wlDock\} onChange=\{\(e\) => toggleWlDock\(e\.target\.checked\)\}/,
               "판독창 상단 체크");
  assert.match(s, /worklist_viewer: on \}, "user"\)/, "체크 → report.prefs 계정 로밍");
  assert.match(s, /worklist_viewer_h: h \}, "user"\)/, "높이도 계정 로밍");
  assert.match(s, /cursor: "row-resize"/, "상하 스플리터");
  assert.match(s, /function WorklistDock\(/, "하단 도크 컴포넌트");
  assert.match(s, /onDoubleClick=\{\(\) => onOpen\(r\.id\)\}/, "더블클릭 = 그 검사 판독 전환");
  assert.match(s, /STATUS_LABEL\[r\.status\]/, "상태 표기는 워크리스트와 같은 사전(STATUS_LABEL)");
});

test("Setting>판독 '판독창 설정' — 같은 키(report.prefs.worklist_viewer)로 양방향", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.ok(s.includes('tr("판독창 설정")') && s.includes('tr("Worklist 뷰어 사용")'));
  assert.match(s, /checked=\{!!rdOpts\.worklist_viewer\}/, "판독창 체크와 같은 키를 읽는다");
  assert.match(s, /worklist_viewer: e\.target\.checked/, "설정에서 바꿔도 같은 키에 쓴다");
  // save() 가 rdOpts 전체를 report.prefs 로 저장하므로 별도 배선 불요 — 그 계약을 고정
  assert.match(s, /putSetting\("report\.prefs",\s*\{ \.\.\.rdOpts/, "save() 가 rdOpts 를 통째로 저장");
});

test("설정 모달 — 제목줄 좌클릭 드래그로 이동(최대화 시 원위치)", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.match(s, /const dragMove = \(e: React\.MouseEvent\)/, "드래그 핸들러");
  assert.match(s, /onMouseDown=\{dragMove\}/, "제목줄에 바인딩");
  assert.match(s, /translate\(\$\{dragOff\.x\}px, \$\{dragOff\.y\}px\)/, "이동은 transform 오프셋");
  assert.match(s, /if \(maxed\) return;/, "최대화 상태에선 드래그 무시");
  assert.match(s, /t\.closest\("button, input, select, a/, "헤더 안 컨트롤 클릭은 드래그가 아니다");
});
