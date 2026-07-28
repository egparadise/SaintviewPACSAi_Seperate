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
- 공개 자가가입(`SAINTVIEW_SIGNUP_ENABLED`)은 **기본 0(꺼짐)** 이고, prod 는 켜져 있으면
  기동을 거부한다. 무인증 `POST /api/signup` 이 즉시 로그인 가능한 계정을 만들면 그것만으로
  Live 픽셀(PHI) 인증이 우회되기 때문이다(로그인이 `sv_pix` 쿠키를 발급한다). 켜 두더라도
  가입이 만든 병원·계정은 `enabled=False`(승인 대기)이므로 관리자 콘솔에서 활성화해야 쓸 수 있다.

### 3-1. 단일 워커 배포 계약 (⚠ 필독 — 운영 항목)

**이 백엔드는 단일 워커 전용이다.** `--workers 2` 이상(또는 gunicorn `-w 2`,
환경변수 `WEB_CONCURRENCY≥2`)으로 띄우면 **에러 없이 조용히 오작동한다.**
캐시·락·인플라이트·세션이 전부 프로세스 인메모리(모듈 전역 dict)이기 때문이다.

기동 명령은 `--workers` 를 쓰지 않는다 — `start_viewer_suite.bat`(포트 8010),
`backend/server_restart.bat`(포트 8000) 모두 `py -3.11 -m uvicorn app.main:app --port … --log-level warning`.
`deploy/nginx-viewer.conf` 의 업스트림도 `proxy_pass http://127.0.0.1:8010` **단일**이다.

**워커가 2개 이상이면 무슨 일이 나는가** (파일:행 — 전부 프로세스 인메모리 전역):

| 구분 | 위치 | 워커가 늘면 |
|---|---|---|
| 기능 파손 | `app/services/webpacs_session.py:16` `_SESSIONS`(sid→A 토큰) | 로그인한 워커가 아닌 곳으로 요청이 가면 A 세션이 없다 → **401·재로그인이 랜덤 발생** |
| 보안 약화 | `app/services/security_service.py:355-357` `_fail_counts`/`_locked_until` | 로그인 실패 잠금이 워커별로 세어져 **임계값이 실질 N배**(워커 4면 5회 잠금이 20회까지 허용) |
| 캐시 손상 | `app/services/webpacs_live.py:497-523` `_INFLIGHT`/`_sop_lock`, `:545` `.part` 임시파일 | SOP 직렬화가 프로세스 안에서만 성립 → 같은 SOP 중복 다운로드. 임시파일명이 `threading.get_ident()` 기반이라 **서로 다른 워커가 같은 `.part` 에 동시 기록** |
| 메모리 N배 | `webpacs_live.py:623-625` `_DECODE_CACHE`(~300MB) + `:737-740` `_ENC_CACHE`(192MB) + `app/api/stt.py:25` `_model_cache` | 워커마다 따로 잡혀 **상한 설계가 무의미** — 워커 4면 2GB+ 가 그냥 곱해져 OOM |
| 캐시 무효화 누락 | `webpacs_live.py:578` `invalidate_instance()` | 자기 워커 캐시만 지운다 → 손상 디코드가 다른 워커에 남아 **특정 요청만 계속 실패** |
| 프루닝 붕괴 | `webpacs_live.py:592-594`, `app/api/htj2k_stream.py:39-41` `_prune_counter` | 프루닝 주기가 N배로 늘어 디스크 상한(HTJ2K 기본 4096MB) 초과 + 다른 워커가 쓰는 중인 파일 삭제 |
| 중복 작업 | `webpacs_live.py:768-769` `_prefetching`, `htj2k_stream.py:28` `_inflight_series`, `app/services/webpacs_bridge.py:414`·`:547` | 같은 작업을 워커 수만큼 동시 수행(프리페치 8스레드×N, OpenJPH 인코딩 CPU 폭증) |
| 표시 불일치 | `worklist.py:234-237`·`webpacs_live.py:387-389` `_TREE_CACHE`, `:177-180` `_HEARTBEAT` | 적중률 1/N + 갱신값과 낡은 값이 번갈아 보임. '다른 사람이 판독 중' 표시가 새로고침마다 나타났다 사라짐 |
| 세션 파손 | `app/api/mobile.py:25` `_SESS`(QR 촬영 토큰) | 업로드가 토큰 발급 워커와 다른 곳으로 가면 토큰 무효 |
| 배경작업 중복 | `main.py` worker_loop·MPPS, `webpacs_sse.py:110`, `ddns_service.py:168` | AI 잡 중복 실행(live 모드면 **중복 과금**), A SSE 연결 N개, DDNS API N배 호출 |
| 포트 충돌 | `app/services/mwl.py:139`, `hl7.py:352`, `app/dicom/mpps_scp.py`(11112) | 2번째 워커부터 bind 실패. MPPS 는 예외를 삼키므로 **조용히 반쪽만 동작** |

**게이트 동작** (`app/config.py`)
- `detect_worker_plan()` 이 `sys.argv` + `WEB_CONCURRENCY` 만 보고 워커 수를 판정한다
  (uvicorn·gunicorn 모두 워커 프로세스 안에서도 `sys.argv` 가 마스터 것 그대로 보존된다).
- `SAINTVIEW_ENV=prod` + 워커 ≥2 가 **확실**하면 `validate_for_prod()` 가 기존 시크릿 게이트와
  같은 자리에서 `RuntimeError` 를 던진다. dev 는 절대 거부하지 않고 `logger.error` 경고만 남긴다.
- ⚠ **예외만으로는 '기동 거부'가 되지 않는다 — 다중 워커 모드에서는 무한 재기동 루프다.**
  `validate_for_prod()` 는 `lifespan` 안에서 호출되므로 예외가 나는 곳은 **워커 자식 프로세스**다.
  uvicorn(`supervisors/multiprocess.py`)은 0.5초마다 `keep_subprocess_alive()` 로 죽은 워커를
  무한히 다시 띄운다(gunicorn arbiter 도 동일). 실측(uvicorn 0.34.0, `app.main:app --workers 2`,
  `SAINTVIEW_ENV=prod`): **30초에 `Started server process` 8회 / `Application startup failed` 8회,
  로그 1334줄, 마스터는 끝까지 살아 있음.** 사이클마다 앱 전체를 spawn 으로 재import 하므로
  (≈3.7초/회) SQLAlchemy·STT 로더까지 매번 다시 올라가며 그 시간이 전부 CPU 다.
  포트는 `netstat` 에 **LISTEN 으로 뜨지 않는다**(마스터가 `bind_socket()` 으로 bind 만 하고
  `listen()` 은 워커가 하기 때문). 그러나 소켓은 점유돼 있어 다른 프로세스는 bind 에 실패하고,
  클라이언트에게는 connection refused 로 보인다.
- 그래서 게이트는 예외를 던지기 **전에** 마스터에게 `SIGTERM` 을 보내 루프를 끊는다
  (`config.terminate_worker_master()`). 아래 조건이 **전부** 맞을 때만 보낸다:
  ① `SAINTVIEW_WORKER_GATE_KILL_MASTER` 가 `0` 이 아니다(운영자 탈출구) /
  ② plan 이 `certain` + `workers≥2` + server 확정 /
  ③ **진짜** `sys.argv[0]` 이 그 서버 CLI 다(모의된 plan·pytest 를 여기서 차단) /
  ④ `os.getppid()` 가 0/1 이 아니다 / ⑤ 리눅스면 `/proc/<ppid>/cmdline` 에 그 서버 이름이 있다.
  하나라도 어긋나면 마스터를 건드리지 않고 예외만 던지며, 그때는 위 재기동 루프가 되므로
  예외 메시지에 붙는 안내대로 **마스터를 직접 종료**해야 한다:
  `pkill -f 'uvicorn.*--workers'` 후 `--workers 1` 로 재기동.
- 판정 규칙(오탐 방지):
  `--reload` 가 있으면 uvicorn 이 workers 를 무시하므로 **1로 확정** /
  명시 플래그(`--workers`·`-w`)가 `WEB_CONCURRENCY` 를 **이긴다** /
  `argv[0]` 이 uvicorn·gunicorn CLI 가 아니면 아예 판단하지 않는다(pytest·alembic·래퍼 오탐 차단).
- 런타임 백스톱: `app/services/worker_guard.py` 가 기동 12초 뒤 같은 부모 아래 살아있는 형제
  워커 수를 1회 세어, 2 이상이면 `logger.error` + `/api/status` 에
  `multi_worker:true`·`worker_count` 로 노출한다. **여기서는 절대 거부하지 않는다**
  (이미 서비스 중인 워커를 죽이면 supervisor 재기동 루프가 된다).
  '형제' 정의는 ppid 하나로는 성립하지 않아 네 겹으로 좁혔다 — 전부 **오탐 방지**가 목적이다:
  · `os.getppid() <= 1` 이면 **검사 자체를 포기**(`worker_count:null`). systemd Type=simple 이나
    컨테이너 init 밑에서는 여러 인스턴스의 ppid 가 모두 1 이라 서로를 형제로 오인한다.
    (지금 리눅스 재기동 경로 `update_server.sh` 의 `setsid xargs -0 nohup` 은 **xargs 가 살아서
    부모로 남으므로** ppid 가 인스턴스마다 고유하다 — 이 경로에서는 해당 없다.)
  · 마커 디렉터리를 **설치경로+포트 해시**로 스코프한다(`/tmp/saintview-worker-guard/<scope>/`).
    `/tmp` 는 호스트 전역이라(systemd 기본 `PrivateTmp=no`) 무관한 백엔드와 섞일 수 있다.
  · 마커에 부모·자신의 **starttime**(`/proc/<pid>/stat` 22번째 필드)을 적고 계수 시 대조한다 →
    pid 재사용(리눅스 기본 `pid_max=32768`)으로 살아난 유령 형제를 배제한다.
  · **좀비(state=Z)는 죽은 것으로 센다.** `/proc/<pid>` 는 좀비에도 존재한다 —
    `update_server.sh` 가 `kill -0` 을 버리고 포트 해제로 종료를 판정하는 것과 같은 함정이다.
  · 윈도우에는 starttime 대조가 없다(`proc_identity()` 가 `''`) — 리눅스 전용 강화다.

**게이트가 못 잡는 두 경우 — 사람이 지켜야 한다**
1. **gunicorn 설정 파일**: `-c gunicorn.conf.py` 안의 `workers = 2` 는 argv/env 어디에도 안 나온다.
   → 기동 게이트는 `certain=False` 로 두고 경고만 한다(런타임 백스톱이 12초 뒤 잡는다).
2. **nginx 로 독립 uvicorn 여러 대를 로드밸런싱**: 각 프로세스는 자기가 유일하다고 믿으므로
   **어떤 in-process 방법으로도 감지할 수 없다.** 지금 `deploy/nginx-viewer.conf` 의 업스트림은
   `127.0.0.1:8010` 단일이라 해당 없지만, **업스트림을 늘리는 순간 이 게이트는 아무 보호도 못 한다.**

**정말 워커를 늘려야 한다면** — 상태를 프로세스 밖으로 먼저 빼야 한다(순서대로):
① `webpacs_session._SESSIONS` 와 `security_service._fail_counts`/`_locked_until` 을 DB/Redis 로
(정합성·보안이 걸린 것부터) → ② `_INFLIGHT`/`_prefetching`/`_inflight_series`/`_AUTO_SYNC_RUNNING`
을 파일락 또는 Redis 락으로 → ③ 디코드·인코드 LRU 를 공유 캐시로 →
④ MPPS/MWL/MLLP/SSE/DDNS/ai_worker 같은 싱글턴 배경작업을 별도 단일 프로세스로 분리.

**운영 중 확인**
```bash
curl -s http://127.0.0.1:8010/api/status | grep -o '"multi_worker":[a-z]*'   # false 여야 정상
ps -o pid,ppid,cmd -C python | grep uvicorn                                  # 같은 ppid 형제가 1개여야 정상
```

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
