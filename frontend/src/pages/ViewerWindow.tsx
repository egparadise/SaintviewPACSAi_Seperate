// 뷰어 전용 웹페이지 — 워크리스트에서 window.open으로 열리는 별도 창 (?viewer=2d&study=ID)
// Study Open 옵션(Add/Stack/Key/With Open)을 URL 파라미터로 전달받아 Viewer2D를 전체 화면으로 띄운다.
import { Suspense, lazy, useEffect, useState } from "react";
import { api, ensureToken, type StudyDetail } from "../api";
import { DEFAULT_CLIENT_VIEWER } from "../lib/viewerConfig";

const Viewer2D = lazy(() => import("./Viewer2D").then((m) => ({ default: m.Viewer2D })));
const ViewerInfi = lazy(() => import("./ViewerInfi").then((m) => ({ default: m.ViewerInfi })));

// 선택 뷰어(설정>뷰어): infi=In Viewer, 그 외(ty/sv)=Viewer2D(엔진 재사용, sv 는 SAINT VIEW 크롬 skin)

export function ViewerWindow() {
  const params = new URLSearchParams(window.location.search);
  const [studyId, setStudyId] = useState(Number(params.get("study") || 0));
  const addId = Number(params.get("add") || 0);
  const stackId = Number(params.get("stack") || 0);
  const keySops = (params.get("keysops") ?? "").split(",").filter(Boolean);
  const woMode = params.get("wo_mode");
  const woIds = (params.get("wo_ids") ?? "").split(",").map(Number).filter(Boolean);

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
  const [addDetail, setAddDetail] = useState<StudyDetail | null>(null);
  const [stackDetail, setStackDetail] = useState<StudyDetail | null>(null);
  const [err, setErr] = useState("");
  const [viewerId, setViewerId] = useState(DEFAULT_CLIENT_VIEWER);

  useEffect(() => {
    if (!studyId) { setErr("study 파라미터가 없습니다"); return; }
    // 타 포트(타 출처) 뷰어: opener에서 토큰 핸드셰이크 후 로드
    void ensureToken().then((ok) => {
      if (!ok) { setErr("인증 토큰을 받지 못했습니다"); return; }
      api.getSetting("viewer.prefs").then((r) => {
        const id = (r.value as { client_viewer?: string }).client_viewer;
        if (id) setViewerId(id);
      }).catch(() => {});
      api.study(studyId).then((d) => {
        setDetail(d);
        document.title = `Saintview Viewer — ${d.modality} ${d.patient_name} ${d.study_date}`;
      }).catch((e) => setErr(e instanceof Error ? e.message : "검사 로드 실패"));
      if (addId) api.study(addId).then(setAddDetail).catch(() => {});
      if (stackId) api.study(stackId).then(setStackDetail).catch(() => {});
    });
  }, [studyId, addId, stackId]);

  if (err) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--stat-emergency)" }}>
        {err} — 워크리스트 창에서 다시 열어주세요. <button onClick={() => window.close()}>닫기</button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-secondary)" }}>
        뷰어 로딩…
      </div>
    );
  }
  const common = {
    detail,
    addDetail,
    stackDetail,
    keySops: keySops.length ? keySops : undefined,
    withOpen: woMode === "add" || woMode === "stack" ? { mode: woMode as "add" | "stack", ids: woIds } : undefined,
    onClose: () => window.close(),
  };
  return (
    <Suspense fallback={
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-secondary)" }}>
        뷰어 로딩…
      </div>
    }>
      {viewerId === "infi"
        ? <ViewerInfi {...common} />
        : <Viewer2D {...common} skin={viewerId === "sv" ? "saint" : "ty"} />}
    </Suspense>
  );
}
