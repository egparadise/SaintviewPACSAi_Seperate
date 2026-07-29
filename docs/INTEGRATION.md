# Saintview Viewer Suite — 외부 연동 명세(INTEGRATION)

> **대상**: Saintview Viewer Suite(Worklist + I-View/T-View/SaintView 뷰어)를 외부 프로그램(EMR·RIS·타 PACS·AI 엔진·원격판독 시스템)과 연동하려는 개발자.
> **전제**: 스위트는 본체(SaintviewPACSai)에서 분리된 독립 패키지로, 자체 docker compose(PostgreSQL **5434** · Orthanc HTTP **8043**/DICOM **4243** · OHIF **3001**), 백엔드 API **:8010**, 뷰어 프론트 **:5180**(HTTPS 자체서명)으로 구동한다.

---

## 1. 연동 토폴로지 — 2모드

### 모드 A — 스위트 자체 스택(올인원)

스위트에 포함된 compose + 백엔드로 완결 구동. 외부 프로그램은 스위트의 API/Orthanc 에 직접 붙는다.

```
[외부 프로그램] ──REST──>  백엔드 API        http://localhost:8010  (FastAPI)
[장비/타 PACS] ──C-STORE─> Orthanc DICOM    <host>:4243  (AET: SVVIEWER)
[외부 뷰어 등] ──DICOMweb─> OHIF nginx      http://localhost:3001/dicom-web  (→ Orthanc 프록시)
[BI/리포팅]   ──SQL─────>  PostgreSQL       localhost:5434  (db=saintview)
[브라우저]    ──HTTPS───>  뷰어 프론트       https://localhost:5180  (Client 포털)
```

- 프론트는 `VITE_PORT_CLIENT=5180` 으로 **Client 포털** 역할로 부팅한다(포트 기반 포털 판정 — `frontend/src/lib/portals.ts`. 5180이 Client 포트로 인식되도록 env 지정 필수. 미지정 시 5173/5174/5175 외 포트는 'all' 폴백으로 전체 기능 단일 서빙).
- Vite dev 서버가 같은 출처 프록시를 제공: `/api → 백엔드(8010)`, `/dicom-web → OHIF nginx(3001)`, `/orthanc → Orthanc(8043, 프리뷰)`. 브라우저는 상대경로만 호출하므로 원격 접속에도 CORS·추가 포트 노출이 필요 없다.

### 모드 B — 기존 서버에 프론트만 연결

이미 운영 중인 Saintview 백엔드/Orthanc 에 스위트 뷰어 프론트만 붙인다. `frontend/.env` 에 대상 서버를 지정:

```ini
# frontend/.env
VITE_PORT_CLIENT=5180
VITE_API_BASE=https://pacs.example.com:8000      # 대상 백엔드 API (빈값=같은 출처 프록시)
VITE_OHIF_BASE=http://pacs.example.com:3000       # OHIF 뷰어 베이스
VITE_DICOMWEB_ROOT=http://pacs.example.com:3000/dicom-web  # WADO-RS/rendered 루트
# 선택: 뷰어 창을 별도 출처로 띄울 때
VITE_VIEWER_BASE=https://localhost:5176
```

- `VITE_API_BASE` 는 `frontend/src/api.ts` 의 모든 REST 호출 베이스, `VITE_DICOMWEB_ROOT` 는 자체 뷰어(T-View/In-View)의 WADO-RS `/rendered` 픽셀 로딩 루트, `VITE_OHIF_BASE` 는 Advance View(OHIF) 딥링크 베이스다.
- 상대경로 프록시를 유지하려면 vite 프록시 대상을 env 로 지정: `SV_API_URL`·`SV_DICOMWEB_URL`·`SV_ORTHANC_URL`(vite 기동 프로세스 env — `frontend/vite.config.ts`).
- 대상 백엔드의 CORS 에 스위트 오리진(`https://<host>:5180`)이 등록돼 있어야 한다(§7 참조).

---

## 2. URL 딥링크

프론트는 SPA 이며 라우팅은 **쿼리 파라미터**로 한다(경로 라우트 없음). 모든 창은 로그인 세션(JWT)이 전제 — 뷰어/판독 창은 열어준 워크리스트 창(opener)과 postMessage 토큰 핸드셰이크(`ensureToken`)로 인증을 인계받는다. **외부 프로그램이 URL 만으로 무인증 오픈하는 것은 불가**하며, 같은 브라우저에 해당 포털 로그인 세션이 있어야 동작한다.

### 2.1 뷰어 창 — `?viewer=2d` (`frontend/src/pages/ViewerWindow.tsx`)

| 파라미터 | 의미 |
|---|---|
| `viewer=2d` | 뷰어 창 모드 진입(필수) |
| `study=<id>` | 주 검사(내부 study id, 필수) |
| `add=<id>` | Add View — 분할 추가로 함께 열 검사 |
| `stack=<id>` | Stack View — 같은 페인에 중첩할 검사 |
| `keysops=<sop1,sop2,…>` | Key Image View — 표시할 SOP Instance UID 콤마 목록 |
| `wo_mode=add\|stack` | Study With Open 모드(Related 검사 동반 오픈) |
| `wo_ids=<id1,id2,…>` | With Open 으로 함께 열 검사 id 목록 |
| `cmp=1` | 뷰어 로드 후 Compare(⇄) 모달 자동 오픈 |

실제 표시 뷰어는 URL 이 아니라 계정 설정 `viewer.prefs.client_viewer`(`infi`=In-View, `ty`/`sv`=T-View/SaintView 스킨)로 결정된다. 창 이름 `sv_viewer` 재사용 — 여러 검사는 한 창의 Exam 탭으로 누적.

```
https://localhost:5180/?viewer=2d&study=123
https://localhost:5180/?viewer=2d&study=123&add=98                 # 1:2 비교
https://localhost:5180/?viewer=2d&study=123&stack=98               # Stack
https://localhost:5180/?viewer=2d&study=123&keysops=1.2.840...7,1.2.840...9
https://localhost:5180/?viewer=2d&study=123&wo_mode=add&wo_ids=98,55
https://localhost:5180/?viewer=2d&study=123&cmp=1                  # Compare 자동 진입
```

### 2.2 판독 창 — `?report=1` (`frontend/src/pages/ReportWindow.tsx`)

```
https://localhost:5180/?report=1&study=123
```

`study=<id>` 하나만 받는다. 창 이름 `sv_report`.

### 2.3 공개(무인증) 딥링크 — `frontend/src/App.tsx`

| URL | 동작 |
|---|---|
| `/?signup=1` | 가입 폼 |
| `/?login=1` | 관리자 로그인(관리자 포털 오리진으로 리다이렉트) |
| `/?client=1` | Client 뷰어 로그인 |
| `/?capture=<token>` | 휴대폰 사진 촬영 페이지 — **토큰 자체가 자격증명**(QR 발급: `POST /api/studies/{id}/mobile-capture`, 사용: `GET/POST /api/mobile-capture/{token}/…`) |

### 2.4 OHIF(Advance View) 딥링크

```
{VITE_OHIF_BASE}/viewer?StudyInstanceUIDs=<StudyUID>[,<UID2>…][&hangingProtocolId=<id>]
예) http://localhost:3001/viewer?StudyInstanceUIDs=1.2.840.113619.2.55.3.1234
```

OHIF 는 DICOM 표준 StudyInstanceUID 를 받으므로 **외부 시스템이 내부 id 없이 호출 가능한 유일한 뷰어 딥링크**다(OHIF 자체는 무인증 — 배포 시 네트워크 계층에서 보호할 것).

---

## 3. 외부 링크/딥링크 (F-21)

`docs/UI_ANALYSIS_PiViewSTAR_화면분석.md` §5.11(INFINITT External Link 분석)에서 정의된 양방향 모델:

- **나가는 링크**: 관리자 설정에 외부 링크 슬롯(제목 + URL 템플릿 + 변수 치환 `{patientId}` `{accessionNumber}` `{studyUid}` `{loginId}`) → 워크리스트/뷰어 컨텍스트 메뉴 노출.
- **들어오는 딥링크**: `/study/{studyUid}?accession={an}` 형태의 표준 진입점.

> **구현 상태(2026-07 기준)**: F-21 은 설계상 **P2 — 전용 백엔드 엔드포인트·설정 키 미구현**이다. 현재 실동작하는 인바운드 딥링크는 §2 의 쿼리 파라미터(내부 id 기반, 인증 세션 필요)와 §2.4 의 OHIF StudyInstanceUID 링크뿐이다. StudyUID→내부 id 변환이 필요하면 `GET /api/worklist` 검색 후 `GET /api/studies/{id}` 를 조합할 것. 존재하지 않는 `/study/{uid}` 라우트를 호출하지 말 것.

---

## 4. REST API 핵심 (외부 프로그램용 엄선)

베이스: `http://<api-host>:8010` (스위트) / 기존 서버는 `:8000`. 인증은 별도 표기 없으면 **JWT Bearer**(`Authorization: Bearer <token>`).

### 4.1 인증

| 메서드·경로 | 설명 |
|---|---|
| `POST /api/auth/login` | 관리자/서버 운영 로그인. Body `{username, password}` → `{token, username, role, hospital_id}`. 연속 실패 시 계정·IP 잠금(security.policy) |
| `POST /api/auth/client-login` | Client 뷰어 3필드 로그인. Body `{hospital_id: "<병원코드 또는 이름>", username, password}` → 토큰. 동일 계정 세션 존재 시 `{duplicate: true}` |
| `POST /api/auth/client-login/force` | 중복 세션 인계(기존 세션 종료 후 발급) |
| `GET /api/auth/profile` · `PUT` | 판독의 정보(이름·면허번호 — 전자서명 원천) |

### 4.2 워크리스트/검사

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/worklist` | 검사 목록. 파라미터: `q` `pid` `pname` `sex` `desc` `modality` `body_part` `status` `date_from/date_to`(YYYYMMDD) `finding` `emergency` `key` `hospital_id` `limit`(≤500) `offset` → `{items, total}` |
| `GET /api/worklist/counts` | 상태별 카운트(SV 상태 바) |
| `POST /api/worklist/nl-query` | 자연어 검색 → 필터 해석(적용은 클라이언트 몫) |
| `GET /api/studies/{id}` | 검사 상세(환자·상태·키이미지 등) |
| `GET /api/studies/{id}/series-tree` | 시리즈→인스턴스 트리. 인스턴스마다 `preview_url` 포함 — 자체 뷰어 썸네일 원천 |
| `GET /api/studies/{id}/instances` | 인스턴스 평면 목록 |
| `POST /api/import-dicom` | DICOM 파일 업로드 수입(multipart) |
| `PUT /api/studies/{id}/memo` · `/bookmark` · `/priority` · `/key-images` | 메모/북마크/우선순위/키이미지 |
| `GET·PUT /api/studies/{id}/annotations` | 주석/계측 조회·저장(정규화 0~1 좌표) |
| `POST /api/studies/{id}/roi-stats` | 서버 픽셀 기반 ROI HU 통계(rect/ellipse 평균·최소·최대·SD·면적) |

### 4.3 렌더 이미지(픽셀)

자체 뷰어의 프레임 로딩은 WADO-RS `/rendered` 를 쓴다(백엔드 아님 — OHIF nginx 프록시 경유):

```
GET {DICOMWEB_ROOT}/studies/{StudyUID}/series/{SeriesUID}/instances/{SOPUID}/rendered[?window=C,W][&accept=image/jpeg&quality=N]
예) http://localhost:3001/dicom-web/studies/1.2…/series/1.2…/instances/1.2…/rendered?window=40,400
```

썸네일은 Orthanc 네이티브 `GET /instances/{orthancId}/preview`(프록시 경로 `/orthanc/...`). Accept 헤더 함정은 §5.2 참조.

### 4.4 판독(리포트)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/studies/{id}/reports` | 판독 버전 이력(초안→수정→확정 전 버전 보존) |
| `PUT /api/reports/{id}` | 판독 수정. Body `{sr_json}`(Structured Report 스키마). 권한 `report.write`. 확정 잠금 중 409 |
| `POST /api/reports/{id}/finalize` | 확정(전자서명 — 프로필의 이름·면허번호가 `diff_metrics.signature` 에 기록) |
| `POST /api/reports/{id}/suspend` | 판독 보류(suspended) |
| `POST /api/reports/{id}/confirm2` | F-17 2차 승인(Conf2) |
| `GET /api/reports/{id}/export?format=pdf\|fhir` | 판독서 출력 — PDF(키이미지 자동 첨부) 또는 FHIR DiagnosticReport |
| `POST /api/reports/{id}/send-sr` | DICOM Basic Text SR 생성 → 동일 StudyUID 로 Orthanc 저장 |
| `POST /api/reports/merge` | 묶음판독(동일 환자 다검사 병합) |
| `POST /api/reports/batch-finalize` | F-22 일괄 확정(critical 자동 제외) |
| `POST /api/studies/{id}/report-lock` | 판독 확정 잠금(Fixed) 토글 — 잠금 중 모든 판독 변이 경로 409 |

### 4.5 오더(MWL/RIS)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/orders` | 파라미터 `status` `date`(YYYYMMDD) `taken`(yes/no — 장비가 MWL 로 가져갔는지) `hospital_id` `limit` |
| `POST /api/orders` | 오더 등록. Body: `patient_key`(필수), `patient_name`(PN `Last^First`), `birth_date`, `sex`, `accession_no`(빈값=자동 채번), `modality`, `scheduled_date/time`, `procedure_desc`, `station_aet`, `body_part`, `projection`, `dicom_study_id`, `hospital_id` |
| `PUT /api/orders/{id}` | 수정(scheduled 만) · `DELETE` 삭제 · `PUT /{id}/status` 상태 전이 |
| `POST /api/orders/export-mwl` | scheduled 오더 → `.wl` 파일 내보내기(Orthanc worklists 폴더) |

### 4.6 외부 AI 결과 병합 (F-12)

```
POST /api/studies/{id}/external-ai
Body: { "vendor": "엔진명(필수, ≤64자)",
        "results": [ { "finding": "...", "confidence": 0.0~1.0,
                       "severity": "normal|minor|significant|critical", ... } ]  # 1~50건
      }
```

초안 findings 에 `[외부AI vendor]` 라벨로 병합. critical → 응급 승격. 확정본·잠금 검사에는 409.

### 4.7 HL7 / 원격판독

| 메서드·경로 | 설명 |
|---|---|
| `GET·PUT /api/hl7/hospitals/{hid}/config/{key}` | 병원별 연동 설정 — `hl7.config`(MLLP 수신) · `remote.reading`(`{enabled, api_key}`) · `mwl.config` · `testgen.config` |
| `GET /api/hl7/hospitals/{hid}/inbox` · `/outbox` | ADT/ORM(수신)·ORU(발신) 중간테이블 조회 |
| `POST /api/hl7/inbox/{mid}/reprocess` · `/outbox/{mid}/send` · `/outbox/sync` | 재처리/발신 |
| `POST /api/hl7/ingest` | HL7 원문 직접 주입(MLLP 없이 동일 처리 경로 — 관리자) |
| `GET·POST /api/hl7/listener/status` · `/start` · `/stop` | MLLP 리스너 제어 |
| `GET·POST /api/hl7/hospitals/{hid}/mwl/status` · `/start` · `/stop` | 병원별 MWL SCP 제어 |
| `POST /api/hl7/remote-report` | **원격판독 입력 창구 — JWT 아님, 병원 API 키 인증.** Body `{hospital_key, accession 또는 study_uid, reading(필수), conclusion?, reporter?}`. 키 실패 누적 시 IP 잠금(429), 확정 잠금 검사 409 |

### 4.8 설정

`GET·PUT /api/settings/{key}` — **화이트리스트 키만**(`backend/app/api/settings.py ALLOWED_KEYS`). PUT Body `{value: {...}, scope: "user"|"global"}`. 주요 키: `ai.policy`(AI 정책 — `draft_enabled` 포함), `pdf.template`, `viewer.prefs`, `worklist.prefs`, `dicom.nodes`(전역), `mode.profiles`(전역).

---

## 5. DICOM 연동

### 5.1 C-STORE 수신 (Orthanc SCP)

| 항목 | 값(스위트) |
|---|---|
| AE Title | `SVVIEWER` (`SVVIEWER_AET` env, 기본값) |
| DICOM 포트 | **4243** (컨테이너 내부 4242 매핑) |
| HTTP/REST | **8043** (내부 8042), 계정 `saintview` / `saintview_dev` (인증 기본 비활성 — 운영 시 `ORTHANC_AUTH=true`) |
| 문자셋 | `DefaultEncoding=Korean` — 태그(0008,0005) 없는 국산 DICOM 을 EUC-KR 로 해석 |
| 수신 정책 | `ORTHANC_CHECK_MODALITY_HOST`(등록 장비만) · `ORTHANC_CHECK_CALLED_AET` · `ORTHANC_DICOM_SERVER_ENABLED` — compose env |

장비 노드 등록: 설정 `dicom.nodes` 편집 후 `POST /api/admin/dicom-nodes/apply` → Orthanc DicomModalities 런타임 반영. 수신 검사는 백엔드 워커가 자동으로 워크리스트 DB 에 동기화하고, 수신 AET→장비→병원으로 테넌시 귀속된다.

### 5.2 DICOMweb (QIDO-RS / WADO-RS)

- 루트: `/dicom-web/`(Orthanc DicomWeb 플러그인). 외부에서는 **OHIF nginx(:3001)** 경유 접근 권장 — CORS 헤더가 여기서 부여된다.
  - QIDO: `GET /dicom-web/studies?PatientID=...`
  - WADO-RS: `GET /dicom-web/studies/{uid}/series/{uid}/instances/{uid}` · `/frames/1` · `/rendered`
- **⚠ `/rendered` Accept 함정(핵심)**: Orthanc 는 브라우저 `<img>` 의 `Accept: image/avif,image/webp,…` 를 **400 으로 거부**하고 `?accept=` 쿼리는 무시한다(헤더만 인정). 스위트 nginx(`deploy/ohif/nginx-default.conf`)가 `/rendered` 요청의 Accept 를 기본 `image/png` 로 강제하고 `?accept=image/jpeg`(+`quality=N`) 쿼리를 헤더로 승격한다. **nginx 를 우회해 Orthanc(:8043)로 직접 `/rendered` 를 호출하는 외부 프로그램은 반드시 `Accept: image/png` 또는 `image/jpeg` 헤더를 명시**할 것.
- `/rendered` 캐시: 200 응답에 한해 1시간 private(정정 재전송 대비 immutable 금지).

### 5.3 MWL (Modality Worklist)

1. **파일 기반(Orthanc worklists 플러그인)** — `POST /api/orders/export-mwl` 이 scheduled 오더를 `.wl` 파일로 `deploy/worklists/` 에 생성 → 장비 C-FIND(MWL)에 Orthanc 가 응답.
2. **병원별 실시간 MWL SCP(pynetdicom)** — `mwl.config {enabled, port, aet, registered_only}` 설정 후 `POST /api/hl7/hospitals/{hid}/mwl/start`. DB 오더에 직접 응답하고 `taken_aet/taken_at` 을 기록.

### 5.4 MPPS

백엔드 내장 MPPS SCP — 스위트 기본 포트 **11113**, AET `SVVIEWER`(`backend/.env` — 메인 Saintview 11112 와 충돌 회피). 장비의 N-CREATE/N-SET 수신 → 오더 상태 전이(`IN PROGRESS→in_progress`, `COMPLETED→completed`, `DISCONTINUED→cancelled`).

---

## 6. DB 직접 연동

### 접속 정보(스위트 기본값)

```
postgresql://saintview:saintview_dev@<host>:5434/saintview     # pgvector/pg16
```

(본체 compose 는 5433 — 스위트는 충돌 회피로 **5434**. 비밀번호는 compose env `SAINTVIEW_DB_PASSWORD`.)

### 주요 테이블 (`backend/app/models/entities.py`)

| 테이블 | 핵심 컬럼 |
|---|---|
| `patients` | `patient_key`(원본 Patient ID, unique) · `issuer` · `name_masked` · `birth_date`(YYYYMMDD) · `sex` |
| `studies` | `study_uid`(unique) · `patient_id`(FK) · `accession_no` · `study_date/time` · `modality` · `body_part` · `study_desc` · `status`(received\|draft_ready\|reading\|finalized) · `emergency` · `key_images`(JSON) · `orthanc_id` · `hospital_id`(테넌시) · `report_locked` · `institution` · `referring_physician` · `memo` · `bookmark` |
| `reports` | `study_id`(FK) · `version`(버전 행 보존) · `status`(draft\|in_review\|finalized\|rejected) · `sr_json` · `narrative_text` · `created_by`('ai'\|username) · `finalized_at` · `diff_metrics`(F-20 지표·전자서명) |
| `orders` | `patient_key` · `patient_name` · `accession_no` · `modality` · `scheduled_date/time` · `procedure_desc` · `station_aet` · `status` · `taken_aet/taken_at` · `hospital_id` |
| `annotations` | `study_id` · `series_uid` · `sop_uid` · `kind`(length\|angle\|rect\|ellipse\|arrow\|text\|ctr…) · `points`(0~1 정규화 JSON) · `value`/`unit` · `source`(user\|ai) · `confidence` |

> **권장: 읽기 전용으로만 사용하고, 쓰기는 반드시 REST API 를 경유하라.** 상태 전이 검증·확정 잠금·병원 테넌시·감사 로그가 모두 서비스 계층에 있어, 직접 INSERT/UPDATE 는 워크플로 정합성을 깨뜨린다. 스키마는 Alembic 마이그레이션으로 변경되므로 컬럼 고정 가정도 금물.

---

## 7. 인증·보안

- **JWT Bearer**: 만료 기본 480분(`SAINTVIEW_JWT_EXPIRE_MINUTES`), 서명 `SAINTVIEW_JWT_SECRET`(HS256 — 운영 32자 이상 필수, prod 게이트가 기본값 기동 거부). 토큰에 병원 스코프(`hid`)·세션(`sid`) 포함.
- **계정 역할 5종**(`services/permissions.py`): `admin` · `doctor` · `radiologist` · `technologist` · `staff`. 역할→권한 매트릭스는 병원별 오버라이드 가능, API 는 `report.write`/`report.finalize`/`report.print` 등 권한 키로 게이트.
- **비-JWT 예외**: `POST /api/hl7/remote-report`(병원 API 키) · `?capture=<token>`(1회성 토큰).
- **무차별 대입 방어**: 로그인·원격판독 키 실패 누적 → 계정·IP 잠금(security.policy). 중복 로그인은 세션 인계.
- **HTTPS 자체서명**: 프론트(:5180)는 HTTPS 전용(인증서 없으면 기동 거부 — 런처가 자동 생성). 프로그램적 호출은 TLS 검증 예외 필요. 운영 전환 시 정식 인증서 권장.
- **CORS**: 스위트 백엔드는 `https://localhost:5180`(+메인 포털 3종)을 기본 허용하고, **`SAINTVIEW_CORS_ORIGINS`**(콤마 구분)로 외부 도메인을 추가한다. 모드 B 는 대상 서버에 스위트 오리진 등록 필요.

---

## 8. 설정 env 표

### 백엔드 (`backend/app/config.py` — `.env.example` 참조)

| env | 기본값 | 스위트 값/비고 |
|---|---|---|
| `SAINTVIEW_ENV` | `dev` | `prod` 시 기본 시크릿 기동 거부 |
| `SAINTVIEW_DATABASE_URL` | `sqlite:///./dev.db` | `postgresql+psycopg2://saintview:...@localhost:5434/saintview` |
| `SAINTVIEW_JWT_SECRET` | `dev-only-change-me` | 운영 32자 이상 |
| `SAINTVIEW_ORTHANC_URL` | `http://localhost:8042` | 스위트: `http://localhost:8043` |
| `SAINTVIEW_ORTHANC_USER/PASSWORD` | `saintview`/`saintview_dev` | |
| `SAINTVIEW_ORTHANC_PREVIEW_BASE` | `/orthanc` | 브라우저 썸네일 베이스(상대=Vite 프록시) |
| `SAINTVIEW_OHIF_URL` | `http://localhost:3000` | 스위트: `:3001` |
| `SAINTVIEW_API_URL` | `http://localhost:8000` | 스위트: `:8010` |
| `SAINTVIEW_PG_HOST/PG_PORT` | `localhost`/`5433` | 스위트: `5434` |
| `SAINTVIEW_CORS_ORIGINS` | — | **스위트 추가** — 콤마 구분 오리진 병합(§7) |
| `SAINTVIEW_AI_MODE` | `mock` | `live` 는 실 Claude API 호출(비용) |
| `SAINTVIEW_AI_DRAFT_ENABLED` | (미설정) | **AI 판독 초안 보류(기본 OFF)** — 활성화는 설정 `ai.policy.draft_enabled`(GUI), env 는 테스트 오버라이드. 비활성 중 `/analyze` 409 |
| `SAINTVIEW_MWL_DIR` | `../deploy/worklists` | Orthanc 마운트와 일치시킬 것 |
| `SAINTVIEW_MPPS_ENABLED/PORT/AET` | `1`/`11112`/`SAINTVIEW` | 스위트: `11113`/`SVVIEWER` |
| `SAINTVIEW_SIGNUP_ENABLED` | `0` | 공개 자가가입 on/off. **기본 OFF** — 켜면 무인증으로 병원+관리자 계정이 생성되고, 그 계정으로 로그인하면 Live 픽셀 쿠키(sv_pix)가 나온다(= PHI 픽셀 게이트 우회). `prod` 는 켜져 있으면 기동을 거부한다(`validate_for_prod`). 켠 상태에서도 생성된 병원·계정은 `enabled=False`(승인 대기)라 운영자가 관리자 콘솔에서 활성화해야 로그인된다. |

### compose (`deploy/docker-compose.yml`)

| env | 기본값 | 비고 |
|---|---|---|
| `SAINTVIEW_DB_PASSWORD` | `saintview_dev` | PostgreSQL |
| `ORTHANC_PASSWORD` / `ORTHANC_AUTH` | `saintview_dev` / `false` | 운영 시 true |
| `SVVIEWER_AET` | `SVVIEWER` | 수신 AE Title |
| `ORTHANC_CHECK_MODALITY_HOST` / `ORTHANC_CHECK_CALLED_AET` / `ORTHANC_DICOM_SERVER_ENABLED` | `false`/`false`/`true` | SCP 수신 정책 |

### 프론트엔드 (`frontend/.env`)

| env | 스위트 값 | 비고 |
|---|---|---|
| `VITE_PORT_CLIENT` | `5180` | 이 포트 접속 = Client 포털 부팅 |
| `VITE_API_BASE` | (빈값) | 같은 출처 프록시 / 모드 B: 대상 서버 절대 URL |
| `VITE_DICOMWEB_ROOT` | `/dicom-web` | WADO-RS `/rendered` 루트(자체 뷰어 픽셀) |
| `VITE_OHIF_BASE` | `http://localhost:3001` | Advance View 딥링크 베이스 |
| `VITE_VIEWER_BASE` | (빈값=같은 출처) | 뷰어 창 별도 출처 분리 시 (아래 제약 참조) |

> **`VITE_VIEWER_BASE` 배치의 제약** — 뷰어 창이 워크리스트와 **다른 오리진**이 되면 `localStorage`
> 를 공유하지 못한다. 그래서 다중 모니터 슬롯 장부(`sv_vslot_*`)와 다운로드 모드 저장본(OPFS)이
> 워크리스트 쪽에서 보이지 않는다.
> · 다중 모니터 순번: 워크리스트가 자기 창 핸들(`!w.closed` — 교차 출처에서도 읽힌다)로 생존을
>   판정해 **정상 동작한다**. 다만 워크리스트를 새로고침하면 핸들이 사라지므로 그 직후 한 번은
>   '첫 오픈'(선택 전 모니터에 같은 검사)으로 다시 시작한다. 같은 출처 배치에서는 장부가 남아
>   순번이 그대로 이어진다.
> · 다운로드 모드: 이 배치에서는 기능 자체가 비활성이다(`lib/opfsStore.ts` 가 안내 문구 표시).
| `SV_API_URL` / `SV_DICOMWEB_URL` / `SV_ORTHANC_URL` | 8010/3001/8043 | vite 프록시 대상(기동 프로세스 env) |

---

*본 명세의 경로·파라미터는 2026-07-20 기준 `backend/app/api/*`, `frontend/src/pages/*`, `deploy/*` 소스에서 확인된 실구현이다. F-21(§3)만 설계 문서 기반 미구현(P2) 항목으로 명시한다.*
