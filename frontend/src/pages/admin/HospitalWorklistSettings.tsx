// 병원 기본 뷰어·워크리스트 설정 — 설정 모달(설정>워크리스트)과 동일 구현을 병원 스코프로 제공.
// 어디서나 작업: 관리 콘솔(여기)=병원 기본값, 설정 모달=계정별 값. 계정 설정이 없는 사용자는
// /api/settings 조회 시 이 병원 기본값으로 폴백된다(user > hospital > 빈값).
// 상용구(Std)는 공유 DB 테이블이라 병원 스코프 대상이 아님 — 설정>워크리스트에서 관리.
import { useEffect, useState } from "react";
import { api } from "../../api";
import { showToast } from "../../lib/toast";
import { COLUMN_DEFS, DEFAULT_COLUMNS, DEFAULT_FIND_FIELDS, FIND_FIELDS } from "../Worklist";
import { DualList, FilterSettingList, Group, Row } from "../SettingsModal";
import {
  DEFAULT_TAB,
  FolderEditModal,
  FolderTreeEditor,
  folderSummary,
  newId,
  type TreeNode,
  type WorklistTab,
} from "../WorklistTree";

// 표기·순서 규약: SaintView → I-View → T-View (설정 모달과 동일)
const VIEWERS = [
  { vk: "sv", label: "SaintView" },
  { vk: "infi", label: "I-View" },
  { vk: "ty", label: "T-View" },
] as const;

export function HospitalWorklistSettings({ hid }: { hid: number }) {
  // worklist.prefs (병원 스코프)
  const [refreshSec, setRefreshSec] = useState(10);
  const [defaultStatus, setDefaultStatus] = useState("");
  const [dblAction, setDblAction] = useState<"viewer2d" | "ohif">("viewer2d");
  const [navLeft, setNavLeft] = useState<"past" | "recent">("past");
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [wlBy, setWlBy] = useState<{ sv?: string[] | null; ty?: string[] | null; infi?: string[] | null }>({});
  const [findFields, setFindFields] = useState<string[]>(DEFAULT_FIND_FIELDS);
  const [panels, setPanels] = useState<Record<string, boolean>>({
    orders: true, prior: true, compare: true, thumb: true, std: true, comment: true, report: true,
  });
  // worklist.tabs / worklist.tree (병원 스코프 — 변경 즉시 저장, 설정 모달과 동일 UX)
  const [tabs, setTabs] = useState<WorklistTab[]>([DEFAULT_TAB]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selTreeId, setSelTreeId] = useState<string | null>(null);
  const [tabModal, setTabModal] = useState<{ index: number } | "add" | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.hospWlSetting(hid, "worklist.prefs").then((r) => {
      const v = r.value as {
        auto_refresh_sec?: number; default_status?: string; columns?: string[];
        by_viewer?: { sv?: string[] | null; ty?: string[] | null; infi?: string[] | null };
        find_fields?: string[]; dbl_action?: "viewer2d" | "ohif";
        panels?: Record<string, boolean>; nav_left?: "past" | "recent";
      };
      if (v.auto_refresh_sec !== undefined) setRefreshSec(v.auto_refresh_sec);
      setDefaultStatus(v.default_status ?? "");
      if (v.columns?.length) setColumns(v.columns.filter((c) => COLUMN_DEFS[c]));
      if (v.by_viewer) setWlBy(v.by_viewer);
      if (v.find_fields?.length) setFindFields(v.find_fields.filter((c) => FIND_FIELDS[c]));
      if (v.dbl_action) setDblAction(v.dbl_action);
      if (v.panels) setPanels((p) => ({ ...p, ...v.panels }));
      if (v.nav_left) setNavLeft(v.nav_left);
    }).catch(() => {});
    api.hospWlSetting(hid, "worklist.tabs").then((r) => {
      const items = (r.value as { items?: WorklistTab[] }).items ?? [];
      setTabs(items.length ? items : [DEFAULT_TAB]);
    }).catch(() => {});
    api.hospWlSetting(hid, "worklist.tree").then((r) => {
      setTree((r.value as { nodes?: TreeNode[] }).nodes ?? []);
    }).catch(() => {});
  }, [hid]);

  const savePrefs = async () => {
    try {
      // 병합 저장 — 병원 스코프 현재 값과 합쳐 다른 키 보존(설정 모달 save()와 동일 규약)
      const cur = (await api.hospWlSetting(hid, "worklist.prefs").catch(() => ({ value: {} }))).value;
      await api.putHospWlSetting(hid, "worklist.prefs", {
        ...cur, auto_refresh_sec: refreshSec, default_status: defaultStatus, columns,
        by_viewer: wlBy, find_fields: findFields, dbl_action: dblAction,
        panels, nav_left: navLeft,
      });
      showToast("저장 되었습니다.");
      setMsg("저장됨 — 계정별 설정이 없는 이 병원 사용자에게 적용됩니다");
    } catch (e) { setMsg("⚠ " + (e as Error).message); }
  };
  const saveTabs = (next: WorklistTab[]) =>
    api.putHospWlSetting(hid, "worklist.tabs", { items: next })
      .then(() => showToast("저장 되었습니다."))
      .catch((e) => setMsg("⚠ " + (e as Error).message));
  const saveTree = (next: TreeNode[]) =>
    api.putHospWlSetting(hid, "worklist.tree", { nodes: next })
      .then(() => showToast("저장 되었습니다."))
      .catch((e) => setMsg("⚠ " + (e as Error).message));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 860 }}>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
        설정 모달의 [워크리스트]와 <b>동일 구현</b> — 여기서는 <b>병원 기본값</b>으로 저장됩니다.
        계정별 설정이 있는 사용자는 그 값이 우선하고(설정 저장·레이아웃/스플리터 변경 포함),
        계정 설정이 아직 없는 사용자는 이 병원 기본값이 적용됩니다.
      </div>

      <Group title="워크리스트 동작">
        <Row label="자동 갱신">
          <select value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>
            <option value={0}>끔</option><option value={5}>5초</option>
            <option value={10}>10초</option><option value={30}>30초</option>
          </select>
        </Row>
        <Row label="기본 상태 필터">
          <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)}>
            <option value="">전체</option><option value="unread">미판독</option>
            <option value="draft">초안</option><option value="final">확정</option>
          </select>
        </Row>
        <Row label="더블클릭 동작">
          <select value={dblAction} onChange={(e) => setDblAction(e.target.value as "viewer2d" | "ohif")}>
            <option value="viewer2d">내장 뷰어</option><option value="ohif">OHIF</option>
          </select>
        </Row>
        <Row label="◀ 이동 방향">
          <select value={navLeft} onChange={(e) => setNavLeft(e.target.value as "past" | "recent")}>
            <option value="past">과거 검사로</option><option value="recent">최신 검사로</option>
          </select>
        </Row>
      </Group>

      <Group title="그리드 컬럼 구성 — Filter Setting (USE/NO USE, UBPACS형)">
        <FilterSettingList
          all={Object.keys(COLUMN_DEFS)}
          selected={columns}
          labelOf={(k) => COLUMN_DEFS[k].label}
          onChange={setColumns}
        />
      </Group>

      {VIEWERS.map(({ vk, label }) => {
        const ov = wlBy[vk];
        return (
          <Group key={vk} title={label + " 워크리스트 — 뷰어별 그리드 컬럼 (병원 기본)"}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <input type="checkbox" checked={!ov}
                     onChange={(e) => setWlBy((p) => ({ ...p, [vk]: e.target.checked ? null : [...columns] }))} />
              공통 워크리스트 설정 사용 (기본) — 해제하면 이 뷰어 전용 컬럼 구성을 편집합니다
            </label>
            {ov && (
              <FilterSettingList
                all={Object.keys(COLUMN_DEFS)}
                selected={ov}
                labelOf={(k) => COLUMN_DEFS[k].label}
                onChange={(cols) => setWlBy((p) => ({ ...p, [vk]: cols }))}
              />
            )}
          </Group>
        );
      })}

      <Group title="검색 필드 구성 (Find criteria)">
        <DualList
          all={Object.keys(FIND_FIELDS)}
          selected={findFields}
          labelOf={(k) => FIND_FIELDS[k]}
          onChange={setFindFields}
        />
      </Group>

      <Group title="워크리스트 구성요소 (Study List 제외 추가/삭제)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
          {([
            ["orders", "오더/예약 (Order)"],
            ["prior", "과거검사 (Related Study List-1)"],
            ["compare", "비교세트 (Related Study List-2)"],
            ["thumb", "썸네일 (Thumbnail Window)"],
            ["std", "상용구 (Reference Window)"],
            ["comment", "Comment / MEMO"],
            ["report", "리포트 (Report Window)"],
          ] as const).map(([k, label]) => (
            <label key={k} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12.5 }}>
              <input type="checkbox" checked={!!panels[k]}
                     onChange={(e) => setPanels((p) => ({ ...p, [k]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </div>
      </Group>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="primary" onClick={savePrefs}>저장 (병원 기본값)</button>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg}</span>
      </div>

      <Group title="워크리스트 페이지 탭 (최대 10 — 변경 즉시 저장)">
        <table className="grid-table">
          <thead><tr><th style={{ width: 130 }}>이름</th><th>검색 조건</th><th style={{ width: 118 }}></th></tr></thead>
          <tbody>
            {tabs.map((t, i) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td style={{ color: "var(--text-secondary)" }}>{folderSummary(t.filter)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button style={{ padding: "0 6px", fontSize: 11 }} title="이름·검색 조건 수정"
                          onClick={() => setTabModal({ index: i })}>수정</button>
                  <button style={{ padding: "0 6px", fontSize: 11 }} disabled={i === 0} title="위로"
                          onClick={() => {
                            const next = [...tabs];
                            [next[i - 1], next[i]] = [next[i], next[i - 1]];
                            setTabs(next); saveTabs(next);
                          }}>▲</button>
                  <button style={{ padding: "0 6px", fontSize: 11 }} disabled={i === tabs.length - 1} title="아래로"
                          onClick={() => {
                            const next = [...tabs];
                            [next[i], next[i + 1]] = [next[i + 1], next[i]];
                            setTabs(next); saveTabs(next);
                          }}>▼</button>
                  <button style={{ padding: "0 6px", fontSize: 11 }} disabled={t.id === "default"} title="삭제"
                          onClick={() => {
                            if (!window.confirm(`'${t.label}' 페이지를 삭제할까요?`)) return;
                            const next = tabs.filter((x) => x.id !== t.id);
                            setTabs(next); saveTabs(next);
                          }}>✕</button>
                </td>
              </tr>
            ))}
            {tabs.length === 0 && (
              <tr><td colSpan={3} style={{ color: "var(--text-secondary)" }}>페이지 없음</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setTabModal("add")} disabled={tabs.length >= 10}>＋ 페이지 추가</button>
        </div>
      </Group>

      <Group title="검색 폴더 트리 (탐색기형 — 변경 즉시 저장)">
        <div style={{
          height: 190, display: "flex", flexDirection: "column", padding: 4,
          border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-canvas)",
        }}>
          <FolderTreeEditor nodes={tree} selectedId={selTreeId}
                            onSelect={(n) => setSelTreeId(n.id)}
                            onChange={(next) => { setTree(next); saveTree(next); }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          각 폴더는 자기 조건만 가지며, 워크리스트에서 폴더 클릭 시 상위 경로 조건이 누적 병합되어 검색됩니다.
        </div>
      </Group>

      {tabModal !== null && (
        <FolderEditModal
          title={tabModal === "add" ? "새 워크리스트 페이지"
               : `페이지 수정 — ${tabs[tabModal.index]?.label ?? ""}`}
          init={tabModal === "add" ? undefined
              : { label: tabs[tabModal.index].label, filter: tabs[tabModal.index].filter }}
          onSave={(label, filter) => {
            let next: WorklistTab[];
            if (tabModal === "add") {
              if (tabs.length >= 10) { alert("워크리스트 페이지는 최대 10개입니다"); return; }
              next = [...tabs, { id: newId(), label, filter }];
            } else {
              next = tabs.map((t, i) => (i === tabModal.index ? { ...t, label, filter } : t));
            }
            setTabs(next); saveTabs(next);
            setTabModal(null);
          }}
          onClose={() => setTabModal(null)}
        />
      )}
    </div>
  );
}
