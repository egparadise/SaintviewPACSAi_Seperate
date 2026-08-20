/* Study Layout 계약(2026-08-20 사용자 확정) — Study > Series > Image.
 *
 * 사용자 요구:
 *   "Study Layout 을 설정하면 상단 탭에 떠 있는 여러 환자의 Study 를 조합할 수 있다.
 *    즉 Study Layout > Series Layout > Image Layout 개념."
 *
 * 가장 중요한 계약은 **Study 1×1 이면 예전과 완전히 같다**는 것이다(안 쓰는 사용자에게 무변화).
 *
 * 실행: node --test --experimental-strip-types frontend/tests/study_layout_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STUDY_LAYOUT_DEFAULT, blockCount, blockEdge, blockIndexAt, blockOfPane, composeGrid,
  fitsPaneLimit, gridLabel, paneIndexAt, paneIndexesOfBlock, paneMatrix, pruneBlocks, readGrid,
} from "../src/lib/studyLayout.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const G = (r, c) => ({ r, c });

test("★ Study 1×1 이면 매핑이 예전과 완전히 같다 — 안 쓰는 사용자에게 무변화", () => {
  assert.deepEqual(STUDY_LAYOUT_DEFAULT, { r: 1, c: 1 });
  for (const [sr, sc] of [[1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [4, 4]]) {
    const series = G(sr, sc);
    const m = paneMatrix(G(1, 1), series);
    // 예전 렌더: PANE_IDS[행 * 열수 + 열]
    const old = Array.from({ length: sr }, (_, r) =>
      Array.from({ length: sc }, (_, c) => r * sc + c));
    assert.deepEqual(m, old, `Series ${sr}×${sc} 에서 자리 배치가 달라지면 회귀다`);
  }
});

test("합성 격자 — 검사 행×시리즈 행, 검사 열×시리즈 열", () => {
  assert.deepEqual(composeGrid(G(1, 2), G(2, 2)), { r: 2, c: 4 });
  assert.deepEqual(composeGrid(G(2, 2), G(1, 1)), { r: 2, c: 2 });
  assert.deepEqual(composeGrid(G(1, 1), G(2, 3)), { r: 2, c: 3 });
});

test("사용자 예시 — Study 1×2 · Series 2×2 → 왼쪽 2×2 가 검사 A, 오른쪽이 검사 B", () => {
  const study = G(1, 2), series = G(2, 2);
  const m = paneMatrix(study, series);
  assert.deepEqual(m, [
    [0, 1, 4, 5],
    [2, 3, 6, 7],
  ], "구획의 페인 번호는 연속이어야 구획을 통째로 다루기 쉽다");
  // 왼쪽 절반은 전부 구획 0, 오른쪽 절반은 구획 1
  for (const gr of [0, 1]) {
    for (const gc of [0, 1]) assert.equal(blockIndexAt(study, series, gr, gc), 0);
    for (const gc of [2, 3]) assert.equal(blockIndexAt(study, series, gr, gc), 1);
  }
  assert.deepEqual(paneIndexesOfBlock(series, 0), [0, 1, 2, 3]);
  assert.deepEqual(paneIndexesOfBlock(series, 1), [4, 5, 6, 7]);
  assert.equal(blockCount(study), 2);
});

test("페인 → 구획 역참조", () => {
  const series = G(2, 2);
  assert.equal(blockOfPane(series, 0), 0);
  assert.equal(blockOfPane(series, 3), 0);
  assert.equal(blockOfPane(series, 4), 1);
  assert.equal(blockOfPane(series, 7), 1);
  assert.equal(blockOfPane(G(1, 1), 5), 5, "1×1 시리즈면 페인 하나가 곧 구획 하나다");
});

test("구획 경계 — 경계선을 그릴 자리", () => {
  const series = G(2, 2);
  assert.deepEqual(blockEdge(series, 0, 0), { top: true, left: true });
  assert.deepEqual(blockEdge(series, 1, 1), { top: false, left: false });
  assert.deepEqual(blockEdge(series, 2, 2), { top: true, left: true }, "다음 구획의 첫 칸");
  assert.deepEqual(blockEdge(series, 0, 2), { top: true, left: true });
});

test("2×2 검사 구획 — 번호는 행 우선(좌→우, 위→아래)", () => {
  const study = G(2, 2), series = G(1, 1);
  assert.deepEqual(paneMatrix(study, series), [[0, 1], [2, 3]]);
  assert.equal(blockIndexAt(study, series, 1, 0), 2, "두 번째 줄 첫 구획");
});

test("페인 상한 — 넘는 조합은 고를 수 없다", () => {
  assert.equal(fitsPaneLimit(G(1, 1), G(10, 10)), true, "100칸까지");
  assert.equal(fitsPaneLimit(G(2, 1), G(10, 10)), false, "20행은 격자 상한을 넘는다");
  assert.equal(fitsPaneLimit(G(2, 2), G(5, 5)), true, "10×10 = 100");
  assert.equal(fitsPaneLimit(G(3, 3), G(4, 4)), false);
});

test("저장값 정리 — 깨져 있어도 화면이 죽지 않는다", () => {
  assert.deepEqual(readGrid(null), { r: 1, c: 1 });
  assert.deepEqual(readGrid({ r: 0, c: 99 }), { r: 1, c: 10 }, "1~10 으로 조인다");
  assert.deepEqual(readGrid({ r: "2", c: 2 }), { r: 1, c: 1 }, "숫자가 아니면 기본값");
  assert.deepEqual(readGrid({ r: 2, c: 3 }), { r: 2, c: 3 });
});

test("구획 수가 줄면 넘치는 배치는 버린다 — 유령 배치 금지", () => {
  const blocks = { 0: { examId: 1, studyUid: "a" }, 3: { examId: 2, studyUid: "b" } };
  assert.deepEqual(pruneBlocks(blocks, G(2, 2)), blocks, "4구획이면 둘 다 남는다");
  assert.deepEqual(pruneBlocks(blocks, G(1, 2)), { 0: { examId: 1, studyUid: "a" } },
    "2구획으로 줄이면 3번 배치는 사라져야 한다(다시 늘렸을 때 되살아나면 안 된다)");
});

test("표기 — 사용자가 쓴 'OO×OO' 형태", () => {
  assert.equal(gridLabel(G(1, 1)), "1×1");
  assert.equal(gridLabel(G(2, 3)), "2×3");
});

test("배선 — 세 뷰어 모두 Srs 옆에 STU 피커가 있고, 매핑은 lib 한 곳에서만", () => {
  const v2 = src("src/pages/Viewer2D.tsx");     // SaintView · T-View
  const inf = src("src/pages/ViewerInfi.tsx");  // I-View
  for (const [name, s] of [["Viewer2D", v2], ["ViewerInfi", inf]]) {
    assert.match(s, /label="STU"/, `${name}: 'STU' 피커가 있어야 한다`);
    assert.match(s, /paneMatrix\(/, `${name}: 격자 매핑은 lib 를 쓴다`);
    assert.ok(!/\* study\.c \+ .*panesPerBlock|Math\.floor\(gr \/ series\.r\)/.test(s),
      `${name}: 매핑 계산을 뷰어에 복제하면 반드시 갈린다`);
  }
});
