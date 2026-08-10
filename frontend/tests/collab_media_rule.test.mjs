/* 협진 미디어 권한·창 동작·초대·탭·배타(2026-08-10 사용자 확정) — 소스 계약.
 *
 * 증상: "상대방이 보이지 않고 내 마이크도 동작하지 않아" — 원인 1순위는 브라우저 권한
 * 차단·장치 점유·엉뚱한 기본 장치인데, 실패 토스트만으로는 알 수 없었다.
 *
 * 계약:
 *   · 미디어 권한 패널은 lib/mediaPerms + components/MediaPermPanel **한 벌** —
 *     협진 창 하단과 설정>협진이 같은 컴포넌트를 쓴다.
 *   · 테스트 프로브는 장치를 열었다 **즉시 놓는다**(통화 점유 금지).
 *   · webrtcMesh 는 패널에서 고른 장치(localStorage)를 ideal 로 소비한다.
 *   · ✕=종료(설정으로 숨기기 전환 가능) · —=숨기기. 탭 전환·숨김은 통화를 죽이지 않는다.
 *   · 미디어는 한 대화만(배타) — 다른 대화 버튼 비활성. 초대는 친구 아니어도 가능.
 *
 * 실행: node --test frontend/tests/collab_media_rule.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

test("mediaPerms — 프로브는 장치를 즉시 놓고, 오류는 조치 가능한 사유로 번역한다", () => {
  const s = src("src/lib/mediaPerms.ts");
  assert.ok((s.match(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/g) || []).length >= 3,
            "probeDevice·probeScreen·probeMicLevel 전부 트랙 즉시 정지");
  assert.match(s, /NotAllowedError/, "권한 차단 사유 매핑");
  assert.match(s, /NotReadableError/, "장치 점유 사유 매핑");
  assert.match(s, /ideal: v/, "장치 선택은 ideal — 장치가 사라져도 기본으로 폴백");
});

test("MediaPermPanel 한 벌 — 협진 창 하단(compact) + 설정>협진이 같은 컴포넌트", () => {
  assert.match(src("src/components/CollabDock.tsx"), /<MediaPermPanel compact \/>/);
  assert.match(src("src/pages/SettingsModal.tsx"), /<MediaPermPanel \/>/);
  const p = src("src/components/MediaPermPanel.tsx");
  assert.match(p, /probeMicLevel/, "마이크 입력 레벨 확인(0 = 권한이 아니라 입력 문제)");
});

test("webrtcMesh — 패널에서 고른 장치를 소비하고, 현재 룸을 노출한다", () => {
  const s = src("src/lib/webrtcMesh.ts");
  assert.match(s, /preferredDevice\(MIC_DEV_KEY\)/, "마이크 장치 선택 소비");
  assert.match(s, /preferredDevice\(CAM_DEV_KEY\)/, "카메라 장치 선택 소비");
  assert.match(s, /room\(\): string \| null \{ return this\.signalRoom; \}/, "미디어 배타 판정용 룸 노출");
});

test("협진 창 — ✕=종료/—=숨기기 구별, 탭 전환·숨김은 통화를 죽이지 않는다", () => {
  const s = src("src/components/CollabDock.tsx");
  assert.match(s, /const endAll = \(\) => \{ mesh\.stop\(\); onClose\(\); \};/, "✕ = 통화 종료 + 닫기");
  assert.match(s, /close_action === "hide" \? onClose\(\) : endAll\(\)/, "✕ 동작은 Setting>협진 설정");
  assert.match(s, /숨기기 — 대화·통화는 그대로 유지됩니다/, "— 버튼 = 숨기기");
  assert.match(s, /if \(!anyMediaRef\.current\) mesh\.stop\(\);/,
               "정리(cleanup)는 미디어가 꺼져 있을 때만 — 탭 전환이 통화를 끊으면 안 된다");
});

test("미디어 배타 — 다른 대화 소유 중엔 버튼 비활성(설정으로 가져오기 전환)", () => {
  const s = src("src/components/CollabDock.tsx");
  assert.match(s, /const foreignOwner = ownerRoom !== null && ownerRoom !== visRoom;/);
  assert.equal((s.match(/foreignOwner && dockCfg\.media_exclusive/g) || []).length >= 3, true,
               "음성·화상·화면 세 버튼 모두 배타 비활성");
  assert.match(s, /if \(anyMediaRef\.current && mesh\.room\(\) !== room\) return;/,
               "다른 대화가 미디어 소유 중이면 그 방의 시그널을 유지");
  assert.match(s, /!foreignOwner && \(mic \|\| cam \|\| screen/, "남의 통화 타일을 이 탭에 그리지 않는다");
});

test("초대·다중 채팅 탭 — 친구 아니어도 대화 시작, 사람별 탭", () => {
  const s = src("src/components/CollabDock.tsx");
  assert.match(s, /u\.relation !== "blocked" && u\.id !== meId/, "차단·본인만 제외하고 전원 초대 가능");
  assert.match(s, /setChats\(\(prev\) => \(prev\.some/, "대화 열기 = 탭 등록");
  assert.match(s, /chats\.map\(\(u\)/, "사람별 대화 탭 바");
  const svc = src("../backend/app/services/collab_service.py");
  assert.match(svc, /def dm_allowed/, "서버 정책 — 차단만 아니면 허용");
});

test("설정>협진 — 협진 창 동작(✕·미디어 배타)이 계정 로밍(viewer.prefs.collab)", () => {
  const s = src("src/pages/SettingsModal.tsx");
  assert.match(s, /close_action: "end" \| "hide"; media_exclusive: boolean;/, "colCfg 확장");
  assert.ok(s.includes('tr("협진 창 동작")') && s.includes('tr("미디어 동시 사용 제한")'));
  const d = src("src/components/CollabDock.tsx");
  assert.match(d, /collab\?: \{ close_action\?: "end" \| "hide"; media_exclusive\?: boolean \}/,
               "협진 창이 같은 키(viewer.prefs.collab)를 읽는다");
});
