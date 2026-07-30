/* 사양 6 — 뷰어 상단 'HP:' 드롭다운 **한 벌**. 뷰어 3종이 이것 하나를 쓴다.
 * ═══════════════════════════════════════════════════════════════════════════════
 *   SaintView·T-View = pages/Viewer2D.tsx (TitleMenu 자리)
 *   I-View          = pages/ViewerInfi.tsx (좌측 툴바 <select> 자리)
 * 예전에는 두 뷰어가 각자 만든 드롭다운을 갖고 있었고(Viewer2D:4522 / ViewerInfi:3406·3415)
 * 항목 구성·표기·동작이 서로 달랐다. 갈라진 것을 다시 갈라지게 두지 않는다 — 여기가 유일한 구현이다.
 *
 * 구성(위→아래, 사양 6 그대로)
 *   ① 기본 (HP 해제)  ← **기본값**. 등록된 항목을 골라야 적용된다.
 *   ② 등록된 규칙들   ← hpRuleOrder 순서(= matchHpRule 이 보는 순서). ★=가장 우선 적용
 *   ③ 직접설정 체크박스 ← 켜면 저장 패널(프로토콜명·체크박스·저장)이 열린다. **기본 언체크**
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { hpRuleOrder, hpSlotLabel, readHpDoc, writeHpDoc, type HpRule } from "../lib/hangingProtocol";
import { findHpRuleByName, hpRuleFromScreen, upsertHpRule, type HpCaptureResult } from "../lib/hpCapture";

/** 뷰어가 넘기는 '지금 화면' — hpCaptureScreen 결과 + 규칙에 함께 실을 값. */
export interface HpMenuCapture extends HpCaptureResult {
  modality?: string;   // 사양 2 — 지금 검사의 장비. 저장되는 규칙의 장비 조건이 된다
  wl?: string;         // 활성 페인의 W/L (구 필드 rule.wl)
  options?: { full_link?: boolean; full_scroll_sync?: boolean; cross_link?: boolean; scout_image?: boolean };
}

export interface HpMenuProps {
  hpName: string;                       // 버튼에 표시되는 현재 HP 이름("기본"=해제)
  rules: HpRule[];                      // hpRuleOrder 를 이미 통과한 목록
  open: boolean;
  setOpen: (v: boolean) => void;
  onSelect: (rule: HpRule) => void;     // 규칙 적용(뷰어의 applyHp)
  onClear: () => void;                  // '기본 (HP 해제)'
  capture: () => HpMenuCapture | null;  // 지금 화면 읽기. null=읽을 수 없음(영상 미로드 등)
  onSaved: (rules: HpRule[]) => void;   // 저장 후 새 목록(드롭다운 갱신)
  onStatus?: (msg: string) => void;
  compact?: boolean;                    // I-View 좌측 툴바(좁은 버튼)
}

const ruleSub = (r: HpRule): string => {
  const sc = (r.screens ?? []).filter((s) => s.role === "viewer");
  const g = sc[0] ?? null;
  const s = g ? g.s : r.s, i = g ? g.i : r.i;
  const prior = sc.flatMap((x) => x.cells ?? []).filter((c) => c.slot && c.slot.kind !== "current");
  return [
    `${r.modality || "*"}/${r.body_part || "*"}/${r.projection || "*"}`,
    `S${s.r}×${s.c} I${i.r}×${i.c}`,
    sc.length > 1 ? `화면 ${sc.length}` : "",
    prior.length ? `과거 ${[...new Set(prior.map((c) => hpSlotLabel(c.slot)))].join("·")}` : "",
    r.source === "viewer" ? "직접설정" : "",
    r.use_on_exam_open === false ? "수동" : "",
  ].filter(Boolean).join(" · ");
};

export default function HpMenu({
  hpName, rules, open, setOpen, onSelect, onClear, capture, onSaved, onStatus, compact,
}: HpMenuProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  // ⚠ 직접설정은 **기본 언체크**(사양 6). 드롭다운을 닫아도 켠 상태를 유지한다 —
  //    '레이아웃을 잡고 → 다시 열어 저장' 이 실제 동선이라 닫힐 때마다 꺼지면 못 쓴다.
  const [direct, setDirect] = useState(false);
  const [name, setName] = useState("");
  const [autoOpen, setAutoOpen] = useState(false);   // 사양 5 ① Exam 열 때 HP 사용 — 뷰어 저장은 기본 off
  const [prio, setPrio] = useState(false);           // 사양 6 '가장 우선 적용' — 기본 off
  const [warn, setWarn] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setOpen]);

  // 직접설정을 켠 순간 한 번 읽어 '무엇이 저장될지'를 미리 보여 준다(경고 포함).
  useEffect(() => {
    if (!direct) { setWarn([]); return; }
    const cap = capture();
    setWarn(cap ? cap.warnings : ["지금 화면을 읽을 수 없습니다 — 영상이 로드된 뒤 다시 시도하세요"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, open]);

  /* 같은 이름의 기존 규칙(덮어쓸 대상) — 저장 **전에** 알리고 체크박스를 그 값으로 프리필한다.
     ⚠ 프리필이 없으면: Setting 에서 'Exam 열 때 HP 사용'을 켜 둔 규칙 "흉부 표준" 을 뷰어에서 같은
       이름으로 다시 저장하는 순간 체크박스 기본값(언체크)이 그대로 저장돼 **자동 적용되던 프로토콜이
       조용히 수동 전용**이 됐다. 저장 후 "(덮어씀)" 만 알렸으니 사용자는 알 방법이 없었다.
       (lib/hpCapture.hpRuleFromScreen 도 '지정 안 한 체크박스는 base 유지'로 함께 고쳤다.) */
  const dup = direct ? findHpRuleByName(rules, name) : null;
  const dupId = dup?.id ?? "";
  const prefilledRef = useRef<string | null>(null);   // 아직 한 번도 안 맞춤(빈 문자열과 구분)
  useEffect(() => {
    if (prefilledRef.current === dupId) return;
    prefilledRef.current = dupId;
    // 덮어쓸 규칙이 생기면 그 값으로, 사라지면 사양 6 기본값(둘 다 언체크)으로 되돌린다.
    setAutoOpen(dup ? dup.use_on_exam_open !== false : false);
    setPrio(dup ? !!dup.priority : false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dupId]);

  const save = async () => {
    const cap = capture();
    if (!cap) { onStatus?.("직접설정 저장 실패 — 지금 화면을 읽을 수 없습니다"); return; }
    const nm = name.trim();
    if (!nm) { onStatus?.("프로토콜명을 입력하세요"); return; }
    setBusy(true);
    try {
      const cur = await api.getSetting("viewer.hp").catch(() => ({ value: {} as Record<string, unknown> }));
      const doc = readHpDoc(cur.value);
      // 같은 이름이 있으면 **그 규칙을 덮어쓴다**(부위·출처 등 설정에서 넣은 매칭 조건은 유지).
      // 같은 이름으로 다른 모니터 창에서 저장하면 화면이 monitor 별로 합쳐진다(mergeHpScreen).
      const base = findHpRuleByName(doc.rules, nm);
      const rule = hpRuleFromScreen({
        name: nm, screen: cap.screen, modality: cap.modality, wl: cap.wl,
        useOnExamOpen: autoOpen, priority: prio, options: cap.options, base,
      });
      const next = upsertHpRule(doc.rules, rule);
      await api.putSetting("viewer.hp", writeHpDoc({ rules: next, modalities: doc.modalities }), "user");
      onSaved(hpRuleOrder(next));
      onStatus?.(`행잉 프로토콜 저장 — ${nm}${base ? " (덮어씀)" : ""} · Setting>행잉(HP)에서 부위·조건을 채우세요`);
      setOpen(false);
    } catch {
      onStatus?.("행잉 프로토콜 저장 실패 — 설정 저장 오류");
    } finally { setBusy(false); }
  };

  const row: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 7, padding: "5px 12px",
    fontSize: 11.5, cursor: "pointer", whiteSpace: "nowrap",
  };
  return (
    <span ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(!open)}
              title="Hanging Protocol — 규칙 선택 · '직접설정'으로 지금 화면을 새 프로토콜로 저장 (관리: Setting>행잉(HP))"
              style={compact
                ? { fontSize: 10.5, padding: "4px 2px", width: "100%", background: open ? "var(--accent)" : undefined,
                    color: open ? "#fff" : undefined, overflow: "hidden", textOverflow: "ellipsis" }
                : { padding: "3px 10px", fontSize: 15.5, display: "inline-flex", alignItems: "center", gap: 5,
                    background: open ? "var(--accent)" : undefined }}>
        HP:{hpName}
        {!compact && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "0 5px", borderRadius: 8, lineHeight: "14px",
                         background: open ? "rgba(255,255,255,0.25)" : "var(--bg-elevated)",
                         color: open ? "#fff" : "var(--text-secondary)", border: "1px solid var(--border)" }}>
            {rules.length}
          </span>
        )}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 360, minWidth: 330, maxHeight: 420,
                      overflow: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border)",
                      borderRadius: 5, boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: "3px 0" }}>
          {/* ① 기본 (HP 해제) — 사양 6 '기본은 해제' */}
          <div style={row} onClick={() => { onClear(); setOpen(false); }}
               onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
               onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
            <div style={{ flex: 1, fontWeight: hpName === "기본" ? 700 : 400 }}>
              {hpName === "기본" ? "● " : ""}기본 (HP 해제)
            </div>
          </div>
          {/* ② 등록된 규칙 — hpRuleOrder 순서 = matchHpRule 이 보는 순서 */}
          {rules.map((r) => (
            <div key={r.id} style={row} onClick={() => { onSelect(r); setOpen(false); }}
                 onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                 onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: hpName === r.name ? 700 : 400 }}>
                  {hpName === r.name ? "● " : ""}{r.priority ? "★ " : ""}{r.name}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 1 }}>{ruleSub(r)}</div>
              </div>
            </div>
          ))}
          {!rules.length && (
            <div style={{ ...row, cursor: "default", color: "var(--text-secondary)" }}>
              등록된 규칙 없음 — 아래 '직접설정'으로 지금 화면을 저장할 수 있습니다
            </div>
          )}
          {/* ③ 직접설정 */}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 3, padding: "6px 12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer",
                            fontWeight: 700 }}
                   title="지금 뷰어에 잡아 둔 화면(모니터·Series/Image 레이아웃·칸별 영상)을 새 프로토콜로 저장합니다">
              <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} />
              직접설정 — 지금 화면을 프로토콜로 저장
            </label>
            {direct && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="프로토콜명 (예: 흉부 비교 2×2)"
                       style={{ fontSize: 11.5, padding: "3px 6px" }} />
                {/* 사양 5 ①·사양 6 '가장 우선 적용' — 둘 다 기본 언체크 */}
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}
                       title="켜면 조건(장비)이 맞는 검사를 열 때 자동으로 이 배치가 적용됩니다. 꺼져 있으면 이 드롭다운에서 골라야 적용됩니다">
                  <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
                  Exam 열 때 자동 적용
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}
                       title="여러 규칙이 걸릴 때 이 규칙을 가장 먼저 검사합니다">
                  <input type="checkbox" checked={prio} onChange={(e) => setPrio(e.target.checked)} />
                  가장 우선 적용
                </label>
                {dup && (
                  <div style={{ fontSize: 10, color: "#fbbf24", lineHeight: 1.35, whiteSpace: "normal" }}>
                    ⚠ 기존 &lsquo;{dup.name}&rsquo; 을 덮어씁니다 — 화면 배치·장비·W/L·링크 4종(전체 링크·스크롤
                    동기화·Cross Link·Scout)이 <b>지금 화면 값</b>으로 바뀝니다. 부위·출처·Projection·설명은
                    유지되고, 위 두 체크박스는 기존 값을 불러왔습니다.
                  </div>
                )}
                {warn.map((w, k) => (
                  <div key={k} style={{ fontSize: 10, color: "#fbbf24", lineHeight: 1.35, whiteSpace: "normal" }}>⚠ {w}</div>
                ))}
                <div style={{ fontSize: 10, color: "var(--text-secondary)", lineHeight: 1.35, whiteSpace: "normal" }}>
                  저장되는 것: 이 모니터 · Series/Image 레이아웃 · 칸별 시리즈 · 칸별 과거검사 기간.
                  3D 창과 다른 모니터 창의 구성은 저장되지 않습니다(같은 이름으로 각 창에서 저장하면 합쳐집니다).
                </div>
                <button onClick={() => void save()} disabled={busy || !name.trim()}
                        style={{ fontSize: 11.5, padding: "4px 0", fontWeight: 700 }}>
                  {busy ? "저장 중…" : "저장 (Setting>행잉에 등록)"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
