// Compare 후보 고르기 — 뷰어 3종(SaintView·T-View·I-View)이 **한 벌만** 쓴다.
//
// 예전에는 각 뷰어가 detail.related_exams(같은 환자 과거검사)를 그대로 나열했다.
// 이제 기준이 두 가지다:
//   · 환자 기준(기본) — 이 환자의 과거 검사
//   · 판독의사 기준   — 내가 판독했던 과거 검사(환자가 달라도 된다)
// 그리고 Modality·Bodypart 로 좁히고 기간을 고른다.
//
// 기본값은 설정 > 판독 > 기본설정 > Compare 에서 온다. 여기서 바꾼 것은 **저장하지 않는다** —
// 설정은 '늘 이렇게 시작한다'는 뜻이고, 이 자리의 변경은 지금 이 판독 한 번에 대한 것이다.
//
// ⚠ 판독의사 기준은 다른 환자가 섞인다. 그래서 후보 줄에 **환자명을 반드시 함께** 찍는다 —
//   같은 환자로 오인한 채 비교하면 판독 사고가 된다.
import { useEffect, useState } from "react";
import { api, type RelatedExam } from "../api";
import {
  BASIS_LABEL, DEFAULT_COMPARE, PERIODS, PERIOD_LABEL, compareQuery, compareSummary,
  readCompareCfg, type CompareBasisKind, type CompareCfg, type ComparePeriod,
} from "../lib/compareBasis";

/** 설정에 저장된 기본 기준을 읽는다(뷰어 마운트 시 1회). */
export function useCompareDefault(): CompareCfg {
  const [cfg, setCfg] = useState<CompareCfg>(DEFAULT_COMPARE);
  useEffect(() => {
    api.getSetting("report.prefs")
      .then((r) => setCfg(readCompareCfg((r.value as { compare?: unknown }).compare)))
      .catch(() => { /* 설정을 못 읽어도 기본(환자 기준)으로 동작한다 */ });
  }, []);
  return cfg;
}

export function ComparePicker({ studyId, modality, bodyPart, patientKey, initial, selected, onToggle }: {
  studyId: number;
  modality?: string;
  bodyPart?: string;
  /** 현재 검사의 환자 — 후보가 다른 환자인지 표시하는 데 쓴다 */
  patientKey?: string;
  initial: CompareCfg;
  selected: Set<number>;
  onToggle: (id: number, on: boolean, row: RelatedExam) => void;
}) {
  const [cfg, setCfg] = useState<CompareCfg>(initial);
  const [rows, setRows] = useState<RelatedExam[] | null>(null);
  const [err, setErr] = useState("");

  // 설정 로드가 늦게 끝나면 기본값이 바뀐다 — 사용자가 아직 안 건드렸을 때만 따라간다
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) setCfg(initial); }, [initial, touched]);

  const q = compareQuery(cfg);
  useEffect(() => {
    let stop = false;
    setRows(null); setErr("");
    api.compareCandidates(studyId, q)
      .then((r) => { if (!stop) setRows(r.items); })
      .catch((e) => { if (!stop) setErr(e instanceof Error ? e.message : "후보 조회 실패"); });
    return () => { stop = true; };
  }, [studyId, q]);

  const set = (patch: Partial<CompareCfg>) => { setTouched(true); setCfg((c) => ({ ...c, ...patch })); };

  return (
    <>
      {/* 기준 — 라디오 2개 */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        {(["patient", "reader"] as CompareBasisKind[]).map((k) => (
          <label key={k} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
            <input type="radio" name="cmp-basis-live" checked={cfg.basis === k}
                   onChange={() => set({ basis: k })} />
            {BASIS_LABEL[k]}
          </label>
        ))}
      </div>

      {/* 좁히기 + 기간 */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap",
                    fontSize: 12, paddingBottom: 8, marginBottom: 8,
                    borderBottom: "1px solid var(--border)" }}>
        <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" checked={cfg.by_modality}
                 onChange={(e) => set({ by_modality: e.target.checked })} />
          Modality{modality ? ` (${modality})` : ""}
        </label>
        <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" checked={cfg.by_body_part}
                 onChange={(e) => set({ by_body_part: e.target.checked })} />
          Bodypart{bodyPart ? ` (${bodyPart})` : ""}
        </label>
        <select value={cfg.period} onChange={(e) => set({ period: e.target.value as ComparePeriod })}>
          {PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
        </select>
        <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 11 }}>
          {compareSummary(cfg, modality, bodyPart)}
        </span>
      </div>

      {err && <div style={{ fontSize: 12, color: "var(--danger, #f87171)", padding: 8 }}>{err}</div>}
      {!err && rows === null && (
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", padding: 8 }}>불러오는 중…</div>
      )}
      {!err && rows?.length === 0 && (
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", padding: 8, lineHeight: 1.7 }}>
          조건에 맞는 검사가 없습니다.
          {cfg.basis === "reader" && <><br />판독의사 기준은 <b>내가 판독한 검사</b>만 모집단입니다.</>}
          {(cfg.by_modality || cfg.by_body_part) && <><br />좁히기를 해제하거나 기간을 넓혀 보세요.</>}
        </div>
      )}
      {rows?.map((re) => {
        const other = !!re.patient_key && !!patientKey && re.patient_key !== patientKey;
        return (
          <label key={re.id}
                 style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 6px",
                          borderRadius: 4, fontSize: 12.5, cursor: "pointer",
                          background: selected.has(re.id) ? "var(--bg-elevated)" : undefined }}>
            <input type="checkbox" checked={selected.has(re.id)}
                   onChange={(e) => onToggle(re.id, e.target.checked, re)} />
            <span style={{ width: 78 }}>{re.study_date}</span>
            <span style={{ width: 36 }}>{re.modality}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {re.study_desc}
              {re.body_part && <span style={{ color: "var(--text-secondary)" }}> · {re.body_part}</span>}
            </span>
            {/* 다른 환자면 눈에 띄게 — 같은 환자로 착각한 채 비교하면 안 된다 */}
            {re.patient_name && (
              <span style={{ fontSize: 11, fontWeight: other ? 700 : 400,
                             color: other ? "var(--warn, #f59e0b)" : "var(--text-secondary)" }}>
                {other ? "⚠ " : ""}{re.patient_name}
              </span>
            )}
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{re.status}</span>
          </label>
        );
      })}
    </>
  );
}
