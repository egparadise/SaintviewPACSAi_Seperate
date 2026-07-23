# WebPACS(SaintViewPACS 인계 웹서비스) 연동 — 우리 뷰어 적용

> 2026-07-23. 인수 패키지 `SaintViewPACS-handover-full-20260721`의 웹 서비스(FastAPI `webpacs_api` +
> Tauri/Web 클라이언트)를 정밀 분석하고, 그 검사 데이터를 **이 Viewer Suite 의 자체 뷰어
> (T-View/In-View/SaintView)** 로 표시하는 브리지를 구현한 기록·운용 가이드.

---

## 1. 인계 웹 서비스 분석 요약

### 1.1 구성

| 계층 | 내용 |
|---|---|
| 클라이언트 | Tauri 2 + React 19 + Cornerstone3D 5 (`999.tauri_pacs`). 데스크톱/Web/QC 3변형 |
| API 서버 | FastAPI `webpacs_api` (`127.0.0.1:8014`, 운영 api.inviz.co.kr — Nginx 리버스 프록시 전제) |
| DB | MySQL/MariaDB 3종 — `cloud_pacs`(검사) / `cloud_manager`(사용자·토큰) / `cloud_remote`(원격판독). FK 없음 |
| 스토리지 | MinIO — 운영 DICOM 은 **AES-256-CBC 암호화**(`file-62-server` 버킷만 평문). `original/`=HTJ2K 이전 원본 백업, `thumb/`·`rendered/`·`metadata/`=평문 파생물 |
| 캐시 | Redis (v2 프레임캐시 기본 OFF·메타 gzip 캐시 ON) |
| 수신 | 독립 프로세스 storescp(AET `InvizPACS`, 41095) → spool → file monitor 가 DB 적재+암호화+MinIO |

### 1.2 클라이언트 Web(브라우저) 타겟의 데이터 계약 (2축)

- **REST** `{base}/api/...` — 로그인 `POST /api/user/auth/login` `{user_id,user_passwd,user_overwrite}`
  → `{token, refresh_token, user_data, status}`(JWT HS256, 헤더 `Authorization: Bearer`).
  워크리스트 `GET /api/study/`(내부 PK `study_idx` 기반), 상세 `GET /api/study/{idx}`,
  시리즈+SOP `GET /api/study/{idx}/series/viewer`(images[]에 `sop_instance_uid`·`bucket_name`·`image_file_path`).
- **DICOMweb v2** `{base}/api/dicomweb/v2/...` — UID 기반. Web 클라이언트가 실사용하는 5종:
  Capability `/`, thumbnail, **instance(`application/dicom` 원본, Range 지원)**, frames(multipart, 원본 TS
  패스스루), series metadata(dicom+json gzip). **rendered 없음** — 픽셀은 클라 WASM 디코드.
  HTJ2K 는 v2 가 `original/` 백업에서 **원본 TS 로 정규화해 서빙**.
- 인증 예외 없음: DICOMweb 포함 전 경로 Bearer 헤더 필수(쿼리 토큰 없음).

### 1.3 통합 관점 핵심 발견

1. **`GET /api/dicomweb/v2/studies/{s}/series/{se}/instances/{sop}` 가 서버측에서 AES 복호화 +
   HTJ2K→원본 TS 정규화를 마친 표준 DICOM 파일을 반환**한다 → 표준 PACS(Orthanc)로 재주입 가능.
2. 인수 자료의 secrets(server-env)에 **`CRYPTION_KEY`/`JWT_SECRET` 이 누락** — MinIO 직결 복호화는
   불가하므로 서버측 복호화 경로(위 1)가 유일하게 안전한 취득 경로.
3. 우리 뷰어의 픽셀 경로는 Orthanc WADO-RS `/rendered?window=C,W`(서버 렌더) 의존 — 인계 v2 에는
   rendered 가 없어 **프론트 직결은 불가**. 워크리스트/주석/ROI/GSPS 등 우리 백엔드 30여 엔드포인트도
   자체 DB·Orthanc 전제.

### 1.4 연동 방식 결정 — 서버측 풀 브리지(Orthanc 미러)

```
[webpacs_api]  ──(REST: study 탐색)──▶  [Viewer Suite 백엔드 webpacs_bridge]
      │                                        │
      └─(DICOMweb v2: instance 원본 DICOM)─────┤ POST /instances
                                               ▼
                                     [우리 Orthanc(8043)] → register_study → 워크리스트
                                               ▼
                    T-View/In-View/SaintView (rendered·주석·ROI·비교판독 전 기능 그대로)
```

- 브라우저 CORS/Authorization 제약 없음(서버-서버), CRYPTION_KEY 불필요, 우리 뷰어 무수정.
- 가져온 검사는 `source_aet="WEBPACS"` 로 표기되어 일반 검사와 동일하게 동작(멱등 — study_uid 중복 시 skip).

## 2. 구현물

| 파일 | 내용 |
|---|---|
| `backend/app/services/webpacs_bridge.py` | `WebPacsClient`(로그인·401 재로그인·목록/상세/series·viewer·instance 다운로드), `import_study`(다운로드→Orthanc→등록, 진행 레지스트리), `webpacs_sync_once`(자동 동기화), 설정 병합(`webpacs.bridge` + env) |
| `backend/app/api/webpacs.py` | `GET/PUT /api/webpacs/config`(관리자, 비밀번호 마스킹) · `POST /test` · `GET /studies`(원격 프록시+로컬 매핑 주입) · `POST /import/{idx}`(백그라운드) · `GET /import/{idx}/status` |
| `backend/app/workers/ai_worker.py` | 워커 루프에 자동 동기화 훅(≈60초, opt-in) |
| `frontend/src/pages/WebPacsBrowser.tsx` | 워크리스트 탭 바 우측 **[WebPACS]** 버튼 → 검색/가져오기/가져와서 열기 모달 + 관리자 접속 설정 |
| `harness/mock_webpacs_api.py` | 인계 서버 계약 재현 모의 서버(테스트·E2E) — `py -3.11 harness/mock_webpacs_api.py --port 8014` |
| `backend/tests/test_webpacs_bridge.py` | 6 테스트 — 로그인/목록/재로그인/가져오기/설정 마스킹/엔드포인트 E2E |

## 3. 운용 가이드 (실서버 연결)

1. **원격 계정 준비**: 인계 PACS 에 `user_type` 에 `P` 가 포함된 계정(브리지 전용 계정 권장).
2. **접속 설정**: 워크리스트 [WebPACS] → ⚙ 접속 설정(관리자) —
   - 원격 주소: `https://api.inviz.co.kr` (또는 로컬 기동 시 `http://127.0.0.1:8014`)
   - 계정 ID/비밀번호, SSL 검증(자체서명이면 해제), 브리지 사용 체크 → 저장 → [연결 테스트]
   - env 로도 지정 가능(설정보다 우선): `SAINTVIEW_WEBPACS_BASE_URL`/`_USER`/`_PASSWORD`/`_ENABLED`/`_VERIFY_SSL`
3. **가져오기**: 검색 → [가져오기] 또는 [가져와서 열기](완료 시 우리 뷰어 새 창). 이미 가져온 검사는
   [우리 뷰어로 열기]로 즉시 오픈. 진행률 표시(N/총).
4. **자동 동기화**(선택): 접속 설정에서 "자동 동기화" 체크 — 워커가 ≈60초마다 원격 최신 N건 중
   미보유 검사를 자동 가져오기.
5. **병원 귀속**: 가져온 검사는 요청자 병원(hid) 또는 설정 `hospital_id` 로 귀속(시스템 관리자 무소속 시).

### 주의·제약

- **비밀번호 저장**: `app_setting`(webpacs.bridge)에 평문 저장 — DB 접근 통제 전제. 운영에서는 env 주입 권장.
- 원격 워크리스트 목록 응답의 `study_count` 는 0 하드코딩(인계 서버 특성) — 총건수는 `/count` 별도 호출로 처리됨.
- 원격 검색 파라미터 매핑: `patient_id`·`patient_name`·`study_modality`·`study_datetime_start/end`·`study_search`(자유 검색 OR).
- 판독문은 가져오지 않음(영상만) — 원격 판독문 연동이 필요하면 `pacs_study_report` REST(`GET /api/study/{idx}/report`)를
  후속으로 매핑할 것(우리 reports 와 확정/서명 모델이 달라 별도 설계 필요).
- 인계 서버의 토큰 만료값이 매우 크지만, 브리지는 401 시 1회 재로그인으로 어떤 만료 정책에도 대응.

## 4. E2E 재현 절차 (모의 서버)

```bash
# 1) 스위트 기동 (Docker: db/orthanc/ohif + 백엔드 8010 + 프론트 5180)
start_viewer_suite.bat

# 2) 모의 인계 서버 (검사 2건 × 3장, 계정 webpacs/webpacs1234)
py -3.11 harness/mock_webpacs_api.py --port 8014

# 3) 뷰어(https://localhost:5180) 관리자 로그인 → [WebPACS] → 접속 설정
#    주소 http://127.0.0.1:8014, 계정 webpacs/webpacs1234, 브리지 사용 → 저장 → 연결 테스트
# 4) 검색 → [가져와서 열기] → 우리 뷰어(T-View/In-View/SaintView)로 표시 확인
```

pytest: `cd backend && py -3.11 -m pytest tests/test_webpacs_bridge.py -q` (전체 255 통과 기준선).
