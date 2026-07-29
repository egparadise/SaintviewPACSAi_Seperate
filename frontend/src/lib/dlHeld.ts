// 뷰어 창이 "지금 이 창이 물고 있는 검사 uid **전부**"를 남기는 장부 — **만료된다(TTL)**.
//
// 왜 새 장부인가: 다운로드 모드의 축출 보호('보고 있는 검사는 삭제하지 않습니다')가 실제로는
// 성립하지 않는 경로가 둘 있었다.
//   ① sv_viewer_tabs 는 **Viewer2D 전용**이다. ViewerInfi 는 이 키를 한 번도 쓰지 않으므로
//      (자기 장부 sv_infi_exams 는 uid 가 없는 id 배열이라 읽을 수도 없다) 단일 모니터 + In-View
//      조합에서는 보호 출처가 통째로 비었다.
//   ② sv_viewer_tabs 에는 **만료가 없다**. 항목이 빠지는 경로는 Exam 탭 ✕ 와 All Close 확정 둘뿐이라
//      브라우저 X·Ctrl+W 로 닫으면 그대로 남아 최대 8건이 무기한 축출 불가가 됐다. 그 합이 상한을
//      넘으면 blockedByProtection 으로 다운로드가 완전히 멈추고, 안내는 '창을 닫으면 이어받습니다'
//      인데 사용자는 이미 다 닫은 상태였다(지시대로 해도 풀리지 않는 안내).
//   ③ 살아 있는 슬롯(viewerSlots)은 TTL 이 있지만 **슬롯당 활성 검사 1건**의 studyId 만 싣고,
//      그 id 를 uid 로 바꾸는 유일한 통로가 큐다. 검색 조건을 바꾸면 큐가 통째로 교체되므로
//      '띄워 둔 2019년 prior' 는 uid 로 변환조차 안 돼 policy=date 의 1순위 희생자가 된다.
//
// 그래서 두 뷰어가 **같은 키에 uid 를 직접** 남긴다. 큐 의존이 사라지고, 창을 어떻게 닫든 TTL 로 풀린다.
//
// ⚠ localStorage 는 오리진별이다 — 뷰어 창이 다른 포트로 뜨는 배치(VITE_VIEWER_BASE)에서는 공유되지
//   않지만, 그 배치는 dlSupportReason() 이 다운로드 기능 자체를 끄므로 노출이 없다(opfsStore.ts:56-60).
// ⚠ 창마다 **키를 나눈다**. 하나의 JSON 을 여러 창이 read-modify-write 하면 항목이 유실된다
//   (이 저장소가 sv_infi_exams 로 실제로 겪은 경합 — viewerSlots.ts:18 주석).

const KEY_PREFIX = "sv_dl_held_";
const ID_KEY = "sv_dl_held_id";

/** 생존 판정 TTL — viewerSlots.SLOT_TTL_MS 와 같은 값. Chrome 은 hidden 문서의 인터벌을 5분 뒤
 *  **1분에 1회**까지 늦추므로(intensive throttling) 그보다 넉넉해야 살아 있는 창이 죽은 것으로 안 보인다. */
export const HELD_TTL_MS = 90_000;
/** 하트비트 주기 — 스로틀링을 감안해도 TTL 안에 여러 번 들어온다. */
export const HELD_BEAT_MS = 5_000;

export interface HeldRec {
  /** 이 창이 물고 있는 검사 uid 전부(활성 탭만이 아니다) */
  u: string[];
  /** 마지막 하트비트 시각 */
  t: number;
}

/** 장부 스냅샷 → 보호할 uid 집합. **순수 함수**(tests/dl_protect_rule.test.mjs 가 직접 부른다). */
export function heldStudyUids(
  snapshot: Iterable<HeldRec | null | undefined>, now: number, ttl = HELD_TTL_MS,
): string[] {
  const out = new Set<string>();
  for (const rec of snapshot) {
    if (!rec || !Array.isArray(rec.u)) continue;
    const t = Number(rec.t) || 0;
    if (now - t > ttl) continue;   // 만료 — 닫힌 창의 잔재
    for (const u of rec.u) if (typeof u === "string" && u) out.add(u);
  }
  return [...out];
}

/* ── 브라우저 측 ── */

/** 이 문서(탭/창)의 장부 키. sessionStorage 라 **리로드에도 같은 키**를 재사용한다 —
 *  매 리로드마다 새 키를 만들면 TTL 이 만료될 때까지 유령 항목이 쌓인다. */
function selfKey(): string {
  let id = "";
  try { id = sessionStorage.getItem(ID_KEY) ?? ""; } catch { /* 접근 불가 */ }
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { sessionStorage.setItem(ID_KEY, id); } catch { /* 무시 — 리로드마다 새 키(TTL 이 정리) */ }
  }
  return KEY_PREFIX + id;
}

export function noteHeldStudies(uids: readonly string[]): void {
  try {
    const u = [...new Set(uids.filter((x) => typeof x === "string" && x))];
    localStorage.setItem(selfKey(), JSON.stringify({ u, t: Date.now() } satisfies HeldRec));
  } catch { /* quota/차단 — 보호 없이도 동작(축출 순서만 정직해진다) */ }
}

export function releaseHeldStudies(): void {
  try { localStorage.removeItem(selfKey()); } catch { /* 무시 */ }
}

/** 뷰어 창이 주기적으로 자기 uid 목록을 남긴다. 반환값은 정리 함수(useEffect 반환값 그대로 사용). */
export function startHeldStudiesHeartbeat(getUids: () => readonly string[]): () => void {
  if (typeof window === "undefined") return () => {};
  const beat = () => { noteHeldStudies(getUids()); };
  beat();
  const timer = window.setInterval(beat, HELD_BEAT_MS);
  // hidden 스로틀링 구간에서 돌아오는 순간 즉시 되살린다(viewerSlots 하트비트와 같은 규약).
  const revive = () => beat();
  window.addEventListener("pageshow", revive);
  window.addEventListener("focus", revive);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", revive);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("pageshow", revive);
    window.removeEventListener("focus", revive);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", revive);
  };
}

/** 살아 있는 뷰어 창들이 물고 있는 검사 uid 전체. 만료 항목은 훑는 김에 지운다. */
export function liveHeldStudyUids(): string[] {
  const snap: (HeldRec | null)[] = [];
  const dead: string[] = [];
  const now = Date.now();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX) || k === ID_KEY) continue;
      let rec: HeldRec | null = null;
      try { rec = JSON.parse(localStorage.getItem(k) ?? "null") as HeldRec | null; } catch { rec = null; }
      if (!rec || now - (Number(rec.t) || 0) > HELD_TTL_MS) { dead.push(k); continue; }
      snap.push(rec);
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch { /* 접근 불가 — 빈 결과 */ }
  return heldStudyUids(snap, now);
}
