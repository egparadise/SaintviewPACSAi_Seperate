// 판독 도크 — Viewer2D 에서 추출한 공유 컴포넌트 (레퍼런스 Report Window 디자인)
// [Report|History|Shortcuts|Templates] 탭 · Font size · CVR Notice · ◀▶ · Reset/Save/Approve
// 동작은 Viewer2D 내장 시절과 완전 동일(이사만) — 리포트 로드/저장/승인/상용구/단축키 포함.
import { useEffect, useRef, useState } from "react";
import { PERM_DENIED_TIP, api, hasPerm, loadPermMe, type PermMe, type PhraseRow, type Report, type StudyDetail } from "../api";
import { dictationLabel, useDictation } from "../lib/useDictation";
import { MicIcon } from "./MicIcon";

export function ReportDock({ detail, width, onLoadPrior, onStatus }: {
  detail: StudyDetail;
  width: number;                            // 도크 폭 (viewer.prefs.dockW)
  onLoadPrior: (examId: number) => void;    // 과거검사 비교 로드 — 활성 페인에 표시
  onStatus: (msg: string) => void;          // 상단 상태 표시줄 메시지
}) {
  const [vreports, setVreports] = useState<Report[]>([]);
  const report = vreports[0] ?? null;
  const [dockTab, setDockTab] = useState<"read" | "hist" | "std" | "tpl">("read");
  const [fontPx, setFontPx] = useState(12);
  const [reading, setReading] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [readingTouched, setReadingTouched] = useState(false);
  // 음성 판독(STT) — 마지막 포커스 필드(기본 Reading)에 전사 삽입
  const dictField = useRef<"reading" | "conclusion">("reading");
  const appendDictation = (text: string) => {
    const add = (prev: string) => (prev ? `${prev} ${text}` : text);
    if (dictField.current === "conclusion") setConclusion(add);
    else { setReading(add); setReadingTouched(true); }
    lastTypedRef.current = Date.now();
  };
  const dictation = useDictation(appendDictation);
  // 뷰어 팔레트 Rec(딕테이션) → STT 전사 텍스트 삽입 가드는 ref로 최신값 참조(선언 순서 무관)
  const dictGateRef = useRef(false);
  const [histView, setHistView] = useState<Report | null>(null);
  const [dockPhrases, setDockPhrases] = useState<PhraseRow[]>([]);
  // Setting>판독(Reading) 옵션 — report.prefs
  const [rdOpts, setRdOpts] = useState<{
    cvr_notice?: boolean; save_alert?: boolean; panel_tab?: string; sidebar_tab?: string;
    insert_pos?: string; key_save?: string; key_approve?: string; key_mic?: string;
  }>({});
  // 유효 권한(perm/me, 레인 W) — report.write 없으면 Reading/Conclusion readOnly + Save/Approve 비활성(조회 가능).
  // 서버가 403 을 강제하므로 이 게이트는 UX(사전 안내) 목적. 로드 실패=null → 전 기능 허용 폴백
  const [permMe, setPermMe] = useState<PermMe | null>(null);
  useEffect(() => { loadPermMe().then(setPermMe).catch(() => {}); }, []);
  const canWrite = hasPerm(permMe, "report.write");

  // ── 판독 확정(Fixed) 잠금 — study.report_locked. 서버 409 가 최종 방어선, UI 는 선반영(UX) ──
  const [locked, setLocked] = useState(!!detail.report_locked);
  useEffect(() => { setLocked(!!detail.report_locked); }, [detail.id, detail.report_locked]);
  const LOCK_TIP = "판독 확정(잠금) 상태 — 변경할 수 없습니다";
  // 다른 창(ReportWindow 등)에서 잠금이 바뀌면 detail 스냅샷이 stale — 저장/토글 실패 시 재조회로 동기화
  const syncLock = async () => {
    try { setLocked(!!(await api.study(detail.id)).report_locked); } catch { /* 조회 실패 → 현 상태 유지 */ }
  };
  const toggleLock = async (checked: boolean) => {
    try {
      const r = await api.reportLock(detail.id, checked);   // 성공 후에만 반영(실패 시 체크 원복)
      setLocked(r.locked);
      onStatus(r.locked ? "판독 확정 잠금 설정됨" : "판독 확정 잠금 해제됨");
    } catch (e) {
      onStatus(e instanceof Error ? e.message : "잠금 변경 실패");
      void syncLock();   // 실패(409/403 등) — 서버 기준 잠금 상태로 재동기화
    }
  };

  // ── 판독 하트비트(read_state) — 45s 주기, typing=마지막 에디터 입력 45s 이내. 실패는 조용히 무시 ──
  const lastTypedRef = useRef(0);
  useEffect(() => {
    lastTypedRef.current = 0;   // 검사 전환 시 이전 검사 typing 상태 미전파
    const beat = () => {
      api.activityHeartbeat([detail.id], "report", Date.now() - lastTypedRef.current < 45_000)
        .catch(() => {});
    };
    beat();  // 마운트/검사 전환 즉시 1회
    const timer = window.setInterval(beat, 45_000);
    return () => window.clearInterval(timer);
  }, [detail.id]);

  const initDockText = (r: Report | null) => {
    setHistView(null);
    setReadingTouched(false);
    if (!r) { setReading(""); setConclusion(""); return; }
    const sr = r.sr_json;
    const lines: string[] = [];
    if (sr.comparison?.summary) lines.push(`[비교] ${sr.comparison.summary}`);
    for (const f of sr.findings ?? []) {
      lines.push(`${f.organ ? f.organ + ": " : ""}${f.observation}${f.severity === "critical" ? " [CRITICAL]" : ""}`);
    }
    setReading(lines.join("\n"));
    setConclusion((sr.impression ?? []).map((i) => i.statement).join("\n"));
  };

  /* 리포트/상용구/판독 설정 로드 — 검사 전환 시 재로드 */
  useEffect(() => {
    api.reports(detail.id).then((r) => {
      setVreports(r.items);
      initDockText(r.items[0] ?? null);
    }).catch(() => {});
    api.phrases().then((r) => setDockPhrases(r.items)).catch(() => {});
    api.getSetting("report.prefs").then((r) => {
      const v = r.value as typeof rdOpts;
      setRdOpts(v);
      if (v.panel_tab === "template") setDockTab("read");  // 기본은 판독 — panel_tab은 사이드탭 기본
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  const buildDockSr = (): Report["sr_json"] | null => {
    if (!report) return null;
    const sr = structuredClone(report.sr_json);
    if (readingTouched) {
      // 자유 판독문으로 대체 — critical 여부는 텍스트 내 [CRITICAL] 표기로 유지
      sr.findings = reading.trim()
        ? [{ organ: "판독", observation: reading.trim(),
             severity: /\[CRITICAL\]/i.test(reading) ? "critical" : "normal", measurements: [] }]
        : [];
    }
    if (!sr.impression.length) sr.impression = [{ rank: 1, statement: "", confidence: "low", codes: [] }];
    sr.impression[0].statement = conclusion;
    return sr;
  };

  const dockSave = async () => {
    if (locked) { onStatus(LOCK_TIP); return; }             // 확정 잠금 — 단축키 경로 포함 차단
    // 확정본 — Save 버튼 disabled(finalizedDock) 조건과 단축키(Ctrl+S) 경로 일치(서버 400 방지)
    if (report?.status === "finalized") { onStatus("확정된 판독입니다 — 수정하려면 새 버전(addendum)을 생성하세요"); return; }
    if (!canWrite) { onStatus(PERM_DENIED_TIP); return; }   // 단축키(Ctrl+S) 경로도 게이트
    const sr = buildDockSr();
    if (!report || !sr) return;
    try {
      await api.updateReport(report.id, sr);
      const r = await api.reports(detail.id);
      setVreports(r.items);
      setReadingTouched(false);
      if (rdOpts.save_alert) alert("리포트가 저장되었습니다");
      else onStatus("리포트 저장됨");
    } catch (e) {
      alert(e instanceof Error ? e.message : "저장 실패");
      void syncLock();   // 다른 창에서 잠금 변경(409) 등 — 서버 기준 잠금 상태 재동기화
    }
  };

  const dockApprove = async () => {
    if (locked) { onStatus(LOCK_TIP); return; }             // 확정 잠금 — 단축키 경로 포함 차단
    // 확정본 — Approve 버튼 disabled(finalizedDock) 조건과 단축키(Ctrl+Shift+A) 경로 일치
    if (report?.status === "finalized") { onStatus("이미 확정된 판독입니다"); return; }
    if (!canWrite) { onStatus(PERM_DENIED_TIP); return; }   // 단축키(Ctrl+Shift+A) 경로도 게이트
    const sr = buildDockSr();
    if (!report || !sr) return;
    if (!window.confirm("판독을 확정(승인·서명)합니다. 확정 후 수정할 수 없습니다.")) return;
    try {
      await api.updateReport(report.id, sr);
      await api.finalizeReport(report.id);
      const r = await api.reports(detail.id);
      setVreports(r.items);
      initDockText(r.items[0] ?? null);
      onStatus("판독 확정(서명) 완료");
    } catch (e) {
      alert(e instanceof Error ? e.message : "승인 실패");
      void syncLock();   // 다른 창에서 잠금 변경(409) 등 — 서버 기준 잠금 상태 재동기화
    }
  };

  const dockInsert = (p: PhraseRow) => {
    if (locked) { onStatus(LOCK_TIP); return; }             // 확정 잠금 — 상용구 삽입 차단
    if (!canWrite) { onStatus(PERM_DENIED_TIP); return; }   // 상용구 삽입도 판독 변경
    const pos = rdOpts.insert_pos ?? "end";
    const join = (cur: string, add: string) => !add ? cur : (cur ? `${cur}\n${add}` : add);
    if (pos === "cursor") {
      // 커서 위치 삽입은 결론 textarea 기준 — 포커스가 없으면 맨 끝
      const el = document.getElementById("sv-dock-conclusion") as HTMLTextAreaElement | null;
      if (el && document.activeElement === el && p.text) {
        const s = el.selectionStart ?? el.value.length;
        setConclusion((c) => c.slice(0, s) + p.text + c.slice(s));
        if (p.reading_text) setReading((r) => join(r, p.reading_text));
        return;
      }
    }
    if (p.reading_text) setReading((r) => join(r, p.reading_text));
    if (p.text) setConclusion((c) => join(c, p.text));
    setReadingTouched(true);
  };

  const dockApplyTemplate = (p: PhraseRow) => {
    if (locked) { onStatus(LOCK_TIP); return; }             // 확정 잠금 — 템플릿 교체 차단
    if (!canWrite) { onStatus(PERM_DENIED_TIP); return; }   // 템플릿 교체도 판독 변경
    if (!window.confirm(`템플릿 '${p.name}'으로 판독/결론을 교체할까요?`)) return;
    setReading(p.reading_text);
    setConclusion(p.text);
    setReadingTouched(true);
  };

  // 시스템 단축키(Setting>판독: 리포트 저장/승인) + Alt+상용구
  const comboOf = (e: KeyboardEvent) =>
    [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt",
     e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join("+");
  const dockKeysRef = useRef({ rdOpts, dockPhrases });
  dockKeysRef.current = { rdOpts, dockPhrases };
  const dockSaveRef = useRef(dockSave); dockSaveRef.current = dockSave;
  const dockApproveRef = useRef(dockApprove); dockApproveRef.current = dockApprove;
  const dockInsertRef = useRef(dockInsert); dockInsertRef.current = dockInsert;
  const dictToggleRef = useRef(dictation.toggle); dictToggleRef.current = dictation.toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { rdOpts: o, dockPhrases: ph } = dockKeysRef.current;
      const combo = comboOf(e);
      if (combo === (o.key_save ?? "Ctrl+S")) { e.preventDefault(); void dockSaveRef.current(); return; }
      if (combo === (o.key_approve ?? "Ctrl+Shift+A")) { e.preventDefault(); void dockApproveRef.current(); return; }
      if (combo === (o.key_mic ?? "Ctrl+M")) { e.preventDefault(); dictToggleRef.current(); return; }
      if (e.altKey && !e.ctrlKey && e.key.length === 1) {
        const hit = ph.find((p) => p.kind === "phrase" && p.shortcut === e.key.toUpperCase());
        if (hit) { e.preventDefault(); dockInsertRef.current(hit); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalizedDock = report?.status === "finalized";
  dictGateRef.current = !finalizedDock && canWrite && !locked;   // 삽입 가드 최신화
  // 뷰어 팔레트 Rec(딕테이션) → STT 전사 텍스트를 이 판독 도크의 포커스 필드에 삽입
  useEffect(() => {
    const onDict = (e: Event) => {
      const t = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (t && dictGateRef.current) appendDictation(t);
    };
    window.addEventListener("sv-dictation-insert", onDict);
    return () => window.removeEventListener("sv-dictation-insert", onDict);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // In Viewer 는 related_exams 를 옵셔널로 다룬다(런타임에 없을 수 있음) — 방어적 기본값
  const relExams = detail.related_exams ?? [];
  // Prior Studies 미니 썸네일 — 검사당 대표 1장(첫 영상 시리즈 중간 인스턴스), 캐시
  const [priorThumbs, setPriorThumbs] = useState<Record<number, string>>({});
  // 과거검사 판독 펼침 — 행 클릭 시 그 검사의 최신 판독(Reading/Conclusion)을 아래로 표시(1건 캐시)
  const [priorOpen, setPriorOpen] = useState<number | null>(null);
  const [priorRpt, setPriorRpt] = useState<Record<number, { reading: string; conclusion: string } | "none" | "loading">>({});
  const togglePriorReport = (examId: number) => {
    setPriorOpen((cur) => (cur === examId ? null : examId));
    if (priorRpt[examId] !== undefined) return;
    setPriorRpt((m) => ({ ...m, [examId]: "loading" }));
    api.reports(examId).then((r) => {
      const rp = r.items[0];
      if (!rp) { setPriorRpt((m) => ({ ...m, [examId]: "none" })); return; }
      const sr = rp.sr_json;
      const lines: string[] = [];
      if (sr.comparison?.summary) lines.push(`[비교] ${sr.comparison.summary}`);
      for (const f of sr.findings ?? []) lines.push(`${f.organ ? f.organ + ": " : ""}${f.observation}`);
      setPriorRpt((m) => ({ ...m, [examId]: {
        reading: lines.join("\n"),
        conclusion: (sr.impression ?? []).map((i) => i.statement).join("\n"),
      } }));
    }).catch(() => setPriorRpt((m) => ({ ...m, [examId]: "none" })));
  };
  useEffect(() => {
    let alive = true;
    (relExams.slice(0, 12)).forEach((e) => {
      if (priorThumbs[e.id] !== undefined) return;
      api.seriesTree(e.id).then((r) => {
        const s0 = r.series.find((x) => !["SR", "KO", "PR", "SEG"].includes(x.modality) && x.instances.length);
        const url = s0 ? s0.instances[Math.floor(s0.instances.length / 2)].preview_url : "";
        if (alive) setPriorThumbs((m) => ({ ...m, [e.id]: url }));
      }).catch(() => { if (alive) setPriorThumbs((m) => ({ ...m, [e.id]: "" })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, relExams.length]);
  const dockSig = (report?.diff_metrics as { signature?: { name: string; license_no: string; signed_at: string } })?.signature;
  const taStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
    border: "1px solid var(--border)", borderRadius: 3, padding: 6,
    fontFamily: "inherit", fontSize: fontPx, resize: "none",
  };

  return (
    <div style={{ width, borderLeft: "1px solid var(--border)", background: "var(--bg-panel)",
                  display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }}>
      {/* 탭 */}
      <div style={{ display: "flex", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" }}>
        {([["read", "Report"], ["hist", "History"], ["std", "Shortcuts"], ["tpl", "Templates"]] as const).map(([k, label]) => (
          <div key={k} onClick={() => setDockTab(k)}
               style={{ flex: 1, textAlign: "center", padding: "5px 0", fontSize: 11.5, cursor: "pointer",
                        fontWeight: dockTab === k ? 700 : 400,
                        borderBottom: dockTab === k ? "2px solid var(--accent)" : "2px solid transparent",
                        color: dockTab === k ? "var(--text-primary)" : "var(--text-secondary)" }}>
            {label}
          </div>
        ))}
      </div>
      {/* 상단 바: Font size · CVR · ◀▶ · Reset/Save/Approve */}
      <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 6px",
                    borderBottom: "1px solid var(--border)", fontSize: 11, flexWrap: "wrap" }}>
        {/* 음성 판독(STT) 마이크 — Font 왼쪽. 서버 설정 엔진으로 구동, 마지막 포커스 필드에 삽입 */}
        <button onClick={dictation.toggle} disabled={finalizedDock || locked || !canWrite || dictation.busy}
                title={dictationLabel(dictation.engine, dictation.recording, dictation.busy)}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "1px 7px",
                         border: `1px solid ${dictation.recording ? "var(--stat-emergency)" : "var(--border)"}`,
                         borderRadius: 5, background: dictation.recording ? "var(--stat-emergency)" : "var(--bg-canvas)",
                         color: dictation.recording ? "#fff" : "var(--text-primary)", cursor: "pointer" }}>
          <MicIcon on={dictation.recording} size={13} />
          {dictation.busy ? "전사…" : dictation.recording ? "녹음" : "음성"}
        </button>
        <span style={{ color: "var(--text-secondary)" }}>Font</span>
        <button style={{ padding: "0 6px" }} onClick={() => setFontPx((f) => Math.max(10, f - 1))}>−</button>
        <span>{fontPx}px</span>
        <button style={{ padding: "0 6px" }} onClick={() => setFontPx((f) => Math.min(22, f + 1))}>＋</button>
        <label title="CVR Notice — critical 소견 경고 표시" style={{ display: "flex", gap: 3, alignItems: "center" }}>
          <input type="checkbox" checked={!!rdOpts.cvr_notice}
                 onChange={(e) => setRdOpts((p) => ({ ...p, cvr_notice: e.target.checked }))} />
          CVR
        </label>
        <span style={{ flex: 1 }} />
        <button title="이전 과거검사 비교" style={{ padding: "0 7px" }}
                disabled={!relExams.length}
                onClick={() => onLoadPrior(relExams[0].id)}>◀</button>
        <button title="다음 과거검사 비교" style={{ padding: "0 7px" }}
                disabled={relExams.length < 2}
                onClick={() => onLoadPrior(relExams[1].id)}>▶</button>
        <button title="서버 저장본으로 되돌리기" style={{ padding: "1px 7px" }}
                onClick={() => initDockText(report)}>Reset</button>
        {/* report.write 게이트(레인 W) + 확정 잠금 — 서버 403/409 가 최종 방어선, UI 는 비활성+안내 툴팁(UX) */}
        <button className="primary" title={locked ? LOCK_TIP : canWrite ? `저장 (${rdOpts.key_save ?? "Ctrl+S"})` : PERM_DENIED_TIP}
                style={{ padding: "1px 9px" }}
                disabled={!report || finalizedDock || !canWrite || locked} onClick={() => void dockSave()}>Save</button>
        <button title={locked ? LOCK_TIP : canWrite ? `승인 — 확정·서명 (${rdOpts.key_approve ?? "Ctrl+Shift+A"})` : PERM_DENIED_TIP}
                style={{ padding: "1px 9px", background: "var(--stat-final)", color: "#fff", border: "none",
                         borderRadius: 4, opacity: !report || finalizedDock || !canWrite || locked ? 0.5 : 1 }}
                disabled={!report || finalizedDock || !canWrite || locked} onClick={() => void dockApprove()}>Approve</button>
      </div>
      {/* 확정(Fixed) 잠금 — finalized 리포트가 있을 때만 노출. 잠금 중 판독 변경 전면 차단(§C) */}
      {finalizedDock && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 8px",
                      borderBottom: "1px solid var(--border)", fontSize: 11 }}>
          <label title="잠금 중에는 판독 수정·확정·재생성·병합이 전부 차단됩니다"
                 style={{ display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={locked} onChange={(e) => void toggleLock(e.target.checked)} />
            🔒 판독 확정(잠금) — 변경 금지
          </label>
          {locked && (
            <span style={{ color: "var(--text-secondary)" }}>잠금 상태 — 판독을 변경할 수 없습니다</span>
          )}
        </div>
      )}
      {rdOpts.cvr_notice && report && /critical/i.test(JSON.stringify(report.sr_json.findings)) && (
        <div style={{ background: "var(--stat-emergency)", color: "#fff", fontSize: 11, padding: "3px 8px", fontWeight: 700 }}>
          ⚠ CVR Notice — study contains CRITICAL finding
        </div>
      )}

      {dockTab === "read" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 5, padding: 7, overflow: "auto" }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            ID: <b style={{ color: "var(--text-primary)" }}>{detail.patient_key}</b> ·
            Reporter: {report?.created_by === "ai" ? `AI(${report.ai_model})` : report?.created_by ?? "-"} ·
            Report Day: {detail.study_date}
          </div>
          {detail.clinical_info && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              Study/Req Comment: {detail.clinical_info}
            </div>
          )}
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)" }}>Reading</div>
          {/* report.write 없으면 readOnly — 조회는 가능(레인 W). 확정 잠금 중에도 readOnly */}
          <textarea value={reading} placeholder="Enter reading findings" disabled={finalizedDock}
                    readOnly={!canWrite || locked} title={locked ? LOCK_TIP : canWrite ? undefined : PERM_DENIED_TIP}
                    onFocus={() => { dictField.current = "reading"; }}
                    onChange={(e) => { setReading(e.target.value); setReadingTouched(true); lastTypedRef.current = Date.now(); }}
                    style={{ ...taStyle, flex: 1.4, minHeight: 90 }} />
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)" }}>Conclusion</div>
          <textarea id="sv-dock-conclusion" value={conclusion} placeholder="Enter conclusion" disabled={finalizedDock}
                    readOnly={!canWrite || locked} title={locked ? LOCK_TIP : canWrite ? undefined : PERM_DENIED_TIP}
                    onFocus={() => { dictField.current = "conclusion"; }}
                    onChange={(e) => { setConclusion(e.target.value); lastTypedRef.current = Date.now(); }}
                    style={{ ...taStyle, flex: 1, minHeight: 70 }} />
          {dockSig && (
            <div style={{ fontSize: 11, color: "var(--stat-final)" }}>
              ✍ {dockSig.name}{dockSig.license_no && ` (License No. ${dockSig.license_no})`} · {dockSig.signed_at?.slice(0, 16).replace("T", " ")}
            </div>
          )}
        </div>
      )}

      {dockTab === "hist" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div style={{ padding: "4px 8px", fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)", background: "var(--bg-elevated)" }}>
            History (click=view)
          </div>
          {vreports.map((r) => (
            <div key={r.id} onClick={() => setHistView(histView?.id === r.id ? null : r)}
                 style={{ padding: "4px 8px", fontSize: 11, cursor: "pointer", borderBottom: "1px solid #24282d",
                          background: histView?.id === r.id ? "var(--accent-subtle)" : undefined }}>
              v{r.version} · {r.status} · {r.created_by === "ai" ? "AI" : r.created_by}
              {r.finalized_at && ` · ${r.finalized_at.slice(0, 10)}`}
            </div>
          ))}
          {vreports.length === 0 && <div style={{ padding: 8, fontSize: 11, color: "var(--text-secondary)" }}>No previous reports</div>}
          {histView && (
            <div style={{ padding: 8, fontSize: fontPx, whiteSpace: "pre-wrap", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>
              {histView.narrative_text || "(empty)"}
            </div>
          )}
          <div style={{ padding: "4px 8px", fontSize: 10.5, fontWeight: 700, color: "var(--text-secondary)",
                        background: "var(--bg-elevated)", borderTop: "1px solid var(--border)" }}>
            Prior Studies (클릭=판독 펼침 · 썸네일 클릭=비교 로드)
          </div>
          {relExams.map((e) => (
            <div key={e.id}>
              <div onClick={() => togglePriorReport(e.id)}
                   title="클릭=이 검사의 판독 내용 펼침/접기 · 썸네일 클릭=활성 페인에 비교 로드"
                   style={{ padding: "4px 8px", fontSize: 11.5, cursor: "pointer", borderBottom: "1px solid #24282d",
                            display: "flex", alignItems: "center", gap: 7 }}
                   onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-hover)")}
                   onMouseLeave={(ev) => (ev.currentTarget.style.background = "")}>
                {priorThumbs[e.id]
                  ? <img src={priorThumbs[e.id]} alt="" title="비교 로드 — 활성 페인에 표시"
                         onClick={(ev) => { ev.stopPropagation(); onLoadPrior(e.id); }}
                         style={{ width: 58, height: 44, objectFit: "cover",
                          borderRadius: 2, border: "1px solid var(--border)", background: "#000", flexShrink: 0 }} />
                  : <span onClick={(ev) => { ev.stopPropagation(); onLoadPrior(e.id); }}
                          style={{ width: 58, height: 44, borderRadius: 2, background: "#000",
                          border: "1px solid var(--border)", flexShrink: 0 }} />}
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {e.study_date} {e.modality} <span style={{ color: "var(--text-secondary)" }}>{e.study_desc}</span>
                </span>
                <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{priorOpen === e.id ? "▴" : "▾"}</span>
              </div>
              {/* 판독 내용 펼침 — 행 1회 클릭 */}
              {priorOpen === e.id && (
                <div style={{ padding: "6px 10px 8px 14px", fontSize: 11, lineHeight: 1.55, background: "var(--bg-canvas)",
                              borderBottom: "1px solid #24282d", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {priorRpt[e.id] === "loading" && <span style={{ color: "var(--text-secondary)" }}>판독 불러오는 중…</span>}
                  {priorRpt[e.id] === "none" && <span style={{ color: "var(--text-secondary)" }}>이 검사의 판독이 없습니다</span>}
                  {typeof priorRpt[e.id] === "object" && (
                    <>
                      <div style={{ color: "var(--text-secondary)", fontWeight: 700, marginBottom: 2 }}>Reading</div>
                      <div>{(priorRpt[e.id] as { reading: string }).reading || "-"}</div>
                      <div style={{ color: "var(--text-secondary)", fontWeight: 700, margin: "6px 0 2px" }}>Conclusion</div>
                      <div>{(priorRpt[e.id] as { conclusion: string }).conclusion || "-"}</div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {relExams.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, color: "var(--text-secondary)" }}>No prior studies</div>
          )}
        </div>
      )}

      {(dockTab === "std" || dockTab === "tpl") && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {dockPhrases.filter((p) => p.kind === (dockTab === "std" ? "phrase" : "template")).map((p) => (
            <div key={p.id}
                 onClick={() => dockTab === "std" ? dockInsert(p) : dockApplyTemplate(p)}
                 title={`${p.reading_text ? `[판독] ${p.reading_text}\n` : ""}${p.text ? `[결론] ${p.text}` : ""}`}
                 style={{ padding: "5px 8px", fontSize: 11.5, cursor: "pointer", borderBottom: "1px solid #24282d" }}
                 onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-hover)")}
                 onMouseLeave={(ev) => (ev.currentTarget.style.background = "")}>
              {p.category && <span style={{ color: "var(--text-secondary)" }}>[{p.category}] </span>}
              {p.name}
              {p.shortcut && <span style={{ color: "var(--accent)", float: "right" }}>Alt+{p.shortcut}</span>}
            </div>
          ))}
          {dockPhrases.filter((p) => p.kind === (dockTab === "std" ? "phrase" : "template")).length === 0 && (
            <div style={{ padding: 10, fontSize: 11, color: "var(--text-secondary)" }}>
              No {dockTab === "std" ? "shortcuts" : "templates"} — register in Settings &gt; Reading
            </div>
          )}
        </div>
      )}
    </div>
  );
}
