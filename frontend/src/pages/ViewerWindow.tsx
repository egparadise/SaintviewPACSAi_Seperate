// 뷰어 전용 웹페이지 — 워크리스트에서 window.open으로 열리는 별도 창 (?viewer=2d&study=ID)
// Study Open 옵션(Add/Stack/Key/With Open)을 URL 파라미터로 전달받아 Viewer2D를 전체 화면으로 띄운다.
import { Suspense, lazy, useEffect, useState } from "react";
import { api, ensureToken, isLiveId, type StudyDetail } from "../api";
import { t as tr, useLang } from "../lib/i18n";
import { onViewerCloseAll } from "../lib/sync";
import { closeAllDelayMs, isViewerClosing, isViewerMounted, shouldForceCloseNow } from "../lib/viewerClose";
import { DEFAULT_CLIENT_VIEWER } from "../lib/viewerConfig";
import { releaseViewerSlot } from "../lib/viewerSlots";
import { folderToFilters, loadTabs } from "./WorklistTree";

const Viewer2D = lazy(() => import("./Viewer2D").then((m) => ({ default: m.Viewer2D })));
const ViewerInfi = lazy(() => import("./ViewerInfi").then((m) => ({ default: m.ViewerInfi })));

// ⚡ 뷰어 청크 선행 로드 — 모듈 평가 시점(=창 문서 로드 직후)에 곧바로 시작한다.
// 예전엔 `if (!detail) return <로딩>` 게이트 때문에 api.study() 응답이 온 뒤에야
// lazy 청크 다운로드가 시작돼, "가장 큰 다운로드"와 "API 왕복"이 직렬로 줄을 섰다.
// 이제 둘이 겹쳐 흘러가므로 첫 프레임까지의 벽시계 시간이 왕복 1회만큼 줄어든다.
void import("./Viewer2D");

// 선택 뷰어(설정>뷰어): infi=In Viewer, 그 외(ty/sv)=Viewer2D(엔진 재사용, sv 는 SAINT VIEW 크롬 skin)

export function ViewerWindow() {
  useLang();
  const params = new URLSearchParams(window.location.search);
  const [studyId, setStudyId] = useState(Number(params.get("study") || 0));
  const addId = Number(params.get("add") || 0);
  const stackId = Number(params.get("stack") || 0);
  const keySops = (params.get("keysops") ?? "").split(",").filter(Boolean);
  const woMode = params.get("wo_mode");
  const woIds = (params.get("wo_ids") ?? "").split(",").map(Number).filter(Boolean);

  // 모니터별 ◀▶ 탐색 탭(navtab) — 이 창이 배정된 워크리스트 탭의 필터로 다음/이전 환자 탐색.
  const navTab = params.get("navtab") ?? "";
  const [navFilter, setNavFilter] = useState<Record<string, string> | undefined>(undefined);
  useEffect(() => {
    if (!navTab) { setNavFilter(undefined); return; }
    loadTabs().then((tabs) => {
      const t = tabs.find((x) => x.id === navTab);
      setNavFilter(t ? folderToFilters(t.filter) : undefined);
    }).catch(() => {});
  }, [navTab]);

  const [detail, setDetail] = useState<StudyDetail | null>(null);
  // ◀👤▶ 환자 이동 — 페이지 리로드 없이 제자리 검사 전환 (뷰어가 sv-nav-study 이벤트로 요청)
  useEffect(() => {
    const onNav = (e: Event) => {
      const id = Number((e as CustomEvent<{ id?: number }>).detail?.id);
      if (!id) return;
      const p = new URLSearchParams(window.location.search);
      p.set("study", String(id));
      ["add", "stack", "keysops", "wo_mode", "wo_ids"].forEach((k) => p.delete(k));
      window.history.replaceState(null, "", `${window.location.pathname}?${p}`);
      setStudyId(id);
    };
    window.addEventListener("sv-nav-study", onNav);
    return () => window.removeEventListener("sv-nav-study", onNav);
  }, []);
  // 워크리스트에서 로그아웃하면 뷰어 창도 닫는다 (localStorage 신호 — 같은 출처 창 간 전파)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sv_logout" || (e.key === "sv_token" && !e.newValue)) window.close();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // 다른 모니터의 All Close 방송 — **뷰어 컴포넌트 밖**(로그아웃 리스너와 같은 자리)에서 받는다.
  // 왜 여기여야 하나: 아래의 `if (!detail) return <뷰어 로딩…>` 게이트와 <Suspense> 때문에, 이 창은
  // api.study() 응답과 lazy 청크가 도착할 때까지 Viewer2D/ViewerInfi 를 아예 마운트하지 않는다.
  // 그 구간(부팅·리로드·에러 화면)에는 뷰어 안의 구독이 존재하지 않아 방송을 통째로 놓쳤고,
  // 다중 모니터는 검사를 열 때마다 대상 창을 URL 로 리로드하므로 이 '귀머거리 구간'을 상시 지나간다.
  // 뷰어가 마운트돼 있으면 그쪽이 주석 저장을 끝내고 스스로 닫는 게 정상 — 여기서 먼저 닫으면
  // 주석이 유실되므로 유예(closeAllDelayMs) 뒤에 닫는 **안전망**으로만 동작한다.
  useEffect(() => onViewerCloseAll(() => {
    // 저장(await)보다 먼저 슬롯을 반납한다 — 남아 있으면 2초 하트비트가 sv_vslot_* 를 되살려
    // All Close 직후의 다음 오픈이 ①부트스트랩 대신 라운드로빈으로 떨어진다.
    releaseViewerSlot();
    const step = closeAllDelayMs(isViewerMounted());
    if (step <= 0) { window.close(); return; }   // 뷰어 미마운트 = 저장할 것이 없다 → 즉시
    // 뷰어가 붙어 있으면 양보한다. 다만 '한 번 재우고 무조건 닫기'는 위험하다 — 저장이 1.5초를
    // 넘기는 순간 문서가 사라져 주석이 유실된다. 뷰어가 아직 닫는 중이면 하드 캡까지 계속 기다린다.
    let waited = 0;
    const t = window.setInterval(() => {
      waited += step;
      if (!shouldForceCloseNow(isViewerClosing(), waited)) return;
      window.clearInterval(t);
      window.close();
    }, step);
  }), []);
  const [addDetail, setAddDetail] = useState<StudyDetail | null>(null);
  const [stackDetail, setStackDetail] = useState<StudyDetail | null>(null);
  const [err, setErr] = useState("");
  const [viewerId, setViewerId] = useState(DEFAULT_CLIENT_VIEWER);

  useEffect(() => {
    if (!studyId) { setErr(tr("study 파라미터가 없습니다")); return; }
    // 타 포트(타 출처) 뷰어: opener에서 토큰 핸드셰이크 후 로드
    void ensureToken().then((ok) => {
      if (!ok) { setErr(tr("인증 토큰을 받지 못했습니다")); return; }
      api.getSetting("viewer.prefs").then((r) => {
        const id = (r.value as { client_viewer?: string }).client_viewer;
        if (id) setViewerId(id);
      }).catch(() => {});
      // Live(원격 직결) 검사: 오픈 즉시 서버측 원본 병렬 예열 킥(A→B 지연 은닉)
      if (isLiveId(studyId)) void api.livePrefetch(studyId);
      // ⚡ 과거검사는 빼고 받는다 — A 의 환자별 검색이 느린 사이트에서 이것 하나가
      //    뷰어 오픈을 4초 넘게 막고 있었다(속도 측정 ② 4.11s). 화면을 먼저 띄우고 나서 채운다.
      api.study(studyId, { related: false }).then((d) => {
        setDetail(d);
        document.title = `Saintview Viewer — ${d.modality} ${d.patient_name} ${d.study_date}`;
        void api.relatedExams(studyId)
          .then((items) => { if (items.length) setDetail((p) => (p ? { ...p, related_exams: items } : p)); })
          .catch(() => {});
      }).catch((e) => setErr(e instanceof Error ? e.message : tr("검사 로드 실패")));
      if (addId) { if (isLiveId(addId)) void api.livePrefetch(addId); api.study(addId).then(setAddDetail).catch(() => {}); }
      if (stackId) { if (isLiveId(stackId)) void api.livePrefetch(stackId); api.study(stackId).then(setStackDetail).catch(() => {}); }
    });
  }, [studyId, addId, stackId]);

  if (err) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--stat-emergency)" }}>
        {err} — {tr("워크리스트 창에서 다시 열어주세요.")} <button onClick={() => window.close()}>{tr("닫기")}</button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-secondary)" }}>
        {tr("뷰어 로딩…")}
      </div>
    );
  }
  const common = {
    detail,
    addDetail,
    stackDetail,
    keySops: keySops.length ? keySops : undefined,
    withOpen: woMode === "add" || woMode === "stack" ? { mode: woMode as "add" | "stack", ids: woIds } : undefined,
    navFilter,   // ◀▶ 탐색 목록 필터(모니터 배정 탭). 없으면 전체 목록.
    onClose: () => window.close(),
  };
  return (
    <Suspense fallback={
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-secondary)" }}>
        {tr("뷰어 로딩…")}
      </div>
    }>
      {viewerId === "infi"
        ? <ViewerInfi {...common} />
        : <Viewer2D {...common} skin={viewerId === "sv" ? "saint" : "ty"} />}
    </Suspense>
  );
}
