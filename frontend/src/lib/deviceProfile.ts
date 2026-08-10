/* 기기 프로필(2026-08-10 사용자 확정) — 같은 계정을 최대 3개 시스템(태블릿·노트북·
 * 판독환경)에서 동시에 쓰고, 시스템마다 다른 환경을 계정당 **3슬롯**까지 서버에 저장한다.
 *
 * 구조 — 설정 문서를 통째로 기기별로 복제하지 않는다. 계정 공용 문서(viewer.prefs 등)는
 * 그대로 두고 **장비 의존 키만** 오버레이 문서(예: viewer.prefs.dev2)에 겹쳐 쓴다:
 *   읽기 = 공용 ⊕ 오버레이(기기 값 우선) · 쓰기 = 공용(전체) + 오버레이(장비 의존 키만)
 * → 오버레이가 없는 기기(첫 로그인)는 마지막 저장값을 그대로 물려받아 시작하고,
 *   컬럼 구성처럼 계정 귀속으로 확정된 값(2026-08-09)은 어느 기기에서 바꿔도 전 기기 공통.
 *
 * 이 파일은 순수 로직만 담는다(외부 import 0) — node 테스트(device_profile_rule)가 직접
 * 불러 계약을 고정한다. 서버 호출·슬롯 협상(ensureDeviceSlot)은 api.ts 쪽.
 */

export const MAX_DEVICE_SLOTS = 3;   // 계정당 기기 프로필 수 — 동시 로그인 상한과 같은 3

/** 장비 의존 키 — 이 키만 기기 슬롯에 갈라 저장한다(그 외 전부 계정 공용).
 *  · viewer.prefs.monitor: 모니터 대수·뷰어/워크리스트/판독창 배치 — 기기마다 다른 대표값
 *  · worklist.prefs 의 패널 크기·표시·썸네일 분할 — 화면 크기(태블릿↔다중 모니터) 의존 */
export const DEVICE_OVERLAY_KEYS: Record<string, readonly string[]> = {
  "viewer.prefs": ["monitor"],
  "worklist.prefs": ["layout_sizes", "sizes_by_viewer", "infi_sizes",
                     "panels", "panels_by_viewer", "thumb_layout"],
};

export type DeviceEntry = {
  id: string;           // localStorage sv_device_id (기기 최초 접속 시 생성되는 UUID)
  slot: number;         // 1..MAX_DEVICE_SLOTS — 오버레이 문서 키(*.dev{slot})가 이 번호를 쓴다
  label: string;        // 설정>환경에서 사용자가 바꾸는 표시 이름(저장 데이터 — i18n 금지)
  screen?: string;      // 참고용 해상도 표기
  last_seen?: string;   // ISO — 슬롯이 다 찼을 때 밀어낼 기기 선정(LRU) 근거
};

export function overlayKeyOf(key: string, slot: number): string {
  return `${key}.dev${slot}`;
}

/** 공용 문서에서 장비 의존 키만 골라낸다 — 오버레이로 저장할 부분.
 *  오버레이 대상 키가 아니면 null(오버레이 저장 자체를 생략). */
export function pickOverlay(key: string, value: Record<string, unknown>): Record<string, unknown> | null {
  const ks = DEVICE_OVERLAY_KEYS[key];
  if (!ks) return null;
  const out: Record<string, unknown> = {};
  for (const k of ks) if (value[k] !== undefined) out[k] = value[k];
  return out;
}

/** 읽기 병합 — 공용 문서 위에 이 기기의 오버레이를 겹친다(장비 의존 키만, 기기 값 우선). */
export function mergeOverlay(key: string, base: Record<string, unknown>,
                             overlay: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const ks = DEVICE_OVERLAY_KEYS[key];
  if (!ks || !overlay) return base;
  const out = { ...base };
  for (const k of ks) if (overlay[k] !== undefined) out[k] = overlay[k];
  return out;
}

/** 슬롯 배정(순수) — 등록된 기기면 그 슬롯 유지, 빈 슬롯이 있으면 새로 배정,
 *  3개가 차 있으면 **가장 오래 안 쓴 기기**를 밀어내고 그 슬롯을 재사용한다.
 *  밀어낸 슬롯의 오버레이 초기화는 호출부(api.ts) 책임 — 이전 기기 환경이 새면 안 된다. */
export function chooseSlot(devices: DeviceEntry[], id: string, nowIso: string, label: string, screen: string):
    { slot: number; devices: DeviceEntry[]; evicted: DeviceEntry | null; isNew: boolean } {
  const list = (devices || []).filter((d) => d && d.id && d.slot >= 1 && d.slot <= MAX_DEVICE_SLOTS);
  const mine = list.find((d) => d.id === id);
  if (mine) {
    return { slot: mine.slot, evicted: null, isNew: false,
             devices: list.map((d) => (d.id === id ? { ...d, last_seen: nowIso, screen } : d)) };
  }
  const used = new Set(list.map((d) => d.slot));
  let slot = 0;
  for (let s = 1; s <= MAX_DEVICE_SLOTS; s++) if (!used.has(s)) { slot = s; break; }
  let evicted: DeviceEntry | null = null;
  let next = list;
  if (!slot) {
    evicted = [...list].sort((a, b) => String(a.last_seen || "").localeCompare(String(b.last_seen || "")))[0];
    slot = evicted.slot;
    next = list.filter((d) => d.id !== evicted!.id);
  }
  next = [...next, { id, slot, label, screen, last_seen: nowIso }];
  return { slot, devices: next, evicted, isNew: true };
}
