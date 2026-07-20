// 공용 RIS 오더 입력기 + 오더 목록 (SPEC_MWL_ORDERS 레인 F-A)
// - OrderEntryRis: 5컬럼(PATIENT INFO/REGION/BODY PART/3열/검사 항목) 오더 입력 폼.
//   Hl7Panel(가상 환자 생성기)·Worklist(새 오더 등록 모달)가 공용으로 사용한다.
// - OrderList: 등록된 오더(수정/삭제) + 장비가 MWL 로 가져간 오더(taken_aet 표시) 목록. 5초 폴링.
// 저장 방식(testgen POST / createOrder)은 호출측 onSave 로 주입 — 이 파일은 API 를 오더 조회/수정/삭제에만 사용.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, type OrderRow } from "../api";

// ── 계약 타입 (SPEC 고정 — 이름/필드 변경 금지) ──
export interface RisPatient {
  patient_id: string; accession: string; sex: string; last_name: string; first_name: string;
  physician: string; department: string; modality: string;
  birth_date: string; scheduled_date: string; scheduled_time: string; station_aet: string; dicom_study_id: string;
}
export interface RisExam { region: string; body_part: string; projection: string }

// ── Modality별 카탈로그 — Region/Body Part/3열(촬영법·기법)이 모달리티마다 다르다
// (예: CT는 Skull이 아니라 Brain이고 FACIAL/MANDIBLE 같은 세부 촬영 부위가 없다)
type ModCatalog = {
  third: string;                     // 3열 제목: Projection(일반촬영)/Scan(단면)/View(유방) 등
  regions: string[];
  parts: Record<string, string[]>;
  techniques: string[];              // 3열 선택 항목
};
const CAT_RADIOGRAPHY: ModCatalog = { // CR·DX 일반촬영
  third: "Projection",
  regions: ["Skull", "Chest", "Abdomen", "Pelvis", "Upper Extremity", "Lower Extremity", "Spine"],
  parts: {
    Skull: ["SKULL", "FACIAL", "MANDIBLE", "NASAL", "TMJ"],
    Chest: ["CHEST", "RIB", "STERNUM", "CLAVICLE"],
    Abdomen: ["ABDOMEN", "KUB"],
    Pelvis: ["PELVIS", "HIP", "SI-JOINT"],
    "Upper Extremity": ["SHOULDER", "HUMERUS", "ELBOW", "FOREARM", "WRIST", "HAND"],
    "Lower Extremity": ["FEMUR", "KNEE", "TIBIA", "ANKLE", "FOOT"],
    Spine: ["C-SPINE", "T-SPINE", "L-SPINE", "SACRUM", "COCCYX"],
  },
  techniques: ["PA", "AP", "Lateral", "Oblique", "Axial", "Lordotic", "Towne", "Waters", "Caldwell", "Tangential"],
};
const CAT_CT: ModCatalog = {
  third: "Scan",
  regions: ["Brain", "Neck", "Chest", "Abdomen", "Pelvis", "Spine", "Extremity", "Angio(CTA)"],
  parts: {
    Brain: ["BRAIN", "PNS", "ORBIT", "TEMPORAL BONE"],
    Neck: ["NECK"],
    Chest: ["CHEST", "LOW-DOSE CHEST"],
    Abdomen: ["ABDOMEN", "ABDOMEN+PELVIS", "LIVER", "UROGRAPHY"],
    Pelvis: ["PELVIS"],
    Spine: ["C-SPINE", "T-SPINE", "L-SPINE", "WHOLE SPINE"],
    Extremity: ["SHOULDER", "ELBOW", "WRIST", "HIP", "KNEE", "ANKLE"],
    "Angio(CTA)": ["BRAIN CTA", "NECK CTA", "CORONARY CTA", "AORTA CTA", "PULMONARY CTA", "LOWER EXT CTA"],
  },
  techniques: ["Non-Contrast (Pre)", "Contrast (Post)", "Pre + Post", "Dynamic", "HRCT", "3D Recon"],
};
const CAT_MR: ModCatalog = {
  third: "Scan",
  regions: ["Brain", "Neck", "Spine", "Joint", "Abdomen", "Pelvis", "Angio(MRA)"],
  parts: {
    Brain: ["BRAIN", "PITUITARY", "ORBIT", "IAC"],
    Neck: ["NECK", "THYROID"],
    Spine: ["C-SPINE", "T-SPINE", "L-SPINE", "WHOLE SPINE"],
    Joint: ["SHOULDER", "ELBOW", "WRIST", "HIP", "KNEE", "ANKLE"],
    Abdomen: ["LIVER", "MRCP", "KIDNEY"],
    Pelvis: ["PELVIS", "PROSTATE", "UTERUS"],
    "Angio(MRA)": ["BRAIN MRA", "NECK MRA"],
  },
  techniques: ["Non-Contrast", "Contrast (Gd)", "Pre + Post", "Diffusion (DWI)", "Perfusion"],
};
const CAT_US: ModCatalog = {
  third: "Technique",
  regions: ["Abdomen", "Pelvis", "Thyroid/Neck", "Breast", "MSK", "Vascular", "OB"],
  parts: {
    Abdomen: ["ABDOMEN", "LIVER", "GALLBLADDER", "KIDNEY", "APPENDIX"],
    Pelvis: ["PELVIS", "PROSTATE", "GYN"],
    "Thyroid/Neck": ["THYROID", "NECK", "SALIVARY GLAND"],
    Breast: ["BREAST (BOTH)", "BREAST (RT)", "BREAST (LT)"],
    MSK: ["SHOULDER", "KNEE", "ANKLE", "SOFT TISSUE"],
    Vascular: ["CAROTID DOPPLER", "LOWER EXT VEIN (DVT)", "RENAL DOPPLER"],
    OB: ["OB (FETAL)", "NT"],
  },
  techniques: ["B-Mode (Routine)", "Doppler", "Elastography"],
};
const CAT_MG: ModCatalog = {
  third: "View",
  regions: ["Breast"],
  parts: { Breast: ["BREAST (BOTH)", "BREAST (RT)", "BREAST (LT)"] },
  techniques: ["CC", "MLO", "ML", "LM", "Spot Compression", "Magnification"],
};
const CAT_XA: ModCatalog = {
  third: "Projection",
  regions: ["Head/Neck", "Coronary", "Aorta", "Peripheral"],
  parts: {
    "Head/Neck": ["CEREBRAL ANGIO", "CAROTID ANGIO"],
    Coronary: ["CORONARY ANGIO (CAG)"],
    Aorta: ["AORTOGRAPHY"],
    Peripheral: ["UPPER EXT ANGIO", "LOWER EXT ANGIO"],
  },
  techniques: ["AP", "Lateral", "LAO", "RAO", "Cranial", "Caudal"],
};
const CAT_NM: ModCatalog = {
  third: "Phase",
  regions: ["Whole Body", "Bone", "Thyroid", "Renal", "Cardiac", "Lung"],
  parts: {
    "Whole Body": ["WHOLE BODY"],
    Bone: ["BONE SCAN", "BONE SPECT"],
    Thyroid: ["THYROID SCAN"],
    Renal: ["RENAL SCAN (DTPA)", "RENAL SCAN (DMSA)"],
    Cardiac: ["MYOCARDIAL SPECT"],
    Lung: ["LUNG PERFUSION"],
  },
  techniques: ["Planar", "Dynamic", "SPECT", "Whole Body Sweep"],
};
const CAT_RF: ModCatalog = {
  third: "Projection",
  regions: ["GI", "GU", "Others"],
  parts: {
    GI: ["ESOPHAGOGRAPHY", "UGI", "SMALL BOWEL SERIES", "BARIUM ENEMA"],
    GU: ["IVP (UROGRAPHY)", "VCUG", "RGP"],
    Others: ["FISTULOGRAPHY", "T-TUBE CHOLANGIO", "HSG"],
  },
  techniques: ["AP", "Lateral", "Oblique", "Spot"],
};
export const CATALOGS: Record<string, ModCatalog> = {
  CR: CAT_RADIOGRAPHY, DX: CAT_RADIOGRAPHY, CT: CAT_CT, MR: CAT_MR,
  US: CAT_US, MG: CAT_MG, XA: CAT_XA, NM: CAT_NM, RF: CAT_RF,
};
const catalogFor = (mod: string): ModCatalog => CATALOGS[mod] ?? CAT_RADIOGRAPHY;
const MODALITIES = ["CR", "CT", "DX", "MR", "US", "MG", "XA", "NM", "RF"];

// ── 파일 로컬 소형 UI (Hl7Panel 스타일과 동일 — 페이지 의존 금지라 로컬 정의) ──
const inp: React.CSSProperties = {
  background: "var(--bg-canvas)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 4, padding: "5px 8px", fontSize: 12.5, minWidth: 0,
};
function Msg({ text }: { text: string }) {
  if (!text) return null;
  return <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: text.startsWith("⚠") ? "var(--danger,#f87171)" : "var(--accent,#7dd3fc)" }}>{text}</div>;
}
function errMsg(e: unknown): string {
  return "⚠ " + ((e as Error).message ?? String(e));
}

// 컬럼 헤더 + 본문 (RIS 5컬럼 공통)
function Col({ title, children, flex }: { title: React.ReactNode; children: React.ReactNode; flex?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 130, flex: flex ?? 1 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--text-secondary)", textTransform: "uppercase", borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// 선택 목록 버튼 (Region / Body Part / Projection)
function PickBtn({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      textAlign: "left", fontSize: 12, padding: "4px 8px", borderRadius: 4, cursor: "pointer",
      border: `1px solid ${selected ? "var(--accent,#7dd3fc)" : "var(--border)"}`,
      background: selected ? "color-mix(in srgb, var(--accent,#7dd3fc) 18%, transparent)" : "var(--bg-canvas)",
      color: selected ? "var(--accent,#7dd3fc)" : "var(--text-primary)", fontWeight: selected ? 700 : 400,
    }}>{label}</button>
  );
}

// PATIENT INFO 필드 (라벨 위·입력 아래 — RIS 폼 스타일)
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11.5, color: "var(--text-secondary)" }}>
      <span>{label}{required && <span style={{ color: "var(--danger,#f87171)" }}> *</span>}</span>
      {children}
    </label>
  );
}

// Generate 링크 (genPid/genAcc 주입 시에만 노출)
function GenLink({ onGen }: { onGen?: () => void }) {
  if (!onGen) return null;
  return (
    <a href="#" style={{ fontSize: 11, color: "var(--accent,#7dd3fc)", whiteSpace: "nowrap" }}
       onClick={(e) => { e.preventDefault(); onGen(); }}>Generate</a>
  );
}

const todayYmd = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
const emptyPatient = (modality: string): RisPatient => ({
  patient_id: "", accession: "", sex: "", last_name: "", first_name: "",
  physician: "", department: "", modality,
  birth_date: "", scheduled_date: todayYmd(), scheduled_time: "", station_aet: "", dicom_study_id: "",
});

// ════════════════════════════ 공용 RIS 오더 입력기 ════════════════════════════
/** RIS 오더 입력 5컬럼 폼 — 저장 로직은 onSave 로 주입(resolve 문자열 = 성공 메시지). */
export function OrderEntryRis(props: {
  onSave: (patient: RisPatient, exams: RisExam[]) => Promise<string>; // resolve = 성공 메시지 문자열
  genPid?: () => string;  // Patient ID Generate 링크 (없으면 링크 숨김)
  genAcc?: () => string;  // Accession Generate
  initialModality?: string;
}) {
  const initMod = props.initialModality ?? "CR";
  const [pt, setPt] = useState<RisPatient>(() => emptyPatient(initMod));
  const [region, setRegion] = useState("");
  const [bodyPart, setBodyPart] = useState("");
  const [projection, setProjection] = useState("");
  const [exams, setExams] = useState<RisExam[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // Modality 변경 → 카탈로그 전환 (선택·검사 항목 초기화: 이전 Modality 부위는 무효)
  const cat = catalogFor(pt.modality);
  const changeModality = (m: string) => {
    setPt((p) => ({ ...p, modality: m }));
    setRegion(""); setBodyPart(""); setProjection("");
    setExams((xs) => {
      if (xs.length > 0) setMsg(`Modality 변경(${m}) — 부위 목록이 바뀌어 검사 항목을 초기화했습니다`);
      return [];
    });
  };

  const addExam = () => {
    if (!region || !bodyPart || !projection) { setMsg(`⚠ Region → Body Part → ${cat.third} 을 먼저 선택하세요`); return; }
    if (exams.some((e) => e.body_part === bodyPart && e.projection === projection)) {
      setMsg("⚠ 이미 추가된 검사 항목입니다"); return;
    }
    setExams((xs) => [...xs, { region, body_part: bodyPart, projection }]);
    setMsg("");
  };
  const clearAll = () => {
    setPt(emptyPatient(initMod)); setRegion(""); setBodyPart(""); setProjection(""); setExams([]);
  };
  const save = async () => {
    if (!pt.last_name.trim()) { setMsg("⚠ Last Name 은 필수입니다"); return; }
    if (exams.length === 0) { setMsg("⚠ 검사 항목을 1건 이상 추가하세요 ([+ Add])"); return; }
    setBusy(true);
    try {
      // 문자열 필드 공백 정리 후 전달 (기존 생성기 동작과 동일)
      const cleaned: RisPatient = {
        ...pt,
        patient_id: pt.patient_id.trim(), accession: pt.accession.trim(),
        last_name: pt.last_name.trim(), first_name: pt.first_name.trim(),
        physician: pt.physician.trim(), department: pt.department.trim(),
        birth_date: pt.birth_date.trim(), scheduled_date: pt.scheduled_date.trim(),
        scheduled_time: pt.scheduled_time.trim(), station_aet: pt.station_aet.trim(),
        dicom_study_id: pt.dicom_study_id.trim(),
      };
      const done = await props.onSave(cleaned, exams);
      setMsg(done);
      clearAll();
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };

  // Study ID 자동 채번 — Worklist 오더 모달과 동일 규칙(S+시각 끝 6자리)
  const genSid = () => setPt((p) => ({ ...p, dicom_study_id: `S${Date.now().toString().slice(-6)}` }));

  const bodyParts = region ? (cat.parts[region] ?? []) : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 14, minWidth: 900, alignItems: "stretch" }}>
        {/* ① PATIENT INFO */}
        <Col title="Patient Info" flex={1.5}>
          <Field label="Patient ID">
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input style={{ ...inp, flex: 1 }} value={pt.patient_id} onChange={(e) => setPt({ ...pt, patient_id: e.target.value })} />
              <GenLink onGen={props.genPid && (() => setPt((p) => ({ ...p, patient_id: props.genPid!() })))} />
            </span>
          </Field>
          <Field label="Accession No.">
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input style={{ ...inp, flex: 1 }} value={pt.accession} onChange={(e) => setPt({ ...pt, accession: e.target.value })} />
              <GenLink onGen={props.genAcc && (() => setPt((p) => ({ ...p, accession: props.genAcc!() })))} />
            </span>
          </Field>
          <Field label="Sex">
            <select style={inp} value={pt.sex} onChange={(e) => setPt({ ...pt, sex: e.target.value })}>
              <option value="">--</option><option value="M">M</option><option value="F">F</option><option value="O">O</option>
            </select>
          </Field>
          <Field label="Last Name" required>
            <input style={inp} value={pt.last_name} onChange={(e) => setPt({ ...pt, last_name: e.target.value })} />
          </Field>
          <Field label="First Name">
            <input style={inp} value={pt.first_name} onChange={(e) => setPt({ ...pt, first_name: e.target.value })} />
          </Field>
          <Field label="Birth date">
            <input style={inp} value={pt.birth_date} maxLength={8} placeholder="YYYYMMDD"
                   onChange={(e) => setPt({ ...pt, birth_date: e.target.value })} />
          </Field>
          <Field label="Physician">
            <input style={inp} value={pt.physician} onChange={(e) => setPt({ ...pt, physician: e.target.value })} />
          </Field>
          <Field label="Department">
            <input style={inp} value={pt.department} onChange={(e) => setPt({ ...pt, department: e.target.value })} />
          </Field>
          <Field label="Modality">
            <select style={inp} value={pt.modality} onChange={(e) => changeModality(e.target.value)}>
              {MODALITIES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="예약일">
            <input style={inp} value={pt.scheduled_date} maxLength={8} placeholder="YYYYMMDD"
                   onChange={(e) => setPt({ ...pt, scheduled_date: e.target.value })} />
          </Field>
          <Field label="예약시각">
            <input style={inp} value={pt.scheduled_time} maxLength={6} placeholder="HHMM"
                   onChange={(e) => setPt({ ...pt, scheduled_time: e.target.value })} />
          </Field>
          <Field label="장비 AET">
            <input style={inp} value={pt.station_aet} placeholder="CR01 (빈칸=ANY)"
                   onChange={(e) => setPt({ ...pt, station_aet: e.target.value })} />
          </Field>
          <Field label="Study ID">
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input style={{ ...inp, flex: 1 }} value={pt.dicom_study_id}
                     onChange={(e) => setPt({ ...pt, dicom_study_id: e.target.value })} />
              <button title="번호 자동 생성" onClick={genSid} style={{ padding: "1px 7px" }}>자동</button>
            </span>
          </Field>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button className="primary" onClick={save} disabled={busy} style={{ flex: 1 }}>{busy ? "저장 중…" : "Save"}</button>
            <button onClick={clearAll} style={{ flex: 1 }}>Clear</button>
          </div>
        </Col>

        {/* ② REGION — Modality별 카탈로그 */}
        <Col title={`Region (${pt.modality})`}>
          {cat.regions.map((rg) => (
            <PickBtn key={rg} label={rg} selected={region === rg}
                     onClick={() => { setRegion(rg); setBodyPart(""); }} />
          ))}
        </Col>

        {/* ③ BODY PART */}
        <Col title="Body Part">
          {!region && <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>Region을 선택하세요</div>}
          {bodyParts.map((bp) => (
            <PickBtn key={bp} label={bp} selected={bodyPart === bp} onClick={() => setBodyPart(bp)} />
          ))}
        </Col>

        {/* ④ PROJECTION/SCAN/VIEW — Modality별 3열 */}
        <Col title={cat.third}>
          {cat.techniques.map((pj) => (
            <PickBtn key={pj} label={pj} selected={projection === pj} onClick={() => setProjection(pj)} />
          ))}
          <button onClick={addExam} style={{ marginTop: 4, fontWeight: 700 }}>+ Add</button>
        </Col>

        {/* ⑤ 검사 항목 */}
        <Col title={`검사 항목 (${exams.length})`} flex={1.4}>
          {exams.length === 0 && (
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              추가된 검사 항목이 없습니다.<br />Region → Body Part → {cat.third} 선택 후 [+ Add] 하세요.
            </div>
          )}
          {exams.map((x, i) => (
            <div key={`${x.body_part}-${x.projection}-${i}`}
                 style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-canvas)" }}>
              <span style={{ flex: 1 }}>{x.body_part} · {x.projection} · {pt.modality || "—"}</span>
              <button onClick={() => setExams((xs) => xs.filter((_, j) => j !== i))}
                      title="삭제" style={{ padding: "0 6px" }}>✕</button>
            </div>
          ))}
        </Col>
      </div>
      <Msg text={msg} />
    </div>
  );
}

// ════════════════════════════ 오더 목록 (등록된 오더 / 장비가 가져간 오더) ════════════════════════════

// 인라인 편집 가능 필드 (SPEC: PUT /api/orders/{id} scheduled 상태만 허용)
type EditForm = {
  patient_name: string; modality: string; body_part: string; projection: string;
  scheduled_date: string; scheduled_time: string; station_aet: string;
  physician: string; department: string; procedure_desc: string;
};
const toEditForm = (o: OrderRow): EditForm => ({
  patient_name: o.patient_name ?? "", modality: o.modality ?? "CR",
  body_part: o.body_part ?? "", projection: o.projection ?? "",
  scheduled_date: o.scheduled_date ?? "", scheduled_time: o.scheduled_time ?? "",
  station_aet: o.station_aet ?? "", physician: o.physician ?? "",
  department: o.department ?? "", procedure_desc: o.procedure_desc ?? "",
});

const fmtTakenAt = (t: string | null | undefined) => (t ? t.replace("T", " ").slice(0, 19) : "—");

// 편집 폼 소형 필드
function EField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-secondary)" }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** 오더 목록 — MWL 테스트 뷰. 5초 폴링으로 '장비 가져감'을 실시간 감지한다. */
export function OrderList(props: {
  hospitalId?: number;   // 병원 스코프. 미지정=전체
  pollMs?: number;       // 기본 5000 (가져감 실시간 감지)
  refreshKey?: number;   // 외부 강제 새로고침 (저장 직후 증가시켜 전달)
}) {
  const pollMs = props.pollMs ?? 5000;
  const [items, setItems] = useState<OrderRow[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [ef, setEf] = useState<EditForm | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // 폴링 콜백에서 최신 편집 상태 참조용 (stale closure 방지)
  const editIdRef = useRef<number | null>(null);
  editIdRef.current = editId;

  const load = useCallback(async () => {
    const params: Record<string, string> = {};
    if (props.hospitalId != null && props.hospitalId > 0) params.hospital_id = String(props.hospitalId);
    const r = await api.orders(params);
    setItems((prev) => {
      const next = r.items;
      const eid = editIdRef.current;
      if (eid == null) return next;
      // 인라인 편집 중인 행은 갱신 보류 — 폴링이 편집 대상 행을 바꾸거나 없애지 않게 유지
      const held = prev.find((o) => o.id === eid);
      if (!held) return next;
      const idx = next.findIndex((o) => o.id === eid);
      if (idx >= 0) { const copy = [...next]; copy[idx] = held; return copy; }
      return [held, ...next];
    });
  }, [props.hospitalId]);

  // 5초 폴링 — 마운트 중에만, 언마운트 시 interval 해제(누수 방지)
  useEffect(() => {
    let alive = true;
    const tick = () => {
      load().then(() => { if (alive) setMsg((m) => (m.startsWith("⚠ 목록") ? "" : m)); })
        .catch((e) => { if (alive) setMsg("⚠ 목록 조회 실패: " + ((e as Error).message ?? String(e))); });
    };
    tick();
    const t = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [load, pollMs, props.refreshKey]);

  const startEdit = (o: OrderRow) => { setEditId(o.id); setEf(toEditForm(o)); setMsg(""); };
  const cancelEdit = () => { setEditId(null); setEf(null); };
  const saveEdit = async () => {
    if (editId == null || !ef) return;
    setBusy(true);
    try {
      await api.updateOrder(editId, ef);
      setEditId(null); setEf(null);
      setMsg("오더 수정 완료");
      await load();
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const del = async (o: OrderRow) => {
    if (!window.confirm(`오더 #${o.id} (${o.accession_no || "—"} · ${o.patient_name || "—"}) 를 삭제할까요?`)) return;
    setBusy(true);
    try {
      await api.deleteOrder(o.id);
      if (editId === o.id) { setEditId(null); setEf(null); }
      setMsg(`오더 #${o.id} 삭제됨`);
      await load();
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };

  const setE = (k: keyof EditForm, v: string) => setEf((p) => (p ? { ...p, [k]: v } : p));

  // 두 섹션 분류 — 그 외(completed/cancelled/in_progress & 미가져감)는 표시 생략(MWL 테스트 뷰)
  const registered = items.filter((o) => o.status === "scheduled" && !o.taken_aet);
  const taken = items.filter((o) => Boolean(o.taken_aet));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 340 }}>
      {/* ── 등록된 오더 (scheduled & 미가져감): 인라인 수정·삭제 ── */}
      <div style={{ fontWeight: 600, fontSize: 12.5 }}>📋 등록된 오더 ({registered.length})</div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12, width: "100%" }}>
          <thead><tr><th>Accession</th><th>환자</th><th>설명</th><th>Mod</th><th>예약일</th><th style={{ width: 52 }} /></tr></thead>
          <tbody>
            {registered.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--text-secondary)" }}>등록된 오더 없음 — 좌측에서 오더를 생성하세요</td></tr>
            )}
            {registered.map((o) => (
              <Fragment key={o.id}>
                <tr>
                  <td>{o.accession_no || "—"}</td>
                  <td>{o.patient_name || "—"}</td>
                  <td title={o.procedure_desc}>{(o.procedure_desc || "—").slice(0, 28)}</td>
                  <td>{o.modality}</td>
                  <td>{o.scheduled_date || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button title="수정" disabled={busy} onClick={() => (editId === o.id ? cancelEdit() : startEdit(o))} style={{ padding: "0 6px" }}>✎</button>{" "}
                    <button title="삭제" disabled={busy} onClick={() => del(o)} style={{ padding: "0 6px" }}>✕</button>
                  </td>
                </tr>
                {editId === o.id && ef && (
                  <tr>
                    <td colSpan={6} style={{ background: "var(--bg-canvas)", padding: 8 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                        <EField label="환자명 (Last^First)">
                          <input style={inp} value={ef.patient_name} onChange={(e) => setE("patient_name", e.target.value)} />
                        </EField>
                        <EField label="Modality">
                          <select style={inp} value={ef.modality} onChange={(e) => setE("modality", e.target.value)}>
                            {MODALITIES.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </EField>
                        <EField label="Body Part">
                          <input style={inp} value={ef.body_part} onChange={(e) => setE("body_part", e.target.value)} />
                        </EField>
                        <EField label="Projection">
                          <input style={inp} value={ef.projection} onChange={(e) => setE("projection", e.target.value)} />
                        </EField>
                        <EField label="예약일 (YYYYMMDD)">
                          <input style={inp} maxLength={8} value={ef.scheduled_date} onChange={(e) => setE("scheduled_date", e.target.value)} />
                        </EField>
                        <EField label="예약시각 (HHMM)">
                          <input style={inp} maxLength={6} value={ef.scheduled_time} onChange={(e) => setE("scheduled_time", e.target.value)} />
                        </EField>
                        <EField label="장비 AET">
                          <input style={inp} value={ef.station_aet} onChange={(e) => setE("station_aet", e.target.value)} />
                        </EField>
                        <EField label="Physician">
                          <input style={inp} value={ef.physician} onChange={(e) => setE("physician", e.target.value)} />
                        </EField>
                        <EField label="Department">
                          <input style={inp} value={ef.department} onChange={(e) => setE("department", e.target.value)} />
                        </EField>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "flex-end" }}>
                        <EField label="Description">
                          <input style={{ ...inp, width: 260 }} value={ef.procedure_desc} onChange={(e) => setE("procedure_desc", e.target.value)} />
                        </EField>
                        <div style={{ flex: 1 }} />
                        <button className="primary" disabled={busy} onClick={saveEdit}>저장</button>
                        <button disabled={busy} onClick={cancelEdit}>취소</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 장비가 가져간 오더 (taken_aet 관찰 기록) ── */}
      <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 4 }}>🏷 장비가 가져간 오더 ({taken.length})</div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>장비가 MWL 로 조회해 간 오더 — 등록 목록에서 자동 분리됩니다</div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid-table" style={{ fontSize: 12, width: "100%" }}>
          <thead><tr><th>장비(AET)</th><th>가져간 시각</th><th>Accession</th><th>환자</th><th>설명</th><th style={{ width: 30 }} /></tr></thead>
          <tbody style={{ opacity: 0.62 }}>
            {taken.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--text-secondary)" }}>아직 장비가 가져간 오더 없음</td></tr>
            )}
            {taken.map((o) => (
              <tr key={o.id}>
                <td style={{ whiteSpace: "nowrap" }}>🏷 {o.taken_aet}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtTakenAt(o.taken_at)}</td>
                <td>{o.accession_no || "—"}</td>
                <td>{o.patient_name || "—"}</td>
                <td title={o.procedure_desc}>{(o.procedure_desc || "—").slice(0, 28)}</td>
                <td>
                  <button title="삭제" disabled={busy} onClick={() => del(o)} style={{ padding: "0 6px" }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Msg text={msg} />
    </div>
  );
}

export default OrderEntryRis;
