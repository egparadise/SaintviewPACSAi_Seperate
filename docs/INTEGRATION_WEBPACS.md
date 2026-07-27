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

## 2.5 Live 모드 — 원격 직결(복사 없음, A DB 단일 원본) ★

미러(가져오기)와 별개로, **A 의 DB·스토리지를 단일 원본으로 두고 B 뷰어가 실시간 직결**하는
모드. 워크리스트 우측 **[Live]** 버튼으로 전환한다(해제: Web Server).

```
[A webpacs_api] ◀──실시간 REST/DICOMweb v2──▶ [B 백엔드 /api/webpacs/live/*] ◀──▶ B 뷰어
   판독·주석·상태의 원본                          가상 id(vid=90,000,000+A study_idx) 어댑터
```

| 축 | 동작 |
|---|---|
| 워크리스트 | A `/api/study/` 실시간 조회(5초 폴링, 최신순) → StudyRow(vid) — 복사·등록 없음 |
| 영상 | A v2 인스턴스를 B 가 서버측 디코드+윈도잉(`/rendered` 동형, pylibjpeg 전 코덱) + 원본 bytes 디스크 캐시. 썸네일은 A 사전생성분 프록시 |
| 판독 | 저장=A `POST report`(R)·승인=동일 POST(A) — **A `pacs_study_report` 에 기록**, study_status 는 A DB 트리거. 저장 전 `change_status/report`(RI 선점, 타 판독의 작성중 409) |
| 주석/표시상태 | A `pacs_image_annotation` 에 전용 슬롯(`sv_annotation`/`sv_presentation`)으로 왕복 — B 클라이언트 간 공유(A 뷰어 주석과 공존, 형식 상이로 상호 렌더는 안 됨) |
| presence | A 신호: `study_status==RI`+판독의명(워크리스트 ✍+MEMO, 판독 도크 배너) · B 간 열람: 라이브 하트비트(👁) · 판독문 외부 갱신 감지(Δ 배너+새로고침) |
| 미지원(차단 안내) | AI 초안·GSPS/KOS·키이미지 등록·북마크·응급 토글·보류·잠금 토글(승인 상태가 곧 잠금)·3D/OHIF |

- 프론트 계약: 검사 id 가 **vid 대역(≥90,000,000)** 이면 `api.ts` 가 자동으로 `/api/webpacs/live/*` 로
  라우팅 — 뷰어(T-View/In-View/SaintView)·판독 도크는 무수정.
- 원격 계정 권한 주의: A 는 일반 판독의(group_level<98)에게 "본인 배정 또는 미배정"만 보여주고
  타인 배정 검사 저장을 409 로 막는다 — Live 용 계정은 `group_level≥98` 또는
  `user_report_edit_all='Y'` 권장.
- rendered/thumb 는 `<img>` 계약상 무인증(기존 Orthanc 프록시와 동일 자세) — 운영은 리버스
  프록시에서 접근 통제.
- 실시간 강화(후속): A 에 SSE `/see/stream`(상태/판독 변경 push)가 이미 있어 폴링을 push 로
  교체 가능.

## 2.6 per-user A 로그인 — "그 서버 계정으로 로그인" (요구4·6 완결) ★

Client 로그인 화면의 **[원격 PACS 서버 계정으로 로그인 (직결·Live)]** 체크 → 사용자가
자기 A(webpacs_api) 계정 ID/PW 로 로그인한다. 그러면:

- B 가 A `/api/user/auth/login` 으로 자격을 검증하고, 성공 시 그 사용자의 A 토큰·신원
  (user_idx·이름·group_level)을 서버 세션에 보관(`webpacs_session`).
- 이후 Live 의 **워크리스트·판독 읽기/쓰기·주석·상태**는 **그 사용자의 A 계정**으로 A 에 접근
  → A 권한 스코프가 그대로 적용되고, 판독 작성자/승인자가 **실제 판독의 이름**으로 A DB 에 기록.
- 이미지(rendered/thumb)는 `<img>` 가 인증 헤더를 못 실으므로 **서비스 계정(공유 브리지)**
  으로 취득(사용자 귀속 불필요) — [WebPACS] 접속 설정의 계정이 이미지 서비스 계정.
- group_level ≥ 98 → 관리자급(전 권한), 그 외 → 판독의. 토큰 만료는 A refresh 로 자동 갱신,
  refresh 만료 시 재로그인.

**요구사항 대응 결과(실서버 E2E 확인)**

| 요구 | 상태 | 근거 |
|---|---|---|
| A 서버 직결 + A Storage 영상 + A DB 데이터 | ✅ | Live 는 우리 Docker(PG/Orthanc) 임상데이터 미사용, A 단일 원본 |
| 그 서버 로그인 계정으로 로그인 | ✅ | webpacs-login → 사용자별 A 세션·토큰 |
| 판독 기록·수정이 A DB 에 100% | ✅ | 저장 R/RR·승인 A/RA, **실제 판독의 귀속**(create/approve name·idx), CVR 조건부 전송, study/refer 코멘트 왕복, SR 구조(권고·critical) 텍스트 무손실 왕복 |
| 모든 기능 하나도 빠짐없이 | ⚠ A 지원 범위 100% | 아래 §2.7 |

## 2.7 A 지원 범위와 원천적 한계 (요구5 정직 고지)

Live 에서 **A 가 지원하는 모든 기능은 동작**한다: 열람·측정/주석 저장·W/L·ROI HU·Compare·
시리즈/스택·판독 작성/수정/확정·메모·응급·북마크·PDF·실시간 상태/presence.

다음은 **A(webpacs_api) 자체에 대응 개념·API 가 없어** A 서버를 확장하지 않는 한 Live 에서
불가능하다(로컬/미러 모드에서는 지원). 임상 판독 자체에는 영향 없음:

| 기능 | 이유 |
|---|---|
| DICOM KOS/SR/GSPS **SOP 출력** | A 는 웹PACS(DB+MinIO)라 이 DICOM 객체 생성·저장 경로 없음. 판독 콘텐츠·주석은 A DB 로 이미 저장됨 |
| 키이미지(significant image) 플래그 | A 스키마에 key-image 플래그 컬럼 없음(클라 표시만 가능) |
| 휴대폰 촬영(QR) 첨부 | 우리 Orthanc 업로드 파이프라인 의존 — 원격 A 검사엔 부적용 |
| CTR 자동계측·AI 분석 | 자사 AI(RAG) 기능 — 46차부터 전역 보류(A 무관) |
| `report_update_datetime` 감사 | A 서버가 UPDATE 시 이 컬럼을 안 채움(A 측 트리거 필요) — 외부변경 감지가 약해질 수 있음 |

> 위 항목이 필요하면 A 서버(webpacs_api)에 해당 엔드포인트/컬럼을 추가해야 하며, 그때 Live
> 어댑터를 확장하면 된다. 우리 소스는 A 소스를 보유하고 있어 확장 가능.

## 2.8 Live 영상 로딩 속도 — 병목과 대책 (실측)

Live 픽셀은 `A 원본 다운로드 → 서버측 디코드 → 윈도잉 → PNG` 경로다. 실측 병목은 **네트워크
연결 오버헤드**가 서버 처리보다 훨씬 컸다.

| 원인 | 증상 | 대책 |
|---|---|---|
| **`localhost` IPv6 폴백** | 연결당 **+210ms**(localhost 219ms vs 127.0.0.1 11ms) | vite proxy·backend .env/config 기본값을 **127.0.0.1** 로 고정 |
| 연결 미재사용 | 프레임마다 새 TCP 핸드셰이크 | keep-alive(브라우저 기본)·httpx 풀 |
| 매 요청 재디코드 | W/L 드래그마다 JPEG2000 디코드 | **디코드 결과 메모리 LRU**(`_DECODE_CACHE`, sop 단위) — 윈도잉만 재수행 |
| 오픈 시 순차 다운로드 | 첫 스크롤이 A 왕복에 묶임 | **시리즈 병렬 프리페치**(`POST /studies/{vid}/prefetch`, 8 워커) — 뷰어 오픈 시 자동 킥 |
| PNG 최대압축 | 인코딩 CPU | `compress_level=1`(로컬망은 대역보다 지연이 지배) |

**실측(모의 A, 64² × 20장)**

| 시나리오 | 개선 전 | 개선 후 |
|---|---|---|
| 콜드 순차 20장 | 60ms/장 | **14ms/장** |
| 웜 재스크롤 | 58ms/장 | **16ms/장** |
| W/L 드래그 | 277ms/회 | **7ms/회** |

> ⚠ 운영 배포 시에도 `SAINTVIEW_ORTHANC_URL`·`SV_*_URL`·DB URL 에 `localhost` 대신
> **127.0.0.1**(또는 실제 IP)을 쓸 것. 실 병원 데이터(512², JPEG2000)는 디코드 비용이 커
> 프리페치·디코드 캐시 효과가 더 크다.

## 2.9 뷰어 오픈 속도 — 목표(DR<1s, CT<3s) 달성 내역

**측정 기준선(실사이즈 합성 데이터)**: DX 2048²×1장, CT 512²×200장.

| 병목 | 원인 | 대책 |
|---|---|---|
| **번들 오염(최대)** | `Viewer2D`가 상수 3개 때문에 `lib/cornerstone.ts` 를 정적 import → `@cornerstonejs/core+tools` **3.0MB** 가 2D 경로에 딸려옴(2D 는 cornerstone 미실행) | `lib/imageFormat.ts` 로 분리(cornerstone 의존 0). **2D 뷰어 창 페이로드 4.2MB → 0.94MB** |
| **dev 모드 서빙** | 런처가 `npm run dev` → 새 창마다 비압축 모듈 수십 개 | 런처 기본을 **프로덕션 빌드(preview)** 로 전환(`start_viewer_suite.bat dev` 로 개발 모드). **6.8MB/53요청 → 0.7MB/3요청** |
| 번들이 API 뒤에 직렬 | `if (!detail) return <로딩>` 이 lazy 청크 다운로드를 API 응답 뒤로 밀어냄 | `ViewerWindow` 모듈 평가 시 `import("./Viewer2D")` 선행 — 다운로드와 API 를 겹침 |
| 첫 프레임이 표시상태 대기 | `Promise.all([seriesTree, presentation])` | seriesTree 만 게이트, presentation 은 도착 시 적용 |
| 동일 GET 중복 | 열기 1회에 `studies/{id}` ×4, `settings/viewer.prefs` ×5 | api.ts **GET 인플라이트 합류**(화이트리스트·TTL 1.5s) → 각 1회 |
| series-tree 반복 | CT 200장 ≈ 116ms, 재오픈마다 Orthanc 왕복 | 60s TTL 캐시(+Import·모바일 업로드 시 무효화). QC 오버레이는 캐시 뒤 적용이라 즉시 반영 |

**실측(프로덕션 빌드, 브라우저 Navigation Timing)**

| 검사 | 첫 프레임 | 목표 | 판정 |
|---|---|---|---|
| DR/DX 2048² | **799ms** | 1,000ms | ✅ |
| CT 512² 200장 | **779ms** (200프레임 전량 프리페치 완료) | 3,000ms | ✅ |

> 현재 저장 압축은 **원본 그대로**(장비 전송 TS 유지 — Orthanc 트랜스코딩 미설정). 뷰어 표시는
> 서버 렌더(`/rendered` PNG/JPEG)라 저장 TS 는 서버 디코드 비용에만 영향한다. 대역이 좁은 원격
> 회선에서는 설정>병원별 영상 형식에서 **JPEG(품질 80~90)** 로 바꾸면 DR 전송량이 크게 준다
> (실측 2048²: PNG 4.1MB/200ms → JPEG q80 2.5MB/77ms, 합성 랜덤 노이즈 기준·실제 X-ray 는 이득이 더 큼).

## 2.10 실시간 동기 — A SSE 구독 (폴링 대체)

A 서버에는 **이미 SSE 가 구현돼 있다**(`GET /see/stream`, `app/router/SeeEvent.py`, 1초 주기):
- `message`(id=`link_update`) — 검사 상태·응급 변경(pacs_study_link 트리거 기반)
- `report_update` — 판독이 변경된 검사 행

> **A 서버 수정 불필요.** 우리가 구독만 하면 된다.

**구현**: `backend/app/services/webpacs_sse.py` 가 백엔드에서 **한 번만** 구독하고 변경 리비전(`rev`)을
메모리에 기록 → 프론트는 `GET /api/webpacs/live/sse-status` 로 rev 만 확인하고
**바뀐 경우에만** 워크리스트를 재조회한다.

| | 기존 | SSE 적용 |
|---|---|---|
| 변경 반영 지연 | 최대 5초 | **≤1초** |
| 무변경 시 A 부하 | 5초마다 전체 목록 조회 | **0**(rev 확인만) |

- 연결 끊김·A 구버전(엔드포인트 없음)이면 `connected=false` → **기존 5초 폴링으로 자동 폴백**(이중 안전)
- SSE 끊기면 1→2→4…30초 백오프 재연결

## 2.11 저대역 자동 대응 — JPEG 자동 선택

원격 저대역에서 DR(2048²) PNG 1장은 2~4MB 라 첫 표시가 1초를 넘긴다.
`frontend/src/lib/imageFormat.ts` 가 **Network Information API** 로 회선을 보고 자동 전환한다.

| 조건 | 동작 |
|---|---|
| 관리자가 형식 명시(png/jpeg) | **그 설정이 항상 우선**(진단 품질 정책 존중) |
| 기본값(`default`) + `saveData` 또는 `effectiveType∈{slow-2g,2g,3g}` 또는 `downlink<25Mbps` | **JPEG q90 자동** |
| 그 외 | 서버 기본 |

실측 효과(20Mbps): DR **1.70s → 0.68s**.

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
