/* 기기 프로필(2026-08-10 사용자 확정) — 계정당 3슬롯 + 장비 의존 설정 분리 저장 계약.
 * lib/deviceProfile.ts 의 순수 로직을 '실제로' 부르고, api.ts/백엔드 배선은 소스 계약으로 고정.
 *
 * 계약:
 *   · 같은 계정 동시 3시스템 — 슬롯 1..3. 4번째 기기는 가장 오래 안 쓴 기기를 밀어내고
 *     그 슬롯을 재사용한다(밀린 슬롯의 오버레이 초기화는 api.ts 책임).
 *   · 장비 의존 키만 오버레이 — viewer.prefs.monitor / worklist.prefs 패널 크기·표시.
 *     컬럼 구성(by_viewer 등)은 계정 공용(2026-08-09 확정)이라 오버레이에 **못** 들어간다.
 *
 * 실행: node --test --experimental-strip-types frontend/tests/device_profile_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEVICE_OVERLAY_KEYS, MAX_DEVICE_SLOTS, chooseSlot, mergeOverlay, pickOverlay, overlayKeyOf,
} from "../src/lib/deviceProfile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("슬롯 배정 — 1..3 순서대로 차고, 등록된 기기는 자기 슬롯을 유지한다", () => {
  assert.equal(MAX_DEVICE_SLOTS, 3);
  let reg = [];
  for (const [i, id] of ["tablet", "laptop", "reading-pc"].entries()) {
    const r = chooseSlot(reg, id, `2026-08-10T0${i}:00:00Z`, `기기${i}`, "1920×1080");
    assert.equal(r.slot, i + 1);
    assert.equal(r.isNew, true);
    assert.equal(r.evicted, null);
    reg = r.devices;
  }
  // 재접속 — 슬롯 유지 + last_seen 갱신, 레지스트리 크기 불변
  const again = chooseSlot(reg, "laptop", "2026-08-10T09:00:00Z", "노트북", "1366×768");
  assert.equal(again.slot, 2);
  assert.equal(again.isNew, false);
  assert.equal(again.devices.length, 3);
  assert.equal(again.devices.find((d) => d.id === "laptop").last_seen, "2026-08-10T09:00:00Z");
});

test("4번째 기기 — 가장 오래 안 쓴 기기를 밀어내고 그 슬롯을 재사용(LRU)", () => {
  const reg = [
    { id: "tablet", slot: 1, label: "t", last_seen: "2026-08-10T05:00:00Z" },
    { id: "laptop", slot: 2, label: "l", last_seen: "2026-08-01T00:00:00Z" },   // 최고령
    { id: "reading-pc", slot: 3, label: "r", last_seen: "2026-08-10T06:00:00Z" },
  ];
  const r = chooseSlot(reg, "new-pc", "2026-08-10T07:00:00Z", "새 PC", "2560×1440");
  assert.equal(r.evicted?.id, "laptop", "가장 오래 안 쓴 기기가 밀린다");
  assert.equal(r.slot, 2, "밀린 슬롯을 재사용");
  assert.equal(r.devices.length, 3, "레지스트리는 3개를 넘지 않는다");
  assert.ok(!r.devices.some((d) => d.id === "laptop"));
});

test("오버레이 분리 — 장비 의존 키만 갈라 저장하고, 읽기 병합은 기기 값이 이긴다", () => {
  // 계정 공용으로 확정된 키(컬럼 구성)는 오버레이 대상에 들어가면 안 된다
  assert.deepEqual([...DEVICE_OVERLAY_KEYS["viewer.prefs"]], ["monitor"]);
  for (const k of ["by_viewer", "col_widths_by_viewer", "columns"])
    assert.ok(!DEVICE_OVERLAY_KEYS["worklist.prefs"].includes(k), `${k} 는 계정 공용`);
  for (const k of ["layout_sizes", "sizes_by_viewer", "panels_by_viewer"])
    assert.ok(DEVICE_OVERLAY_KEYS["worklist.prefs"].includes(k), `${k} 는 장비 의존`);

  const doc = { monitor: { screens: [0, 1] }, hang2d: { CT: "2x2" }, ui_lang: "ko" };
  assert.deepEqual(pickOverlay("viewer.prefs", doc), { monitor: { screens: [0, 1] } });
  assert.equal(pickOverlay("report.prefs", doc), null, "오버레이 대상이 아닌 키는 null");

  const merged = mergeOverlay("viewer.prefs",
    { monitor: { screens: [0] }, hang2d: { CT: "2x2" } },
    { monitor: { screens: [0, 1, 2] }, hang2d: { CT: "1x1" } });   // 오버레이의 비대상 키는 무시
  assert.deepEqual(merged.monitor, { screens: [0, 1, 2] }, "장비 의존 키는 기기 값");
  assert.deepEqual(merged.hang2d, { CT: "2x2" }, "그 외 키는 공용 값 그대로");

  assert.equal(overlayKeyOf("viewer.prefs", 2), "viewer.prefs.dev2");
});

test("api.ts 배선 — 설정 읽기/쓰기가 슬롯 오버레이를 지나고, 계정 전환 시 재협상한다", () => {
  const s = src("src/api.ts");
  assert.ok(s.includes("ensureDeviceSlot"), "슬롯 협상 함수");
  assert.match(s, /getSetting: async[\s\S]{0,400}mergeOverlay\(/, "읽기 = 공용 ⊕ 오버레이");
  assert.match(s, /putSetting: async[\s\S]{0,500}pickOverlay\(/, "쓰기 = 공용 전체 + 장비 의존 키만 오버레이");
  assert.match(s, /setToken[\s\S]{0,200}slotPromise = null/, "계정 전환 시 슬롯 재협상");
  assert.ok(s.includes("clearDeviceSlot") && s.includes("renameDeviceSlot"), "설정>환경 슬롯 관리 API");
  // 밀어내기·비우기 시 그 슬롯의 오버레이를 초기화한다(이전 기기 환경 누출 방지) — 2곳
  assert.ok((s.match(/overlayKeyOf\(k, (r\.slot|gone\.slot)\), \{\}/g) || []).length >= 2,
            "evict/clear 오버레이 초기화");
});

test("백엔드 계약 — 세션 상한 3(한 곳) + 기기 설정 키 화이트리스트(user 전용)", () => {
  const svc = src("../backend/app/services/session_service.py");
  assert.match(svc, /MAX_LIVE_SESSIONS = 3/, "상한 3 — 이 상수 한 곳");
  assert.ok(svc.includes("def live_sessions") && svc.includes("def enforce_cap"));
  assert.match(svc, /last_seen\.asc\(\)/, "인계 대상 = 가장 오래 안 쓴 세션부터");

  const auth = src("../backend/app/api/auth.py");
  assert.match(auth, />= session_service\.MAX_LIVE_SESSIONS/, "client-login 은 3개째까지 무프롬프트");
  assert.equal((auth.match(/session_service\.enforce_cap\(/g) || []).length, 2,
               "force + webpacs-login 두 경로 모두 enforce_cap 한 곳을 쓴다");
  assert.ok(!auth.includes("session_service.find_live("), "1세션 인계 모델(find_live 직접 호출) 금지");

  const st = src("../backend/app/api/settings.py");
  for (const k of ["device.slots", "viewer.prefs.dev1", "viewer.prefs.dev3",
                   "worklist.prefs.dev1", "worklist.prefs.dev3"])
    assert.ok((st.match(new RegExp(`"${k.replace(/\./g, "\\.")}"`, "g")) || []).length >= 2,
              `${k} — ALLOWED_KEYS 와 USER_ONLY_KEYS 양쪽 등재`);
});
