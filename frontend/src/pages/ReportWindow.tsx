// 전용 판독 창 — 뷰어 [Reading] 버튼으로 열리는 별도 페이지 (?report=1&study=ID)
// 레이아웃: [판독|판독 기록|단축키|템플릿] 탭 · Font · CVR · ◀▶ · 초기화/저장/승인 · Reading/Conclusion
import { useEffect, useRef, useState } from "react";
import { api, ensureToken, type PhraseRow, type RelatedExam, type Report, type StudyDetail } from "../api";
import { onStudySync, postStudySync } from "../lib/sync";
import { dictationLabel, useDictation } from "../lib/useDictation";
import { MicIcon } from "../components/MicIcon";

type Tab = "read" | "hist" | "std" | "tpl";

/* History 과거검사 썸네일 — 검사의 첫 영상 시리즈 중간 프리뷰를 지연 로드 */
function HistThumb({ examId }: { examId: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.seriesTree(examId).then((r) => {
      const s = r.series.find((x) => x.instances.length);
      const inst = s?.instances[Math.floor((s.instances.length - 1) / 2)];
      if (alive) setUrl(inst?.preview_url ?? null);
    }).catch(() => { /* 프리뷰 없음 */ });
    return () => { alive = false; };
  }, [examId]);
  const box: React.CSSProperties = { width: 56, height: 56, borderRadius: 4, background: "#000", flexShrink: 0 };
  return url
    ? <img src={url} alt="" draggable={false} style={{ ...box, objectFit: "cover" }} />
    : <div style={{ ...box, display: "grid", placeItems: "center", fontSize: 16, color: "var(--text-secondary)" }}>🎞️</div>;
}

export function ReportWindow() {
  const params = new URLSearchParams(window.location.search);
  const initId = Number(params.get("study") || 0);

  const [detail, setDetail] = useState<StudyDetail | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [navList, setNavList] = useState<number[]>([]);
  const [navIdx, setNavIdx] = useState(0);
  const [tab, setTab] = useState<Tab>("read");  // (구버전 호환 — 중앙은 항상 판독)
  const [sideTab, setSideTab] = useState<"hist" | "sheet">("hist");      // 좌측: 판독 기록 | 기록지
  const [rightTab, setRightTab] = useState<"std" | "tpl">("std");        // 우측: 단축키 | 템플릿
  const [hosp, setHosp] = useState("");                                  // Hospital Comment (= study.memo)
  const [relatedView, setRelatedView] = useState<{ label: string; text: string } | null>(null);
  const [selPast, setSelPast] = useState<number | null>(null);   // History 에서 단일 클릭한 과거 검사(기준·하이라이트)
  const [sameCompare, setSameCompare] = useState(false);          // Same Compare — 선택 기준과 같은 장비·검사명만
  const grabRef = useRef(false);   // 판독 텍스트를 좌클릭 잡은 상태(누른 채 V=붙여넣기)
  const [fontPx, setFontPx] = useState(12);
  const [reading, setReading] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [touched, setTouched] = useState(false);
  // 음성 판독(STT) — 마지막 포커스 필드(기본 Reading)에 전사 텍스트 삽입
  const dictField = useRef<"reading" | "conclusion">("reading");
  const insertDictation = (text: string) => {
    const add = (prev: string) => (prev ? `${prev} ${text}` : text);
    if (dictField.current === "conclusion") setConclusion(add);
    else setReading(add);
    setTouched(true);
    lastTypedRef.current = Date.now();
  };
  const dictation = useDictation(insertDictation);
  const [histView, setHistView] = useState<Report | null>(null);
  const [phrases, setPhrases] = useState<PhraseRow[]>([]);
  const [rdOpts, setRdOpts] = useState<Record<string, unknown>>({});
  const [msg, setMsg] = useState("");
  // ── History(과거검사) 상호작용: 단일클릭=판독 표시, 더블클릭=1:2 Compare, 드래그·잡고 V=판독영역 복사 ──
  // 과거검사 판독 미리보기 — 검사별 최종(없으면 최신) 판독문 lazy 로드(최대 12건 캐시)
  const [pastTexts, setPastTexts] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!detail) return;
    let alive = true;
    detail.related_exams.slice(0, 12).forEach((e) => {
      if (pastTexts[e.id] !== undefined) return;
      api.reports(e.id).then((rr) => {
        const fin = rr.items.find((x) => x.status === "finalized") ?? rr.items[0];
        if (alive) setPastTexts((m) => ({ ...m, [e.id]: fin?.narrative_text ?? "" }));
      }).catch(() => { if (alive) setPastTexts((m) => ({ ...m, [e.id]: "" })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.related_exams.length]);

  const pasteReading = (text: string) => {
    if (!text || lockedRef.current || finalizedRef.current) return;
    const add = (prev: string) => (prev ? `${prev}\n${text}` : text);
    if (dictField.current === "conclusion") setConclusion(add); else setReading(add);
    setTouched(true);
    setMsg("과거 판독을 현재 판독영역에 복사했습니다");
  };
  const pickPast = (e: RelatedExam) => {
    setSelPast(e.id);
    api.reports(e.id).then((rr) => {
      const fin = rr.items.find((x) => x.status === "finalized") ?? rr.items[0];
      setRelatedView({ label: `${e.study_date} ${e.modality} ${e.study_desc}`, text: fin?.narrative_text || "(판독 없음)" });
    }).catch(() => setRelatedView({ label: `${e.study_date} ${e.modality}`, text: "(판독 조회 실패)" }));
  };
  const openCompare = (e: RelatedExam) => {
    if (!detail) return;
    // 현재 판독 검사 + 과거검사를 1:2 Compare(Add View)로 — 뷰어가 좌:현재 / 우:과거 로 배치
    const w = window.open(`${window.location.origin}${window.location.pathname}?viewer=2d&study=${detail.id}&add=${e.id}`, "sv_viewer");
    w?.focus();
  };
  // 판독 텍스트를 좌클릭으로 잡은 채 'V' → 현재 판독영역에 붙여넣기 (마우스업/블러=잡기 해제)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (grabRef.current && (ev.key === "v" || ev.key === "V") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        pasteReading(relatedView?.text ?? "");
      }
    };
    const onUp = () => { grabRef.current = false; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("dragend", onUp);   // 네이티브 드래그는 mouseup 미발생 → dragend 로도 해제(잡기 stuck 방지)
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mouseup", onUp); window.removeEventListener("dragend", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedView]);
  const report = reports[0] ?? null;

  // ── 계정별 로컬 단축키·템플릿 — 1차 로컬(localStorage) 저장, 주기적으로 서버(user 스코프) 백업 ──
  const user = localStorage.getItem("sv_user") ?? "anon";
  const LP_KEY = `sv_phrases_${user}`;
  const [localPhrases, setLocalPhrases] = useState<PhraseRow[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LP_KEY);
      if (raw) { setLocalPhrases(JSON.parse(raw)); return; }
    } catch { /* 초기화 */ }
    // 로컬이 비어 있으면 서버 백업에서 복원 (PC 교체/재설치 대비)
    api.getSetting("report.phrases_local").then((r) => {
      const items = (r.value as { items?: PhraseRow[] }).items;
      if (items?.length) {
        setLocalPhrases(items);
        localStorage.setItem(LP_KEY, JSON.stringify(items));
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveLocalPhrases = (items: PhraseRow[]) => {
    setLocalPhrases(items);
    try { localStorage.setItem(LP_KEY, JSON.stringify(items)); } catch { /* quota */ }
  };
  // 주기 백업 — 설정>판독 '백업 주기(분)' (0=끄기, 기본 10분)
  useEffect(() => {
    let timer: number | undefined;
    api.getSetting("report.prefs").then((r) => {
      const min = Number((r.value as { phrase_backup_min?: number }).phrase_backup_min ?? 10);
      if (!min) return;
      timer = window.setInterval(() => {
        try {
          const raw = localStorage.getItem(LP_KEY);
          void api.putSetting("report.phrases_local",
            { items: raw ? JSON.parse(raw) : [], at: new Date().toISOString() }, "user");
        } catch { /* 무시 */ }
      }, Math.max(1, min) * 60_000);
    }).catch(() => {});
    return () => { if (timer) window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const addLocalPhrase = () => {
    const name = prompt(`새 ${rightTab === "std" ? "단축키" : "템플릿"} 이름`);
    if (!name) return;
    const reading = prompt("판독(Reading) 내용 — 비우면 생략") ?? "";
    const concl = prompt("결론(Conclusion) 내용 — 비우면 생략") ?? "";
    const shortcut = rightTab === "std" ? (prompt("Alt+? 단축키 문자 (예: A) — 비우면 없음") ?? "") : "";
    saveLocalPhrases([...localPhrases, {
      id: -Date.now(), name, text: concl, reading_text: reading,
      modality: "", body_part: "", category: "내 항목", shortcut: shortcut.trim().toUpperCase().slice(0, 1),
      kind: rightTab === "std" ? "phrase" : "template", created_by: user,
    } as PhraseRow]);
  };

  // 워크리스트에서 로그아웃하면 판독 창도 닫는다 (뷰어 창과 동일한 신호)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sv_logout" || (e.key === "sv_token" && !e.newValue)) window.close();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const finalized = report?.status === "finalized";
  const sig = (report?.diff_metrics as { signature?: { name: string; license_no: string; signed_at: string } })?.signature;
  // 전역 keydown(잡고 V) 핸들러에서 최신값을 읽도록 ref 동기 — pasteReading 가드용
  const lockedRef = useRef(false);
  const finalizedRef = useRef(false);
  useEffect(() => { finalizedRef.current = finalized; }, [finalized]);

  // ── 판독 확정(Fixed) 잠금 — study.report_locked. 서버 409 가 최종 방어선, UI 는 선반영(UX) ──
  const [locked, setLocked] = useState(false);
  useEffect(() => { setLocked(!!detail?.report_locked); }, [detail?.id, detail?.report_locked]);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  const LOCK_TIP = "판독 확정(잠금) 상태 — 변경할 수 없습니다";
  // 다른 창(뷰어 도크 등)에서 잠금이 바뀌면 detail 스냅샷이 stale — 저장/토글 실패 시 재조회로 동기화
  const syncLock = async () => {
    if (!detail) return;
    try { setLocked(!!(await api.study(detail.id)).report_locked); } catch { /* 조회 실패 → 현 상태 유지 */ }
  };
  const toggleLock = async (checked: boolean) => {
    if (!detail) return;
    try {
      const r = await api.reportLock(detail.id, checked);   // 성공 후에만 반영(실패 시 체크 원복)
      setLocked(r.locked);
      setMsg(r.locked ? "판독 확정 잠금 설정됨" : "판독 확정 잠금 해제됨");
    } catch (e) {
      alert(e instanceof Error ? e.message : "잠금 변경 실패");
      void syncLock();   // 실패(409/403 등) — 서버 기준 잠금 상태로 재동기화
    }
  };

  // ── 판독 하트비트(read_state) — 45s 주기, typing=마지막 에디터 입력 45s 이내. 실패는 조용히 무시 ──
  const lastTypedRef = useRef(0);
  const hbStudyId = detail?.id ?? 0;
  useEffect(() => {
    if (!hbStudyId) return;
    lastTypedRef.current = 0;   // 검사 전환 시 이전 검사 typing 상태 미전파
    const beat = () => {
      api.activityHeartbeat([hbStudyId], "report", Date.now() - lastTypedRef.current < 45_000)
        .catch(() => {});
    };
    beat();  // 마운트/검사 전환 즉시 1회
    const timer = window.setInterval(beat, 45_000);
    return () => window.clearInterval(timer);
  }, [hbStudyId]);

  const initText = (r: Report | null) => {
    setHistView(null);
    setTouched(false);
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

  const [navLeft, setNavLeft] = useState<"past" | "recent">("past");  // Setting>정책
  const curIdRef = useRef(0);

  const navListRef = useRef<number[]>([]);
  const loadStudy = async (id: number, broadcast = true) => {
    const d = await api.study(id);
    curIdRef.current = id;
    const at = navListRef.current.indexOf(id);
    if (at >= 0) setNavIdx(at);
    setDetail(d);
    setHosp(d.memo ?? "");
    setRelatedView(null);
    setSelPast(null); setSameCompare(false);   // 검사 전환 시 History 선택·Same Compare 필터 초기화(stale 방지)
    setTplPreview(null);
    setAppliedTpl(null);
    tplBackup.current = null;
    document.title = `Reading — ${d.modality} ${d.patient_name} ${d.study_date}`;
    const r = await api.reports(id);
    setReports(r.items);
    initText(r.items[0] ?? null);
    if (broadcast) postStudySync(id, "report");  // Worklist·Viewer 연동
  };
  const loadStudyRef = useRef(loadStudy);
  loadStudyRef.current = loadStudy;

  // 다른 창(Viewer/Worklist)에서 환자가 바뀌면 같은 환자를 따라간다
  useEffect(() => {
    const off = onStudySync("report", (id) => {
      if (id !== curIdRef.current) void loadStudyRef.current(id, false);
    });
    return off;
  }, []);

  useEffect(() => {
    if (!initId) return;
    void ensureToken().then(async (ok) => {
      if (!ok) { setMsg("인증 토큰을 받지 못했습니다 — 뷰어/워크리스트에서 다시 열어주세요"); return; }
      try {
        await loadStudy(initId);
        // ◀▶ = 워크리스트 순서 환자 이동 (뷰어 화살표와 동일 동작)
        api.worklist({ limit: "500" }).then((r) => {
          const ids = r.items.map((it) => it.id);
          setNavList(ids);
          navListRef.current = ids;
          setNavIdx(Math.max(0, ids.indexOf(initId)));
        }).catch(() => { setNavList([initId]); navListRef.current = [initId]; });
        api.phrases().then((r) => setPhrases(r.items)).catch(() => {});
        api.getSetting("report.prefs").then((r) => {
          const v = r.value as Record<string, unknown>;
          setRdOpts(v);
          if (v.sidebar_tab === "sheet") setSideTab("sheet");
          if (v.panel_tab === "template") setRightTab("tpl");
        }).catch(() => {});
        api.getSetting("worklist.prefs").then((r) => {
          const nl = (r.value as { nav_left?: "past" | "recent" }).nav_left;
          if (nl) setNavLeft(nl);
        }).catch(() => {});
      } catch (e) { setMsg(e instanceof Error ? e.message : "검사 로드 실패"); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initId]);

  /** visual: -1=◀, 1=▶ — 시간대별 한 단계, 방향=Setting>정책(nav_left). 목록은 최신이 idx 0 */
  const navStep = (visual: 1 | -1) => {
    const leftStep = navLeft === "past" ? 1 : -1;
    return visual === -1 ? leftStep : -leftStep;
  };
  const navTargetIdx = (visual: 1 | -1) => {
    const next = navIdx + navStep(visual);
    return next >= 0 && next < navList.length ? next : -1;
  };
  const nav = async (visual: 1 | -1) => {
    const next = navTargetIdx(visual);
    if (next < 0) return;
    setNavIdx(next);
    const id = navList[next];
    await loadStudy(id);   // postStudySync → 워크리스트 선택도 따라감
    // 이미지도 함께 — 뷰어 창(sv_viewer)을 그 검사로 열기/전환 (닫혀 있으면 새로 연다)
    window.open(`${window.location.origin}${window.location.pathname}?viewer=2d&study=${id}`, "sv_viewer");
    setTimeout(() => window.focus(), 120);   // 판독창 포커스 유지(계속 넘기며 판독)
  };

  const buildSr = (): Report["sr_json"] | null => {
    if (!report) return null;
    const sr = structuredClone(report.sr_json);
    if (touched) {
      sr.findings = reading.trim()
        ? [{ organ: "판독", observation: reading.trim(),
             severity: /\[CRITICAL\]/i.test(reading) ? "critical" : "normal", measurements: [] }]
        : [];
    }
    if (!sr.impression.length) sr.impression = [{ rank: 1, statement: "", confidence: "low", codes: [] }];
    sr.impression[0].statement = conclusion;
    return sr;
  };

  const save = async () => {
    if (locked) { setMsg(LOCK_TIP); return; }   // 확정 잠금 — 단축키(Ctrl+S) 경로 포함 차단
    // 확정본 — Save 버튼 disabled(finalized) 조건과 단축키 경로 일치(서버 400 alert 방지)
    if (finalized) { setMsg("확정된 판독입니다 — 수정하려면 새 버전(addendum)을 생성하세요"); return; }
    const sr = buildSr();
    if (!report || !sr || !detail) return;
    try {
      await api.updateReport(report.id, sr);
      if (hosp !== (detail.memo ?? "")) await api.setMemo(detail.id, hosp);  // Hospital Comment
      const r = await api.reports(detail.id);
      setReports(r.items);
      setTouched(false);
      if (rdOpts.save_alert) alert("리포트가 저장되었습니다"); else setMsg("저장됨");
    } catch (e) {
      alert(e instanceof Error ? e.message : "저장 실패");
      void syncLock();   // 다른 창에서 잠금 변경(409) 등 — 서버 기준 잠금 상태 재동기화
    }
  };

  const approve = async () => {
    if (locked) { setMsg(LOCK_TIP); return; }   // 확정 잠금 — 단축키(Ctrl+Shift+A) 경로 포함 차단
    // 확정본 — Approve 버튼 disabled(finalized) 조건과 단축키 경로 일치
    if (finalized) { setMsg("이미 확정된 판독입니다"); return; }
    const sr = buildSr();
    if (!report || !sr || !detail) return;
    if (!window.confirm("판독을 확정(승인·서명)합니다. 확정 후 수정할 수 없습니다.")) return;
    try {
      await api.updateReport(report.id, sr);
      await api.finalizeReport(report.id);
      const r = await api.reports(detail.id);
      setReports(r.items);
      initText(r.items[0] ?? null);
      setMsg("확정(서명) 완료");
      if (rdOpts.open_next_after_save && navIdx < navList.length - 1) void nav(1);  // 저장 후 다음 레포트 열기
    } catch (e) {
      alert(e instanceof Error ? e.message : "승인 실패");
      void syncLock();   // 다른 창에서 잠금 변경(409) 등 — 서버 기준 잠금 상태 재동기화
    }
  };

  const insertPhrase = (p: PhraseRow) => {
    if (locked) { setMsg(LOCK_TIP); return; }   // 확정 잠금 — 상용구 삽입 차단
    const join = (cur: string, add: string) => !add ? cur : (cur ? `${cur}\n${add}` : add);
    if (p.reading_text) { setReading((r) => join(r, p.reading_text)); setTouched(true); }
    if (p.text) setConclusion((c) => join(c, p.text));
  };
  // ── 템플릿: 클릭=하단 미리보기, 우측 동그라미 체크=적용(교체)·해제=원문 복원 ──
  const [tplPreview, setTplPreview] = useState<PhraseRow | null>(null);
  const [appliedTpl, setAppliedTpl] = useState<number | null>(null);
  const tplBackup = useRef<{ reading: string; conclusion: string } | null>(null);
  const toggleTemplate = (p: PhraseRow) => {
    if (locked) { setMsg(LOCK_TIP); return; }   // 확정 잠금 — 템플릿 적용/해제 차단
    if (appliedTpl === p.id) {
      // 체크 해제 — 적용 전 내용 복원
      if (tplBackup.current) {
        setReading(tplBackup.current.reading);
        setConclusion(tplBackup.current.conclusion);
      } else {
        setReading("");
        setConclusion("");
      }
      tplBackup.current = null;
      setAppliedTpl(null);
      setTouched(true);
      return;
    }
    // 새 적용 — 첫 적용 시점의 원문만 백업(템플릿 간 전환에도 원문 유지)
    if (appliedTpl === null) tplBackup.current = { reading, conclusion };
    setReading(p.reading_text);
    setConclusion(p.text);
    setAppliedTpl(p.id);
    setTouched(true);
  };

  // 시스템 단축키(Setting>판독) + Alt+상용구
  const keysRef = useRef({ rdOpts, phrases });
  keysRef.current = { rdOpts, phrases };
  const saveRef = useRef(save); saveRef.current = save;
  const approveRef = useRef(approve); approveRef.current = approve;
  const insertRef2 = useRef(insertPhrase); insertRef2.current = insertPhrase;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { rdOpts: o, phrases: ph } = keysRef.current;
      const combo = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt",
                     e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join("+");
      if (combo === (o.key_save ?? "Ctrl+S")) { e.preventDefault(); void saveRef.current(); return; }
      if (combo === (o.key_approve ?? "Ctrl+Shift+A")) { e.preventDefault(); void approveRef.current(); return; }
      if (e.altKey && !e.ctrlKey && e.key.length === 1) {
        const hit = ph.find((p) => p.kind === "phrase" && p.shortcut === e.key.toUpperCase());
        if (hit) { e.preventDefault(); insertRef2.current(hit); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!detail) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: msg ? "var(--stat-emergency)" : "var(--text-secondary)" }}>
        {msg || "판독 창 로딩…"}
      </div>
    );
  }
  void tab; void setTab; void histView;  // (구버전 탭 상태 — 레이아웃 개편으로 미사용)

  const taStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
    border: "1px solid var(--border)", borderRadius: 4, padding: 8,
    fontFamily: "inherit", fontSize: fontPx, resize: "none",
  };
  const inStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
    border: "1px solid var(--border)", borderRadius: 4, padding: "6px 8px", fontSize: fontPx,
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--text-primary)" };
  const sideTabStyle = (on: boolean): React.CSSProperties => ({
    flex: 1, textAlign: "center", padding: "9px 0", fontSize: 12.5, cursor: "pointer",
    fontWeight: on ? 700 : 400,
    borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent",
    color: on ? "var(--text-primary)" : "var(--text-secondary)",
    background: on ? undefined : "var(--bg-elevated)",
  });
  const phraseList = [...phrases, ...localPhrases]
    .filter((p) => p.kind === (rightTab === "std" ? "phrase" : "template"));
  // History 목록 — Same Compare 시 선택 기준(refExam)과 같은 장비·검사명(부위)만, 검사일 최신순
  const refExam = detail.related_exams.find((e) => e.id === selPast) ?? null;
  const histList = [...detail.related_exams]
    .filter((e) => !sameCompare || !refExam || (e.modality === refExam.modality && e.study_desc === refExam.study_desc))
    .sort((a, b) => (a.study_date < b.study_date ? 1 : a.study_date > b.study_date ? -1 : 0));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-canvas)" }}>
      {/* 최상단: Font size 바 (레퍼런스) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 14px",
                    background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
        {/* 음성 판독(STT) 마이크 — Font size 왼쪽. 서버 설정 엔진(브라우저/Whisper/OpenAI)으로 구동 */}
        <button onClick={dictation.toggle} disabled={finalized || locked || dictation.busy}
                title={dictationLabel(dictation.engine, dictation.recording, dictation.busy)}
                style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "3px 10px",
                         border: `1px solid ${dictation.recording ? "var(--stat-emergency)" : "var(--border)"}`,
                         borderRadius: 6, background: dictation.recording ? "var(--stat-emergency)" : "var(--bg-canvas)",
                         color: dictation.recording ? "#fff" : "var(--text-primary)", fontSize: 12.5, cursor: "pointer" }}>
          <MicIcon on={dictation.recording} />
          {dictation.busy ? "전사 중…" : dictation.recording ? "녹음 중" : "음성 판독"}
        </button>
        <span style={{ color: "var(--text-secondary)" }}>Font size</span>
        <button style={{ padding: "0 8px" }} onClick={() => setFontPx((f) => Math.max(10, f - 1))}>−</button>
        <input type="range" min={10} max={24} value={fontPx} onChange={(e) => setFontPx(Number(e.target.value))} />
        <b>{fontPx}px</b>
        <button style={{ padding: "0 8px" }} onClick={() => setFontPx((f) => Math.min(24, f + 1))}>＋</button>
      </div>
      {dictation.err && (
        <div style={{ padding: "3px 14px", fontSize: 11.5, color: "var(--stat-emergency)", background: "var(--bg-panel)" }}>
          ⚠ {dictation.err}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* 좌측 사이드바: 판독 기록 | 기록지 */}
        <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--border)",
                      display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
            <div style={sideTabStyle(sideTab === "hist")} onClick={() => setSideTab("hist")}>History</div>
            <div style={sideTabStyle(sideTab === "sheet")} onClick={() => setSideTab("sheet")}>기록지</div>
          </div>
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {sideTab === "hist" ? (
              detail.related_exams.length === 0 && reports.slice(1).length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
                              padding: "60px 18px", textAlign: "center" }}>
                  <div style={{ fontSize: 34, opacity: 0.5 }}>🕘</div>
                  <b style={{ fontSize: 13.5 }}>No previous reports</b>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    이 환자의 이전 검사 기록이 없거나 판독이 완료되지 않았습니다.
                  </div>
                  <button className="primary" style={{ padding: "4px 14px", fontSize: 12 }}
                          onClick={() => window.open(
                            `${window.location.origin}${window.location.pathname}?viewer=2d&study=${detail.id}`,
                            "sv_viewer")}>
                    ▶ 이전 검사 영상 요청
                  </button>
                </div>
              ) : (
                <>
                  {reports.slice(1).map((r) => (
                    <div key={r.id}
                         onClick={() => setRelatedView({
                           label: `v${r.version} · ${r.created_by === "ai" ? "AI" : r.created_by}`,
                           text: r.narrative_text || "(내용 없음)",
                         })}
                         style={{ padding: "7px 12px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #24282d" }}>
                      📄 현재 검사 v{r.version} · {r.status} · {r.created_by === "ai" ? "AI" : r.created_by}
                    </div>
                  ))}
                  {/* Same Compare — 선택 기준(마지막 클릭)과 같은 장비·검사명(부위)만 정렬 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
                    <button onClick={() => setSameCompare((s) => !s)} disabled={!refExam}
                            title="Same Compare — 선택한 과거영상과 같은 장비·검사명(부위)만 정렬 (먼저 과거영상 클릭)"
                            style={{ fontSize: 11, padding: "3px 10px", opacity: refExam ? 1 : 0.5,
                                     background: sameCompare ? "var(--accent)" : undefined, color: sameCompare ? "#fff" : undefined }}>
                      Same Compare{sameCompare ? " ●" : ""}
                    </button>
                    {sameCompare && refExam && (
                      <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{refExam.modality}/{refExam.study_desc} 기준</span>
                    )}
                  </div>
                  {/* 과거검사 이미지 — 단일클릭=판독 표시, 더블클릭=1:2 Compare 열기 */}
                  {histList.map((e) => (
                    <div key={e.id} onClick={() => pickPast(e)} onDoubleClick={() => openCompare(e)}
                         title="단일클릭=판독 표시 · 더블클릭=1:2 Compare(현재 옆) 열기"
                         style={{ padding: "8px 10px", cursor: "pointer", borderBottom: "2px solid var(--border)",
                                  background: e.id === selPast ? "var(--bg-elevated)" : undefined }}>
                      {/* 상단: 날짜 + 복사(과거 판독→현재 판독영역) */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1 }}>{e.study_date}</span>
                        {pastTexts[e.id] ? (
                          <button onClick={(ev) => { ev.stopPropagation(); pasteReading(pastTexts[e.id]); }}
                                  title="이 과거 판독을 현재 판독영역에 복사"
                                  className="primary" style={{ fontSize: 10.5, padding: "1px 10px" }}>복사</button>
                        ) : null}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>{e.modality} · {e.study_desc || "-"}
                        <span style={{ fontSize: 10, color: "var(--text-secondary)", fontWeight: 400 }}>  {e.status}</span>
                      </div>
                      {/* 본문: 과거 영상 썸네일 + 판독 미리보기 */}
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <HistThumb examId={e.id} />
                        <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--text-primary)",
                                      display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical",
                                      overflow: "hidden", whiteSpace: "pre-wrap" }}>
                          {pastTexts[e.id] === undefined ? "판독 불러오는 중…"
                            : pastTexts[e.id] ? pastTexts[e.id] : "(판독 기록 없음)"}
                        </div>
                        <span style={{ flexShrink: 0, fontSize: 13, color: "var(--text-secondary)" }}>⇆</span>
                      </div>
                    </div>
                  ))}
                  {relatedView && (
                    <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--accent)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>[{relatedView.label}]</span>
                        <button onClick={() => pasteReading(relatedView.text)} disabled={finalized || locked}
                                title="현재 판독영역(마지막 포커스 필드)에 복사" style={{ fontSize: 10.5, padding: "1px 8px" }}>→ 복사</button>
                      </div>
                      <div draggable
                           onDragStart={(ev) => ev.dataTransfer.setData("text/plain", relatedView.text)}
                           onMouseDown={() => { grabRef.current = true; }}
                           title="드래그하여 판독영역(Reading/Conclusion)에 놓기 · 또는 좌클릭 누른 채 V"
                           style={{ fontSize: fontPx, whiteSpace: "pre-wrap", color: "var(--text-secondary)", cursor: "grab",
                                    border: "1px dashed var(--border)", borderRadius: 4, padding: 6 }}>
                        {relatedView.text}
                      </div>
                    </div>
                  )}
                </>
              )
            ) : (
              <>
                {/* 선택한 과거영상의 판독 — 드래그/잡고 V 로 판독영역에 복사 */}
                {relatedView && (
                  <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "var(--accent)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>[{relatedView.label}] 과거 판독</span>
                      <button onClick={() => pasteReading(relatedView.text)} disabled={finalized || locked}
                              title="현재 판독영역에 복사" style={{ fontSize: 10.5, padding: "1px 8px" }}>→ 복사</button>
                    </div>
                    <div draggable
                         onDragStart={(ev) => ev.dataTransfer.setData("text/plain", relatedView.text)}
                         onMouseDown={() => { grabRef.current = true; }}
                         title="드래그하여 판독영역에 놓기 · 또는 좌클릭 누른 채 V"
                         style={{ fontSize: fontPx, whiteSpace: "pre-wrap", color: "var(--text-secondary)", cursor: "grab",
                                  border: "1px dashed var(--border)", borderRadius: 4, padding: 6 }}>
                      {relatedView.text}
                    </div>
                  </div>
                )}
                <table className="grid-table" style={{ fontSize: 12 }}>
                  <tbody>
                    <tr><th style={{ width: 90 }}>환자 ID</th><td>{detail.patient_key}</td></tr>
                  <tr><th>이름</th><td>{detail.patient_name}</td></tr>
                  <tr><th>성별/생년</th><td>{detail.sex} / {detail.birth_date}</td></tr>
                  <tr><th>검사명</th><td>{detail.study_desc}</td></tr>
                  <tr><th>Modality</th><td>{detail.modality}</td></tr>
                  <tr><th>부위</th><td>{detail.body_part}</td></tr>
                  <tr><th>검사일</th><td>{detail.study_date}</td></tr>
                  <tr><th>Accession</th><td>{detail.accession_no}</td></tr>
                  <tr><th>기관</th><td>{detail.institution || "-"}</td></tr>
                  <tr><th>의뢰의</th><td>{detail.referring_physician || "-"}</td></tr>
                  <tr><th>임상정보</th><td>{detail.clinical_info || "-"}</td></tr>
                </tbody>
                </table>
              </>
            )}
          </div>
        </div>

        {/* 중앙: 판독 본문 */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px",
                        borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
            <b>(/)</b>
            <span>ID: <b>{detail.patient_key}</b></span>
            <span style={{ color: "var(--text-secondary)" }}>{detail.modality}/{detail.study_date}</span>
            {msg && <span style={{ color: "var(--stat-final)" }}>{msg}</span>}
            <span style={{ flex: 1 }} />
            <label title="CVR Notice — critical 소견 경고" style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={!!rdOpts.cvr_notice}
                     onChange={(e) => setRdOpts((p) => ({ ...p, cvr_notice: e.target.checked }))} />
              CVR Notice
            </label>
            <button title={`◀ ${navLeft === "past" ? "한 단계 과거" : "한 단계 최신"} 검사 (뷰어 ◀와 동일 — 정책에서 변경)`}
                    style={{ padding: "1px 10px" }}
                    disabled={navTargetIdx(-1) < 0} onClick={() => void nav(-1)}>◀</button>
            <button title={`▶ ${navLeft === "past" ? "한 단계 최신" : "한 단계 과거"} 검사 (뷰어 ▶와 동일 — 정책에서 변경)`}
                    style={{ padding: "1px 10px" }}
                    disabled={navTargetIdx(1) < 0} onClick={() => void nav(1)}>▶</button>
            <button title="서버 저장본으로 되돌리기" style={{ padding: "2px 10px" }} onClick={() => initText(report)}>Reset</button>
            <button className="primary" title={locked ? LOCK_TIP : `저장 (${String(rdOpts.key_save ?? "Ctrl+S")})`} style={{ padding: "2px 12px" }}
                    disabled={!report || finalized || locked} onClick={() => void save()}>Save</button>
            <button title={locked ? LOCK_TIP : `승인 — 확정·서명 (${String(rdOpts.key_approve ?? "Ctrl+Shift+A")})`}
                    style={{ padding: "2px 12px", background: "var(--stat-final)", color: "#fff", border: "none", borderRadius: 4,
                             opacity: !report || finalized || locked ? 0.5 : 1 }}
                    disabled={!report || finalized || locked} onClick={() => void approve()}>Approve</button>
          </div>
          {/* 확정(Fixed) 잠금 — finalized 리포트가 있을 때만 노출. 잠금 중 판독 변경 전면 차단(§C) */}
          {finalized && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "5px 12px",
                          borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
              <label title="잠금 중에는 판독 수정·확정·재생성·병합이 전부 차단됩니다"
                     style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={locked} onChange={(e) => void toggleLock(e.target.checked)} />
                🔒 판독 확정(잠금) — 변경 금지
              </label>
              {locked && <span style={{ color: "var(--text-secondary)" }}>잠금 상태 — 판독을 변경할 수 없습니다</span>}
            </div>
          )}
          {!!rdOpts.cvr_notice && report && /critical/i.test(JSON.stringify(report.sr_json.findings)) && (
            <div style={{ background: "var(--stat-emergency)", color: "#fff", fontSize: 12, padding: "4px 12px", fontWeight: 700 }}>
              ⚠ CVR Notice — CRITICAL 소견 포함 검사
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 18px",
                        display: "flex", flexDirection: "column", gap: 10, maxWidth: 1100 }}>
            <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12.5 }}>
              <span><b>ID:</b> <input readOnly value={detail.patient_key} style={{ ...inStyle, width: 150, display: "inline-block" }} /></span>
              <span><b>Reporter:</b> <input readOnly
                value={report?.created_by === "ai" ? `AI(${report.ai_model})` : report?.created_by ?? ""}
                style={{ ...inStyle, width: 190, display: "inline-block" }} /></span>
              <span><b>Report Day:</b> <input readOnly value={detail.study_date} style={{ ...inStyle, width: 120, display: "inline-block" }} /></span>
            </div>
            <div style={labelStyle}>Hospital Comment</div>
            <input value={hosp} disabled={finalized || locked} placeholder="병원 코멘트 (저장 시 함께 기록)"
                   onChange={(e) => setHosp(e.target.value)} style={inStyle} />
            <div style={labelStyle}>Study/Req Comment</div>
            <input readOnly value={detail.clinical_info ?? ""} style={inStyle} />
            <div style={labelStyle}>Refer Comment</div>
            <input readOnly value={detail.referring_physician ?? ""} style={inStyle} />
            <div style={labelStyle}>Reading {dictField.current === "reading" && dictation.recording && <span style={{ color: "var(--stat-emergency)" }}>● 음성 입력 중</span>}</div>
            <textarea value={reading} placeholder="판독 소견을 입력하세요 (마이크로 음성 입력 가능)" disabled={finalized || locked}
                      title={locked ? LOCK_TIP : undefined}
                      onFocus={() => { dictField.current = "reading"; }}
                      onChange={(e) => { setReading(e.target.value); setTouched(true); lastTypedRef.current = Date.now(); }}
                      style={{ ...taStyle, minHeight: 140, flex: 1.2 }} />
            <div style={labelStyle}>Conclusion {dictField.current === "conclusion" && dictation.recording && <span style={{ color: "var(--stat-emergency)" }}>● 음성 입력 중</span>}</div>
            <textarea value={conclusion} placeholder="결론을 입력하세요 (마이크로 음성 입력 가능)" disabled={finalized || locked}
                      title={locked ? LOCK_TIP : undefined}
                      onFocus={() => { dictField.current = "conclusion"; }}
                      onChange={(e) => { setConclusion(e.target.value); lastTypedRef.current = Date.now(); }}
                      style={{ ...taStyle, minHeight: 110, flex: 1 }} />
            {sig && (
              <div style={{ fontSize: 12.5, color: "var(--stat-final)" }}>
                ✍ {sig.name}{sig.license_no && ` (면허 제${sig.license_no}호)`} · {sig.signed_at?.slice(0, 16).replace("T", " ")}
              </div>
            )}
          </div>
        </div>

        {/* 우측 사이드바: 단축키 | 템플릿 */}
        <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid var(--border)",
                      display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "stretch", borderBottom: "1px solid var(--border)" }}>
            <div style={sideTabStyle(rightTab === "std")} onClick={() => setRightTab("std")}>Shortcuts</div>
            <div style={sideTabStyle(rightTab === "tpl")} onClick={() => setRightTab("tpl")}>Templates</div>
            <button title={`내 ${rightTab === "std" ? "단축키" : "템플릿"} 추가 (계정 로컬 저장 · 주기 서버 백업)`}
                    onClick={addLocalPhrase}
                    style={{ width: 34, border: "none", background: "var(--bg-elevated)",
                             color: "var(--accent)", fontSize: 15, cursor: "pointer" }}>＋</button>
          </div>
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {phraseList.map((p) => (
              <div key={p.id}
                   onClick={() => rightTab === "std" ? insertPhrase(p)
                     : setTplPreview((cur) => (cur?.id === p.id ? null : p))}   /* 1회 클릭 = 미리보기 토글 */
                   title={rightTab === "std"
                     ? `${p.reading_text ? `[판독] ${p.reading_text}\n` : ""}${p.text ? `[결론] ${p.text}` : ""}`
                     : "클릭=아래 미리보기 · 우측 ◯=적용/해제"}
                   style={{ padding: "8px 12px", fontSize: 12.5, cursor: "pointer", borderBottom: "1px solid #24282d",
                            display: "flex", alignItems: "center", gap: 6,
                            background: rightTab === "tpl" && tplPreview?.id === p.id ? "var(--accent-subtle)" : undefined }}
                   onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-hover)")}
                   onMouseLeave={(ev) => (ev.currentTarget.style.background =
                     rightTab === "tpl" && tplPreview?.id === p.id ? "var(--accent-subtle)" : "")}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.category && <span style={{ color: "var(--text-secondary)" }}>[{p.category}] </span>}
                  {p.name}
                </span>
                {p.shortcut && <span style={{ color: "var(--accent)", flexShrink: 0 }}>Alt+{p.shortcut}</span>}
                {p.id < 0 && (
                  <span title="내 항목 삭제" style={{ flexShrink: 0, color: "var(--stat-emergency)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`'${p.name}' 항목을 삭제할까요?`)) {
                            saveLocalPhrases(localPhrases.filter((x) => x.id !== p.id));
                          }
                        }}>🗑️</span>
                )}
                {rightTab === "tpl" && (
                  <span title={appliedTpl === p.id ? "체크 해제 — 적용 전 내용 복원" : "적용 — 판독/결론을 이 템플릿으로"}
                        onClick={(e) => { e.stopPropagation(); toggleTemplate(p); }}
                        style={{
                          flexShrink: 0, width: 17, height: 17, borderRadius: "50%",
                          display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700,
                          border: `2px solid ${appliedTpl === p.id ? "var(--accent)" : "#475569"}`,
                          background: appliedTpl === p.id ? "var(--accent)" : "transparent",
                          color: "#fff",
                        }}>{appliedTpl === p.id ? "✓" : ""}</span>
                )}
              </div>
            ))}
            {/* 템플릿 미리보기 — 선택한 항목의 판독/결론 내용 */}
            {rightTab === "tpl" && tplPreview && (
              <div style={{ padding: 10, borderTop: "1px solid var(--border)", background: "var(--bg-elevated)" }}>
                <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 4 }}>
                  [{tplPreview.name}] 미리보기 — 우측 ◯ 체크로 적용
                </div>
                {tplPreview.reading_text && (
                  <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-secondary)", marginBottom: 6 }}>
                    <b style={{ color: "var(--text-primary)" }}>판독</b><br />{tplPreview.reading_text}
                  </div>
                )}
                {tplPreview.text && (
                  <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-secondary)" }}>
                    <b style={{ color: "var(--text-primary)" }}>결론</b><br />{tplPreview.text}
                  </div>
                )}
              </div>
            )}
            {phraseList.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
                No {rightTab === "std" ? "shortcuts" : "templates"} — register in Settings &gt; Reading
                <br />or add your own with ＋ above
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
