/* 용량 초과 자동 삭제 규정 회귀 — lib/opfsStore.ts 의 planEvictions **원본**을 그대로 부른다.
 *
 * 왜 이 파일이 필요했나: 예전 축출 코드(opfsPrune)는 첫 줄이 dlSupportReason()(= import.meta.env·
 * window·navigator)이라 node 가 부를 수 없었다. 그래서 축출 규칙 테스트가 **0건**이었고,
 * 설정 문구('오래된 검사부터')와 실제 동작(lastUsed LRU)이 정반대인 채로 통과했다.
 *
 * 지키는 규정:
 *   ① 기본 정책은 **과거 검사일부터**다 — 옛날 검사를 오늘 열어 봤다고 해서 최신 검사가 먼저
 *      날아가면 안 된다(예전 코드는 정확히 그렇게 답했다).
 *   ② 보고 있는·받는 중인 검사는 **절대** 축출 목록에 없다. 그것 때문에 상한을 못 맞추면
 *      blockedByProtection 을 낸다(호출부는 '더 받지 않기'로 대응한다).
 *   ③ 상한보다 큰 검사 하나 = 받는 중 보호로 축출 0 + blocked — 지우고 다시 받는 무한 루프 차단.
 *   ④ 검사일을 모르는 검사(nodate/파싱불가)는 **가장 나중에** 지운다 — 모르는 것을 1순위로 두면
 *      방금 받은 검사가 먼저 날아간다.
 *   ⑤ 옛 레코드(studyDate 필드 없음)는 경로 세그먼트 dir[1] 로 폴백한다.
 *   ⑥ 설정 기본값 — autoEvict=true, evictBy=date(오타·미지정 포함), warnAtPct clamp.
 *
 * 실행: node frontend/tests/dl_evict_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { planEvictions, studyDateRank } from "../src/lib/opfsStore.ts";
import { DL_DEFAULTS, readDlPrefs } from "../src/lib/dlPrefs.ts";

const GB = 1024 * 1024 * 1024;
const NOW = Date.parse("2026-07-29T12:00:00Z");
const rec = (studyUid, bytes, lastUsed, studyDate, dir) => ({
  studyUid, bytes, lastUsed, ...(studyDate === undefined ? {} : { studyDate }), ...(dir ? { dir } : {}),
});

test("① 기본 정책은 과거 검사일부터 — 오늘 열어 본 옛날 검사가 최신 검사보다 먼저 지워진다", () => {
  // 조사에서 나온 재현 그대로: 2019년 검사(오늘 아침 열어봄) vs 2026년 검사(9일째 안 봄).
  // lastUsed LRU 로 판정하면 답이 ['NEW2026'] 으로 **정반대**가 된다.
  const records = [
    rec("OLD2019", 1.5 * GB, NOW - 4 * 3600_000, "20190103"),
    rec("NEW2026", 1.5 * GB, NOW - 9 * 86400_000, "20260720"),
  ];
  const p = planEvictions({ records, limitBytes: 2 * GB, protectedUids: [] });
  assert.deepEqual(p.evict, ["OLD2019"],
    "검사일 기준이 아니다 — lastUsed 로 되돌리면 최신 검사가 먼저 날아간다");
  assert.equal(p.freedBytes, 1.5 * GB);
  assert.equal(p.blockedByProtection, false);

  // policy=lru 는 **선택했을 때만** 옛 동작이 된다(설정에 남겨 둔 경로).
  const q = planEvictions({ records, limitBytes: 2 * GB, policy: "lru", protectedUids: [] });
  assert.deepEqual(q.evict, ["NEW2026"]);
});

test("① 상한 이하면 아무것도 지우지 않는다", () => {
  const p = planEvictions({
    records: [rec("A", 1 * GB, NOW, "20200101")], limitBytes: 2 * GB, protectedUids: [],
  });
  assert.deepEqual(p.evict, []);
  assert.equal(p.totalBytes, 1 * GB);
  assert.equal(p.blockedByProtection, false);
});

test("② 보고 있는 검사는 1순위여도 축출되지 않는다 — 대신 다음 후보로 넘어간다", () => {
  // 재현: 09:00 에 연 비교검사(2019년, 보는 중) 0.9GB + 방금 받은 새 검사들. 상한 2GB.
  const records = [
    rec("PRIOR", 0.9 * GB, NOW - 3 * 3600_000, "20190510"),   // 보는 중 = 보호
    rec("S1", 0.8 * GB, NOW - 60_000, "20260728"),
    rec("S2", 0.8 * GB, NOW - 30_000, "20260729"),
  ];
  const p = planEvictions({ records, limitBytes: 2 * GB, protectedUids: ["PRIOR"] });
  assert.ok(!p.evict.includes("PRIOR"), "보고 있는 검사가 지워졌다 — 판독 중 화면이 서버 렌더로 되돌아간다");
  assert.deepEqual(p.evict, ["S1"]);
  assert.equal(p.blockedByProtection, false);
});

test("② 보호분만으로 상한을 못 맞추면 blockedByProtection 이 참이고 보호 검사는 그대로 남는다", () => {
  const records = [
    rec("OPEN_A", 1.6 * GB, NOW, "20180101"),   // 보호(가장 오래된 검사이자 보호 대상)
    rec("OPEN_B", 1.0 * GB, NOW, "20180201"),   // 보호
    rec("FREE", 0.2 * GB, NOW, "20260101"),
  ];
  const p = planEvictions({ records, limitBytes: 2 * GB, protectedUids: ["OPEN_A", "OPEN_B"] });
  assert.deepEqual(p.evict, ["FREE"]);
  assert.equal(p.blockedByProtection, true,
    "못 맞췄는데 blocked 를 안 내면 호출부가 계속 받아 브라우저 할당량이 터진다");
  assert.equal(p.totalBytes - p.freedBytes > 2 * GB, true);
});

test("③ 상한보다 큰 검사 하나 — 받는 중 보호로 축출 0 + blocked(무한 되돌이 차단)", () => {
  // 상한 1GB 인데 지금 받는 검사가 이미 1.2GB. 보호가 없으면 자기 자신을 지우고 다시 받는다.
  const records = [rec("BIG", 1.2 * GB, NOW, "20260729")];
  const p = planEvictions({ records, limitBytes: 1 * GB, protectedUids: ["BIG"] });
  assert.deepEqual(p.evict, [], "받는 중인 검사를 지운다 — 지우고 받기를 영원히 반복한다");
  assert.equal(p.blockedByProtection, true);
  // 보호가 빠지면(=회귀) 자기 자신이 축출된다는 것을 명시적으로 남긴다
  const bad = planEvictions({ records, limitBytes: 1 * GB, protectedUids: [] });
  assert.deepEqual(bad.evict, ["BIG"]);
});

test("④ 검사일을 모르는 검사는 가장 나중에 지운다 — 방금 받은 검사가 먼저 날아가면 안 된다", () => {
  const records = [
    rec("NODATE", 1 * GB, NOW, "nodate"),
    rec("OLD", 1 * GB, NOW - 86400_000, "20150101"),
    rec("MID", 1 * GB, NOW - 86400_000, "20220101"),
  ];
  const p = planEvictions({ records, limitBytes: 1.5 * GB, protectedUids: [] });
  assert.deepEqual(p.evict, ["OLD", "MID"]);
  assert.ok(!p.evict.includes("NODATE"));
  // 모두 지워야 할 만큼 넘치면 nodate 가 마지막 순서로 들어간다
  const q = planEvictions({ records, limitBytes: 0.5 * GB, protectedUids: [] });
  assert.deepEqual(q.evict, ["OLD", "MID", "NODATE"]);
});

test("④ 검사일이 같으면 lastUsed 로 동률을 깬다", () => {
  const records = [
    rec("SAME_NEWUSE", 1 * GB, NOW, "20200101"),
    rec("SAME_OLDUSE", 1 * GB, NOW - 86400_000, "20200101"),
  ];
  const p = planEvictions({ records, limitBytes: 1.5 * GB, protectedUids: [] });
  assert.deepEqual(p.evict, ["SAME_OLDUSE"]);
});

test("⑤ studyDate 가 없는 옛 레코드는 경로 dir[1] 로 폴백한다", () => {
  assert.equal(studyDateRank("2026-07-28"), 20260728, "'YYYY-MM-DD' 도 읽어야 한다");
  assert.equal(studyDateRank("20190103"), 20190103);
  assert.equal(studyDateRank("nodate"), 0);
  assert.equal(studyDateRank(undefined), 0);
  const records = [
    // studyDate 필드가 통째로 없는 옛 레코드 — dir = [v1, {검사일}, {환자__UID}]
    rec("LEGACY_OLD", 1 * GB, NOW, undefined, ["v1", "20170301", "P1__abc"]),
    rec("LEGACY_NEW", 1 * GB, NOW - 86400_000, undefined, ["v1", "20260101", "P2__def"]),
  ];
  const p = planEvictions({ records, limitBytes: 1.5 * GB, protectedUids: [] });
  assert.deepEqual(p.evict, ["LEGACY_OLD"],
    "dir[1] 폴백이 없으면 옛 레코드가 전부 '검사일 미상' 이 되어 순서가 lastUsed 로 되돌아간다");
});

test("⑤ 같은 검사의 여러 파일은 검사 단위로 합산된다(삭제 단위 = 검사)", () => {
  const records = [
    rec("A", 0.6 * GB, NOW - 1000, "20200101"),
    rec("A", 0.6 * GB, NOW, "20200101"),
    rec("B", 1.0 * GB, NOW, "20260101"),
  ];
  const p = planEvictions({ records, limitBytes: 1.5 * GB, protectedUids: [] });
  assert.deepEqual(p.evict, ["A"]);
  assert.equal(p.freedBytes, 1.2 * GB, "검사 단위 합산이 아니면 상한 계산이 어긋난다");
  assert.equal(p.totalBytes, 2.2 * GB);
});

test("⑥ 설정 기본값 — 자동 삭제는 켜짐, 기준은 date(오타·미지정 포함), 알림 임계는 잘린다", () => {
  assert.equal(readDlPrefs({}).autoEvict, true, "기본이 꺼짐이면 할당량이 터져 저장본 전체가 날아간다");
  assert.equal(readDlPrefs(undefined).autoEvict, true);
  assert.equal(readDlPrefs({ dl_auto_evict: false }).autoEvict, false, "명시적으로 false 일 때만 꺼진다");
  assert.equal(readDlPrefs({ dl_auto_evict: "no" }).autoEvict, true, "값이 깨졌으면 켜진 채로 둔다");
  assert.equal(readDlPrefs({}).evictBy, "date");
  assert.equal(readDlPrefs({ dl_evict_by: "LRU" }).evictBy, "date", "정확히 'lru' 일 때만 LRU");
  assert.equal(readDlPrefs({ dl_evict_by: "oldest" }).evictBy, "date");
  assert.equal(readDlPrefs({ dl_evict_by: "lru" }).evictBy, "lru");
  assert.equal(readDlPrefs({}).warnNearLimit, true);
  assert.equal(readDlPrefs({ dl_warn_near: false }).warnNearLimit, false);
  assert.equal(readDlPrefs({ dl_warn_pct: 5 }).warnAtPct, 50);
  assert.equal(readDlPrefs({ dl_warn_pct: 500 }).warnAtPct, 99);
  assert.equal(readDlPrefs({ dl_warn_pct: "x" }).warnAtPct, DL_DEFAULTS.warnAtPct);
  assert.equal(DL_DEFAULTS.evictBy, "date");
  assert.equal(DL_DEFAULTS.autoEvict, true);
});

test("⑥ 정책이 무엇이든 보호 규칙은 같은 함수를 지난다 — lru 에서도 보호가 유효하다", () => {
  const records = [
    rec("OPEN", 1.5 * GB, NOW - 86400_000, "20260101"),   // LRU 1순위지만 보호 대상
    rec("OTHER", 1.0 * GB, NOW, "20250101"),
  ];
  const p = planEvictions({ records, limitBytes: 2 * GB, policy: "lru", protectedUids: ["OPEN"] });
  assert.deepEqual(p.evict, ["OTHER"]);
});
