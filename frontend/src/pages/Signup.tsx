// 가입 — 병원 정보 · 라이선스 · 가입자(초기 관리자) · 결재 (가입 흐름도)
// 가입 환경 설정(signup.fields.hospital — 관리자 콘솔 [가입 환경 설정])을 소비해
// 병원 정보 입력 항목의 표시/필수를 반영한다. 미설정·로드 실패 시 기존 폼 그대로.
import { useEffect, useState } from "react";
import { api, fetchSignupFields } from "../api";

const inp: React.CSSProperties = {
  width: "100%", background: "var(--bg-canvas)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 4, padding: "7px 9px", fontSize: 13, boxSizing: "border-box",
};
function Field({ label, children, req }: { label: string; children: React.ReactNode; req?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}{req && <span style={{ color: "#f87171" }}> *</span>}</span>
      {children}
    </label>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px", margin: 0,
                       display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", padding: "0 6px" }}>{title}</legend>
      {children}
    </fieldset>
  );
}

export function Signup({ onDone, onCancel }: { onDone: (username: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({
    // 병원 정보
    name: "", zip: "", address: "", address_detail: "", departments: "", phone: "", fax: "", homepage: "",
    license_clients: 1, modality_limit: 0,
    // 가입자
    rname: "", title: "", sex: "", birth6: "", rphone: "", mobile: "", email: "",
    username: "", password: "", password_confirm: "",
    // 결재
    method: "monthly_transfer", card_last4: "",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 가입 환경 설정 — 병원 정보 필드의 표시/필수 (미설정=null=기존 그대로)
  const [fieldCfg, setFieldCfg] = useState<Record<string, { enabled: boolean; required: boolean; label: string }> | null>(null);
  useEffect(() => {
    fetchSignupFields("hospital").then((cfg) => {
      if (cfg) setFieldCfg(Object.fromEntries(cfg.fields.map((x) => [x.key, { enabled: x.enabled, required: x.required, label: x.label }])));
    });
  }, []);
  const show = (k: string) => !fieldCfg || (fieldCfg[k]?.enabled ?? true);
  const reqd = (k: string) => !!fieldCfg?.[k]?.required;
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  // 주소 검색 — Daum(카카오) 우편번호 서비스 지연 로드 후 팝업. 완료 시 우편번호+주소 채움.
  // 오프라인/스크립트 실패 시 주소 직접 입력으로 자연 폴백(주소 input 은 편집 가능 유지).
  type DaumData = { zonecode: string; roadAddress: string; jibunAddress: string };
  type DaumWin = { daum?: { Postcode: new (o: { oncomplete: (d: DaumData) => void }) => { open: () => void } } };
  const loadDaum = () => new Promise<void>((resolve, reject) => {
    const w = window as unknown as DaumWin;
    if (w.daum?.Postcode) return resolve();
    const s = document.createElement("script");
    s.src = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("주소 검색 서비스를 불러오지 못했습니다 — 인터넷 연결을 확인하거나 주소를 직접 입력하세요"));
    document.head.appendChild(s);
  });
  const searchAddr = async () => {
    setErr("");
    try {
      await loadDaum();
      const w = window as unknown as Required<DaumWin>;
      new w.daum.Postcode({
        oncomplete: (d) => {
          set("zip", d.zonecode);
          set("address", d.roadAddress || d.jibunAddress);
        },
      }).open();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "주소 검색 실패");
    }
  };

  const submit = async () => {
    setErr("");
    if (!f.name.trim()) return setErr("병원 이름을 입력하세요");
    // 가입 환경 설정의 필수 항목 검증 (표시 중인 항목만)
    if (fieldCfg) {
      for (const [k, cfg] of Object.entries(fieldCfg)) {
        if (!cfg.enabled || !cfg.required) continue;
        const v = (f as Record<string, unknown>)[k];
        if (v == null || String(v).trim() === "") return setErr(`${cfg.label || k} 항목은 필수입니다`);
      }
    }
    if (!f.username.trim()) return setErr("관리자 ID를 입력하세요");
    if (f.password.length < 8) return setErr("비밀번호는 8자 이상이어야 합니다");
    if (f.password !== f.password_confirm) return setErr("비밀번호 확인이 일치하지 않습니다");
    if (f.birth6 && !/^\d{6}$/.test(f.birth6)) return setErr("주민번호 앞자리는 숫자 6자리(생년월일)입니다");
    setBusy(true);
    try {
      const r = await api.signup({
        hospital: {
          name: f.name, zip: f.zip, address: f.address, address_detail: f.address_detail,
          departments: f.departments, phone: f.phone,
          fax: f.fax, homepage: f.homepage,
          license_clients: Number(f.license_clients), modality_limit: Number(f.modality_limit),
        },
        registrant: {
          name: f.rname, title: f.title, sex: f.sex, birth6: f.birth6, phone: f.rphone,
          mobile: f.mobile, email: f.email, username: f.username,
          password: f.password, password_confirm: f.password_confirm,
        },
        billing: { method: f.method, card_last4: f.card_last4 },
      });
      alert(r.message);
      onDone(r.username);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "가입 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100%", overflow: "auto", display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: 720, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 14,
                    background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 22 }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>병원 가입</div>

        <Section title="병원 정보">
          <Field label="병원 이름" req><input style={inp} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
          {show("departments") && <Field label="진료과 (콤마 구분)" req={reqd("departments")}><input style={inp} placeholder="영상의학과,내과" value={f.departments} onChange={(e) => set("departments", e.target.value)} /></Field>}
          {show("address") && (
            <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--text-secondary)" }}>우편번호</span>
                  <input style={{ ...inp, width: 130 }} value={f.zip} readOnly placeholder="검색" />
                </div>
                <button type="button" onClick={searchAddr} style={{ padding: "7px 14px", whiteSpace: "nowrap" }}>🔍 주소 검색</button>
              </div>
              <Field label="주소" req={reqd("address")}><input style={inp} value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="주소 검색 또는 직접 입력" /></Field>
              <Field label="상세주소"><input style={inp} value={f.address_detail} onChange={(e) => set("address_detail", e.target.value)} placeholder="동·호수 등 상세주소 직접 입력" /></Field>
            </div>
          )}
          {show("homepage") && <Field label="홈페이지" req={reqd("homepage")}><input style={inp} value={f.homepage} onChange={(e) => set("homepage", e.target.value)} /></Field>}
          {show("phone") && <Field label="연락처" req={reqd("phone")}><input style={inp} value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>}
          {show("fax") && <Field label="Fax" req={reqd("fax")}><input style={inp} value={f.fax} onChange={(e) => set("fax", e.target.value)} /></Field>}
          {show("license_clients") && <Field label="License — Client(뷰어) 수" req={reqd("license_clients")}><input style={inp} type="number" min={1} value={f.license_clients} onChange={(e) => set("license_clients", e.target.value)} /></Field>}
          {show("modality_limit") && <Field label="연결할 Modality 수 (0=무제한)" req={reqd("modality_limit")}><input style={inp} type="number" min={0} value={f.modality_limit} onChange={(e) => set("modality_limit", e.target.value)} /></Field>}
        </Section>

        <Section title="가입자 등록 (초기 관리자 — admin)">
          <Field label="이름" req><input style={inp} value={f.rname} onChange={(e) => set("rname", e.target.value)} /></Field>
          <Field label="직책"><input style={inp} value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
          <Field label="성별">
            <select style={inp} value={f.sex} onChange={(e) => set("sex", e.target.value)}>
              <option value="">선택</option><option value="M">남</option><option value="F">여</option>
            </select>
          </Field>
          <Field label="주민번호 앞 6자리 (생년월일)"><input style={inp} maxLength={6} placeholder="700101" value={f.birth6} onChange={(e) => set("birth6", e.target.value.replace(/\D/g, ""))} /></Field>
          <Field label="전화번호"><input style={inp} value={f.rphone} onChange={(e) => set("rphone", e.target.value)} /></Field>
          <Field label="휴대전화"><input style={inp} value={f.mobile} onChange={(e) => set("mobile", e.target.value)} /></Field>
          <Field label="이메일"><input style={inp} value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <div />
          <Field label="ID" req><input style={inp} value={f.username} onChange={(e) => set("username", e.target.value)} /></Field>
          <div />
          <Field label="비밀번호 (8자 이상)" req><input style={inp} type="password" value={f.password} onChange={(e) => set("password", e.target.value)} /></Field>
          <Field label="비밀번호 확인" req><input style={inp} type="password" value={f.password_confirm} onChange={(e) => set("password_confirm", e.target.value)} /></Field>
        </Section>

        <Section title="결재">
          <Field label="결재 방법">
            <select style={inp} value={f.method} onChange={(e) => set("method", e.target.value)}>
              <option value="monthly_transfer">월별 이체 (계산서 발행)</option>
              <option value="card">카드 등록</option>
            </select>
          </Field>
          {f.method === "card" && (
            <Field label="카드 번호 (마지막 4자리만 저장)"><input style={inp} value={f.card_last4} onChange={(e) => set("card_last4", e.target.value.replace(/\D/g, ""))} placeholder="**** **** **** 1234" /></Field>
          )}
        </Section>

        {err && <div style={{ color: "#f87171", fontSize: 12.5 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} disabled={busy}>취소</button>
          <button className="primary" onClick={submit} disabled={busy}>{busy ? "가입 중…" : "가입하기"}</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          ⚠ 주민번호는 앞 6자리(생년월일)만 저장되며, 카드는 마지막 4자리만 보관됩니다. 전체 번호는 저장하지 않습니다.
        </div>
      </div>
    </div>
  );
}
