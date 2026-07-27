# 웹 설치 빠른 가이드 — webpacs_api 계열 서버에 붙이기

> 대상: 인계 계열(SaintViewPACS / **webpacs_api**) PACS 운영서버에 이 뷰어를 붙여
> **웹으로 동작**시키는 절차. 배포 zip(`SaintviewViewerSuite-dist-*.zip`) 기준.
> 상세·문제해결은 `docs/DEPLOYMENT.md`, 연동 계약은 `docs/INTEGRATION_WEBPACS.md`.

---

## 0. 개념 — 무엇이 어디서 도는가

```
[사용자 브라우저]  ──HTTPS──▶  [뷰어 서버 PC] ──아웃바운드──▶ [대상 A: webpacs_api 운영서버]
 https://<뷰어서버IP>:5180        (이 zip 설치처)                (기존 PACS — 그대로 둠)
                                  ├ 프론트(vite :5180)
                                  ├ 백엔드(FastAPI :8010) ← A에서 받은 DICOM 서버측 디코드·렌더
                                  └ Docker: PostgreSQL·Orthanc·OHIF
```

- **A(기존 PACS)는 건드리지 않습니다.** 코드 변경·재기동·포트 개방 불필요.
- 뷰어 서버가 A로 **나가는(outbound)** 방향만 통신 → A쪽 방화벽/CORS 설정 변경 없음.
- 사용자는 뷰어 서버 IP로 브라우저 접속만 하면 됩니다(순수 웹).

---

## 1. 뷰어 서버 PC 준비물

| 항목 | 비고 |
|---|---|
| Windows 10/11 | 런처(.bat) 기준. Linux 는 수동 기동 |
| Docker Desktop | PostgreSQL·Orthanc·OHIF 컨테이너 |
| Python 3.11 (`py -3.11`) | 백엔드 + **서버측 DICOM 디코드**(pylibjpeg 코덱) |
| Node.js 22 + npm | 프론트 vite |
| 가용 포트 | **5180**(뷰어) · **8010**(API) · 8043/4243(Orthanc) · 5434(PG) · 3001(OHIF) |
| 아웃바운드 | 뷰어서버 → A(443 또는 8014) 허용 |

원격 접속(다른 PC에서 브라우저로)이면 뷰어 서버가 5180 을 **HTTPS**로 열어야 합니다
(다중 모니터 감지가 secure context 필수) — 런처가 자체서명 인증서를 자동 생성합니다.

---

## 2. 설치 (뷰어 서버에서 5단계)

```bat
:: 1) zip 해제 후 루트에서 — 파이썬/노드 의존성 설치
cd backend  && py -3.11 -m pip install -r requirements.txt  && cd ..
cd frontend && npm install                                 && cd ..

:: 2) 원클릭 기동 (Docker 확인 → 인증서 생성 → 백엔드 8010 → 뷰어 5180)
start_viewer_suite.bat

:: 3) 최초 1회 — 병원·계정 시드(로그인용)
cd backend && py -3.11 seed_sample.py
```

접속·로그인:
- 브라우저 `https://localhost:5180` (원격은 `https://<뷰어서버IP>:5180`) — 최초 1회 인증서 경고 통과
- 병원 `SAMPLE01` / 계정 `sample_admin` / 비번 `sample1234` (**운영 전 반드시 변경**)

---

## 3. 대상 A(webpacs_api) 연결 — 3분

붙이기 전 딱 2가지만 확인:

1. **브리지용 원격 계정** — A 의 PACS 사용자(`user_type` 에 `P` 포함).
   - 미러(가져오기)만 쓸 거면 아무 P 계정이면 됨.
   - **Live(직결)로 판독까지 하려면** `group_level ≥ 98`(병원/센터/최고관리자) 또는
     `user_report_edit_all='Y'` 계정 권장 — 일반 판독의 등급은 A가 "본인 배정 검사"만
     보여주고 타인 검사 저장을 막습니다.
2. **A 가 DICOMweb v2 를 서비스하는지** — 브라우저나 curl 로:
   `GET {A주소}/api/dicomweb/v2/` (Bearer) → Capability JSON 이면 OK.

설정(둘 중 하나):

- **GUI**: 워크리스트 우측 **[WebPACS]** → ⚙ 접속 설정 → 원격 주소·계정·비번 입력 →
  저장 → **[연결 테스트]**(원격 검사 수가 뜨면 성공). SSL: 공인 인증서 ON / 자체서명 OFF.
- **env(운영 권장 — DB 평문 저장 회피)**: 뷰어 서버 `backend/.env` 에
  ```
  SAINTVIEW_WEBPACS_ENABLED=1
  SAINTVIEW_WEBPACS_BASE_URL=https://api.<대상>.co.kr
  SAINTVIEW_WEBPACS_USER=<브리지계정>
  SAINTVIEW_WEBPACS_PASSWORD=<비번>
  SAINTVIEW_WEBPACS_VERIFY_SSL=1        # 자체서명이면 0
  ```

---

## 4. 두 가지 사용 모드 (버튼으로 전환)

| 버튼 | 모드 | 동작 |
|---|---|---|
| **[WebPACS]** | 가져오기(미러) | 원격 검사를 검색 → [가져와서 열기] → 우리 저장소로 **복사** 후 표시(원본 보존) |
| **[Live]** | 직결(복사 없음) ★ | 원격 워크리스트 실시간 조회 → 열람·판독이 **A DB에 실시간 왕복**. 타 계정 작성중·값 변경 실시간 감지 |

- 미러: 안정적·오프라인 열람 가능. 판독문은 우리 DB(원격과 분리).
- Live: 복사 0, A가 단일 원본, 판독이 A에 저장 → A 클라이언트와 즉시 공유. 5초 실시간 동기.

---

## 5. 운영 전환 체크(공개 배포 시)

- `backend/.env` 에 `SAINTVIEW_ENV=prod` + `SAINTVIEW_JWT_SECRET`(32자+)·관리자/Orthanc 비번
  지정(기본값은 prod 게이트가 거부).
- `deploy/docker-compose.prod.yml` 오버레이(Orthanc 인증·포트 제한).
- 픽셀 엔드포인트(rendered/thumb)는 `<img>` 계약상 무인증 → 운영은 리버스 프록시에서 접근 통제.
- `admin/admin1234`·`sample1234` 등 기본 비번 전부 교체.

---

## 6. 잘 안 될 때 30초 진단

| 증상 | 확인 |
|---|---|
| 연결 테스트 로그인 실패 | 계정 `user_type` 에 P 포함? 비번? A의 5회/1시간 실패 잠금? |
| 연결은 되나 목록 0건 | 계정의 병원/센터 권한 스코프(A가 권한 필터 적용) |
| 영상 안 보임(검은 화면) | 뷰어서버에 pylibjpeg 3종 설치됐나(`requirements.txt`) · A의 v2 응답 확인 |
| 5180 접속 불가 | HTTPS 전용 — 인증서 생성 여부(`frontend/certs`), 런처 재실행 |
| Live 판독 저장 409 | 타 판독의 작성중이거나 이미 승인됨(정상 동작) / 계정 권한 등급 |

---

**요약**: zip 해제 → `pip install`·`npm install` → `start_viewer_suite.bat` → `seed_sample.py`
→ [WebPACS] 접속 설정에 A 주소·계정 → [연결 테스트] → [Live] 또는 [WebPACS]로 열람.
A 서버는 손대지 않습니다.

---

## 7. ⚡ 느리다면 여기부터 (실서버 점검 결과)

실제 배포 서버(nginx 서빙) 점검에서 **가장 큰 두 가지**가 발견됐다. 코드가 아니라 **서버 설정** 문제다.

| 증상 | 확인 방법 | 조치 |
|---|---|---|
| **JS 무압축 전송** (823KB 그대로) | 브라우저 F12 > 네트워크 > `index-*.js` 의 "전송" ≈ "크기" 면 무압축 | 아래 스크립트 한 줄 → **823KB → 220KB** |
| **자산 캐시 없음** | 응답 헤더에 `Cache-Control` 없음 | 같은 파일의 `/assets/` 블록(`immutable, max-age=1y`) 적용 → 재방문 시 재검증 0회 |

**적용 (서버에서 한 줄)** — 기존 `server { }` 블록은 건드리지 않는다.
`conf.d` 에 http 컨텍스트 드롭인 한 장만 넣고, `nginx -t` 실패 시 자동 원복한다.

```bash
sudo sh deploy/apply_nginx.sh https://<주소>
```

Windows nginx 라면:

```bash
powershell -ExecutionPolicy Bypass -File deploy/apply_nginx.ps1 -NginxDir C:/nginx -CheckUrl https://<주소>
```

스크립트가 끝나면서 압축 여부를 스스로 확인해 준다. 수동 확인은:

```bash
curl -sI https://<주소>/assets/index-XXXX.js | grep -iE "content-encoding|cache-control|content-length"
#  → content-encoding: gzip  와  cache-control: ...immutable  이 나와야 정상
```

되돌리기: `sudo rm /etc/nginx/conf.d/zz-saintview-gzip.conf && sudo nginx -s reload`

빌드가 `.gz`/`.br` 를 함께 만들어 두므로 `gzip_static on;` 이면 **런타임 CPU 없이** 압축본이 나간다.

### 그래도 느리면 — 설정에서 직접 측정

**설정 > 속도 측정 (Speed Test)** 에서 [▶ 속도 측정] 을 누르면
① 서버 왕복 ② 검사 정보 ③ 시리즈 목록 ④ 첫 영상(콜드) ⑤ 재요청(웜) ⑥ 실효 전송속도
를 **그 서버·그 회선 기준**으로 재고, 어느 구간이 병목인지와 조치를 바로 알려준다.

① 서버 왕복 ② 검사 정보 ③ 시리즈 목록 ④ 첫 영상(콜드) ⑤ 재요청(웜) ⑥ 실효 전송속도
**⑦ 서버 압축(gzip)** — 브라우저가 실제로 받은 바이트와 압축 해제 후 크기를 비교해 판정한다.

자주 나오는 판정:
- 🔴 *서버 gzip 이 꺼져 있습니다* → 위 `apply_nginx.sh` 한 줄
- 🔴 *개발(dev) 모드로 서빙 중* → 서버에서 `start_viewer_suite.bat`(인자 없이) 재기동
- 🔴 *첫 영상이 큰 PNG* → 설정 > 병원 설정 > 뷰어 영상 형식을 **JPEG(품질 90)** 로
- 🟠 *서버 왕복이 큼* → 회선/거리 문제. 프리페치·캐시가 2회차부터 흡수
