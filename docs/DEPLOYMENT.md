# Viewer Suite 배포 가이드 — 타 PACS Server 연동용 (WebPACS 브리지 포함)

> 이 문서는 배포 패키지(`deploy/make_dist.py` 산출 zip)를 새 사이트에 설치하고
> 대상 PACS 서버와 연동하는 절차의 단일 기준이다.

## 1. 패키지 만들기 (개발 PC)

```bash
cd frontend && npm run build     # 프로덕션 dist 생성
cd .. && py -3.11 deploy/make_dist.py
# → build/SaintviewViewerSuite-dist-<날짜>-<해시>/ + 동명 .zip
```

시크릿(backend/.env·frontend/certs 개인키)은 자동 제외되며, 포함 시 빌드가 실패한다.

## 2. 사이트 요구사항 (뷰어 서버 PC)

| 항목 | 요구 |
|---|---|
| OS | Windows 10/11 (런처 기준. Linux 는 수동 기동 절차 준용) |
| Docker Desktop | 필수 — PostgreSQL(pgvector)·Orthanc·OHIF 컨테이너 |
| Python | 3.11 (`py -3.11`) + `pip install -r backend/requirements.txt` |
| Node.js | 22 + npm (프론트 vite 구동·재빌드용) |
| OpenSSL | 권장 — 런처가 HTTPS 자체서명 인증서 자동 생성(없으면 Git 동봉본 사용) |
| 포트 | **8010**(API) · **5180**(뷰어 HTTPS) · **8043/4243**(Orthanc HTTP/DICOM) · **5434**(PG) · **3001**(OHIF) · 11113(MPPS) |
| 디스크 | 가져온 검사가 Orthanc 볼륨에 원본 저장 — 검사량 기준 여유 확보 |

## 3. 설치·기동

```bash
# 1) zip 해제 후 루트에서
cd backend && py -3.11 -m pip install -r requirements.txt && cd ..
cd frontend && npm install && cd ..

# 2) 원클릭 기동 (Docker 확인→인증서 생성→백엔드 8010→뷰어 5180)
start_viewer_suite.bat

# 3) 최초 1회 — 샘플 병원·계정 시드(Client 로그인용)
cd backend && py -3.11 seed_sample.py
```

- 접속: `https://localhost:5180` (자체서명 — 최초 1회 경고 통과)
- 로그인: 병원 `SAMPLE01` / `sample_admin`(또는 `sample_dr`) / `sample1234` — 운영 전 변경
- 시스템 관리자 API 계정: `admin`/`admin1234` — 운영 전 변경
- 운영 전환 시: `backend/.env` 에 `SAINTVIEW_ENV=prod` + `SAINTVIEW_JWT_SECRET`(32자+)·
  관리자/Orthanc 비밀번호 지정(prod 게이트가 기본값 거부), `deploy/docker-compose.prod.yml` 오버레이 적용.

## 4. 대상 PACS 서버 연동 — 경로 2가지

### A. WebPACS 브리지 (인계 계열 webpacs_api 서버 — 권장)

대상 서버가 SaintViewPACS(webpacs_api) 계열일 때. 원격 REST 로 검사를 탐색하고
DICOMweb v2 인스턴스(서버가 AES 복호화·HTJ2K 정규화한 표준 DICOM)를 받아
스위트 Orthanc 로 미러 → 우리 뷰어 전 기능 동작. 자세한 계약: `docs/INTEGRATION_WEBPACS.md`.

**연동 전 준비물 체크리스트**

- [ ] 대상 API base URL (예: `https://api.<병원>.co.kr` — Nginx 뒤 8014)
- [ ] 원격 PACS 계정 — `pacs_users.user_type` 에 **'P' 포함**(브리지 전용 계정 발급 권장), ID/PW
- [ ] 네트워크: 뷰어 서버 → 대상 API 아웃바운드(443 또는 8014) 허용. 인바운드/CORS 는 불필요(서버-서버)
- [ ] SSL: 공인 인증서면 "SSL 검증" ON, 자체서명이면 OFF
- [ ] 대상 서버가 DICOMweb v2 를 서비스하는지 확인:
      `GET {base}/api/dicomweb/v2/` (Bearer) → Capability JSON 이면 OK
- [ ] 가져온 검사를 귀속할 병원(스위트 병원 마스터의 id) 결정

**설정 방법(둘 중 하나)**

1. GUI: 워크리스트 우측 **[WebPACS]** → ⚙ 접속 설정(관리자) → 주소/계정/SSL/자동 동기화 → 저장 → [연결 테스트]
2. env(운영 권장 — DB 평문 저장 회피):
   `SAINTVIEW_WEBPACS_BASE_URL` / `SAINTVIEW_WEBPACS_USER` / `SAINTVIEW_WEBPACS_PASSWORD` /
   `SAINTVIEW_WEBPACS_ENABLED=1` / `SAINTVIEW_WEBPACS_VERIFY_SSL=0|1` (env 가 GUI 설정보다 우선)

**검수 절차**: 연결 테스트(원격 검사 수 표시) → 검색 → 검사 1건 [가져와서 열기] →
뷰어 표시·`/rendered` 정상 → 필요 시 "자동 동기화" ON(워커 ≈60초, 최신 N건).

**운용 특성**: 멱등(동일 StudyUID 재가져오기 안 함) · `source_aet=WEBPACS` 표기 ·
판독문은 가져오지 않음(영상만 — 판독 연동은 후속 과제).

### B. 표준 DICOM 연동 (타 벤더 PACS·장비 공통)

대상이 webpacs_api 계열이 아니면 표준 경로 사용 — 별도 어댑터 없이 동작:

- **C-STORE 수신**: 대상 PACS/장비에서 스위트 Orthanc 로 전송 — **AET `SVVIEWER`, 포트 `4243`**.
  수신 검사는 워커가 자동으로 워크리스트에 등록(수신 AET→장비→병원 자동 귀속).
- **DICOMweb push**: `POST http://<뷰어서버>:8043/dicom-web/studies` (STOW-RS) 또는
  Orthanc REST `POST /instances`.
- **파일 반입**: 워크리스트 [Import](USB/CD) 또는 `POST /api/import-dicom`.
- 방화벽: 대상 → 뷰어 서버 4243(DIMSE)/8043(HTTP) 인바운드 허용. 필요 시 스위트 장비
  등록(관리 콘솔)로 수신 AET 화이트리스트.

### C. 반대 방향(우리 뷰어를 타 시스템에서 열기)

HIS/타 PACS 워크리스트에서 우리 뷰어를 딥링크로 여는 통합은 `docs/INTEGRATION.md`
(딥링크 `?viewer=2d&study=`·OHIF `StudyInstanceUIDs=`·REST·원격판독 API 키) 참조.

## 5. 문제 해결

| 증상 | 확인 |
|---|---|
| 연결 테스트 실패(로그인) | 계정 user_type 'P' 여부·비밀번호·1시간 5회 실패 잠금(대상 서버 정책) |
| 연결은 되나 목록 0건 | 대상 계정의 병원/센터 권한 스코프(pacs_study_view 필터) |
| 가져오기 일부 실패(failed>0) | 대상 v2 인스턴스 404(DB-스토리지 불일치)·MinIO 장애 — 상태 폴링의 error 확인 |
| 뷰어 픽셀 안 보임 | 스위트 Orthanc(8043) 기동·`/dicom-web/.../rendered` 200 확인(OHIF nginx 3001 경유) |
| 5180 접속 불가 | HTTPS 전용 — 인증서 생성 여부(`frontend/certs`), 런처 재실행 |
