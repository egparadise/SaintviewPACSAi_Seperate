// 홈 — PACS 소개 및 가입 진입 (Inviz 스타일 라이트 랜딩)
// 앱은 다크 테마지만 랜딩은 자체 라이트 테마(.lp-*)로 독립 구성한다.
import { useEffect, useState } from "react";
import { api } from "../api";
import invizLogo from "../assets/inviz-logo.png";
import heroLaptop from "../assets/hero-laptop.png";

const INVIZ_URL = "https://www.inviz.co.kr/";

const FEATURES: { icon: string; title: string; desc: string }[] = [
  { icon: "🏥", title: "멀티 병원(테넌시)", desc: "병원별 가입·계정·데이터 격리. 설정으로 자기 병원 검사만 조회." },
  { icon: "🩻", title: "DICOM 수신·뷰어", desc: "Modality(SCU/SCP) 등록 수신, 자체 2D 뷰어·OHIF·내장 MPR." },
  { icon: "🤖", title: "AI 판독 보조", desc: "구조화 Structured Report 초안 — 최종 판독은 의료인이 검토·확정." },
  { icon: "💾", title: "저장·백업·압축", desc: "저장공간 감독, 기간 백업, JPEG2000/JPEG-LS 압축, 보존 정책." },
  { icon: "📡", title: "MPPS·MWL·GSPS", desc: "수행단계 수신으로 오더 자동 갱신, 워크리스트, 타사 PR 불러오기." },
  { icon: "🛡️", title: "역할 권한", desc: "관리자·의사·영상의학과·방사선사·기타 — 권한 매트릭스." },
];

// 랜딩 전용 스타일 1회 주입(라이트 테마·키프레임 — 인라인 불가한 것)
const LP_CSS = `
.lp{min-height:100%;overflow:auto;background:
   radial-gradient(1100px 560px at 82% -8%, #ece6ff 0%, rgba(236,230,255,0) 58%),
   radial-gradient(820px 460px at -5% -5%, #f1ecff 0%, rgba(241,236,255,0) 55%),
   linear-gradient(180deg,#fdfcff 0%,#f6f3fd 100%);
   color:#181529;font-family:var(--font,system-ui,sans-serif);}
.lp-nav{display:flex;align-items:center;justify-content:space-between;padding:18px 44px;gap:16px;flex-wrap:wrap;}
.lp-logo{display:inline-flex;align-items:center;text-decoration:none;}
.lp-logo img{height:34px;width:auto;display:block;transition:opacity .15s;}
.lp-logo:hover img{opacity:.8;}
.lp-navbtns{display:flex;gap:10px;flex-wrap:wrap;}
.lp-btn{padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid #e4dff2;background:#fff;color:#332a4d;transition:all .15s;white-space:nowrap;}
.lp-btn:hover{border-color:#c7bdf0;box-shadow:0 4px 12px rgba(124,58,237,.10);}
.lp-btn.primary{background:linear-gradient(135deg,#7c3aed,#9333ea);border:none;color:#fff;box-shadow:0 8px 18px rgba(124,58,237,.32);}
.lp-btn.primary:hover{filter:brightness(1.06);box-shadow:0 10px 22px rgba(124,58,237,.40);}
.lp-btn:disabled{opacity:.5;cursor:not-allowed;box-shadow:none;}
.lp-hero{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;align-items:center;max-width:1320px;margin:14px auto 0;padding:20px 48px 10px;}
@media(max-width:920px){.lp-hero{grid-template-columns:1fr;}.lp-hero-art{order:-1;}}
.lp-badge{display:inline-flex;align-items:center;gap:8px;background:#ece4fe;color:#6d28d9;font-size:13.5px;font-weight:700;padding:8px 16px;border-radius:999px;}
.lp-title{font-size:clamp(30px,4.6vw,60px);font-weight:900;line-height:1.05;letter-spacing:-2px;margin:24px 0 0;color:#12101f;white-space:nowrap;}
@media(max-width:920px){.lp-title{white-space:normal;}}
.lp-title .grad{background:linear-gradient(110deg,#7c3aed 10%,#9333ea 55%,#6366f1);-webkit-background-clip:text;background-clip:text;color:transparent;}
.lp-sub{margin-top:22px;font-size:17px;line-height:1.7;color:#5c5672;max-width:520px;}
.lp-hero-art{position:relative;display:flex;align-items:center;justify-content:center;min-height:360px;}
.lp-dot{animation:lpFloat 5s ease-in-out infinite;transform-origin:center;}
@keyframes lpFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-13px)}}
/* 회전 캐러셀 — 전체 폭 무한 마퀴(좌↔우 끝까지 스윕). 2배 트랙 → -50% 에서 seamless 루프 */
.lp-carousel{max-width:1320px;margin:34px auto 0;padding:6px 20px;display:flex;align-items:center;gap:10px;}
.lp-marq{overflow:hidden;flex:1;padding:10px 0;
   -webkit-mask:linear-gradient(90deg,transparent,#000 4%,#000 96%,transparent);
           mask:linear-gradient(90deg,transparent,#000 4%,#000 96%,transparent);}
.lp-track{display:flex;gap:20px;width:max-content;animation:lpScroll 34s linear infinite;}
.lp-marq:hover .lp-track{animation-play-state:paused;}
@keyframes lpScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
.lp-card{flex:0 0 250px;background:#fff;border:1px solid #efeafa;border-radius:16px;padding:20px;
   box-shadow:0 12px 32px rgba(80,50,160,.08);}
.lp-card-ic{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:23px;
   background:linear-gradient(135deg,#efe8ff,#e4d8ff);margin-bottom:14px;}
.lp-card-t{font-weight:800;font-size:15.5px;color:#201a36;}
.lp-card-d{margin-top:8px;font-size:12.8px;line-height:1.6;color:#6a6482;}
.lp-arrow{flex:0 0 auto;width:44px;height:44px;border-radius:50%;border:1px solid #e6e0f5;background:#fff;color:#7c3aed;
   font-size:22px;cursor:pointer;display:grid;place-items:center;transition:all .15s;box-shadow:0 5px 14px rgba(80,50,160,.12);}
.lp-arrow:hover{background:#7c3aed;color:#fff;border-color:#7c3aed;}
.lp-arrow.on{background:#7c3aed;color:#fff;border-color:#7c3aed;}
.lp-foot{text-align:center;padding:44px 20px 60px;}
.lp-foot-t{font-size:25px;font-weight:800;color:#231d3a;}
.lp-foot-t .grad{background:linear-gradient(110deg,#7c3aed,#6366f1);-webkit-background-clip:text;background-clip:text;color:transparent;}
.lp-foot-s{margin-top:8px;font-size:14px;color:#6a6482;}
`;
function ensureCss() {
  if (typeof document === "undefined" || document.getElementById("lp-css")) return;
  const s = document.createElement("style");
  s.id = "lp-css"; s.textContent = LP_CSS;
  document.head.appendChild(s);
}

// 히어로 — Saintview Viewer 실제 목업 이미지(회사 제공 에셋). 배경(라벤더)까지 포함된 png.
function HeroArt() {
  return (
    <img src={heroLaptop} alt="Saintview Viewer"
         style={{ width: "100%", maxWidth: 720, display: "block" }} />
  );
}

export function Landing({ onSignup, onAdminLogin, onClientLogin }: {
  onSignup: () => void; onAdminLogin: () => void; onClientLogin: () => void;
}) {
  ensureCss();
  const [canSignup, setCanSignup] = useState(true);
  const [dir, setDir] = useState<"normal" | "reverse">("normal");   // 화살표: 회전 방향(좌/우)
  useEffect(() => {
    api.signupEnabled().then((r) => setCanSignup(r.enabled)).catch(() => {});
  }, []);
  const loop = [...FEATURES, ...FEATURES];   // 2배 트랙 → seamless 무한 순환

  return (
    <div className="lp">
      <nav className="lp-nav">
        <a className="lp-logo" href={INVIZ_URL} target="_blank" rel="noopener noreferrer" title="Inviz 홈페이지로 이동">
          <img src={invizLogo} alt="Inviz" />
        </a>
        <div className="lp-navbtns">
          <button className="lp-btn primary" onClick={onSignup} disabled={!canSignup}
                  title={canSignup ? "" : "현재 온라인 가입이 비활성화되어 있습니다"}>병원 가입</button>
          <button className="lp-btn" onClick={onClientLogin}>Client 뷰어 접속</button>
          <button className="lp-btn" onClick={onAdminLogin}>관리자 로그인</button>
        </div>
      </nav>

      <section className="lp-hero">
        <div>
          <span className="lp-badge">✨ AI로 연결된 스마트 Web PACS Platform</span>
          <h1 className="lp-title">Saintview <span className="grad">PACS AI</span></h1>
          <p className="lp-sub">
            웹 기반 PACS + AI 판독 보조 플랫폼 —<br />
            DICOM 수신 · 보관 · 조회와 Structured Report 초안 생성을 하나로
          </p>
          {!canSignup && (
            <div style={{ fontSize: 12.5, color: "#a1435a", marginTop: 12 }}>
              현재 온라인 가입이 비활성화되어 있습니다 — 관리자에게 문의하세요.
            </div>
          )}
        </div>
        <div className="lp-hero-art"><HeroArt /></div>
      </section>

      {/* 기능 카드 — 전체 폭 자동 회전 마퀴(좌↔우 끝까지). 화살표로 방향 전환, hover 시 정지 */}
      <div className="lp-carousel">
        <button className={`lp-arrow${dir === "reverse" ? " on" : ""}`} onClick={() => setDir("reverse")} aria-label="왼쪽으로">‹</button>
        <div className="lp-marq">
          <div className="lp-track" style={{ animationDirection: dir }}>
            {loop.map((f, i) => (
              <div className="lp-card" key={i}>
                <div className="lp-card-ic">{f.icon}</div>
                <div className="lp-card-t">{f.title}</div>
                <div className="lp-card-d">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
        <button className={`lp-arrow${dir === "normal" ? " on" : ""}`} onClick={() => setDir("normal")} aria-label="오른쪽으로">›</button>
      </div>

      <footer className="lp-foot">
        <div className="lp-foot-t">Smarter Workflow, <span className="grad">Better Care</span></div>
        <div className="lp-foot-s">Saintview PACS AI는 의료진의 더 나은 진단과 효율적인 워크플로우를 지원합니다.</div>
      </footer>
    </div>
  );
}
