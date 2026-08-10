/* 협진 미디어 권한·장치(2026-08-10 사용자 확정) — "상대가 안 보이고 내 마이크가 동작하지
 * 않는" 증상의 1차 원인은 대부분 **브라우저 권한 차단·다른 프로그램의 장치 점유·엉뚱한
 * 기본 장치**다. 통화 버튼의 실패 토스트만으로는 사용자가 원인을 알 수 없으므로,
 * 권한 상태를 조회·요청하고 장치를 고르고 마이크 입력을 눈으로 확인하는 기능을 제공한다.
 *
 * 장치 선택은 이 PC(localStorage)에 저장한다 — 장치는 기기 종속이라 계정 로밍 대상이 아니다.
 * webrtcMesh.setMicrophone/setCamera 가 preferredDevice() 로 이 값을 소비한다(ideal —
 * 장치가 뽑혀 있어도 exact 처럼 실패하지 않고 기본 장치로 폴백). */

export const MIC_DEV_KEY = "sv_media_mic_id";
export const CAM_DEV_KEY = "sv_media_cam_id";

export type PermState = "granted" | "denied" | "prompt" | "unknown";

/** 권한 상태 조회 — Permissions API 미지원(구형 브라우저·일부 웹뷰)이면 "unknown". */
export async function queryPerm(name: "microphone" | "camera"): Promise<PermState> {
  try {
    const q = (navigator.permissions as { query?: (d: { name: string }) => Promise<{ state: string }> })?.query;
    if (!q) return "unknown";
    const r = await q.call(navigator.permissions, { name });
    return (["granted", "denied", "prompt"].includes(r.state) ? r.state : "unknown") as PermState;
  } catch { return "unknown"; }
}

/** getUserMedia 오류 → 사용자가 조치할 수 있는 한국어 사유(i18n 은 호출부 tr()). */
export function mediaErrorMsg(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError")
    return "브라우저가 차단했습니다 — 주소창의 자물쇠(사이트 설정)에서 허용으로 바꾼 뒤 새로고침하세요.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "장치를 찾을 수 없습니다 — 연결(플러그·블루투스)을 확인하세요.";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "다른 프로그램이 장치를 사용 중입니다 — 그 프로그램을 닫고 다시 시도하세요.";
  if (name === "OverconstrainedError") return "선택한 장치를 쓸 수 없습니다 — 기본 장치로 바꿔 보세요.";
  if (name === "SecurityError") return "보안 제약으로 차단됐습니다 — HTTPS 접속인지 확인하세요.";
  return e instanceof Error ? e.message : "권한 또는 장치를 확인하세요.";
}

/** 선택 장치 제약 — webrtcMesh 가 소비. ideal 이라 장치가 사라져도 기본으로 폴백한다. */
export function preferredDevice(key: string): { deviceId?: { ideal: string } } {
  try {
    const v = localStorage.getItem(key);
    return v ? { deviceId: { ideal: v } } : {};
  } catch { return {}; }
}

export type MediaProbe = { ok: boolean; msg: string };

/** 마이크/카메라 권한 요청 겸 동작 확인 — 트랙은 **즉시 정지**(점유 금지, 확인만). */
export async function probeDevice(kind: "mic" | "cam"): Promise<MediaProbe> {
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, msg: "이 브라우저는 지원하지 않습니다" };
  try {
    const c = kind === "mic"
      ? { audio: { ...preferredDevice(MIC_DEV_KEY) }, video: false }
      : { audio: false, video: { ...preferredDevice(CAM_DEV_KEY) } };
    const s = await navigator.mediaDevices.getUserMedia(c);
    const n = s.getTracks().length;
    s.getTracks().forEach((t) => t.stop());
    return n > 0 ? { ok: true, msg: "" } : { ok: false, msg: "사용 가능한 장치가 없습니다" };
  } catch (e) { return { ok: false, msg: mediaErrorMsg(e) }; }
}

/** 화면 공유 확인 — 브라우저 선택 대화상자가 뜨는 것 자체가 성공 신호. 즉시 정지. */
export async function probeScreen(): Promise<MediaProbe> {
  const get = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
  if (!get) return { ok: false, msg: "이 브라우저는 화면 공유를 지원하지 않습니다" };
  try {
    const s = await get({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
    return { ok: true, msg: "" };
  } catch (e) { return { ok: false, msg: mediaErrorMsg(e) }; }
}

export type MediaDeviceLists = { mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[] };

/** 장치 목록 — 라벨은 권한 허용 후에만 채워진다(브라우저 규격). */
export async function listMediaDevices(): Promise<MediaDeviceLists> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { mics: all.filter((d) => d.kind === "audioinput"),
             cams: all.filter((d) => d.kind === "videoinput") };
  } catch { return { mics: [], cams: [] }; }
}

/** 마이크 입력 레벨 확인 — ms 동안 최대 레벨(0~100)을 돌려준다. "켜져는 있는데 소리가
 *  안 들어오는"(OS 음소거·볼륨 0·엉뚱한 장치) 경우를 눈으로 확인하는 용도. */
export async function probeMicLevel(onLevel: (v: number) => void, ms = 2500): Promise<MediaProbe & { max: number }> {
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, msg: "이 브라우저는 지원하지 않습니다", max: 0 };
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...preferredDevice(MIC_DEV_KEY) }, video: false });
    const AC = (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return { ok: true, msg: "", max: -1 };   // 레벨 측정 불가 브라우저 — 권한 확인은 성공
    ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    let max = 0;
    const t0 = performance.now();
    await new Promise<void>((res) => {
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const lv = Math.min(100, Math.round((peak / 128) * 200));   // 일반 발화가 절반쯤 차게
        max = Math.max(max, lv);
        onLevel(lv);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res();
      };
      tick();
    });
    return { ok: true, msg: "", max };
  } catch (e) {
    return { ok: false, msg: mediaErrorMsg(e), max: 0 };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    try { void ctx?.close(); } catch { /* 무시 */ }
    onLevel(0);
  }
}
