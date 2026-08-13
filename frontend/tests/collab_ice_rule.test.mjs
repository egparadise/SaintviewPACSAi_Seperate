/* 협진 ICE 해석 규칙 — lib/collabIce.ts 를 **실제로** 부른다.
 *
 * 실사고(2026-08-12): sv70(클라우드)에서 1:1 통화가 "연결 중…" 뒤 조용히 사라졌다.
 * 신호는 정상, **미디어 경로(ICE)** 실패 — 기본 ICE 가 빈 배열이라 서로 다른 망 사이에
 * 길이 없었다. 여기 규칙이 틀리면 두 방향의 사고가 난다:
 *   · 우선순위가 틀리면 → 관리자가 TURN 을 넣어도 안 먹는다
 *   · 사설망 판정이 틀리면 → 폐쇄망 병원이 매 통화 외부 STUN 을 질의한다(원래 설계 취지 훼손)
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STUN, hasTurn, isPrivateHost, parseIceJson, resolveIceServers, sanitizeIceServers,
} from "../src/lib/collabIce.ts";

const PUB = "sv70.cloudcare.life";

/* ── ① 우선순위: 이 PC > 서버 > 기본 ── */

test("resolveIceServers — 아무 설정 없음 + 공인 주소 = 기본 STUN", () => {
  const r = resolveIceServers({ localRaw: null, server: null, hostname: PUB });
  assert.equal(r.source, "default");
  assert.deepEqual(r.servers, DEFAULT_STUN);
});

test("resolveIceServers — 서버 설정이 있으면 기본을 덮는다 (관리자 TURN 이 실제로 먹어야 한다)", () => {
  const turn = [{ urls: ["turn:sv70:3478"], username: "u", credential: "c" }];
  const r = resolveIceServers({ localRaw: null, server: turn, hostname: PUB });
  assert.equal(r.source, "server");
  assert.deepEqual(r.servers, turn);
});

test("resolveIceServers — 이 PC 설정이 서버 설정보다 이긴다 (좌석별 예외)", () => {
  const r = resolveIceServers({
    localRaw: '[{"urls":"stun:internal:3478"}]',
    server: [{ urls: ["turn:sv70:3478"] }], hostname: PUB,
  });
  assert.equal(r.source, "local");
  assert.deepEqual(r.servers, [{ urls: ["stun:internal:3478"] }]);
});

test("resolveIceServers — **빈 배열은 '명시적으로 끔'** 이다(없음으로 강등 금지)", () => {
  // 서버가 [] 를 저장했다 = 폐쇄망이라 일부러 껐다. 기본 STUN 으로 되살리면 설계 취지 훼손.
  const s = resolveIceServers({ localRaw: null, server: [], hostname: PUB });
  assert.equal(s.source, "server");
  assert.deepEqual(s.servers, []);
  const l = resolveIceServers({ localRaw: "[]", server: [{ urls: ["turn:x"] }], hostname: PUB });
  assert.equal(l.source, "local");
  assert.deepEqual(l.servers, []);
});

test("resolveIceServers — 깨진 로컬 JSON 은 없는 것으로(다음 층으로 강등)", () => {
  const r = resolveIceServers({ localRaw: "{망가짐", server: null, hostname: PUB });
  assert.equal(r.source, "default");
});

/* ── ② 사설망 판정 — 폐쇄망 배려의 실체 ── */

test("isPrivateHost — 사설 주소로 접속했으면 기본 STUN 을 켜지 않는다", () => {
  for (const h of ["localhost", "127.0.0.1", "10.0.12.7", "192.168.0.10",
                   "172.16.5.1", "172.31.255.1", "169.254.1.1", "pacs.local", "::1"]) {
    assert.equal(isPrivateHost(h), true, `${h} 를 공인으로 봤다`);
  }
  const r = resolveIceServers({ localRaw: null, server: null, hostname: "192.168.0.10" });
  assert.equal(r.source, "none");
  assert.deepEqual(r.servers, []);
});

test("isPrivateHost — 공인 도메인·공인 IP 는 기본 STUN 대상", () => {
  for (const h of [PUB, "8.8.8.8", "172.32.0.1", "viewer.hospital.co.kr"]) {
    assert.equal(isPrivateHost(h), false, `${h} 를 사설로 봤다`);
  }
});

/* ── ③ 정규화 — 설정 오타가 통화를 통째로 죽이지 않게 ── */

test("sanitizeIceServers — stun/turn/turns 외 URL 과 모르는 키를 버린다", () => {
  const out = sanitizeIceServers([
    { urls: "turn:sv70:3478", username: "u", credential: "c", 이상한키: 1 },
    { urls: ["http://evil", "stun:ok:3478"] },
    { urls: "javascript:alert(1)" },
    "문자열", null, { username: "고아" },
  ]);
  assert.deepEqual(out, [
    { urls: ["turn:sv70:3478"], username: "u", credential: "c" },
    { urls: ["stun:ok:3478"] },
  ]);
});

test("parseIceJson — null/빈 문자열은 '설정 없음', '[]' 는 빈 목록", () => {
  assert.equal(parseIceJson(null), null);
  assert.equal(parseIceJson("  "), null);
  assert.deepEqual(parseIceJson("[]"), []);
});

test("hasTurn — STUN 만으로는 false (대칭 NAT 안내 판정)", () => {
  assert.equal(hasTurn(DEFAULT_STUN), false);
  assert.equal(hasTurn([{ urls: ["turn:x:3478"] }]), true);
  assert.equal(hasTurn([{ urls: "turns:x:5349" }]), true);
});
