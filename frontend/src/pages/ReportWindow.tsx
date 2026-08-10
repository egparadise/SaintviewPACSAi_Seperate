// 전용 판독 창 — 뷰어 [Reading] 버튼으로 열리는 별도 페이지 (?report=1&study=ID)
// 레이아웃: [판독|판독 기록|단축키|템플릿] 탭 · Font · CVR · ◀▶ · 초기화/저장/승인 · Reading/Conclusion
import { useEffect, useRef, useState } from "react";
import { api, ensureToken, type PhraseRow, type RelatedExam, type Report, type StudyDetail, type StudyRow } from "../api";
import { STATUS_LABEL } from "./Worklist";
import { onStudySync, onViewerCloseAll, postStudySync } from "../lib/sync";
import { shouldCloseReportWindow } from "../lib/viewerClose";
import { liveViewerSlots, noteViewerSlot } from "../lib/viewerSlots";
import { dictationLabel, useDictation } from "../lib/useDictation";
import { histThumbLimiter, limitedMap } from "../lib/netLimit";
import { MicIcon } from "../components/MicIcon";
import { t as tr, useLang } from "../lib/i18n";

type Tab = "read" | "hist" | "std" | "tpl";

/** 판독창이 직접 여는 뷰어 창("sv_viewer") — 다중 모니터 벽이 서 있으면 mm=1 로 열어야 한다.
 *
 *  왜: mm(다중 모니터 관리 배치) 승격이 빠진 창은 In-View 가 공유 Exam 레지스트리 **전체**를
 *  탭이 아니라 페인에 깐다(ViewerInfi 의 hangList 분기는 mm 일 때만 자기 배정 검사로 좁힌다).
 *  ◀▶ 로 sv_viewer 가 **새로** 생기면 sessionStorage(sv_mm)도 비어 있어 mm=false 가 되고,
 *  그 창에 "다른 모니터에서 연 검사들"이 함께 걸린다 — 사용자가 본 '다른 모니터 영상이 같이 보인다'.
 *
 *  판정은 살아 있는 슬롯 장부로 한다: sv_viewer 외 슬롯 창이 하나라도 살아 있으면 다중 모니터 벽이다.
 *  단일 창뿐이면 mm 을 싣지 않는다(기존 단일 창 규칙·외부 선택 동기 유지). */
function viewerUrlFor(qs: string): string {
  const wall = [...liveViewerSlots().keys()].some((n) => n !== "sv_viewer");
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?${qs}${wall ? "&mm=1" : ""}`;
}

/* History 과거검사 썸네일 — 검사의 첫 영상 시리즈 중간 프리뷰를 지연 로드 */
function HistThumb({ examId }: { examId: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // ⚠ 이 컴포넌트는 과거검사 **항목마다** 마운트된다. 예전에는 각자 즉시 seriesTree 를
    //   쏘아 판독창을 여는 순간 전건이 한꺼번에 나갔다(검사 하나가 A 왕복 1+N회다).
    //   공유 큐에 세워 동시 2건으로 묶는다 — 화면 위에서부터 차례로 채워진다.
    void histThumbLimiter.run(() => api.seriesTree(examId)).then((r) => {
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
  useLang();   // 언어 변경 시 리렌더 — 별도 브라우저 창이므로 루트에서 구독
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
  // Worklist 뷰어 도크(2026-08-10 사용자 확정) — 판독창 하단에 워크리스트를 붙여
  // '다음 판독 대상'을 보면서 판독한다. 체크·높이 모두 report.prefs 계정 로밍
  // (Setting>판독>판독창 설정과 양방향 — 같은 키 worklist_viewer 를 읽고 쓴다).
  const [wlDock, setWlDock] = useState(false);
  const [wlDockH, setWlDockH] = useState(260);
  const toggleWlDock = (on: boolean) => {
    setWlDock(on);
    api.getSetting("report.prefs").then((r) =>
      api.putSetting("report.prefs", { ...r.value, worklist_viewer: on }, "user")).catch(() => {});
  };
  const dockDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = wlDockH;
    const move = (ev: MouseEvent) =>
      setWlDockH(Math.min(Math.max(120, startH + (startY - ev.clientY)), Math.round(window.innerHeight * 0.7)));
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      setWlDockH((h) => {
        api.getSetting("report.prefs").then((r) =>
          api.putSetting("report.prefs", { ...r.value, worklist_viewer_h: h }, "user")).catch(() => {});
        return h;
      });
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  /** 도크 더블클릭 — 그 검사의 판독으로 전환(◀▶ 와 동일하게 뷰어 창도 함께 전환) */
  const openFromDock = (id: number) => {
    void loadStudyRef.current(id);
    const w = window.open(viewerUrlFor(`viewer=2d&study=${id}`), "sv_viewer");
    if (w) noteViewerSlot("sv_viewer", id);
  };
  const [msg, setMsg] = useState("");
  // ── History(과거검사) 상호작용: 단일클릭=판독 표시, 더블클릭=1:2 Compare, 드래그·잡고 V=판독영역 복사 ──
  // 과거검사 판독 미리보기 — 검사별 최종(없으면 최신) 판독문 lazy 로드(최대 12건 캐시)
  const [pastTexts, setPastTexts] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!detail) return;
    let alive = true;
    // ⚠ 예전에는 12건을 **동시에** 쏘았다. 검사마다 A 왕복이라 판독창을 여는 순간
    //   수십 건이 한꺼번에 나가 서버 스레드풀을 통째로 먹었다. 2건씩 순차로 받는다 —
    //   화면은 어차피 위에서부터 읽으므로 체감 차이가 없다.
    const todo = detail.related_exams.slice(0, 12).filter((e) => pastTexts[e.id] === undefined);
    void limitedMap(todo, 2, async (e) => {
      try {
        const rr = await api.reports(e.id);
        const fin = rr.items.find((x) => x.status === "finalized") ?? rr.items[0];
        if (alive) setPastTexts((m) => ({ ...m, [e.id]: fin?.narrative_text ?? "" }));
      } catch {
        if (alive) setPastTexts((m) => ({ ...m, [e.id]: "" }));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.related_exams.length]);

  const pasteReading = (text: string) => {
    if (!text || lockedRef.current || finalizedRef.current) return;
    const add = (prev: string) => (prev ? `${prev}\n${text}` : text);
    if (dictField.current === "conclusion") setConclusion(add); else setReading(add);
    setTouched(true);
    setMsg(tr("과거 판독을 현재 판독영역에 복사했습니다"));
  };
  const pickPast = (e: RelatedExam) => {
    setSelPast(e.id);
    api.reports(e.id).then((rr) => {
      const fin = rr.items.find((x) => x.status === "finalized") ?? rr.items[0];
      setRelatedView({ label: `${e.study_date} ${e.modality} ${e.study_desc}`, text: fin?.narrative_text || tr("(판독 없음)") });
    }).catch(() => setRelatedView({ label: `${e.study_date} ${e.modality}`, text: tr("(판독 조회 실패)") }));
  };
  const openCompare = (e: RelatedExam) => {
    if (!detail) return;
    // 현재 판독 검사 + 과거검사를 1:2 Compare(Add View)로 — 뷰어가 좌:현재 / 우:과거 로 배치
    const w = window.open(viewerUrlFor(`viewer=2d&study=${detail.id}&add=${e.id}`), "sv_viewer");
    if (w) noteViewerSlot("sv_viewer", detail.id);   // 라운드로빈 장부 갱신(이 모니터가 무엇을 물고 있는지)
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
    const name = prompt(rightTab === "std" ? tr("새 단축키 이름") : tr("새 템플릿 이름"));
    if (!name) return;
    const reading = prompt(tr("판독(Reading) 내용 — 비우면 생략")) ?? "";
    const concl = prompt(tr("결론(Conclusion) 내용 — 비우면 생략")) ?? "";
    const shortcut = rightTab === "std" ? (prompt(tr("Alt+? 단축키 문자 (예: A) — 비우면 없음")) ?? "") : "";
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
  // 뷰어의 All Close(전 모니터) 를 판독창도 받는다 — '모든 모니터가 한꺼번에' 라는 기대에 맞추기 위해.
  // ⚠ 기본값은 **닫지 않음**이다(Setting>모니터 'All Close 시 판독창도 함께 닫기'). 판독 원고는
  //   뷰어 주석과 달리 자동 저장이 없어, 임의로 닫으면 작성 중인 원고가 통째로 날아간다.
  //   켜 두었더라도 미저장 입력(touched)이 있으면 닫지 않고 안내만 남긴다 — 판정은
  //   lib/viewerClose.shouldCloseReportWindow 한 곳.
  // ⚠ 한계: VITE_VIEWER_BASE 로 뷰어를 다른 오리진에 띄운 배치에서는 BroadcastChannel 이 오리진
  //   경계를 넘지 못해 이 신호가 판독창(워크리스트 오리진)에 닿지 않는다.
  const closeReportRef = useRef(false);
  const touchedRef = useRef(false);
  useEffect(() => { touchedRef.current = touched; }, [touched]);
  useEffect(() => {
    api.getSetting("viewer.prefs").then((r) => {
      closeReportRef.current = (r.value as { monitor?: { close_report?: boolean } }).monitor?.close_report === true;
    }).catch(() => {});
    return onViewerCloseAll(() => {
      if (shouldCloseReportWindow(closeReportRef.current, touchedRef.current)) window.close();
      else if (closeReportRef.current) setMsg(tr("저장하지 않은 판독 내용이 있어 판독창은 닫지 않았습니다"));
    });
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
  const LOCK_TIP = tr("판독 확정(잠금) 상태 — 변경할 수 없습니다");
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
      setMsg(r.locked ? tr("판독 확정 잠금 설정됨") : tr("판독 확정 잠금 해제됨"));
    } catch (e) {
      alert(e instanceof Error ? e.message : tr("잠금 변경 실패"));
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
      if (!ok) { setMsg(tr("인증 토큰을 받지 못했습니다 — 뷰어/워크리스트에서 다시 열어주세요")); return; }
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
          if (v.worklist_viewer === true) setWlDock(true);
          const wh = Number(v.worklist_viewer_h);
          if (wh >= 120 && wh <= 800) setWlDockH(wh);
          if (v.sidebar_tab === "sheet") setSideTab("sheet");
          if (v.panel_tab === "template") setRightTab("tpl");
        }).catch(() => {});
        api.getSetting("worklist.prefs").then((r) => {
          const nl = (r.value as { nav_left?: "past" | "recent" }).nav_left;
          if (nl) setNavLeft(nl);
        }).catch(() => {});
      } catch (e) { setMsg(e instanceof Error ? e.message : tr("검사 로드 실패")); }
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
    const w = window.open(viewerUrlFor(`viewer=2d&study=${id}`), "sv_viewer");
    if (w) noteViewerSlot("sv_viewer", id);   // 라운드로빈 장부 갱신 — 이 모니터의 현재 검사가 바뀌었다
    // ⚠ 다운로드 모드 기준선(markDlOpened/dlResume)은 여기서 부를 수 없다 — 그것들은 워크리스트
    //   **문서**의 상태다(이 창은 별도 문서). 대신 워크리스트가 '뷰어가 살아 있는가' 를 폴로 보고
    //   상승 에지에서 스스로 재개한다(viewerSlots.decideBaselineArm). 위 noteViewerSlot 이 그
    //   판정의 입력이므로 **지우면 안 된다**. 한때 이 경로에 재개가 없어, 뷰어 ✕ 뒤 ◀▶ 로 판독을
    //   이어 가면 백그라운드 다운로드가 그 세션 내내 죽어 있었다.

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
    if (finalized) { setMsg(tr("확정된 판독입니다 — 수정하려면 새 버전(addendum)을 생성하세요")); return; }
    const sr = buildSr();
    if (!report || !sr || !detail) return;
    try {
      await api.updateReport(report.id, sr);
      if (hosp !== (detail.memo ?? "")) await api.setMemo(detail.id, hosp);  // Hospital Comment
      const r = await api.reports(detail.id);
      setReports(r.items);
      setTouched(false);
      if (rdOpts.save_alert) alert(tr("리포트가 저장되었습니다")); else setMsg(tr("저장됨"));
    } catch (e) {
      alert(e instanceof Error ? e.message : tr("저장 실패"));
      void syncLock();   // 다른 창에서 잠금 변경(409) 등 — 서버 기준 잠금 상태 재동기화
    }
  };

  const approve = async () => {
    if (locked) { setMsg(LOCK_TIP); return; }   // 확정 잠금 — 단축키(Ctrl+Shift+A) 경로 포함 차단
    // 확정본 — Approve 버튼 disabled(finalized) 조건과 단축키 경로 일치
    if (finalized) { setMsg(tr("이미 확정된 판독입니다")); return; }
    const sr = buildSr();
    if (!report || !sr || !detail) return;
    if (!window.confirm(tr("판독을 확정(승인·서명)합니다. 확정 후 수정할 수 없습니다."))) return;
    try {
      await api.updateReport(report.id, sr);
      await api.finalizeReport(report.id);
      const r = await api.reports(detail.id);
      setReports(r.items);
      initText(r.items[0] ?? null);
      setMsg(tr("확정(서명) 완료"));
      if (rdOpts.open_next_after_save && navIdx < navList.length - 1) void nav(1);  // 저장 후 다음 레포트 열기
    } catch (e) {
      alert(e instanceof Error ? e.message : tr("승인 실패"));
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
        {msg || tr("판독 창 로딩…")}
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

  // 환자 정보 배너(레퍼런스: 이름 (S/000Y) · ID · 일시 · MOD / 부위 / 검사명) — 판독 대상 확인용
  const ageY = (() => {
    const b = String(detail.birth_date ?? "").replace(/\D/g, "");
    const s = String(detail.study_date ?? "").replace(/\D/g, "");
    if (b.length < 8 || s.length < 8) return "";
    let a = Number(s.slice(0, 4)) - Number(b.slice(0, 4));
    if (s.slice(4, 8) < b.slice(4, 8)) a -= 1;              // 검사일 기준 만 나이
    return a >= 0 && a < 200 ? `${String(a).padStart(3, "0")}Y` : "";
  })();
  const sexAge = [detail.sex, ageY].filter(Boolean).join("/");
  const studyAt = (() => {
    const t = String(detail.study_time ?? "").replace(/\D/g, "");
    const hm = t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
      : t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : "";
    return [detail.study_date, hm].filter(Boolean).join(" ");
  })();
  const examLine = [detail.modality, detail.body_part, detail.study_desc].filter(Boolean).join(" / ");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-canvas)" }}>
      {/* 최상단: Font size 바 (레퍼런스) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 14px",
                    background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
        {/* 판독 대상 환자 배너 — 이름·성별/나이·ID·검사 일시·검사 구분 (다른 환자를 판독하는 사고 방지) */}
        <span style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0, overflow: "hidden",
                       whiteSpace: "nowrap" }}>
          {detail.emergency && <b style={{ color: "var(--stat-emergency)" }}>⚠</b>}
          <b style={{ fontSize: 14.5 }}>{detail.patient_name}{sexAge ? ` (${sexAge})` : ""}</b>
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>ID: {detail.patient_key}</span>
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{studyAt}</span>
          <b style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}>{examLine}</b>
        </span>
        {/* 음성 판독(STT) 마이크 — Font size 왼쪽. 서버 설정 엔진(브라우저/Whisper/OpenAI)으로 구동 */}
        <button onClick={dictation.toggle} disabled={finalized || locked || dictation.busy}
                title={tr(dictationLabel(dictation.engine, dictation.recording, dictation.busy))}
                style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "3px 10px",
                         border: `1px solid ${dictation.recording ? "var(--stat-emergency)" : "var(--border)"}`,
                         borderRadius: 6, background: dictation.recording ? "var(--stat-emergency)" : "var(--bg-canvas)",
                         color: dictation.recording ? "#fff" : "var(--text-primary)", fontSize: 12.5, cursor: "pointer" }}>
          <MicIcon on={dictation.recording} />
          {dictation.busy ? tr("전사 중…") : dictation.recording ? tr("녹음 중") : tr("음성 판독")}
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
            <div style={sideTabStyle(sideTab === "sheet")} onClick={() => setSideTab("sheet")}>{tr("기록지")}</div>
          </div>
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {sideTab === "hist" ? (
              detail.related_exams.length === 0 && reports.slice(1).length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
                              padding: "60px 18px", textAlign: "center" }}>
                  <div style={{ fontSize: 34, opacity: 0.5 }}>🕘</div>
                  <b style={{ fontSize: 13.5 }}>No previous reports</b>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {tr("이 환자의 이전 검사 기록이 없거나 판독이 완료되지 않았습니다.")}
                  </div>
                  <button className="primary" style={{ padding: "4px 14px", fontSize: 12 }}
                          onClick={() => window.open(
                            `${window.location.origin}${window.location.pathname}?viewer=2d&study=${detail.id}`,
                            "sv_viewer")}>
                    {tr("▶ 이전 검사 영상 요청")}
                  </button>
                </div>
              ) : (
                <>
                  {reports.slice(1).map((r) => (
                    <div key={r.id}
                         onClick={() => setRelatedView({
                           label: `v${r.version} · ${r.created_by === "ai" ? "AI" : r.created_by}`,
                           text: r.narrative_text || tr("(내용 없음)"),
                         })}
                         style={{ padding: "7px 12px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #24282d" }}>
                      📄 {tr("현재 검사")} v{r.version} · {r.status} · {r.created_by === "ai" ? "AI" : r.created_by}
                    </div>
                  ))}
                  {/* Same Compare — 선택 기준(마지막 클릭)과 같은 장비·검사명(부위)만 정렬 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
                    <button onClick={() => setSameCompare((s) => !s)} disabled={!refExam}
                            title={tr("Same Compare — 선택한 과거영상과 같은 장비·검사명(부위)만 정렬 (먼저 과거영상 클릭)")}
                            style={{ fontSize: 11, padding: "3px 10px", opacity: refExam ? 1 : 0.5,
                                     background: sameCompare ? "var(--accent)" : undefined, color: sameCompare ? "#fff" : undefined }}>
                      Same Compare{sameCompare ? " ●" : ""}
                    </button>
                    {sameCompare && refExam && (
                      <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{refExam.modality}/{refExam.study_desc} {tr("기준")}</span>
                    )}
                  </div>
                  {/* 과거검사 이미지 — 단일클릭=판독 표시, 더블클릭=1:2 Compare 열기 */}
                  {histList.map((e) => (
                    <div key={e.id} onClick={() => pickPast(e)} onDoubleClick={() => openCompare(e)}
                         title={tr("단일클릭=판독 표시 · 더블클릭=1:2 Compare(현재 옆) 열기")}
                         style={{ padding: "8px 10px", cursor: "pointer", borderBottom: "2px solid var(--border)",
                                  background: e.id === selPast ? "var(--bg-elevated)" : undefined }}>
                      {/* 상단: 날짜 + 복사(과거 판독→현재 판독영역) */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1 }}>{e.study_date}</span>
                        {pastTexts[e.id] ? (
                          <button onClick={(ev) => { ev.stopPropagation(); pasteReading(pastTexts[e.id]); }}
                                  title={tr("이 과거 판독을 현재 판독영역에 복사")}
                                  className="primary" style={{ fontSize: 10.5, padding: "1px 10px" }}>{tr("복사")}</button>
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
                          {pastTexts[e.id] === undefined ? tr("판독 불러오는 중…")
                            : pastTexts[e.id] ? pastTexts[e.id] : tr("(판독 기록 없음)")}
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
                                title={tr("현재 판독영역(마지막 포커스 필드)에 복사")} style={{ fontSize: 10.5, padding: "1px 8px" }}>{tr("→ 복사")}</button>
                      </div>
                      <div draggable
                           onDragStart={(ev) => ev.dataTransfer.setData("text/plain", relatedView.text)}
                           onMouseDown={() => { grabRef.current = true; }}
                           title={tr("드래그하여 판독영역(Reading/Conclusion)에 놓기 · 또는 좌클릭 누른 채 V")}
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
                      <span style={{ fontSize: 11, color: "var(--accent)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>[{relatedView.label}] {tr("과거 판독")}</span>
                      <button onClick={() => pasteReading(relatedView.text)} disabled={finalized || locked}
                              title={tr("현재 판독영역에 복사")} style={{ fontSize: 10.5, padding: "1px 8px" }}>{tr("→ 복사")}</button>
                    </div>
                    <div draggable
                         onDragStart={(ev) => ev.dataTransfer.setData("text/plain", relatedView.text)}
                         onMouseDown={() => { grabRef.current = true; }}
                         title={tr("드래그하여 판독영역에 놓기 · 또는 좌클릭 누른 채 V")}
                         style={{ fontSize: fontPx, whiteSpace: "pre-wrap", color: "var(--text-secondary)", cursor: "grab",
                                  border: "1px dashed var(--border)", borderRadius: 4, padding: 6 }}>
                      {relatedView.text}
                    </div>
                  </div>
                )}
                <table className="grid-table" style={{ fontSize: 12 }}>
                  <tbody>
                    <tr><th style={{ width: 90 }}>{tr("환자 ID")}</th><td>{detail.patient_key}</td></tr>
                  <tr><th>{tr("이름")}</th><td>{detail.patient_name}</td></tr>
                  <tr><th>{tr("성별/생년")}</th><td>{detail.sex} / {detail.birth_date}</td></tr>
                  <tr><th>{tr("검사명")}</th><td>{detail.study_desc}</td></tr>
                  <tr><th>Modality</th><td>{detail.modality}</td></tr>
                  <tr><th>{tr("부위")}</th><td>{detail.body_part}</td></tr>
                  <tr><th>{tr("검사일")}</th><td>{detail.study_date}</td></tr>
                  <tr><th>Accession</th><td>{detail.accession_no}</td></tr>
                  <tr><th>{tr("기관")}</th><td>{detail.institution || "-"}</td></tr>
                  <tr><th>{tr("의뢰의")}</th><td>{detail.referring_physician || "-"}</td></tr>
                  <tr><th>{tr("임상정보")}</th><td>{detail.clinical_info || "-"}</td></tr>
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
            <label title={tr("판독창 하단에 워크리스트 표시 — 다음 판독 대상 확인 (계정 저장·Setting>판독)")}
                   style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={wlDock} onChange={(e) => toggleWlDock(e.target.checked)} />
              {tr("Worklist 뷰어")}
            </label>
            <label title={tr("CVR Notice — critical 소견 경고")} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={!!rdOpts.cvr_notice}
                     onChange={(e) => setRdOpts((p) => ({ ...p, cvr_notice: e.target.checked }))} />
              CVR Notice
            </label>
            <button title={navLeft === "past" ? tr("◀ 한 단계 과거 검사 (뷰어 ◀와 동일 — 정책에서 변경)") : tr("◀ 한 단계 최신 검사 (뷰어 ◀와 동일 — 정책에서 변경)")}
                    style={{ padding: "1px 10px" }}
                    disabled={navTargetIdx(-1) < 0} onClick={() => void nav(-1)}>◀</button>
            <button title={navLeft === "past" ? tr("▶ 한 단계 최신 검사 (뷰어 ▶와 동일 — 정책에서 변경)") : tr("▶ 한 단계 과거 검사 (뷰어 ▶와 동일 — 정책에서 변경)")}
                    style={{ padding: "1px 10px" }}
                    disabled={navTargetIdx(1) < 0} onClick={() => void nav(1)}>▶</button>
            <button title={tr("서버 저장본으로 되돌리기")} style={{ padding: "2px 10px" }} onClick={() => initText(report)}>Reset</button>
            <button className="primary" title={locked ? LOCK_TIP : `${tr("저장")} (${String(rdOpts.key_save ?? "Ctrl+S")})`} style={{ padding: "2px 12px" }}
                    disabled={!report || finalized || locked} onClick={() => void save()}>Save</button>
            <button title={locked ? LOCK_TIP : `${tr("승인 — 확정·서명")} (${String(rdOpts.key_approve ?? "Ctrl+Shift+A")})`}
                    style={{ padding: "2px 12px", background: "var(--stat-final)", color: "#fff", border: "none", borderRadius: 4,
                             opacity: !report || finalized || locked ? 0.5 : 1 }}
                    disabled={!report || finalized || locked} onClick={() => void approve()}>Approve</button>
          </div>
          {/* 확정(Fixed) 잠금 — finalized 리포트가 있을 때만 노출. 잠금 중 판독 변경 전면 차단(§C) */}
          {finalized && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "5px 12px",
                          borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
              <label title={tr("잠금 중에는 판독 수정·확정·재생성·병합이 전부 차단됩니다")}
                     style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={locked} onChange={(e) => void toggleLock(e.target.checked)} />
                {tr("🔒 판독 확정(잠금) — 변경 금지")}
              </label>
              {locked && <span style={{ color: "var(--text-secondary)" }}>{tr("잠금 상태 — 판독을 변경할 수 없습니다")}</span>}
            </div>
          )}
          {!!rdOpts.cvr_notice && report && /critical/i.test(JSON.stringify(report.sr_json.findings)) && (
            <div style={{ background: "var(--stat-emergency)", color: "#fff", fontSize: 12, padding: "4px 12px", fontWeight: 700 }}>
              {tr("⚠ CVR Notice — CRITICAL 소견 포함 검사")}
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
            <input value={hosp} disabled={finalized || locked} placeholder={tr("병원 코멘트 (저장 시 함께 기록)")}
                   onChange={(e) => setHosp(e.target.value)} style={inStyle} />
            <div style={labelStyle}>Study/Req Comment</div>
            <input readOnly value={detail.clinical_info ?? ""} style={inStyle} />
            <div style={labelStyle}>Refer Comment</div>
            <input readOnly value={detail.referring_physician ?? ""} style={inStyle} />
            <div style={labelStyle}>Reading {dictField.current === "reading" && dictation.recording && <span style={{ color: "var(--stat-emergency)" }}>{tr("● 음성 입력 중")}</span>}</div>
            <textarea value={reading} placeholder={tr("판독 소견을 입력하세요 (마이크로 음성 입력 가능)")} disabled={finalized || locked}
                      title={locked ? LOCK_TIP : undefined}
                      onFocus={() => { dictField.current = "reading"; }}
                      onChange={(e) => { setReading(e.target.value); setTouched(true); lastTypedRef.current = Date.now(); }}
                      style={{ ...taStyle, minHeight: 140, flex: 1.2 }} />
            <div style={labelStyle}>Conclusion {dictField.current === "conclusion" && dictation.recording && <span style={{ color: "var(--stat-emergency)" }}>{tr("● 음성 입력 중")}</span>}</div>
            <textarea value={conclusion} placeholder={tr("결론을 입력하세요 (마이크로 음성 입력 가능)")} disabled={finalized || locked}
                      title={locked ? LOCK_TIP : undefined}
                      onFocus={() => { dictField.current = "conclusion"; }}
                      onChange={(e) => { setConclusion(e.target.value); lastTypedRef.current = Date.now(); }}
                      style={{ ...taStyle, minHeight: 110, flex: 1 }} />
            {sig && (
              <div style={{ fontSize: 12.5, color: "var(--stat-final)" }}>
                ✍ {sig.name}{sig.license_no && ` (${tr("면허 제")}${sig.license_no}${tr("호")})`}{(sig as { major_no?: string }).major_no && ` · ${tr("전문의 제")}${(sig as { major_no?: string }).major_no}${tr("호")}`} · {sig.signed_at?.slice(0, 16).replace("T", " ")}
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
            <button title={rightTab === "std" ? tr("내 단축키 추가 (계정 로컬 저장 · 주기 서버 백업)") : tr("내 템플릿 추가 (계정 로컬 저장 · 주기 서버 백업)")}
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
                     ? `${p.reading_text ? `${tr("[판독]")} ${p.reading_text}\n` : ""}${p.text ? `${tr("[결론]")} ${p.text}` : ""}`
                     : tr("클릭=아래 미리보기 · 우측 ◯=적용/해제")}
                   style={{ padding: "8px 12px", fontSize: 12.5, cursor: "pointer", borderBottom: "1px solid #24282d",
                            display: "flex", alignItems: "center", gap: 6,
                            background: rightTab === "tpl" && tplPreview?.id === p.id ? "var(--accent-subtle)" : undefined }}
                   onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-hover)")}
                   onMouseLeave={(ev) => (ev.currentTarget.style.background =
                     rightTab === "tpl" && tplPreview?.id === p.id ? "var(--accent-subtle)" : "")}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.category && <span style={{ color: "var(--text-secondary)" }}>[{tr(p.category)}] </span>}
                  {p.name}
                </span>
                {p.shortcut && <span style={{ color: "var(--accent)", flexShrink: 0 }}>Alt+{p.shortcut}</span>}
                {p.id < 0 && (
                  <span title={tr("내 항목 삭제")} style={{ flexShrink: 0, color: "var(--stat-emergency)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`'${p.name}' ${tr("항목을 삭제할까요?")}`)) {
                            saveLocalPhrases(localPhrases.filter((x) => x.id !== p.id));
                          }
                        }}>🗑️</span>
                )}
                {rightTab === "tpl" && (
                  <span title={appliedTpl === p.id ? tr("체크 해제 — 적용 전 내용 복원") : tr("적용 — 판독/결론을 이 템플릿으로")}
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
                  [{tplPreview.name}] {tr("미리보기 — 우측 ◯ 체크로 적용")}
                </div>
                {tplPreview.reading_text && (
                  <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-secondary)", marginBottom: 6 }}>
                    <b style={{ color: "var(--text-primary)" }}>{tr("판독")}</b><br />{tplPreview.reading_text}
                  </div>
                )}
                {tplPreview.text && (
                  <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-secondary)" }}>
                    <b style={{ color: "var(--text-primary)" }}>{tr("결론")}</b><br />{tplPreview.text}
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
      {/* 하단 Worklist 뷰어(2026-08-10 사용자 확정) — 상하 스플리터로 높이 조절, 계정 저장 */}
      {wlDock && (
        <>
          <div onMouseDown={dockDragStart} title={tr("드래그하여 높이 조절")}
               style={{ height: 6, cursor: "row-resize", background: "var(--border)", flexShrink: 0 }} />
          <div style={{ height: wlDockH, flexShrink: 0, borderTop: "1px solid var(--border)",
                        display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-panel)" }}>
            <WorklistDock curId={detail.id} onOpen={openFromDock} />
          </div>
        </>
      )}
    </div>
  );
}

/* 판독창 하단 Worklist 뷰어 — 워크리스트와 같은 소스(api.worklist: Live/로컬 자동)를 30초마다
 * 갱신해 '다음 판독을 해야 할 환자'를 보여준다. 단일클릭=선택 표시, 더블클릭=그 검사 판독 전환. */
function WorklistDock({ curId, onOpen }: { curId: number; onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<StudyRow[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const tick = () => api.worklist({ limit: "200" })
      .then((r) => { if (alive) { setRows(r.items); setErr(""); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    tick();
    const t = window.setInterval(tick, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  const th: React.CSSProperties = { position: "sticky", top: 0, background: "var(--bg-elevated)",
                                    textAlign: "left", padding: "4px 8px", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "3px 8px", whiteSpace: "nowrap", overflow: "hidden",
                                    textOverflow: "ellipsis", maxWidth: 260 };
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      {err && <div style={{ padding: 8, fontSize: 12, color: "var(--stat-emergency)" }}>{err}</div>}
      <table className="grid-table" style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={th}>{tr("상태")}</th><th style={th}>{tr("이름")}</th><th style={th}>ID</th>
          <th style={th}>MOD</th><th style={th}>{tr("검사일")}</th><th style={th}>{tr("검사시각")}</th>
          <th style={th}>{tr("부위")}</th><th style={th}>Img</th>
          <th style={th}>{tr("검사명")}</th><th style={th}>{tr("의뢰의")}</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onDoubleClick={() => onOpen(r.id)}
                title={tr("더블클릭 = 그 검사 판독으로 전환 (뷰어도 함께 전환)")}
                style={{ cursor: "pointer", borderBottom: "1px solid var(--border)",
                         background: r.id === curId ? "var(--bg-elevated)" : undefined,
                         fontWeight: r.id === curId ? 700 : 400 }}>
              <td style={td}>{tr(STATUS_LABEL[r.status] ?? r.status)}</td>
              <td style={td}>{r.patient_name}</td>
              <td style={td}>{r.patient_key}</td>
              <td style={td}>{r.modality}</td>
              <td style={td}>{r.study_date}</td>
              <td style={td}>{r.study_time}</td>
              <td style={td}>{r.body_part}</td>
              <td style={td}>{r.instance_count}</td>
              <td style={td}>{r.study_desc}</td>
              <td style={td}>{r.referring_physician}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
