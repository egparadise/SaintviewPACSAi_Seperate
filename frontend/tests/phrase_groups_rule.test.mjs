/* 단축키·템플릿의 모달리티별 분류 계약(2026-08-21 사용자 확정).
 *
 * 사용자 요구:
 *   그림1 — Setting>판독>단축키 설정: **모달리티별 분류**, 선택하면 확장하여 하위에 나타남
 *   그림2 — 판독창의 단축키: 모달리티별 분류 + **현재 판독할 모달리티가 확장**되며 하단에 나타남
 *
 * 실행: node --test --experimental-strip-types frontend/tests/phrase_groups_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMMON_LABEL, MODALITY_ORDER, autoOpenKey, groupByModality, initialOpenKeys, sameFamily,
} from "../src/lib/phraseGroups.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const P = (id, modality, name = `p${id}`) => ({ id, modality, name });
const ROWS = [
  P(1, "CT"), P(2, "CR"), P(3, ""), P(4, "MR"), P(5, "CR"), P(6, "MG"), P(7, "  "),
];

test("모달리티별로 묶는다 — 빈 모달리티는 '공통'", () => {
  const g = groupByModality(ROWS);
  const byKey = Object.fromEntries(g.map((x) => [x.key, x.items.map((i) => i.id)]));
  assert.deepEqual(byKey["CR"], [2, 5]);
  assert.deepEqual(byKey["CT"], [1]);
  assert.deepEqual(byKey[""], [3, 7], "빈 값·공백은 한 그룹");
  assert.equal(g.find((x) => x.key === "").label, COMMON_LABEL);
});

test("공통이 맨 앞, 그다음은 판독 현장에서 흔한 순서", () => {
  const keys = groupByModality(ROWS).map((g) => g.key);
  assert.equal(keys[0], "", "어느 검사에서나 쓰는 것이라 늘 보이는 편이 낫다");
  // CR → MG → CT → MR (MODALITY_ORDER 순서)
  assert.deepEqual(keys.slice(1), ["CR", "MG", "CT", "MR"]);
  assert.ok(MODALITY_ORDER.indexOf("CR") < MODALITY_ORDER.indexOf("CT"));
});

test("목록에 없는 모달리티는 뒤에 알파벳순", () => {
  const keys = groupByModality([P(1, "ZZ"), P(2, "CT"), P(3, "AA")]).map((g) => g.key);
  assert.deepEqual(keys, ["CT", "AA", "ZZ"], "알려진 것 먼저, 나머지는 이름순");
});

test("동류 판정 — 일반촬영은 장비·병원마다 CR/DX/DR 로 들어온다", () => {
  assert.equal(sameFamily("DR", "CR"), true);
  assert.equal(sameFamily("dx", "CR"), true, "대소문자 무관");
  assert.equal(sameFamily("MRI", "MR"), true);
  assert.equal(sameFamily("PET", "PT"), true);
  assert.equal(sameFamily("CT", "MR"), false);
  assert.equal(sameFamily("", "CT"), false, "모르면 같다고 하지 않는다");
});

test("★ 그림2 — 현재 검사의 모달리티가 열린다(정확 일치 → 동류 순)", () => {
  const g = groupByModality(ROWS);
  assert.equal(autoOpenKey(g, "CT"), "CT");
  assert.equal(autoOpenKey(g, "DR"), "CR", "DR 검사인데 단축키는 CR 로 등록돼 있는 일이 흔하다");
  assert.equal(autoOpenKey(g, "MRI"), "MR");
});

test("맞는 그룹이 없으면 아무것도 열지 않는다 — 엉뚱한 것을 이 검사용으로 오해하지 않게", () => {
  const g = groupByModality(ROWS);
  assert.equal(autoOpenKey(g, "US"), null, "'첫 그룹을 연다' 로 하지 않는다");
  assert.equal(autoOpenKey(g, ""), null);
  assert.equal(autoOpenKey([], "CT"), null);
});

test("처음 펼치는 집합 = 현재 모달리티 + 공통", () => {
  const g = groupByModality(ROWS);
  assert.deepEqual([...initialOpenKeys(g, "CT")].sort(), ["", "CT"]);
  assert.deepEqual([...initialOpenKeys(g, "US")], [""], "맞는 모달리티가 없어도 공통은 펼친다");
  // 공통 그룹이 아예 없으면 공백 키를 넣지 않는다
  const g2 = groupByModality([P(1, "CT")]);
  assert.deepEqual([...initialOpenKeys(g2, "CT")], ["CT"]);
});

test("배선 — 판독창은 현재 모달리티를 펼치고, 설정은 전부 펼친 채 시작한다", () => {
  const dock = src("src/components/ReportDock.tsx");
  assert.match(dock, /groupByModality\(rows\)/, "판독창도 같은 규칙을 쓴다");
  assert.match(dock, /openGrp \?\? initialOpenKeys\(groups, detail\.modality\)/,
    "지금 판독할 검사의 모달리티가 열려야 한다(그림2)");
  assert.match(dock, /\(\{g\.items\.length\}\)/, "그룹마다 개수 표시");

  const st = src("src/pages/SettingsModal.tsx");
  assert.match(st, /groupByModality\(list\)/, "설정도 같은 규칙(그림1)");
  assert.match(st, /const \[closedGrp, setClosedGrp\]/,
    "설정은 **닫힌 것**을 기억한다 = 기본이 '전부 펼침'. 등록된 것을 한눈에 보는 자리이기 때문");

  // 규칙 복제 금지 — 두 화면이 각자 정렬·동류 판정을 들고 있으면 반드시 갈린다
  for (const [n, s] of [["ReportDock", dock], ["SettingsModal", st]]) {
    assert.ok(!/MODALITY_ORDER\s*=|FAMILIES\s*=/.test(s), `${n}: 분류 규칙을 복제하면 갈린다`);
  }
});

test("★ 단축키 목록을 그리는 **모든 화면**이 모달리티로 분류한다", () => {
  const SCREENS = {
    "설정(Setting>판독>단축키)": "src/pages/SettingsModal.tsx",
    "판독창(ReportWindow)": "src/pages/ReportWindow.tsx",
    "뷰어 도크(ReportDock)": "src/components/ReportDock.tsx",
  };
  for (const [label, f] of Object.entries(SCREENS)) {
    const t = src(f);
    assert.match(t, /groupByModality\(/, `${label}: 분류가 걸려 있어야 한다`);
    assert.match(t, /from "\.\.\/lib\/phraseGroups"/, `${label}: 규칙은 lib 한 곳`);
  }
  // 판독 화면(설정 아님) 둘은 현재 검사 모달리티를 펼친다 — 그림2
  for (const f of ["src/pages/ReportWindow.tsx", "src/components/ReportDock.tsx"]) {
    assert.match(src(f), /initialOpenKeys\(\s*\w+,\s*detail\.modality\s*\)/,
      `${f}: 현재 검사의 모달리티가 펼쳐져 있어야 한다`);
  }
});

