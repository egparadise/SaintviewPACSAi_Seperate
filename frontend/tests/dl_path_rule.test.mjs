/* 다운로드 모드 저장 경로·설정 해석 회귀 테스트 — lib/opfsStore.ts / lib/dlCache.ts 를 '실제로' 부른다.
 *
 * 지키는 규정:
 *   ① 경로에 StudyUID 가 들어간다 — **같은 날·같은 환자·같은 모달리티 검사 2건**이 충돌하면 안 된다.
 *      (이건 가정이 아니라 이미 당한 사고다: 63cdafc 에서 반출 ZIP 이 앞 검사를 못 꺼내고
 *       ISO 는 바이트를 이어붙여 손상 DICOM 을 구웠다. 사용자 확정 폴더 구조 '날짜-환자-Modality'
 *       그대로 두면 재현된다.)
 *   ② 썸네일과 본 영상은 Thumbnail / DICOM 으로 갈린다(사용자 확정 구조. 이름만 계승 — 내용은 JPEG).
 *   ③ 경로 세그먼트는 안전화된다 — `/`·`\`·`..` 로 폴더를 벗어날 수 없다.
 *   ④ 캐시 키는 kind 로 갈린다 — 썸네일이 본 영상 자리를 차지하면 안 된다.
 *   ⑤ 영상 취득 모드 기본값은 Live 이고, 범위를 벗어난 설정값은 잘린다(설정이 깨져도 폭주 금지).
 *
 * 되돌리면(경로에서 StudyUID 를 빼면 / kind 를 키에서 빼면) 아래 케이스가 실패한다.
 * 실행: node frontend/tests/dl_path_rule.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dlKey, dlPathFor, pendingTasks } from "../src/lib/opfsStore.ts";
import { DL_DEFAULTS, readDlPrefs } from "../src/lib/dlPrefs.ts";

/** 같은 날·같은 환자·같은 모달리티 — StudyUID 만 다른 검사 2건 */
const A = { studyUid: "1.2.410.200001.1.9999.20260728.111111", patientKey: "P12345", studyDate: "2026-07-28", modality: "CT" };
const B = { studyUid: "1.2.410.200001.1.9999.20260728.222222", patientKey: "P12345", studyDate: "2026-07-28", modality: "CT" };

test("① 같은 날·같은 환자·같은 모달리티 검사 2건의 검사 폴더가 서로 다르다", () => {
  const a = dlPathFor("full", "1.2.3.sopA", A);
  const b = dlPathFor("full", "1.2.3.sopB", B);
  assert.notDeepEqual(a.dir, b.dir,
    "검사 폴더가 같으면 63cdafc 의 경로 충돌 사고가 그대로 재현된다(StudyUID 를 경로에서 뺐는가?)");
  // 날짜·환자 부분은 같아야 한다 — 사용자 확정 구조를 버린 게 아니라 뒤에 UID 만 덧붙인 것
  assert.equal(a.dir[0], "v1");
  assert.equal(a.dir[1], "2026-07-28");
  assert.equal(b.dir[1], "2026-07-28");
  assert.ok(a.dir[2].startsWith("P12345__"), `환자ID 로 시작해야 한다: ${a.dir[2]}`);
  assert.ok(b.dir[2].startsWith("P12345__"), `환자ID 로 시작해야 한다: ${b.dir[2]}`);
});

test("① 검사 폴더가 다르면 파일 전체 경로도 다르다(같은 SOP 이름이라도)", () => {
  const a = dlPathFor("full", "same.sop.uid", A);
  const b = dlPathFor("full", "same.sop.uid", B);
  assert.notEqual(a.path.join("/"), b.path.join("/"));
});

test("② 썸네일과 본 영상이 Thumbnail / DICOM 으로 갈린다", () => {
  const th = dlPathFor("th", "1.2.3.sop", A);
  const full = dlPathFor("full", "1.2.3.sop", A);
  assert.equal(th.path[th.path.length - 2], "Thumbnail");
  assert.equal(full.path[full.path.length - 2], "DICOM");
  assert.deepEqual(th.dir, full.dir, "같은 검사면 삭제 단위(검사 폴더)는 같아야 한다");
  assert.equal(th.path[3], "CT", "Modality 폴더가 검사 폴더 바로 아래에 온다");
});

test("③ 경로 세그먼트 안전화 — 구분자·상위 이동으로 폴더를 벗어날 수 없다", () => {
  const evil = { studyUid: "../../../etc", patientKey: "../..", studyDate: "../../x", modality: "a/b\\c" };
  const p = dlPathFor("full", "../../../evil.sop", evil);
  for (const s of p.path) {
    assert.ok(!s.includes("/"), `세그먼트에 / 가 남았다: ${s}`);
    assert.ok(!s.includes("\\"), `세그먼트에 \\ 가 남았다: ${s}`);
    assert.notEqual(s, "..", "세그먼트가 상위 이동이 되면 안 된다");
    assert.ok(!s.startsWith("."), `세그먼트가 . 로 시작하면 안 된다: ${s}`);
    assert.ok(s.length > 0);
  }
  assert.equal(p.path[0], "v1");
});

test("④ 캐시 키는 kind 로 갈린다 — 썸네일이 본 영상 자리를 차지하지 않는다", () => {
  assert.notEqual(dlKey("th", "1.2.3"), dlKey("full", "1.2.3"));
  assert.equal(dlKey("full", "1.2.3", "j90"), "live|full|j90|1.2.3");
  assert.equal(dlKey("th", "1.2.3"), "live|th|1.2.3");
});

test("④ 캐시 키에 소스 구분자가 있다 — 미러 배치에서 A 저장본이 로컬 검사 자리를 차지하지 않는다", () => {
  // 미러 연동(로컬 Orthanc + Live 병행)에서는 같은 검사가 두 경로에 있고 SOP UID 가 동일하다.
  // 지금 저장본은 전부 Live(A 렌더)라 'live|' 로 못 박는다 — 나중에 로컬로 범위를 넓혀도 안 섞인다.
  assert.ok(dlKey("full", "1.2.3", "j90").startsWith("live|"),
    "소스 구분자가 없으면 로컬 검사 페인에 A 저장본이 그려질 수 있다");
});

test("④ 형식이 다르면 키도 파일도 갈린다 — 관리자 PNG(무손실) 설정이 옛 JPEG 저장본에 먹히지 않게", () => {
  // 관리자가 png ↔ jpeg 를 바꾸면 이미 받아 둔 바이트는 **다른 형식**이다. 키가 같으면
  // png 로 바꾼 뒤에도 예전 JPEG 이 계속 히트해 진단 품질 설정이 조용히 무시된다.
  assert.notEqual(dlKey("full", "1.2.3", "png"), dlKey("full", "1.2.3", "j90"));
  assert.notEqual(dlKey("full", "1.2.3", "j90"), dlKey("full", "1.2.3", "j100"));
  const png = dlPathFor("full", "1.2.3.sop", A, "png");
  const jpg = dlPathFor("full", "1.2.3.sop", A, "j90");
  assert.notEqual(png.path.join("/"), jpg.path.join("/"),
    "경로가 같으면 두 형식이 같은 파일을 덮어써 인덱스는 둘인데 바이트는 하나가 된다");
  assert.ok(png.path[png.path.length - 1].endsWith(".png"));
  assert.ok(jpg.path[jpg.path.length - 1].endsWith(".jpg"));
  assert.deepEqual(png.dir, jpg.dir, "형식이 달라도 삭제 단위(검사 폴더)는 같아야 한다");
});

test("⑤ 영상 취득 모드 기본값은 download — 시작 즉시 최신부터 받는다(2026-08-10 사용자 확정)", () => {
  assert.equal(DL_DEFAULTS.mode, "download", "Live 와 다운받기 중 다운받기가 기본");
  assert.equal(readDlPrefs(undefined).mode, "download");
  assert.equal(readDlPrefs({}).mode, "download");
  // 명시 저장(마커)만 존중 — 구 기본(live) 시절 저장값은 잔재라 download 로 승격
  assert.equal(readDlPrefs({ dl_mode: "live" }).mode, "download", "마커 없는 옛 live 는 승격");
  assert.equal(readDlPrefs({ dl_mode_set: true, dl_mode: "live" }).mode, "live", "명시 live 는 존중");
  assert.equal(readDlPrefs({ dl_mode_set: true, dl_mode: "download" }).mode, "download");
  assert.equal(readDlPrefs({ dl_mode_set: true, dl_mode: "DOWNLOAD" }).mode, "download",
               "마커가 있으면 live 정확 일치 외에는 기본(download)");
  assert.deepEqual(readDlPrefs({}), DL_DEFAULTS);
});

test("⑤ 설정값이 범위를 벗어나면 잘린다 — 동시 받기가 폭주해 원격 PACS 를 때리면 안 된다", () => {
  // 2026-08-10 사용자 확정: 기본 = 최대(8). 서버 전역 A 게이트(12)가 폭주 보호를 담당.
  assert.equal(DL_DEFAULTS.concurrency, 8, "받기 속도 최대가 기본");
  assert.equal(readDlPrefs({ dl_conc_set: true, dl_conc: 99 }).concurrency, 8);
  assert.equal(readDlPrefs({ dl_conc_set: true, dl_conc: 0 }).concurrency, 1);
  assert.equal(readDlPrefs({ dl_conc_set: true, dl_conc: 3 }).concurrency, 3, "명시 저장(마커)은 존중");
  assert.equal(readDlPrefs({ dl_conc: 2 }).concurrency, 8,
               "구 UI(권장 2) 시절 저장값은 마커가 없다 — 새 기본(최대)으로 승격");
  assert.equal(readDlPrefs({ dl_conc: "abc" }).concurrency, DL_DEFAULTS.concurrency);
  assert.equal(readDlPrefs({ dl_limit_gb: 100000 }).limitGb, 200);
  assert.equal(readDlPrefs({ dl_recent_n: -5 }).recentN, 1);
  assert.equal(readDlPrefs({ dl_scope: "weird" }).scope, "list");
});

/* ── ⑥ 재개 규칙: 이미 있는 키는 다시 받지 않는다 (opfsStore.pendingTasks) ──────────────
 * 뷰어를 닫으면 다운로드가 멈추고(dlStop) 다시 열면 되살아난다(dlResume). 재개는 그 검사를
 * 처음부터 다시 훑으므로, 이미 받아 둔 키를 걸러내지 않으면 닫았다 여는 것을 반복할 때마다
 * 같은 바이트를 원격 A 에서 다시 내려받는다.
 * 스케줄러(dlScheduler.pump)가 api.ts 를 import 해 node 에서 직접 못 도는 대신, 규칙 본체만
 * 순수 함수로 빼서 여기서 검증한다 — pump 는 이 함수를 호출한다(다른 구현을 두지 않는다).
 * 되돌리면(스킵을 지우면) 첫 케이스가 실패한다. */
test("⑥ 이미 저장된 키는 재요청 목록에서 빠진다 — 재개가 '처음부터 다시 받기'가 되지 않는다", async () => {
  const tasks = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const stored = new Set(["a", "c"]);
  const asked = [];
  const rest = await pendingTasks(tasks, async (k) => { asked.push(k); return stored.has(k); });
  assert.deepEqual(rest.map((t) => t.key), ["b"], "이미 있는 a·c 를 다시 받으면 회선·A 부하가 두 배가 된다");
  assert.deepEqual(asked.sort(), ["a", "b", "c"], "모든 키를 확인해야 한다(일부만 보면 중복 다운로드가 샌다)");
});

test("⑥ 전부 있으면 남는 작업이 0 — 재개가 A 에 요청을 한 건도 내지 않는다", async () => {
  const rest = await pendingTasks([{ key: "a" }, { key: "b" }], async () => true);
  assert.equal(rest.length, 0);
});

test("⑥ 존재 확인이 실패하면 '없음'으로 본다 — 인덱스가 깨져도 다운로드가 멈추지 않는다", async () => {
  const rest = await pendingTasks([{ key: "a" }, { key: "b" }], async (k) => {
    if (k === "a") throw new Error("idb broken");
    return true;
  });
  assert.deepEqual(rest.map((t) => t.key), ["a"], "확인 실패를 '있음'으로 처리하면 파일이 영영 안 채워진다");
});

test("⑥ 순서가 보존된다 — 시리즈 순서대로 받는다는 규칙이 필터에서 뒤집히면 안 된다", async () => {
  const tasks = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}` }));   // 청크(64) 경계를 넘긴다
  const rest = await pendingTasks(tasks, async (k) => k === "k0" || k === "k100");
  assert.deepEqual(rest.map((t) => t.key).slice(0, 3), ["k1", "k2", "k3"]);
  assert.equal(rest.length, 198);
  assert.equal(rest[98].key, "k99");
  assert.equal(rest[99].key, "k101", "청크 경계에서 순서가 섞이면 시리즈가 뒤죽박죽 채워진다");
});
