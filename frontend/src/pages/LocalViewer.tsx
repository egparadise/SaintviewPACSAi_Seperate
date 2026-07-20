// 로컬 뷰어 (레인 F) — Local Server 모드 전용 경량 뷰어 모달.
// 시리즈 콤보 + 이미지 ◀▶/휠 스크롤 + W/L 프리셋 + 확대(CSS scale) + 닫기.
// 이미지는 /api/local/instances/{iid}/rendered (인증 fetch→blob) — 로컬 확인용, 거창한 도구 없음.
import { useEffect, useRef, useState } from "react";
import { api, localRendered, type LocalSeriesNode } from "../api";

// W/L 프리셋 — 자동(파라미터 생략)=서버 기본. CT 대표 4종
const WL_PRESETS: { key: string; label: string; wc?: number; ww?: number }[] = [
  { key: "auto", label: "자동" },
  { key: "soft", label: "연부 40/400", wc: 40, ww: 400 },
  { key: "lung", label: "폐 −600/1500", wc: -600, ww: 1500 },
  { key: "bone", label: "뼈 300/1500", wc: 300, ww: 1500 },
  { key: "brain", label: "뇌 40/80", wc: 40, ww: 80 },
];

export function LocalViewer({ studyId, title, onClose }: {
  studyId: number;
  title?: string;      // 헤더 표기 — 환자명·검사 요약
  onClose: () => void;
}) {
  const [series, setSeries] = useState<LocalSeriesNode[] | null>(null);  // null=로딩 중
  const [sIdx, setSIdx] = useState(0);   // 선택 시리즈
  const [iIdx, setIIdx] = useState(0);   // 선택 이미지
  const [wl, setWl] = useState(0);       // WL_PRESETS 인덱스
  const [zoom, setZoom] = useState(1);
  const [url, setUrl] = useState("");    // 현재 이미지 blob URL
  const [err, setErr] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const urlRef = useRef("");             // 언마운트 revoke 용

  // 트리 로드 — 실패는 '⚠ 준비 중' 우아 처리 (백엔드 미구현 포함)
  useEffect(() => {
    let alive = true;
    api.localTree(studyId)
      .then((r) => { if (alive) { setSeries(r.series); setSIdx(0); setIIdx(0); } })
      .catch((e) => { if (alive) { setSeries([]); setErr(e instanceof Error ? e.message : "⚠ 준비 중"); } });
    return () => { alive = false; };
  }, [studyId]);

  const cur = series?.[sIdx] ?? null;
  const inst = cur?.instances[iIdx] ?? null;
  const count = cur?.instances.length ?? 0;

  // 이미지 로드 — 인스턴스/프리셋 변경 시 blob 재요청, 이전 URL revoke
  useEffect(() => {
    if (!inst) return;
    let alive = true;
    setImgBusy(true);
    const p = WL_PRESETS[wl];
    localRendered(inst.iid, p.wc, p.ww)
      .then((blob) => {
        if (!alive) { return; }
        const next = URL.createObjectURL(blob);
        setUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return next; });
        urlRef.current = next;
        setErr("");
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "이미지 로드 실패"); })
      .finally(() => { if (alive) setImgBusy(false); });
    return () => { alive = false; };
  }, [inst, wl]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const step = (d: number) => setIIdx((i) => Math.min(Math.max(i + d, 0), Math.max(count - 1, 0)));

  // 휠=이미지 스크롤 — React onWheel 은 passive 등록이라 preventDefault 불가 → 네이티브 non-passive 리스너
  const wheelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setIIdx((i) => Math.min(Math.max(i + (e.deltaY > 0 ? 1 : -1), 0), Math.max(count - 1, 0)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [count]);

  // 키보드: ←/→ 이미지 이동, Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, onClose]);

  const btn: React.CSSProperties = { padding: "2px 9px", fontSize: 11.5 };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "grid",
                  placeItems: "center", zIndex: 400 }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: "min(940px, 96vw)", height: "min(760px, 92vh)",
                    display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* 헤더 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                      borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <b style={{ fontSize: 13 }}>🗔 로컬 뷰어</b>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden",
                         textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <button style={{ marginLeft: "auto" }} onClick={onClose} title="닫기 (Esc)">✕</button>
        </div>

        {/* 컨트롤: 시리즈 콤보 · ◀▶ · W/L 프리셋 · 확대 */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
                      padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 12, flexShrink: 0 }}>
          <select value={sIdx} disabled={!series?.length} style={{ fontSize: 12, maxWidth: 280 }}
                  onChange={(e) => { setSIdx(Number(e.target.value)); setIIdx(0); }}>
            {(series ?? []).map((s, i) => (
              <option key={s.series_uid} value={i}>
                S{s.series_number} · {s.modality} {s.series_desc || "(무제)"} — {s.instances.length}장
              </option>
            ))}
            {!series?.length && <option>시리즈 없음</option>}
          </select>
          <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <button style={btn} disabled={iIdx <= 0} onClick={() => step(-1)} title="이전 이미지 (←)">◀</button>
            <span style={{ minWidth: 62, textAlign: "center", color: "var(--text-secondary)" }}>
              {count ? `${iIdx + 1} / ${count}` : "0 / 0"}
            </span>
            <button style={btn} disabled={iIdx >= count - 1} onClick={() => step(1)} title="다음 이미지 (→)">▶</button>
          </span>
          <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <span style={{ color: "var(--text-secondary)" }}>W/L</span>
            {WL_PRESETS.map((p, i) => (
              <button key={p.key} style={{ ...btn, ...(wl === i ? { background: "var(--accent)", color: "#fff" } : {}) }}
                      onClick={() => setWl(i)}>{p.label}</button>
            ))}
          </span>
          <span style={{ display: "flex", gap: 3, alignItems: "center", marginLeft: "auto" }}>
            <button style={btn} onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))} title="축소">−</button>
            <span style={{ minWidth: 44, textAlign: "center", color: "var(--text-secondary)" }}>{Math.round(zoom * 100)}%</span>
            <button style={btn} onClick={() => setZoom((z) => Math.min(8, +(z + 0.25).toFixed(2)))} title="확대">＋</button>
            <button style={btn} onClick={() => setZoom(1)} title="원본 배율">1:1</button>
          </span>
        </div>

        {/* 이미지 영역 — 휠=이미지 스크롤, CSS scale 확대 */}
        <div ref={wheelRef}
             style={{ flex: 1, minHeight: 0, background: "#000", overflow: "auto",
                      display: "grid", placeItems: "center", position: "relative" }}>
          {series === null ? (
            <span style={{ color: "#9ca3af", fontSize: 12.5 }}>로딩 중…</span>
          ) : err ? (
            <span style={{ color: "var(--stat-emergency)", fontSize: 12.5, padding: 16, textAlign: "center" }}>
              ⚠ {err}
            </span>
          ) : !inst ? (
            <span style={{ color: "#9ca3af", fontSize: 12.5 }}>표시할 이미지가 없습니다</span>
          ) : (
            url && (
              <img src={url} alt={`Img ${inst.instance_number}`}
                   style={{ maxWidth: "100%", maxHeight: "100%", transform: `scale(${zoom})`,
                            transformOrigin: "center center", imageRendering: zoom > 1.5 ? "pixelated" : "auto",
                            opacity: imgBusy ? 0.55 : 1, transition: "opacity 0.1s" }} />
            )
          )}
          {inst && (
            <span style={{ position: "absolute", left: 8, bottom: 6, fontSize: 11, color: "#93c5fd" }}>
              #{inst.instance_number} · {inst.cols}×{inst.rows} · {WL_PRESETS[wl].label}
            </span>
          )}
        </div>

        <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-secondary)",
                      borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          휠=이미지 스크롤 · ←/→=이동 · Esc=닫기 — 로컬 확인용 경량 뷰어 (서버 데이터와 무관)
        </div>
      </div>
    </div>
  );
}
