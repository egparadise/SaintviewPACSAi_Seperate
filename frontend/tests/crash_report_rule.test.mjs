/* 오류 리포트가 **쓸모 있어야 한다** — components/ErrorBoundary.describeReason 를 실제로 부른다.
 *
 * 사용자가 보낸 sv70 로그가 이랬다:
 *   { "where": "unhandledrejection", "message": "[object XMLHttpRequest]", "build": "" }  × 20
 *
 * 세 가지가 동시에 잘못돼 있었다:
 *   ① `String(reason)` 이 XHR 을 문자열로 뭉개 **status·URL 을 통째로 버렸다**.
 *      영상 로더(@cornerstonejs/dicom-image-loader)는 Error 가 아니라 XHR 을 그대로 reject 한다.
 *   ② build 가 늘 "" 였다 — vite 의 define 은 식별자 치환이라 globalThis 에는 안 붙는데
 *      globalThis.__APP_VERSION__ 를 읽고 있었다. 어느 빌드에서 난 오류인지 알 수 없었다.
 *   ③ 같은 오류 20줄이 링버퍼를 채워 **정작 원인이 된 첫 오류를 밀어냈다**.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { describeReason } from "../src/lib/crashReason.ts";

test("XHR 거부 — status 와 URL 이 메시지에 남는다 (핵심 회귀 방어)", () => {
  const xhr = {
    readyState: 4, status: 502, statusText: "Bad Gateway",
    responseURL: "https://sv70.cloudcare.life/api/webpacs/live/rendered/1.2.3/1.2.4/1.2.5",
  };
  const d = describeReason(xhr);
  assert.notEqual(d.message, "[object XMLHttpRequest]", "예전처럼 정보를 버렸다");
  assert.match(d.message, /502/, `status 가 없다: ${d.message}`);
  assert.match(d.message, /rendered\/1\.2\.3/, `주소가 없다: ${d.message}`);
});

test("status 0 은 '네트워크 실패' 로 구분한다 — HTTP 오류와 원인이 다르다", () => {
  // 중단·CORS·연결 끊김일 때 브라우저는 status 를 0 으로 준다.
  const d = describeReason({ readyState: 4, status: 0, statusText: "", responseURL: "https://x/y" });
  assert.match(d.message, /네트워크 실패/, d.message);
  assert.match(d.message, /status 0/, d.message);
});

test("주소를 모르는 XHR 도 '주소 불명' 으로 남는다 (빈 문자열로 흘리지 않는다)", () => {
  const d = describeReason({ readyState: 4, status: 404, statusText: "Not Found", responseURL: "" });
  assert.match(d.message, /404/);
  assert.match(d.message, /주소 불명/);
});

test("Error 는 그대로 — message 와 stack 을 보존한다", () => {
  const e = new Error("무언가 터졌다");
  const d = describeReason(e);
  assert.equal(d.message, "무언가 터졌다");
  assert.ok(d.stack.length > 0, "stack 을 버렸다");
});

test("fetch Response 도 status·URL 을 남긴다", () => {
  const d = describeReason({ ok: false, status: 503, url: "https://sv70/api/auth/webpacs-login" });
  assert.match(d.message, /503/);
  assert.match(d.message, /webpacs-login/);
});

test("일반 객체 — message/error/detail 중 있는 것을 쓴다", () => {
  assert.match(describeReason({ message: "권한 없음" }).message, /권한 없음/);
  assert.match(describeReason({ detail: "원격 PACS 응답 없음" }).message, /원격 PACS/);
  assert.match(describeReason({ error: "타임아웃" }).message, /타임아웃/);
});

test("아무 단서도 없는 객체는 JSON 으로라도 남긴다 — '[object Object]' 로 흘리지 않는다", () => {
  const d = describeReason({ a: 1, b: "x" });
  assert.notEqual(d.message, "[object Object]");
  assert.match(d.message, /"a"/);
});

test("원시값 거부도 문자열로 남는다", () => {
  assert.equal(describeReason("문자열 사유").message, "문자열 사유");
  assert.equal(describeReason(undefined).message, "undefined");
  assert.equal(describeReason(null).message, "null");
});

test("순환 참조 객체에도 던지지 않는다 (기록 실패가 앱을 막으면 안 된다)", () => {
  const a = {};
  a.self = a;
  assert.doesNotThrow(() => describeReason(a));
  assert.ok(describeReason(a).message.length > 0);
});
