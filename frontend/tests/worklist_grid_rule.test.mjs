/* 워크리스트 그리드 컬럼 직접 조작 — 2026-08-10 사용자 확정 계약.
 *
 * 요구: 3스킨(Saint/I/T) 모두 ① 헤더 드래그로 컬럼 위치 이동 ② 우측 가장자리로 폭 조절
 *       ③ 전체 컬럼 USE 시 넘치면 가로 스크롤 ④ 조정값은 계정 사용자 ID 로 저장.
 *
 * 소스 계약으로 고정한다(StudyGrid 는 3스킨이 공유하는 단일 컴포넌트 — variant 만 다름):
 *  · tableLayout fixed + colgroup — auto 레이아웃은 내용이 폭을 이겨 조절이 무력화된다
 *  · 순서 저장 키 = by_viewer[vk] (설정 ▲▼ 와 동일 키 — 두 UI 가 갈리면 안 된다)
 *  · 폭 저장 키 = col_widths_by_viewer[vk] (계정별 worklist.prefs 병합 저장)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "src", "pages", "Worklist.tsx"), "utf8");

test("① 헤더 드래그 이동 — draggable + drop 재배열이 존재한다", () => {
  assert.ok(src.includes("draggable={!!onReorder}"), "헤더 드래그가 사라졌다");
  assert.ok(src.includes("const dropOn = (c: string)"), "드롭 재배열 함수가 없다");
});

test("② 폭 조절 — col-resize 핸들 + 40~600px 클램프", () => {
  assert.ok(src.includes('cursor: "col-resize"'), "폭 조절 핸들이 없다");
  assert.ok(src.includes("Math.max(40, Math.min(600,"), "폭 클램프(40~600)가 사라졌다");
  assert.ok(src.includes("resizingRef.current = true"),
    "폭 조절 중 드래그 이동 금지 가드가 없다 — 핸들을 끌면 컬럼이 이동해 버린다");
});

test("③ 가로 스크롤 — tableLayout fixed + colgroup + 넘침 컨테이너", () => {
  assert.ok(src.includes('tableLayout: "fixed", width: totalW, minWidth: "100%"'),
    "fixed 레이아웃·전체폭이 사라졌다 — 폭 지정과 가로 스크롤이 무력화된다");
  assert.ok(src.includes("<colgroup>"), "colgroup 이 없다");
});

test("④ 계정별 저장 — 순서는 by_viewer[vk], 폭은 col_widths_by_viewer[vk] 병합 저장", () => {
  assert.ok(/by_viewer: \{ \.\.\.\(\(r\.value as \{ by_viewer\?: object \}\)\.by_viewer \?\? \{\}\), \[vk\]: next \}/.test(src),
    "순서 저장이 설정 ▲▼ 와 다른 키로 갈라졌다");
  assert.ok(src.includes("col_widths_by_viewer: { ...cur, [vk]: next }"), "폭 저장 키가 사라졌다");
  assert.ok(src.includes("setColW(cwBag?.[vk] ?? {})"), "폭 복원(모드 전환 시)이 없다");
});
