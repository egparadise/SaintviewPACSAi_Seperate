// 검색 폴더 트리 + 워크리스트 페이지 탭 (UBPACS-Z Worklist 패턴)
// - 폴더 트리: 탐색기형 계층(예: 응급실 > DR > Chest) — 경로의 조건이 누적 병합되어 검색 적용
// - 페이지 탭: 저장된 검색 정의를 WORKLIST 1 / CR / 응급실 같은 탭으로 등록·전환(최대 10)
// 두 데이터 모두 서버 설정(worklist.tree / worklist.tabs, user scope)으로 로밍 —
// 워크리스트 화면과 Setting 화면이 동일 컴포넌트로 편집한다.
import { useState } from "react";
import { api } from "../api";

/* ── 타입 ── */
export interface FolderFilter {
  modality?: string; body_part?: string; desc?: string;
  pid?: string; pname?: string; sex?: string; status?: string;
  emergency?: boolean;
  date?: "" | "today" | "3d" | "1w" | "1m";
}
export interface TreeNode { id: string; label: string; filter: FolderFilter; children: TreeNode[] }
export interface WorklistTab { id: string; label: string; filter: FolderFilter }

export const DEFAULT_TAB: WorklistTab = { id: "default", label: "WORKLIST 1", filter: {} };

const DATE_LABEL: Record<string, string> = {
  "": "전체", today: "Today", "3d": "최근 3일", "1w": "최근 1주", "1m": "최근 1개월",
};
const DATE_DAYS: Record<string, number> = { today: 0, "3d": 3, "1w": 7, "1m": 30 };
const STATUS_LABEL: Record<string, string> = {
  unread: "미판독", received: "도착", draft_ready: "AI초안", reading: "판독중",
  finalized: "확정", suspended: "보류",
};

export const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ── 조건 변환 ── */
export function dateFromPreset(p?: string): string {
  if (!p || !(p in DATE_DAYS)) return "";
  const d = new Date();
  d.setDate(d.getDate() - DATE_DAYS[p]);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

function stripEmpty(f: FolderFilter): FolderFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v !== "" && v !== undefined && v !== false) out[k] = v;
  }
  return out as FolderFilter;
}

export function findPath(nodes: TreeNode[], id: string, trail: TreeNode[] = []): TreeNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [...trail, n];
    const sub = findPath(n.children ?? [], id, [...trail, n]);
    if (sub) return sub;
  }
  return null;
}

/** 루트→노드 경로의 조건 누적 병합 — 하위 폴더가 동일 키를 덮어쓴다 */
export function mergedFilter(nodes: TreeNode[], id: string): FolderFilter | null {
  const path = findPath(nodes, id);
  if (!path) return null;
  return path.reduce<FolderFilter>((acc, n) => ({ ...acc, ...stripEmpty(n.filter) }), {});
}

/** FolderFilter → 워크리스트 filters(Record) */
export function folderToFilters(f: FolderFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["modality", "body_part", "desc", "pid", "pname", "sex", "status"] as const) {
    if (f[k]) out[k] = f[k]!;
  }
  if (f.emergency) out.emergency = "true";
  if (f.date) out.tree_from = dateFromPreset(f.date);
  return out;
}

/** 워크리스트 filters(Record) → FolderFilter (탭 스냅샷용) */
export function filtersToFolder(filters: Record<string, string>, datePreset: string): FolderFilter {
  const f: FolderFilter = {};
  for (const k of ["modality", "body_part", "desc", "pid", "pname", "sex", "status"] as const) {
    if (filters[k]) f[k] = filters[k];
  }
  if (filters.emergency === "true") f.emergency = true;
  if (datePreset && datePreset in DATE_DAYS) f.date = datePreset as FolderFilter["date"];
  return f;
}

/** 조건 한 줄 요약 — 트리/탭 툴팁·설정 화면 표시 */
export function folderSummary(f: FolderFilter): string {
  const p: string[] = [];
  if (f.date) p.push(DATE_LABEL[f.date]);
  if (f.modality) p.push(f.modality);
  if (f.body_part) p.push(f.body_part);
  if (f.desc) p.push(f.desc);
  if (f.status) p.push(STATUS_LABEL[f.status] ?? f.status);
  if (f.emergency) p.push("⚠응급");
  if (f.pid) p.push(`ID:${f.pid}`);
  if (f.pname) p.push(f.pname);
  if (f.sex) p.push(f.sex);
  return p.join(" · ") || "조건 없음";
}

/* ── 트리 불변 변형 ── */
export function addChild(nodes: TreeNode[], parentId: string | null, node: TreeNode): TreeNode[] {
  if (parentId === null) return [...nodes, node];
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: [...(n.children ?? []), node] }
      : { ...n, children: addChild(n.children ?? [], parentId, node) });
}
export function removeNode(nodes: TreeNode[], id: string): TreeNode[] {
  return nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: removeNode(n.children ?? [], id) }));
}
export function updateNode(nodes: TreeNode[], id: string, patch: Partial<TreeNode>): TreeNode[] {
  return nodes.map((n) =>
    n.id === id ? { ...n, ...patch } : { ...n, children: updateNode(n.children ?? [], id, patch) });
}

/* ── 서버 로드/저장 ── */
export async function loadTree(): Promise<TreeNode[]> {
  try {
    const r = await api.getSetting("worklist.tree");
    return ((r.value as { nodes?: TreeNode[] }).nodes) ?? [];
  } catch { return []; }
}
export async function saveTree(nodes: TreeNode[]) {
  await api.putSetting("worklist.tree", { nodes }, "user");
}
export async function loadTabs(): Promise<WorklistTab[]> {
  try {
    const r = await api.getSetting("worklist.tabs");
    const items = ((r.value as { items?: WorklistTab[] }).items) ?? [];
    return items.length ? items : [DEFAULT_TAB];
  } catch { return [DEFAULT_TAB]; }
}
export async function saveTabs(items: WorklistTab[]) {
  await api.putSetting("worklist.tabs", { items }, "user");
}

/* ── 폴더(=검색 정의) 편집 모달 — Worklist·Settings 공용 ── */
export function FolderEditModal({ title, init, onSave, onClose }: {
  title: string;
  init?: { label: string; filter: FolderFilter };
  onSave: (label: string, filter: FolderFilter) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(init?.label ?? "");
  const [f, setF] = useState<FolderFilter>(init?.filter ?? {});
  const set = (k: keyof FolderFilter, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  const Row = ({ name, children }: { name: string; children: React.ReactNode }) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
      <span style={{ width: 70, color: "var(--text-secondary)", flexShrink: 0 }}>{name}</span>
      {children}
    </label>
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 400 }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
                    width: 560, maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto",
                    padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        <Row name="이름 *">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
                 placeholder="예: 응급실 / DR / Chest" style={{ flex: 1 }} />
        </Row>
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          이 폴더가 더할 조건만 입력 — 상위 폴더 조건과 누적 병합되어 검색됩니다.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Row name="기간">
            <select value={f.date ?? ""} onChange={(e) => set("date", e.target.value)} style={{ flex: 1 }}>
              {Object.entries(DATE_LABEL).map(([k, v]) => <option key={k} value={k}>{k ? v : "(상속)"}</option>)}
            </select>
          </Row>
          <Row name="Modality">
            <select value={f.modality ?? ""} onChange={(e) => set("modality", e.target.value)} style={{ flex: 1 }}>
              <option value="">(상속)</option>
              {["CR", "DX", "CT", "MR", "US", "MG", "XA", "NM", "ES", "RF", "OT"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Row>
          <Row name="부위">
            <input value={f.body_part ?? ""} onChange={(e) => set("body_part", e.target.value)}
                   placeholder="CHEST…" style={{ flex: 1, minWidth: 0 }} />
          </Row>
          <Row name="검사명">
            <input value={f.desc ?? ""} onChange={(e) => set("desc", e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          </Row>
          <Row name="상태">
            <select value={f.status ?? ""} onChange={(e) => set("status", e.target.value)} style={{ flex: 1 }}>
              <option value="">(상속)</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Row>
          <Row name="응급">
            <input type="checkbox" checked={!!f.emergency} onChange={(e) => set("emergency", e.target.checked)} />
          </Row>
          <Row name="환자 ID">
            <input value={f.pid ?? ""} onChange={(e) => set("pid", e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          </Row>
          <Row name="성별">
            <select value={f.sex ?? ""} onChange={(e) => set("sex", e.target.value)} style={{ flex: 1 }}>
              <option value="">(상속)</option><option value="M">M</option>
              <option value="F">F</option><option value="O">O</option>
            </select>
          </Row>
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
          <button className="primary" disabled={!label.trim()}
                  onClick={() => onSave(label.trim(), stripEmpty(f))}>저장</button>
          <button onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}

/* ── 폴더 트리 편집기 — Worklist 좌측 레일·Settings 공용 ──
   onChange가 호출될 때마다 호출부가 saveTree로 영속화한다. */
export function FolderTreeEditor({ nodes, onChange, selectedId, onSelect, applyHint }: {
  nodes: TreeNode[];
  onChange: (next: TreeNode[]) => void;
  selectedId: string | null;
  onSelect: (node: TreeNode) => void;
  applyHint?: boolean;  // 워크리스트: 클릭=검색 적용 힌트 표시
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ mode: "add-root" | "add-child" | "edit" } | null>(null);

  const toggle = (id: string) => setCollapsed((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const renderRows = (list: TreeNode[], depth: number): React.ReactNode => list.map((n) => (
    <div key={n.id}>
      <div onClick={() => onSelect(n)}
           title={`${folderSummary(mergedFilter(nodes, n.id) ?? n.filter)}${applyHint ? " — 클릭=검색 적용" : ""}`}
           style={{
             display: "flex", alignItems: "center", gap: 3, padding: "3px 4px",
             paddingLeft: 4 + depth * 12, borderRadius: 3, cursor: "pointer", fontSize: 12,
             background: selectedId === n.id ? "var(--accent-subtle)" : undefined,
             color: selectedId === n.id ? "var(--text-primary)" : "var(--text-secondary)",
             whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
           }}>
        <span onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
              style={{ width: 11, flexShrink: 0, textAlign: "center" }}>
          {(n.children?.length ?? 0) > 0 ? (collapsed.has(n.id) ? "▸" : "▾") : ""}
        </span>
        <span style={{ flexShrink: 0 }}>📁</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{n.label}</span>
        {/* 선택된 행에 바로 수정/삭제 — 어디서 편집하는지 즉시 보이도록 */}
        {selectedId === n.id && (
          <>
            <span title="이 폴더 이름·조건 수정" style={{ flexShrink: 0, fontSize: 10.5, padding: "0 3px" }}
                  onClick={(e) => { e.stopPropagation(); setModal({ mode: "edit" }); }}>수정</span>
            <span title="이 폴더 삭제(하위 포함)"
                  style={{ flexShrink: 0, fontSize: 11, padding: "0 3px", color: "var(--stat-emergency)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`'${n.label}' 폴더와 하위 폴더를 모두 삭제할까요?`)) {
                      onChange(removeNode(nodes, n.id));
                    }
                  }}>✕</span>
          </>
        )}
      </div>
      {!collapsed.has(n.id) && (n.children?.length ?? 0) > 0 && renderRows(n.children, depth + 1)}
    </div>
  ));

  const selected = selectedId ? findPath(nodes, selectedId)?.at(-1) ?? null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 편집 버튼 바 — 트리 위에 항상 표시(레일이 넘쳐도 잘리지 않음) */}
      <div style={{ display: "flex", gap: 2, padding: "2px 2px 4px", flexWrap: "wrap",
                    borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button title="루트 폴더 추가" style={{ padding: "1px 6px", fontSize: 10.5 }}
                onClick={() => setModal({ mode: "add-root" })}>＋루트</button>
        <button title="선택 폴더 아래에 하위 폴더 추가" style={{ padding: "1px 6px", fontSize: 10.5 }}
                disabled={!selected} onClick={() => setModal({ mode: "add-child" })}>＋하위</button>
        <button title="선택 폴더 이름·조건 수정" style={{ padding: "1px 6px", fontSize: 10.5 }}
                disabled={!selected} onClick={() => setModal({ mode: "edit" })}>수정</button>
        <button title="선택 폴더 삭제(하위 포함)" style={{ padding: "1px 6px", fontSize: 10.5 }}
                disabled={!selected}
                onClick={() => {
                  if (!selected) return;
                  if (!window.confirm(`'${selected.label}' 폴더와 하위 폴더를 모두 삭제할까요?`)) return;
                  onChange(removeNode(nodes, selected.id));
                }}>✕</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {nodes.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-secondary)", padding: "4px 6px" }}>
            ＋루트로 폴더 등록<br />예: 응급실 › DR › Chest
          </div>
        )}
        {renderRows(nodes, 0)}
      </div>
      {modal && (
        <FolderEditModal
          title={modal.mode === "edit" ? `폴더 수정 — ${selected?.label}`
               : modal.mode === "add-child" ? `'${selected?.label}' 아래 새 폴더` : "새 루트 폴더"}
          init={modal.mode === "edit" && selected ? { label: selected.label, filter: selected.filter } : undefined}
          onSave={(label, filter) => {
            if (modal.mode === "edit" && selected) {
              onChange(updateNode(nodes, selected.id, { label, filter }));
            } else {
              const node: TreeNode = { id: newId(), label, filter, children: [] };
              onChange(addChild(nodes, modal.mode === "add-child" ? selected?.id ?? null : null, node));
            }
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
