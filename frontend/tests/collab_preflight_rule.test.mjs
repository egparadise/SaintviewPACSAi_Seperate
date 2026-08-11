/* 협진 서버 차단 판정 — lib/collabPreflight.ts 를 **실제로** 부른다.
 *
 * 이 판정이 틀리면 두 방향 모두 사람을 헤매게 한다:
 *   · 거짓 양성 → 멀쩡한 서버를 고치라고 한다(관리자가 nginx 를 뒤집는다)
 *   · 거짓 음성 → 서버가 막고 있는데 "사이트 설정에서 허용하세요" 라고 한다.
 *                 사용자는 아무리 눌러도 안 되는 것을 계속 누른다 ← 실제로 겪은 일
 * 화면만 봐서는 어느 쪽인지 알 수 없으므로 규칙을 여기서 못박는다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMedia, checkSocket, checkTurn, classifyMediaError, parsePermissionsPolicy, shouldAlert,
} from "../src/lib/collabPreflight.ts";

const OK = { secureContext: true, hasApi: true, policy: "absent", featureAllowed: null };

/* ── ① Permissions-Policy 파싱 ── */

test("parsePermissionsPolicy — 빈 괄호가 '차단'이다", () => {
  const h = 'camera=(), microphone=(self), display-capture=*';
  assert.equal(parsePermissionsPolicy(h, "camera"), "blocked");
  assert.equal(parsePermissionsPolicy(h, "microphone"), "allowed");
  assert.equal(parsePermissionsPolicy(h, "display-capture"), "allowed");
});

test("parsePermissionsPolicy — 지시자가 없으면 absent (차단이라고 단정하지 않는다)", () => {
  // ⚠ 여기서 blocked 를 돌려주면, 헤더를 아예 안 보내는 정상 서버를 전부 '차단'으로 본다
  assert.equal(parsePermissionsPolicy("geolocation=()", "camera"), "absent");
  assert.equal(parsePermissionsPolicy("", "camera"), "absent");
  assert.equal(parsePermissionsPolicy(null, "camera"), "absent");
  assert.equal(parsePermissionsPolicy(undefined, "camera"), "absent");
});

test("parsePermissionsPolicy — 오리진 목록·공백·대문자를 견딘다", () => {
  assert.equal(parsePermissionsPolicy('Camera=(self "https://a.b")', "camera"), "allowed");
  assert.equal(parsePermissionsPolicy("  camera = ( )  ", "camera"), "blocked");
  assert.equal(parsePermissionsPolicy("camera=(),microphone=()", "microphone"), "blocked");
});

test("parsePermissionsPolicy — 구 Feature-Policy(공백 문법)도 읽는다", () => {
  assert.equal(parsePermissionsPolicy("camera 'none'; microphone 'self'", "camera"), "blocked");
  assert.equal(parsePermissionsPolicy("camera 'none'; microphone 'self'", "microphone"), "allowed");
  assert.equal(parsePermissionsPolicy("microphone 'self'", "camera"), "absent");
});

/* ── ② 사전 점검 — 서버 탓과 사용자 탓을 가른다 ── */

test("checkMedia — 정상 환경이면 아무것도 막지 않는다", () => {
  assert.deepEqual(checkMedia("camera", OK), []);
  assert.deepEqual(checkMedia("display-capture", OK), []);
});

test("checkMedia — HTTPS 가 아니면 그것만 알린다 (나머지는 전부 이것 때문이다)", () => {
  const r = checkMedia("microphone", { ...OK, secureContext: false, hasApi: false });
  assert.equal(r.length, 1, "원인이 여럿으로 보이면 관리자가 엉뚱한 것부터 고친다");
  assert.equal(r[0].code, "insecure_context");
  assert.equal(r[0].serverSide, true);
  assert.ok(r[0].snippet?.includes("listen 443"), "조치에 실제 설정이 없다");
});

test("checkMedia — 정책 차단은 서버 탓, API 부재는 브라우저 탓", () => {
  const pol = checkMedia("camera", { ...OK, policy: "blocked" });
  assert.equal(pol[0].code, "policy_blocked");
  assert.equal(pol[0].serverSide, true);

  // featurePolicy 로만 알아낸 경우도 같은 판정
  const fp = checkMedia("camera", { ...OK, featureAllowed: false });
  assert.equal(fp[0].code, "policy_blocked");

  const api = checkMedia("camera", { ...OK, hasApi: false });
  assert.equal(api[0].code, "no_api");
  assert.equal(api[0].serverSide, false, "브라우저 문제를 서버 조치로 안내하면 안 된다");
});

test("checkMedia — featurePolicy 를 모르는 브라우저(null)를 차단으로 보지 않는다", () => {
  // Chrome 외 브라우저는 document.featurePolicy 가 없다. null 을 false 처럼 다루면
  // Firefox·Safari 사용자 전원에게 "서버가 막고 있다"고 거짓 안내하게 된다.
  assert.deepEqual(checkMedia("camera", { ...OK, featureAllowed: null }), []);
});

/* ── ③ WebSocket — close 코드가 범인을 가린다 ── */

test("checkSocket — 한 번도 안 열렸으면 nginx 업그레이드 차단", () => {
  const r = checkSocket({ status: "closed", everOpened: false, lastCloseCode: 1006 });
  assert.equal(r[0].code, "ws_blocked");
  assert.equal(r[0].serverSide, true);
  assert.ok(r[0].snippet?.includes("proxy_set_header Connection \"upgrade\""));
});

test("checkSocket — 앱이 의도적으로 닫은 것(4xxx)은 nginx 탓이 아니다", () => {
  // 4401 인증만료·4403 계정없음·4429 연결과다 — 이걸 nginx 문제로 안내하면
  // 관리자가 멀쩡한 설정을 뒤집는다.
  for (const code of [4401, 4403, 4429]) {
    assert.deepEqual(checkSocket({ status: "closed", everOpened: false, lastCloseCode: code }), [],
                     `close ${code} 를 서버 설정 문제로 오인했다`);
  }
});

test("checkSocket — 열렸던 적이 있으면 순단이다(설정을 고치라고 하지 않는다)", () => {
  const r = checkSocket({ status: "closed", everOpened: true, lastCloseCode: 1006 });
  assert.equal(r[0].serverSide, false);
  assert.notEqual(r[0].code, "ws_blocked");
});

test("checkSocket — 열려 있으면 아무 문제 없다", () => {
  assert.deepEqual(checkSocket({ status: "open", everOpened: true, lastCloseCode: 0 }), []);
});

/* ── ④ TURN — 막힌 게 아니라 경고다 ── */

test("checkTurn — 타 망 참가자 + ICE 없음일 때만, 그리고 blocking 이 아니다", () => {
  const w = checkTurn(true, 0);
  assert.equal(w[0].code, "no_turn");
  assert.equal(w[0].blocking, false, "경고를 차단으로 올리면 사내망 통화까지 막는다");
  assert.equal(w[0].serverSide, true);
  assert.deepEqual(checkTurn(true, 2), [], "TURN 이 있는데 경고했다");
  assert.deepEqual(checkTurn(false, 0), [], "같은 망인데 경고했다");
});

/* ── ⑤ 실패 오류 분류 ── */

test("classifyMediaError — 같은 NotAllowedError 라도 정책이면 서버 탓", () => {
  // Chrome 은 Permissions-Policy 차단도 NotAllowedError 로 준다. 메시지가 유일한 단서다.
  const pol = classifyMediaError("camera", "NotAllowedError",
    "Permissions policy violation: camera is not allowed in this document.");
  assert.equal(pol.code, "policy_blocked");
  assert.equal(pol.serverSide, true);

  const user = classifyMediaError("camera", "NotAllowedError", "Permission denied by user");
  assert.equal(user.code, "user_denied");
  assert.equal(user.serverSide, false);
});

test("classifyMediaError — 장치·보안 오류를 제자리로 보낸다", () => {
  assert.equal(classifyMediaError("microphone", "NotFoundError", "").code, "no_device");
  assert.equal(classifyMediaError("microphone", "NotReadableError", "").code, "no_device");
  assert.equal(classifyMediaError("microphone", "NotFoundError", "").serverSide, false);
  assert.equal(classifyMediaError("camera", "SecurityError", "").code, "insecure_context");
  assert.equal(classifyMediaError("camera", "SecurityError", "").serverSide, true);
});

test("classifyMediaError — 사용자가 공유 창을 취소한 것은 알림이 아니다", () => {
  const c = classifyMediaError("display-capture", "AbortError", "");
  assert.equal(c.blocking, false);
  assert.equal(shouldAlert([c]), false, "취소할 때마다 알림 창이 뜨면 못 쓴다");
});

test("shouldAlert — 서버 조치가 필요하면 경고여도 띄운다", () => {
  assert.equal(shouldAlert([]), false);
  assert.equal(shouldAlert(checkTurn(true, 0)), true, "TURN 경고는 관리자가 알아야 한다");
  assert.equal(shouldAlert(checkMedia("camera", { ...OK, policy: "blocked" })), true);
});
