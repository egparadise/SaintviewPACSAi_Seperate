# Saintview Viewer Suite

**Saintview PACS AI 의 뷰어 제품군(Worklist + I-View/T-View/SaintView)을 외부 프로그램 연동용으로
완전히 분리한 독립 배포판.** 소스코드 전체 + 자체 인프라(PostgreSQL·Orthanc·OHIF, docker compose)를
포함하며, 다른 서버의 기존 Saintview 스택에 붙이는 것도 설정만으로 가능하다.

| 구성 | 포트 | 비고 |
|---|---|---|
| 뷰어 프론트(Worklist·I-View·T-View·SaintView) | **5180** (HTTPS 자체서명) | `VITE_PORT_CLIENT=5180` — Client 포털 부팅 |
| 백엔드 API (FastAPI) | **8010** | `/api/health` |
| PostgreSQL (pgvector) | **5434** | compose `svviewer-db` |
| Orthanc (DICOMweb / C-STORE) | **8043 / 4243** | AET `SVVIEWER`, compose `svviewer-orthanc` |
| OHIF (Advance View) | **3001** | compose `svviewer-ohif` |

메인 Saintview PACS AI(8000/5173~5175/5433/8042/3000)와 **포트·컨테이너·볼륨이 분리**되어
같은 PC 에 나란히 실행할 수 있고, 단독으로 다른 서버에 배포해도 된다.

## 빠른 시작

```bat
:: 0) 요구사항: Docker Desktop, Python 3.11(py 런처), Node.js(npm), openssl(Git 동봉으로 대체 가능)
cd frontend && npm install && cd ..     :: 최초 1회
start_viewer_suite.bat                  :: 원클릭 — docker + API(8010) + 뷰어(5180) + 브라우저
```

- 접속: https://localhost:5180 (자체서명 인증서 — 최초 1회 [고급]→[계속])
- DB 스키마는 백엔드 첫 기동 시 자동 생성(`init_db`), 또는 `cd backend && alembic upgrade head`

### ⚠ 최초 1회 — 샘플 병원·계정 시드 (Client 로그인에 필수)

5180 은 **Client 뷰어 로그인**(병원 ID + 개별 ID + PW)이며 **병원 소속 계정만** 허용된다
(시스템 관리자 `admin` 은 Client 로그인 거부). 새 DB 에는 병원이 없으므로 시드를 먼저 실행:

```bat
cd backend
set SAINTVIEW_DATABASE_URL=postgresql+psycopg2://saintview:saintview_dev@localhost:5434/saintview
py -3.11 seed_sample.py
```

| 용도 | 병원 ID | 개별 ID | PW |
|---|---|---|---|
| Client 뷰어(판독의) | `SAMPLE01` | `sample_dr` | `sample1234` |
| Client 뷰어(병원 관리자) | `SAMPLE01` | `sample_admin` | `sample1234` |
| Client 뷰어(방사선사) | `SAMPLE01` | `sample_rt` | `sample1234` |

> 로그인 화면은 이 값을 **자동으로 채우지 않는다**(직접 입력). 예전에는 병원 ID 칸이 `SAMPLE01`,
> 개별 ID 칸이 `admin` 으로 프리필돼 있었는데, 그 상태로 브라우저가 "비밀번호 저장"을 하면
> 크롬이 그 값을 이 사이트의 자격증명(username=`Sample01`)으로 기억한다. 그 뒤로는 같은 문서의
> 다른 텍스트 칸 — 특히 워크리스트 **SEARCH** 칸 — 에 자동완성으로 흘러들어가 목록이 비어 보인다.
> 이미 겪고 있다면 `chrome://password-manager/passwords` 에서 이 사이트 항목(사용자 이름 `Sample01`)을
> 삭제해야 증상이 멈춘다 — 코드 수정만으로는 이미 저장된 항목이 지워지지 않는다.

운영 배포에서는 시드 대신 관리자 콘솔에서 실제 병원·계정을 등록한다:
`frontend/.env` 의 `VITE_PORT_ADMIN`(기본 5181) 포트로 두 번째 인스턴스를 띄우면
관리자 포털(`admin / admin1234` — 운영 전 반드시 변경)로 부팅된다.

```bat
cd frontend && npm run dev -- --host 0.0.0.0 --port 5181 --strictPort
```

## 검사 넣어보기 (연동 테스트)

- DICOM 장비/타 PACS → C-STORE: **호스트IP:4243, Called AET `SVVIEWER`**
- 합성 DICOM 스모크: `py -3.11 harness/smoke_dicom_pipeline.py` (Orthanc→DB 동기화→워크리스트 표시)
- 수신된 검사는 백엔드 워커가 자동으로 워크리스트에 동기화한다.

## 외부 프로그램 연동

**`docs/INTEGRATION.md`** 참조 — URL 딥링크(뷰어/판독창 직접 오픈), REST API, DICOMweb,
MWL/MPPS, DB 직접 접속, 기존 Saintview 서버에 프론트만 붙이는 방법(`frontend/.env` 의
`VITE_API_BASE`, vite 프록시 `SV_API_URL`/`SV_DICOMWEB_URL`/`SV_ORTHANC_URL`),
CORS 추가 오리진(`SAINTVIEW_CORS_ORIGINS`).

## 빌드 (프로덕션 정적 산출물)

```bat
cd frontend
npm run build        :: tsc -b + vite build → frontend/dist (정적 파일 — nginx 등으로 서빙 가능)
```

`frontend/dist` 를 임의의 웹서버로 서빙하는 경우 `/api`·`/dicom-web`·`/orthanc` 경로를
백엔드·Orthanc 로 리버스 프록시해야 한다(개발 모드에서는 vite 가 이 프록시를 대신한다).

## 실시간 협진 (Co-Reading)

같은 병원·다른 병원에 접속해 있는 사용자끼리 **친구 요청 → 수락 → 협진 세션**으로 한 환자의
영상을 함께 보며 의견을 교환한다. 메신저 채팅 · 음성 · 화상이 모두 된다.

| 항목 | 구현 |
|---|---|
| 화면 공유 | **뷰어 상태 미러링** — 검사/시리즈/레이아웃/줌·팬·회전·W-L을 JSON으로만 전송(초당 수 KB). Slave 브라우저가 원본 픽셀을 직접 받아 그리므로 **진단 화질이 그대로**다 |
| 타 병원 영상 | **세션 한정 임시 열람권**(`collab_grant`) — 세션이 열려 있고 참가 중인 동안 그 검사에만 유효. 세션 종료 시 즉시 회수 + 전 접근 감사로그(`collab_study_read`) |
| 화상·음성 | **P2P mesh WebRTC** — 미디어가 서버를 거치지 않는다. 신규 컨테이너 없음, 정원 6명 |
| 권한 | Master(초청자)가 제어권을 승인해야 Slave가 화면을 조작한다. **판독 수정·영상 삭제 등은 어떤 경우에도 위임되지 않는다** |

**권한 모델의 핵심** — 임시 열람권은 조회 게이트(`worklist._require_study(allow_collab=True)`)
**4개 엔드포인트에만** opt-in으로 꽂혀 있고, 쓰기 경로(`require_effective`)는 협진의 존재를
모른다. 위임 가능한 것은 `collab.*` capability뿐이며 `permissions.sanitize_collab_caps`가
화이트리스트 교집합으로 강제한다 — `report.write`·`study.delete`는 통과 자체가 불가능하다.
검증: `backend/tests/test_collab.py`(21건).

### ⚠ 운영 배포 시 필수 — nginx WebSocket 설정

협진은 `WS /api/collab/ws` 를 쓴다. **기존 `location /api/` 블록은 keep-alive 를 위해
`Connection ""` 를 넣기 때문에 그대로 두면 업그레이드가 깨진다.** `deploy/nginx-viewer.conf`
에 더 구체적인 `location /api/collab/ws` 블록이 추가돼 있으니 운영 nginx에도 함께 반영할 것
(`nginx -t` 후 `nginx -s reload`). 개발 모드는 `vite.config.ts` 의 `/api` 프록시에 `ws: true`
가 들어가 있어 별도 설정이 필요 없다.

### 병원 밖 협진 (선택)

사내망은 host candidate 만으로 연결되므로 기본값(ICE 서버 없음) 그대로 동작한다. 인터넷을
건너는 협진이 필요하면 브라우저 `localStorage` 키 `sv_collab_ice` 에 STUN/TURN 배열을 넣는다
(예: `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`).
공개 STUN 을 기본값으로 박지 않은 이유는 폐쇄망에서 매 통화마다 못 나가는 주소로 질의해
연결이 느려지기 때문이다.

## 참고

- 뷰어는 **HTTPS 전용**(원격 PC 다중 모니터 감지 `getScreenDetails` = secure context 필수) —
  인증서가 없으면 런처가 자동 생성한다.
- AI 판독 초안 생성 기능은 현재 **보류(기본 OFF)** — RAG Structured Report 개편 전까지.
  재활성: 설정 > AI 정책 마스터 스위치(또는 env `SAINTVIEW_AI_DRAFT_ENABLED=1`).
- 시크릿은 `backend/.env`(gitignore) 에만 — `.env.example` 을 복사해 사용.
- 백엔드 테스트: `cd backend && py -3.11 -m pytest` (SQLite 임시 DB, AI mock)
