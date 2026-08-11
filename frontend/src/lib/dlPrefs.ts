// 영상 취득 모드(설정 > 환경 > 영상 취득)의 **설정 모양과 해석**만 담는 모듈.
//
// 왜 별도 파일인가: 이 해석을 읽는 곳이 4군데(뷰어 2종·워크리스트·설정 화면)라 한 곳에서
// 정의해야 어긋나지 않고, 의존이 0 이라 회귀 테스트가 브라우저 없이 직접 부를 수 있다
// (tests/dl_path_rule.test.mjs).
//
// ⚠ 네이밍: 이 저장소에는 이미 '모드'가 둘 있다 — sv_server_mode(local/web/live, Worklist.tsx)
//   와 연동 3가지 모드(미러/Live/표준 DICOM). 이 항목은 **영상 취득 모드**로 부르고
//   sv_server_mode 는 건드리지 않는다. 저장 위치는 viewer.prefs.dl_*(뷰어가 소비하므로
//   worklist.prefs 가 아니다).

export interface DlPrefs {
  mode: "live" | "download";   // live = 볼 때 받는다(기본) / download = 미리 받아 둔다
  limitGb: number;             // 저장 상한(GB)
  concurrency: number;         // 동시 fetch
  scope: "list" | "recent";    // 대상 범위
  recentN: number;             // scope=recent 일 때 상위 N 건
  // ── 용량 초과 시 자동 삭제 ──────────────────────────────────────────────
  /** 상한 초과 시 과거 데이터부터 자동 삭제(기본 켜짐).
   *  ⚠ 끄기는 반드시 '상한 도달 시 더 받지 않기'와 **세트**다(dlScheduler 의 게이트).
   *    안 그러면 상한을 넘긴 채 계속 받다가 브라우저 할당량이 터지고, 그때 브라우저는
   *    v1/ 트리를 **통째로 조용히** 지운다(opfsPersist 는 완화일 뿐 보장이 아니다). */
  autoEvict: boolean;
  /** 축출 기준 — date = 과거 검사일부터(기본), lru = 오래 안 본 것부터 */
  evictBy: "date" | "lru";
  warnNearLimit: boolean;      // 상한 근접 알림
  warnAtPct: number;           // 알림 임계(%) 50~99
}

export const DL_DEFAULTS: DlPrefs = {
  // 동시 받기 기본 8 = 최대(2026-08-10 사용자 확정 "받기 속도 최대가 기본") — 서버의
  // 검사당 예열 워커(prefetch_series 8)와 정합. 폭주 보호는 서버 전역 A 게이트
  // (SAINTVIEW_A_PIXEL_SLOTS=12)가 담당한다 — 로그인·타 사용자 몫은 거기서 지켜진다.
  // 모드 기본 download(2026-08-10 사용자 확정 "Live 와 다운받기 중 다운받기가 기본") —
  // 프로그램이 시작되면 워크리스트 목록(최신순) 그대로 즉시 받기 시작한다(dlScheduler ①→②→③).
  // 영상을 클릭해 열 때의 동작(열린 검사 우선 dlPromote·뷰어 생존 중 일시정지)은 기존 규칙 그대로.
  mode: "download", limitGb: 2, concurrency: 8, scope: "list", recentN: 50,
  autoEvict: true, evictBy: "date", warnNearLimit: true, warnAtPct: 90,
};

function clamp(n: unknown, lo: number, hi: number, d: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
}

/** viewer.prefs 값 → DlPrefs.
 *  ★ 기본 **download**(2026-08-10 사용자 확정 — 구 기본 live 를 뒤집음). 저장면 우려는
 *    상한(limitGb)·자동 삭제(autoEvict 기본 켬)가 담당한다. 명시 저장 마커(dl_mode_set)가
 *    있을 때만 저장값을 존중 — 구 기본(live) 시절 저장된 dl_mode 는 잔재라 download 로 승격.
 *  ★ 숫자는 전부 잘라 넣는다 — 동시 받기가 폭주하면 공용 원격 PACS(A)를 때린다. */
export function readDlPrefs(value: unknown): DlPrefs {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    mode: v.dl_mode_set === true ? (v.dl_mode === "live" ? "live" : "download")
                                 : DL_DEFAULTS.mode,
    limitGb: clamp(v.dl_limit_gb, 1, 200, DL_DEFAULTS.limitGb),
    // dl_conc_set 마커가 있을 때만 저장값 존중 — 구 UI(상한 4·권장 2) 시절 저장된 dl_conc 는
    // 옛 권장의 잔재라 무시하고 새 기본(8=최대)으로 승격한다(2026-08-10 사용자 확정).
    concurrency: v.dl_conc_set === true ? clamp(v.dl_conc, 1, 8, DL_DEFAULTS.concurrency)
                                        : DL_DEFAULTS.concurrency,
    scope: v.dl_scope === "recent" ? "recent" : "list",
    recentN: clamp(v.dl_recent_n, 1, 500, DL_DEFAULTS.recentN),
    // ★ 자동 삭제·알림은 **정확히 false 일 때만** 끈다(키가 없거나 값이 깨지면 켜진 채로 둔다).
    //   기본을 끔으로 두면 상한을 넘긴 채 계속 받다가 할당량이 터져 저장본 전체가 조용히 날아간다
    //   — 'download 는 정확히 download 일 때만' 과 방향은 반대지만 근거는 같다(안전한 쪽이 기본).
    autoEvict: v.dl_auto_evict !== false,
    // ★ 정확히 "lru" 일 때만 LRU. 오타·미지정·옛 값은 전부 기본(date) — 설정 문구와 실제 정책이
    //   어긋나는 것 자체가 사고이므로 문구의 기본(과거 검사일부터)으로 수렴시킨다.
    evictBy: v.dl_evict_by === "lru" ? "lru" : "date",
    warnNearLimit: v.dl_warn_near !== false,
    warnAtPct: clamp(v.dl_warn_pct, 50, 99, DL_DEFAULTS.warnAtPct),
  };
}
