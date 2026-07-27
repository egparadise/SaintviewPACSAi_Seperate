// 오버레이 배치 편집기 — 어떤 값을 영상의 어느 귀퉁이에 보일지, **모달리티별**로 정한다.
//
// 왜 그래픽인가: "좌상단에 환자명" 같은 목록만 보여 주면 실제 화면에서 어떻게 보이는지 상상해야 한다.
// 여기서는 **실제 배치 그대로의 미리보기 상자**를 두고, 귀퉁이를 클릭해 고른 뒤 값을 넣는다.
// 미리보기에는 예시 값이 그 자리에 그대로 찍히므로 결과를 눈으로 확인하면서 고를 수 있다.
import { useState } from "react";
import {
  CORNERS, CORNER_LABEL, DEFAULT_CORNERS, DEFAULT_BY_MODALITY, OVERLAY_FIELDS,
  cornerLines, cornersFor, type CornerMap, type Corner, type OverlaySource,
} from "../lib/overlayFields";

/** 편집 대상 모달리티 — "*" 는 나머지 전부에 적용되는 공통값 */
const MODS = ["*", "CR", "DR", "MG", "US", "CT", "MR", "XA", "NM", "PT"];
const MOD_LABEL = (m: string) => (m === "*" ? "공통 (그 외 전부)" : m);

/** 미리보기에 쓰는 예시 값 — 실제 판독 화면과 같은 모양으로 보이게 */
const SAMPLE: Record<string, OverlaySource> = {
  MG: { patient_name: "홍길동", sex: "F", patient_key: "12345678", study_date: "20260727",
        study_desc: "유방촬영(양측)", body_part: "BREAST", modality: "MG", accession: "A2026-0731",
        institution: "인비즈영상의학과", series_number: 1, series_desc: "Bilateral 4-view",
        image_no: 1, image_total: 4, rows: 2294, cols: 1914, pixel_spacing: [0.07, 0.07],
        laterality: "R", view_position: "CC", wl: "1200,2200", zoom: 1.04 },
  CT: { patient_name: "홍길동", sex: "M", patient_key: "12345678", study_date: "20260727",
        study_desc: "Abdomen & Pelvis CT", body_part: "ABDOMEN", modality: "CT", accession: "A2026-0731",
        institution: "인비즈영상의학과", series_number: 2, series_desc: "Urography 2.0 Tissue",
        image_no: 130, image_total: 258, rows: 512, cols: 512, pixel_spacing: [0.78, 0.78],
        slice_thickness: 2, slice_location: -142.5, wl: "60,400", zoom: 1 },
};
const sampleFor = (m: string) =>
  SAMPLE[m] ?? { ...SAMPLE.CT, modality: m === "*" ? "CT" : m, series_desc: "Series", body_part: "" };

const posStyle: Record<Corner, React.CSSProperties> = {
  tl: { top: 6, left: 8, textAlign: "left" },
  tr: { top: 6, right: 8, textAlign: "right" },
  bl: { bottom: 6, left: 8, textAlign: "left" },
  br: { bottom: 6, right: 8, textAlign: "right" },
};

export function OverlayLayoutEditor({ cfg, onChange }: {
  cfg: Record<string, CornerMap>;
  onChange: (next: Record<string, CornerMap>) => void;
}) {
  const [mod, setMod] = useState("*");
  const [corner, setCorner] = useState<Corner>("tl");
  const cur: CornerMap = cornersFor(cfg, mod === "*" ? undefined : mod);
  const sample = sampleFor(mod);

  const setCur = (next: CornerMap) => onChange({ ...cfg, [mod]: next });
  const toggle = (id: string) => {
    const has = cur[corner].includes(id);
    // 다른 귀퉁이에 이미 있으면 거기서 빼고 이 귀퉁이로 옮긴다 — 같은 값이 두 곳에 뜨는 혼란 방지
    const cleaned = Object.fromEntries(
      CORNERS.map((c) => [c, cur[c].filter((x) => x !== id)]),
    ) as CornerMap;
    setCur(has ? cleaned : { ...cleaned, [corner]: [...cleaned[corner], id] });
  };
  const whereIs = (id: string): Corner | null =>
    CORNERS.find((c) => cur[c].includes(id)) ?? null;

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      {/* 모달리티 — 값이 따로 지정된 것은 ● 로 표시 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 132 }}>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>모달리티</div>
        {MODS.map((m) => (
          <button key={m} onClick={() => setMod(m)}
                  style={{ textAlign: "left", fontSize: 11.5, padding: "3px 7px",
                           fontWeight: mod === m ? 700 : 400,
                           background: mod === m ? "var(--accent)" : undefined,
                           color: mod === m ? "#fff" : undefined }}>
            {MOD_LABEL(m)} {cfg[m] ? "●" : ""}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minWidth: 380 }}>
        {/* 미리보기 — 귀퉁이를 클릭해 고른다. 값은 예시로 실제 위치에 찍힌다 */}
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
          미리보기 — 귀퉁이를 클릭해 고른 뒤, 아래에서 값을 넣거나 뺍니다
          (다른 귀퉁이에 있던 값은 자동으로 옮겨집니다)
        </div>
        <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9",
                      background: "linear-gradient(135deg,#1b1b1b 0%,#3a3a3a 45%,#141414 100%)",
                      border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
          {/* 영상이 있는 것처럼 보이게 하는 흐린 타원 — 글자 대비 확인용 */}
          <div style={{ position: "absolute", left: "28%", top: "12%", width: "44%", height: "76%",
                        borderRadius: "50%", background: "radial-gradient(#8a8a8a,#2a2a2a 70%)",
                        opacity: 0.55 }} />
          {CORNERS.map((c) => {
            const lines = cornerLines(cur[c], sample);
            const on = corner === c;
            return (
              <div key={c} onClick={() => setCorner(c)} title={`${CORNER_LABEL[c]} 선택`}
                   style={{ position: "absolute", ...posStyle[c], cursor: "pointer",
                            padding: "3px 6px", borderRadius: 4, minWidth: 66, minHeight: 20,
                            border: on ? "1px dashed var(--accent)" : "1px dashed transparent",
                            background: on ? "rgba(59,130,246,0.16)" : undefined,
                            fontSize: 10.5, lineHeight: 1.45, color: "#fff",
                            textShadow: "0 0 3px #000", whiteSpace: "pre" }}>
                {lines.length ? lines.join("\n")
                  : <span style={{ opacity: 0.5 }}>({CORNER_LABEL[c]} 비어 있음)</span>}
              </div>
            );
          })}
        </div>

        {/* 값 선택 — 현재 귀퉁이에 있는 것은 강조, 다른 귀퉁이에 있는 것은 그 위치를 표시 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "9px 0 5px" }}>
          <b style={{ fontSize: 12 }}>선택한 귀퉁이: {CORNER_LABEL[corner]}</b>
          <button style={{ fontSize: 11 }} onClick={() => setCur({ ...cur, [corner]: [] })}>
            이 귀퉁이 비우기
          </button>
          <button style={{ fontSize: 11 }}
                  onClick={() => { const n = { ...cfg }; delete n[mod]; onChange(n); }}>
            기본값으로
          </button>
        </div>
        {Array.from(new Set(OVERLAY_FIELDS.map((f) => f.group))).map((g) => (
          <div key={g} style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center",
                                marginBottom: 4 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-secondary)", width: 42 }}>{g}</span>
            {OVERLAY_FIELDS.filter((f) => f.group === g).map((f) => {
              const at = whereIs(f.id);
              const here = at === corner;
              return (
                <button key={f.id} onClick={() => toggle(f.id)}
                        title={at ? `${CORNER_LABEL[at]}에 있음 — 클릭하면 ${here ? "제거" : `${CORNER_LABEL[corner]}로 이동`}`
                                  : `${CORNER_LABEL[corner]}에 추가`}
                        style={{ fontSize: 11, padding: "2px 7px", borderRadius: 10,
                                 background: here ? "var(--accent)" : undefined,
                                 color: here ? "#fff" : at ? "var(--text-secondary)" : undefined,
                                 opacity: at && !here ? 0.7 : 1 }}>
                  {f.label}{at && !here ? ` · ${CORNER_LABEL[at]}` : ""}
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.7 }}>
          값이 없는 항목은 화면에 아예 그리지 않습니다(빈 줄이 생기지 않음).
          <b> 모달리티에 따로 지정하지 않으면 공통 설정</b>을, 공통도 없으면 내장 기본값을 씁니다.
          {mod !== "*" && !cfg[mod] && DEFAULT_BY_MODALITY[mod] && (
            <> 지금 {mod} 는 <b>{mod} 전용 내장 기본값</b>을 쓰는 중입니다.</>
          )}
          {mod === "*" && !cfg["*"] && (
            <> 지금은 내장 기본값({DEFAULT_CORNERS.tl.length}개 항목 등)을 쓰는 중입니다.</>
          )}
        </div>
      </div>
    </div>
  );
}
