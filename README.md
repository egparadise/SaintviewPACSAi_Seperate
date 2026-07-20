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

## 참고

- 뷰어는 **HTTPS 전용**(원격 PC 다중 모니터 감지 `getScreenDetails` = secure context 필수) —
  인증서가 없으면 런처가 자동 생성한다.
- AI 판독 초안 생성 기능은 현재 **보류(기본 OFF)** — RAG Structured Report 개편 전까지.
  재활성: 설정 > AI 정책 마스터 스위치(또는 env `SAINTVIEW_AI_DRAFT_ENABLED=1`).
- 시크릿은 `backend/.env`(gitignore) 에만 — `.env.example` 을 복사해 사용.
- 백엔드 테스트: `cd backend && py -3.11 -m pytest` (SQLite 임시 DB, AI mock)
