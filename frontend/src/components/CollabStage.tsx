// 협진 무대(Stage) — 공유 화면 / 공유 화이트보드를 **크게** 띄우고 그 위에서 함께 작업한다.
//
// 왜 필요한가: 협진 패널의 4:3 타일에서는 공유 화면의 글자를 읽을 수도, 그 위에 정확히
// 그릴 수도 없다. 다학제는 "같이 보며 같이 표시하는 것"이므로 넓은 자리가 있어야 한다.
// 뷰어 본문을 잠시 무대로 바꾼다(MPR 임베드가 같은 자리를 쓰는 방식과 같다).
//
// ■ 두 표면의 성질이 다르다 — UI 도 다르게 안내한다
//   · screen  발표자 PC 의 픽셀이다. 발표자가 스크롤하면 마크가 어긋난다 → **레이저 기본**.
//             남기려면 📌 로 고정하고, 고정 마크에는 그 위험을 배지로 알린다.
//   · wb      좌표가 우리 것이라 절대 어긋나지 않는다 → **고정 기본**.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openPortalWindow } from "../lib/collabPopout";
import { colorOf } from "../lib/collabState";
import { frameBox, type MarkLife } from "../lib/collabSurface";
import { t as tr } from "../lib/i18n";
import { showToast } from "../lib/toast";
import type { UseCollab } from "../lib/useCollab";
import { MarkupOverlay, type MarkTool } from "./MarkupOverlay";

export type StageMode =
  | { kind: "screen"; peerId: number; name: string }
  | { kind: "wb" };

/** 화이트보드 배경 — 빈 화면 / 격자 / 지금 보고 있는 영상 붙여넣기.
 *  세 번째가 실제 다학제 사용법이다: 영상을 붙여 놓고 그 위에 도식을 그린다. */
type WbBg = "plain" | "grid" | "snap";

const TOOLS: { k: MarkTool; icon: string; label: string }[] = [
  { k: "pointer", icon: "↖", label: "가리키기" },
  { k: "pen", icon: "✎", label: "펜" },
  { k: "arrow", icon: "↗", label: "화살표" },
  { k: "line", icon: "／", label: "직선" },
  { k: "rect", icon: "▭", label: "사각형" },
  { k: "ellipse", icon: "◯", label: "원" },
  { k: "text", icon: "T", label: "글자" },
];

export function CollabStage({ mode, stream, cl, snapshot, popoutFeatures, onMode, onClose }: {
  mode: StageMode;
  /** screen 모드일 때 그 사람의 MediaStream. wb 모드면 null. */
  stream: MediaStream | null;
  cl: UseCollab;
  /** 지금 뷰어 화면을 PNG data URL 로 — 화이트보드 배경 '영상 붙여넣기'용.
   *  무대가 뷰어 자리를 차지하므로 **무대를 열기 전에** 부모가 찍어 둔 것을 받는다. */
  snapshot: string | null;
  /** 별도 창 배치 features — 다중 모니터. 제스처 안에서 await 못 하므로 미리 받는다 */
  popoutFeatures?: string;
  onMode: (m: StageMode) => void;
  onClose: () => void;
}) {
  const surface = mode.kind === "screen" ? "screen" : "wb";
  const hostRef = useRef<HTMLDivElement | null>(null);
  const vidRef = useRef<HTMLVideoElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vid, setVid] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<MarkTool>("pen");
  const [wbBg, setWbBg] = useState<WbBg>("plain");
  // 표면이 바뀌면 수명 기본값도 바뀐다 — 위 주석의 이유. 사용자가 바꾸면 그 값을 유지한다.
  const [lifeBySurface, setLifeBySurface] = useState<Record<string, MarkLife>>(
    { screen: "laser", wb: "pin" });
  const life = lifeBySurface[surface] ?? "pin";
  // 별도 창으로 뺀 상태. 같은 출처라 createPortal 로 **부모 트리 그대로** 자식 창에 그린다 —
  // 두 번째 React root 를 쓰면 마크·커서를 손으로 밀어 넣어야 하고, 그 동기화를 한 번만
  // 빠뜨려도 두 창이 다른 그림을 보여 준다(그게 협진에서 제일 위험한 상태다).
  const [popWin, setPopWin] = useState<Window | null>(null);

  // 무대 크기 추적 — 창을 줄이면 그리기 영역도 따라 줄어야 한다(좌표는 정규화라 마크는 제자리).
  // popWin 을 dep 에 넣는 이유: 별도 창으로 옮기면 host 엘리먼트가 **다른 문서**로 이동하므로
  // 관찰 대상을 다시 걸어야 한다(안 그러면 자식 창 크기가 0 으로 남아 그리기가 막힌다).
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const view = el.ownerDocument.defaultView;
    const RO = view?.ResizeObserver ?? ResizeObserver;
    const ro = new RO(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [popWin]);

  // 별도 창이 닫히면 무대를 본문으로 되돌린다(사용자가 창의 X 를 눌렀을 때)
  useEffect(() => {
    if (!popWin) return;
    const back = () => setPopWin(null);
    popWin.addEventListener("pagehide", back);
    // 부모가 사라지면 자식도 닫는다 — 환자 화면이 뜬 창을 주인 없이 남기지 않는다
    return () => {
      popWin.removeEventListener("pagehide", back);
      if (!popWin.closed) { try { popWin.close(); } catch { /* 무시 */ } }
    };
  }, [popWin]);

  const popOut = useCallback(() => {
    // ⚠ 반드시 클릭 핸들러 안에서 **동기적으로**(팝업 차단기가 제스처 밖 open 을 막는다)
    const w = openPortalWindow("stage", tr("협진 무대"), popoutFeatures);
    if (!w) { showToast(tr("팝업이 차단되었습니다 — 이 사이트의 팝업을 허용해 주세요"), "error"); return; }
    setPopWin(w);
  }, [popoutFeatures]);

  // 비디오 스트림 연결 + 프레임 크기 추적
  useEffect(() => {
    const el = vidRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => { /* 자동재생 차단은 사용자 조작 후 붙는다 */ });
    const onMeta = () => setVid({ w: el.videoWidth, h: el.videoHeight });
    onMeta();
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("resize", onMeta);
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("resize", onMeta);
    };
  }, [stream]);

  // 공유가 끊기면 그 표면의 마크를 치운다 — 다른 화면을 가리키게 되는 편이 더 나쁘다.
  const hadStream = useRef(false);
  useEffect(() => {
    const live = !!stream?.getVideoTracks().some((t) => t.readyState === "live");
    if (hadStream.current && !live && mode.kind === "screen") cl.clearSurfaceMarks("screen");
    hadStream.current = live;
  }, [stream, mode.kind, cl]);

  // 그릴 수 있는 사각형 — 화이트보드는 무대 전체, 공유 화면은 레터박스를 뺀 영상 부분.
  // 🔴 이 한 줄이 "모두에게 같은 자리" 를 성립시킨다(lib/collabSurface.frameBox).
  const box = useMemo(
    () => (mode.kind === "wb"
      ? { x: 0, y: 0, w: size.w, h: size.h }
      : frameBox(size.w, size.h, vid.w, vid.h)),
    [mode.kind, size.w, size.h, vid.w, vid.h]);

  const marks = cl.annosOf(surface);
  const cursors = cl.cursors.filter((c) => c.pid === surface);
  const canDraw = cl.can(tool === "text" ? "collab.text" : "collab.annotate");
  const myMarks = marks.filter((m) => m.by === cl.meId).length;

  const stage = (
    <div style={{ flex: 1, display: "flex", flexDirection: "column",
                  minWidth: 0, minHeight: 0, height: popWin ? "100vh" : undefined,
                  background: "#000" }}>
      {/* ── 무대 도구막대 ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
                    flexWrap: "wrap", background: "var(--bg-elevated)",
                    borderBottom: "1px solid var(--border)", fontSize: 12 }}>
        <strong style={{ color: "var(--text)" }}>
          {mode.kind === "wb" ? tr("공유 화이트보드") : `🖥 ${mode.name}`}
        </strong>
        <button onClick={() => onMode({ kind: "wb" })}
                className={mode.kind === "wb" ? "primary" : undefined}
                style={{ fontSize: 11, padding: "1px 8px" }}>
          {tr("화이트보드")}
        </button>

        <span style={{ width: 1, height: 16, background: "var(--border)" }} />

        {TOOLS.map((t) => (
          <button key={t.k} onClick={() => setTool(t.k)} title={tr(t.label)}
                  disabled={t.k !== "pointer" && !canDraw}
                  className={tool === t.k ? "primary" : undefined}
                  style={{ fontSize: 13, padding: "1px 7px", minWidth: 26,
                           color: tool === t.k ? undefined : colorOf(cl.meId) }}>
            {t.icon}
          </button>
        ))}

        <span style={{ width: 1, height: 16, background: "var(--border)" }} />

        {/* 수명 — 공유 화면에서 이게 왜 중요한지 title 로 설명한다 */}
        <button onClick={() => setLifeBySurface((p) => ({
                  ...p, [surface]: life === "laser" ? "pin" : "laser" }))}
                className={life === "laser" ? "primary" : undefined}
                title={life === "laser"
                  ? tr("레이저 — 3초 뒤 사라집니다 (가리키기에 알맞습니다)")
                  : tr("고정 — 세션 동안 남습니다")}
                style={{ fontSize: 11, padding: "1px 8px" }}>
          {life === "laser" ? `🔦 ${tr("레이저")}` : `📌 ${tr("고정")}`}
        </button>

        {mode.kind === "screen" && life === "pin" && (
          <span title={tr("공유 화면은 발표자가 스크롤하면 내용이 바뀝니다 — 고정 마크가 다른 곳을 가리킬 수 있습니다")}
                style={{ fontSize: 10.5, color: "var(--warn, #fbbf24)" }}>
            ⚠ {tr("화면이 바뀌면 어긋날 수 있음")}
          </span>
        )}

        {mode.kind === "wb" && (
          <>
            <span style={{ width: 1, height: 16, background: "var(--border)" }} />
            {([["plain", "빈 화면"], ["grid", "격자"], ["snap", "영상 붙여넣기"]] as const)
              .map(([k, label]) => (
                <button key={k} onClick={() => setWbBg(k)}
                        disabled={k === "snap" && !snapshot}
                        className={wbBg === k ? "primary" : undefined}
                        style={{ fontSize: 11, padding: "1px 8px" }}>
                  {tr(label)}
                </button>
              ))}
          </>
        )}

        <span style={{ flex: 1 }} />
        <button onClick={() => cl.clearSurfaceMarks(surface)} disabled={!myMarks && !cl.isHost}
                title={cl.isHost ? tr("전체 지우기") : tr("내가 그린 것만 지웁니다")}
                style={{ fontSize: 11, padding: "1px 8px" }}>
          🧹 {cl.isHost ? tr("전체 지우기") : tr("내 마크 지우기")}
        </button>
        {/* 별도 창 — 팝아웃(⧉, 보기 전용)과 달리 **그 위에서 그대로 함께 그릴 수 있다**.
            판독 환경은 다중 모니터가 기본이라, 공유 화면은 옆 모니터에 크게 두고
            DICOM 은 본 모니터에 남기는 것이 실제 사용 방식이다. */}
        {!popWin && (
          <button onClick={popOut} title={tr("별도 창으로 — 다른 모니터에서 함께 표시할 수 있습니다")}
                  style={{ fontSize: 11, padding: "1px 8px" }}>⧉</button>
        )}
        {popWin && (
          <button onClick={() => setPopWin(null)} title={tr("본문으로 되돌리기")}
                  style={{ fontSize: 11, padding: "1px 8px" }}>⤢ {tr("본문으로")}</button>
        )}
        <button onClick={onClose} style={{ fontSize: 11, padding: "1px 8px" }}>
          ✕ {tr("무대 닫기")}
        </button>
      </div>

      {/* ── 무대 본체 ── */}
      <div ref={hostRef} style={{ flex: 1, position: "relative", minHeight: 0,
                                  overflow: "hidden", background: "#000" }}>
        {mode.kind === "screen" ? (
          // object-fit:contain — 공유 화면은 잘리면 안 된다. 잘리면 마크가 가리키는 곳이
          // 상대 화면에는 아예 없을 수 있다(타일이 cover 라 실제로 잘리고 있었다).
          <video ref={vidRef} autoPlay playsInline muted
                 style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                          objectFit: "contain", background: "#000" }} />
        ) : (
          <div style={{ position: "absolute", inset: 0, background: "#12161c",
                        ...(wbBg === "snap" && snapshot
                          ? { backgroundImage: `url(${snapshot})`, backgroundSize: "contain",
                              backgroundPosition: "center", backgroundRepeat: "no-repeat" }
                          : wbBg === "grid"
                            ? { backgroundImage:
                                  "linear-gradient(rgba(255,255,255,.07) 1px, transparent 1px)," +
                                  "linear-gradient(90deg, rgba(255,255,255,.07) 1px, transparent 1px)",
                                backgroundSize: "32px 32px" }
                            : {}) }} />
        )}

        <MarkupOverlay
          surface={surface} box={box} marks={marks} cursors={cursors}
          meId={cl.meId} tool={tool} life={life} canDraw={canDraw}
          onAdd={cl.addAnno} onRemove={cl.removeAnno}
          onCursor={(x, y) => cl.sendCursor(surface, x, y)} />

        {!canDraw && (
          <div style={{ position: "absolute", left: 8, bottom: 8, zIndex: 25, fontSize: 11,
                        background: "rgba(0,0,0,.7)", color: "#ddd", padding: "2px 8px",
                        borderRadius: 10, pointerEvents: "none" }}>
            {tr("보기 전용 — 가리키기는 됩니다")}
          </div>
        )}
      </div>
    </div>
  );

  // 별도 창으로 뺐으면 자식 문서에 그린다. 본문 자리에는 되돌리는 안내만 남긴다 —
  // 무대가 통째로 사라지면 사용자가 "협진이 꺼졌나?" 하고 헷갈린다.
  if (popWin) {
    return (
      <>
        <div style={{ flex: 1, display: "grid", placeItems: "center", gap: 8,
                      minWidth: 0, minHeight: 0, background: "#000",
                      color: "var(--text-secondary)", fontSize: 12 }}>
          <div>{tr("무대가 별도 창에 있습니다")}</div>
          <button onClick={() => setPopWin(null)} style={{ fontSize: 11, padding: "2px 10px" }}>
            ⤢ {tr("본문으로")}
          </button>
        </div>
        {createPortal(stage, popWin.document.body)}
      </>
    );
  }
  return stage;
}
