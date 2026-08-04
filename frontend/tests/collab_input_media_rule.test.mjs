/* 협진 입력·미디어 회귀 규칙.
 *
 * 실제 장애 두 가지를 고정한다.
 *   ① 초대받은 계정은 WS/화면 미러 이벤트로 부모가 자주 다시 그려진다. 채팅 초안까지
 *      React controlled state 에 묶으면 IME 조합/포커스가 흔들릴 수 있으므로 DOM ref 로 둔다.
 *   ② P2P 연결을 먼저 만든 뒤 장치를 켜는 정상 UX 에서 addTrack 만 호출하면 새 m-line 재협상이
 *      없어 상대에게 음성/영상이 안 간다. 최초 연결부터 A/V transceiver 를 확보해야 한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const dock = readFileSync(`${root}components/CollabDock.tsx`, "utf8");
const session = readFileSync(`${root}components/CollabSessionPanel.tsx`, "utf8");
const rtc = readFileSync(`${root}lib/webrtcMesh.ts`, "utf8");

test("DM/세션 채팅은 재렌더와 분리된 plain-text 편집기이고 IME Enter를 보호한다", () => {
  for (const [name, src] of [["DM", dock], ["세션", session]]) {
    assert.match(src, /ref=\{draftRef\}[\s\S]{0,160}contentEditable=\{true\}/,
      `${name} 입력이 DOM 소유 plain-text 편집기가 아니다`);
    assert.match(src, /draftRef\.current\?\.innerText\.trim\(\)/,
      `${name} 전송이 편집기 DOM에서 글을 읽지 않는다`);
    assert.doesNotMatch(src, /value=\{draft\}/, `${name} 입력이 렌더 주기에 다시 결합됐다`);
    assert.match(src, /nativeEvent\.isComposing/, `${name} 입력에서 한글 IME Enter 보호가 없다`);
    assert.match(src, /e\.stopPropagation\(\)/, `${name} 입력이 뷰어 전역 단축키로 전파된다`);
  }
});

test("WebRTC는 최초 offer 전에 audio/video 송수신 슬롯을 확보한다", () => {
  assert.match(rtc, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
  assert.match(rtc, /addTransceiver\("video", \{ direction: "sendrecv" \}\)/);
  assert.match(rtc, /sender\.replaceTrack\(track\)/, "장치 토글이 기존 송신 슬롯을 교체하지 않는다");
  assert.doesNotMatch(rtc, /pc\.addTrack\(/, "연결 후 addTrack은 재협상 누락 장애를 되살린다");
});

test("화면 공유는 브라우저 선택 UI를 쓰고 사용자가 공유를 중지하면 트랙을 정리한다", () => {
  assert.match(rtc, /getDisplayMedia/);
  assert.match(rtc, /track\.addEventListener\("ended"/);
  assert.match(session, /mesh\.setScreenShare\(!screen\)/);
  // Suite 는 표시 문자열을 tr() 로 감싼다(10개 언어) — 라벨은 `🖥 ${tr("공유 중")}` 형태
  assert.match(session, /🖥 [^\n]*공유 중/);
});

test("1:1 DM에서도 음성·화상·화면 공유를 바로 시작한다", () => {
  assert.match(dock, /mesh\.start\(meId, room\)/, "DM room 시그널링 컨텍스트가 없다");
  assert.match(dock, /mesh\.setMicrophone\(!mic\)/);
  assert.match(dock, /mesh\.setCamera\(!cam\)/);
  assert.match(dock, /mesh\.setScreenShare\(!screen\)/);
  assert.match(rtc, /room: this\.signalRoom/, "WebRTC SDP\/ICE에 DM room이 실리지 않는다");
  assert.match(rtc, /sendRtc\("rtc\.ready"/, "나중에 대화창을 연 상대와 재협상할 ready 신호가 없다");
});

test("rtc.ready 는 '유실 offer 복구' 신호다 — 살아 있는 통화를 끊지 않는다", () => {
  // 회귀: 가드가 없으면 syncPeers(참가자 입·퇴장마다 호출)가 이미 연결된 피어에게도
  // ready 를 보내고, 받은 쪽이 dropPeer→재연결을 해서 전원 통화가 매번 끊겼다.
  assert.match(rtc, /const fresh = !this\.pcs\.has\(id\)/, "송신측 신규 연결 가드가 없다");
  assert.match(rtc, /if \(fresh && this\.myId < id\) this\.sendRtc\("rtc\.ready"/,
    "이미 연결된 피어에게도 ready 를 보낸다");
  assert.match(rtc, /live === "connected" \|\| live === "connecting"/,
    "수신측이 살아 있는 연결을 확인하지 않고 끊는다");
});

test("원격 미디어는 자동 재생 속성을 가진다", () => {
  assert.match(session, /muted=\{muted\} autoPlay playsInline/);
});

test("응답 측 미디어가 나갈 자리를 만든다 — associated transceiver 우선 + sendrecv", () => {
  // 실브라우저 2탭 검증에서 잡은 결함: 원격 offer 를 적용하면 브라우저가 m-line 마다
  // 새 transceiver 를 만들고, 미리 선점한 것은 mid=null 고아로 남는다. 고아에 트랙을 붙이면
  // answer 가 recvonly 로 나가 **응답한 쪽의 음성·영상이 한 방향도 흐르지 않는다**.
  assert.match(rtc, /txs\.find\(\(t\) => t\.mid !== null\)/,
    "연결된(mid 있는) transceiver 를 우선 고르지 않는다");
  assert.match(rtc, /tx\.direction === "recvonly"[\s\S]{0,60}tx\.direction = "sendrecv"/,
    "recvonly 로 남은 방향을 sendrecv 로 열지 않는다");
  assert.match(rtc, /this\.attachTracks\(pc\);[\s\S]{0,200}createAnswer\(\)/,
    "answer 를 만들기 전에 트랙을 붙이지 않는다(그 뒤엔 재협상 없이 못 보낸다)");
});
