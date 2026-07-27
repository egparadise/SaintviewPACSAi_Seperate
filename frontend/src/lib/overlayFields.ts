// 영상 위 4모서리 오버레이 — 무엇을 어느 귀퉁이에 보일지(모달리티별).
//
// 왜 설정으로 빼나: 판독자가 늘 보는 정보는 모달리티마다 다르다. CT 는 슬라이스 두께·W/L 이,
// MG 는 좌우·뷰(RCC/LMLO)와 압박 정보가, CR/DR 은 촬영 부위·자세가 먼저다.
// 하드코딩된 4모서리는 어느 과에는 과하고 어느 과에는 모자란다.
//
// 설계
//  · 필드는 **id 로만** 저장한다(viewer.prefs.overlay_by_modality). 표시 문자열 생성은 여기 resolve.
//  · 값이 없으면 그 줄은 아예 그리지 않는다 — 빈 라벨이 화면을 어지럽히지 않게.
//  · 모달리티 키가 없으면 "*"(공통) → 그것도 없으면 내장 기본값.

export type Corner = "tl" | "tr" | "bl" | "br";
export const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
export const CORNER_LABEL: Record<Corner, string> = {
  tl: "좌상", tr: "우상", bl: "좌하", br: "우하",
};

/** 오버레이에 넣을 수 있는 값들 — DICOM 헤더/검사/시리즈/영상/표시상태에서 뽑는다 */
export interface OverlaySource {
  patient_name?: string; sex?: string; patient_key?: string;
  study_date?: string; study_desc?: string; body_part?: string; modality?: string;
  accession?: string; institution?: string;
  series_number?: number; series_desc?: string; series_modality?: string;
  image_no?: number; image_total?: number;
  rows?: number; cols?: number; pixel_spacing?: number[];
  slice_thickness?: number; slice_location?: number;
  laterality?: string; view_position?: string;
  wl?: string; zoom?: number; fx?: string;
}

export interface FieldDef { id: string; label: string; group: string }

/** 카탈로그 — 설정 화면의 선택지. group 은 묶어 보여 주기용 */
export const OVERLAY_FIELDS: FieldDef[] = [
  { id: "patient_name", label: "환자명", group: "환자" },
  { id: "sex", label: "성별", group: "환자" },
  { id: "patient_key", label: "환자 ID", group: "환자" },
  { id: "study_date", label: "검사일", group: "검사" },
  { id: "study_desc", label: "검사명", group: "검사" },
  { id: "body_part", label: "검사 부위", group: "검사" },
  { id: "modality", label: "모달리티", group: "검사" },
  { id: "accession", label: "Accession No", group: "검사" },
  { id: "institution", label: "기관명", group: "검사" },
  { id: "series", label: "시리즈 (번호·설명)", group: "시리즈" },
  { id: "series_no", label: "시리즈 번호", group: "시리즈" },
  { id: "series_desc", label: "시리즈 설명", group: "시리즈" },
  { id: "image_no", label: "영상 번호 (n/전체)", group: "영상" },
  { id: "matrix", label: "매트릭스 (가로×세로)", group: "영상" },
  { id: "pixel_spacing", label: "픽셀 간격 (mm)", group: "영상" },
  { id: "slice_thickness", label: "슬라이스 두께", group: "영상" },
  { id: "slice_location", label: "슬라이스 위치", group: "영상" },
  { id: "laterality", label: "좌우 (L/R)", group: "영상" },
  { id: "view_position", label: "촬영 자세 (CC/MLO 등)", group: "영상" },
  { id: "wl", label: "W/L (윈도우)", group: "표시" },
  { id: "zoom", label: "확대율 %", group: "표시" },
  { id: "fx", label: "필터", group: "표시" },
];
const FIELD_IDS = new Set(OVERLAY_FIELDS.map((f) => f.id));

export type CornerMap = Record<Corner, string[]>;

/** 내장 기본값 — 지금까지 쓰던 4모서리 구성 그대로(설정을 안 건드리면 화면이 안 바뀐다) */
export const DEFAULT_CORNERS: CornerMap = {
  tl: ["patient_name", "sex", "study_desc", "study_date"],
  tr: ["series", "image_no"],
  bl: ["modality", "patient_key"],
  br: ["zoom", "wl", "fx"],
};
/** 모달리티별 기본 — MG 는 좌우·자세가 판독의 시작점이라 우상단에 올린다 */
export const DEFAULT_BY_MODALITY: Record<string, CornerMap> = {
  MG: {
    tl: ["patient_name", "sex", "study_date"],
    tr: ["laterality", "view_position", "image_no"],
    bl: ["modality", "patient_key"],
    br: ["zoom", "wl"],
  },
  CT: {
    tl: ["patient_name", "sex", "study_desc", "study_date"],
    tr: ["series", "image_no"],
    bl: ["modality", "patient_key", "slice_thickness"],
    br: ["zoom", "wl"],
  },
};

export function normCorners(v: unknown): CornerMap {
  const o = (v ?? {}) as Partial<Record<Corner, unknown>>;
  const pick = (c: Corner) => {
    const a = o[c];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && FIELD_IDS.has(x))
                            : DEFAULT_CORNERS[c];
  };
  return { tl: pick("tl"), tr: pick("tr"), bl: pick("bl"), br: pick("br") };
}

/** 저장된 설정에서 이 모달리티의 구성을 고른다: 모달리티 → "*"(공통) → 내장 기본 */
export function cornersFor(
  cfg: Record<string, unknown> | undefined, modality: string | undefined,
): CornerMap {
  const m = (modality || "").toUpperCase();
  if (cfg && m && cfg[m]) return normCorners(cfg[m]);
  if (cfg && cfg["*"]) return normCorners(cfg["*"]);
  return DEFAULT_BY_MODALITY[m] ?? DEFAULT_CORNERS;
}

const num = (n: unknown, d = 1) =>
  typeof n === "number" && isFinite(n) ? (Math.round(n * 10 ** d) / 10 ** d).toString() : "";

/** 필드 id → 실제 표시 문자열. 값이 없으면 빈 문자열(호출부가 그 줄을 생략) */
export function fieldText(id: string, s: OverlaySource): string {
  switch (id) {
    case "patient_name": return s.patient_name || "";
    case "sex":          return s.sex ? `(${s.sex})` : "";
    case "patient_key":  return s.patient_key || "";
    case "study_date":   return s.study_date || "";
    case "study_desc":   return s.study_desc || "";
    case "body_part":    return s.body_part || "";
    case "modality":     return s.modality || "";
    case "accession":    return s.accession ? `ACC ${s.accession}` : "";
    case "institution":  return s.institution || "";
    case "series":       return s.series_number != null
      ? `S${s.series_number} ${s.series_desc || s.series_modality || ""}`.trim() : (s.series_desc || "");
    case "series_no":    return s.series_number != null ? `S${s.series_number}` : "";
    case "series_desc":  return s.series_desc || "";
    case "image_no":     return s.image_no != null && s.image_total != null
      ? `Img: ${s.image_no}/${s.image_total}` : "";
    case "matrix":       return s.cols && s.rows ? `${s.cols}×${s.rows}` : "";
    case "pixel_spacing": {
      const ps = s.pixel_spacing;
      return ps && ps.length ? `${num(ps[0], 3)} mm` : "";
    }
    case "slice_thickness": return s.slice_thickness ? `${num(s.slice_thickness)} mm` : "";
    case "slice_location":  return s.slice_location != null ? `Z ${num(s.slice_location)}` : "";
    case "laterality":      return s.laterality || "";
    case "view_position":   return s.view_position || "";
    case "wl":              return s.wl ? `W/L: ${s.wl}` : "";
    case "zoom":            return s.zoom != null ? `Z: ${Math.round(s.zoom * 100)}%` : "";
    case "fx":              return s.fx || "";
    default:                return "";
  }
}

/** 한 모서리에 그릴 줄들 — 빈 값은 빼고, 환자명+성별처럼 짧은 것은 한 줄로 붙인다 */
export function cornerLines(ids: string[], s: OverlaySource): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const t = fieldText(ids[i], s);
    if (!t) continue;
    // 성별은 바로 앞 줄(보통 환자명)에 붙여 한 줄로 — "홍길동 (M)"
    if (ids[i] === "sex" && out.length) { out[out.length - 1] += ` ${t}`; continue; }
    out.push(t);
  }
  return out;
}
