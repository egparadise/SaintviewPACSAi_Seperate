# 파일럿 배포 체크리스트 (운영 보안)

> 설계 §8 보안 게이트의 배포 절차화. **모든 항목 완료 전 환자 데이터 연결 금지.**

## 1. 시크릿 준비
- [ ] `cp .env.example backend/.env` 후 모든 `CHANGE_ME` 교체
- [ ] `SAINTVIEW_ENV=prod` 설정 — 백엔드가 기동 시 기본 시크릿을 거부함(자동 게이트)
- [ ] JWT 시크릿 생성: `python -c "import secrets;print(secrets.token_urlsafe(48))"`
- [ ] 관리자 비밀번호: 기동 후 즉시 UI에서 변경(`/api/auth/change-password`)
- [ ] Anthropic API 키: 콘솔에서 **파일럿 전용 키 신규 발급**(워크스페이스 분리·지출 한도 설정)

## 2. 인프라 기동
```bash
export ORTHANC_PASSWORD=...   # 운영 비밀번호
python deploy/gen_prod_conf.py                # nginx 인증 프록시 생성(시크릿 포함 — 커밋 금지)
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml up -d
cd backend && alembic upgrade head
```
- [ ] Orthanc 인증 활성 확인: `curl http://localhost:8042/system` → 401
- [ ] OHIF 프록시 경유 정상: `curl http://localhost:3000/dicom-web/studies` → 200
- [ ] Orthanc `DicomCheckCalledAet` 등 수신 검증 옵션 검토(화면분석 §5.3)

## 3. 네트워크/전송 구간
- [ ] **HTTPS 종단**: 프론트·백엔드·OHIF 앞에 TLS 리버스 프록시(nginx/caddy) — HTTP 직접 노출 금지
- [ ] 백엔드 CORS `allow_origins`를 실제 도메인으로 교체(`app/main.py`)
- [ ] DB(5432)·Orthanc HTTP(8042) 외부 차단 확인(`docker-compose.prod.yml` 적용 시 자동)
- [ ] DICOM 4242 포트는 병원 장비 대역만 방화벽 허용

## 4. 데이터 보호
- [ ] PHI 비식별화 게이트 회귀: `pytest backend/tests/test_deid.py` + `harness/eval_rag.py` PASS
- [ ] vision 분석은 IRB/보안심의 전 **off 유지**(ai.policy.vision=false 기본)
- [ ] DB·Orthanc 볼륨 일일 백업 + 복구 리허설 1회
- [ ] 감사 로그 보존 정책 확정(audit_log — 의료법 추적성)

## 4-1. 단일 워커 배포 계약 (⚠ 어기면 조용히 오작동)
> 이 백엔드는 **단일 워커 전용**이다. 캐시·락·인플라이트·A세션이 전부 프로세스 인메모리라
> 워커가 2개 이상이면 오류 없이 깨진다: A 로그인 랜덤 만료 / 로그인 실패 잠금 임계값 N배 /
> 같은 SOP 중복 다운로드·`.part` 동시 기록으로 캐시 손상 / 디코드·인코드 캐시와 STT 모델이
> 워커 수만큼 곱해져 OOM / MPPS·MWL 포트 bind 실패(조용히 반쪽 동작).
> 전체 목록과 근거는 `docs/DEPLOYMENT.md` §3-1.

- [ ] 기동 명령에 `--workers`(gunicorn `-w`)가 **없는지** 확인 — 있으면 반드시 `1`
- [ ] 환경변수 `WEB_CONCURRENCY` 가 **설정돼 있지 않은지** 확인(`env | grep WEB_CONCURRENCY` → 없음)
- [ ] gunicorn 을 쓴다면 설정 파일의 `workers` 값 확인 — **이 값은 기동 게이트가 못 잡는다**
- [ ] nginx 업스트림이 단일인지 확인(`deploy/nginx-viewer.conf` = `127.0.0.1:8010` 하나) —
      독립 uvicorn 여러 대를 로드밸런싱하면 **어떤 in-process 감지도 불가능**하다
- [ ] 기동 후 확인: `curl -s http://127.0.0.1:8010/api/status` → `"multi_worker":false`
      (기동 12초 뒤 런타임 백스톱이 형제 워커를 세어 채운다)
- [ ] 백엔드 로그에 `[다중 워커 감지]` 줄이 없는지 확인

> ⚠ **`SAINTVIEW_ENV=prod` 의 게이트는 '깔끔한 기동 거부'가 아니다.** 게이트 예외는
> `lifespan` 안, 즉 **워커 자식 프로세스**에서 난다. uvicorn 마스터는 죽은 워커를 0.5초마다
> 다시 띄우므로(gunicorn arbiter 동일) 기본 동작은 **무한 재기동 루프**다 —
> 실측(uvicorn 0.34.0, `--workers 2`): 30초에 기동 실패 8회, 로그 1334줄, 매 회 앱 전체 재import.
> 그래서 게이트는 예외 전에 마스터에게 `SIGTERM` 을 보내 루프를 끊는다
> (`config.terminate_worker_master()`, 조건은 `docs/DEPLOYMENT.md` §3-1).
> **조건이 안 맞아 마스터를 못 내린 경우**(예: `SAINTVIEW_WORKER_GATE_KILL_MASTER=0`,
> 부모가 uvicorn 이 아님) 예외 메시지 끝에 그 경고가 붙는다. 그때 증상은:
> · 로그에 `Application startup failed` 가 계속 반복 · CPU 를 계속 태움
> · 포트는 `netstat` 에 LISTEN 으로 **안 보이는데** 다른 프로세스는 bind 실패(마스터가 점유)
> · 클라이언트에는 connection refused
> 조치: `pkill -f 'uvicorn.*--workers'` 로 마스터를 직접 죽이고 `--workers 1` 로 재기동.

> ⚠ `deploy/update_server.sh` 의 '맨 프로세스 재기동' 경로는 `/proc/<pid>/cmdline` 을 그대로
> 복사해 다시 띄운다(스스로 `--workers` 를 붙이지는 않는다). 즉 **지금 돌고 있는 프로세스가
> `--workers 2` 로 떠 있다면 갱신 후에도 같은 인자로 뜨고, prod 게이트에 걸려 기동에 실패한다
> (게이트가 마스터까지 내리면 그대로 종료, 못 내리면 위의 재기동 루프가 된다 — 어느 쪽이든
> 서비스는 안 뜬다).**
> 원격 운영 중이라면 사고로 보이므로, 갱신 전에 위 첫 두 항목을 먼저 확인하라.

## 5. 운영 검증
- [ ] 스모크: `python harness/smoke_dicom_pipeline.py` PASS
- [ ] 실장비 1대에서 C-STORE 수신 → 워크리스트 표시 → AI 초안 → 확정 → PDF/SR 왕복
- [ ] AI 품질 기준선: 파일럿 2주 후 `/api/admin/ai-quality` 수용률 리뷰(설계 §10)
- [ ] 장애 시나리오: Orthanc 중단 시 워커 재시도, Claude API 장애 시 mock 폴백 여부 결정

## 규제 메모 (설계 §8.3)
파일럿은 **원내 연구/판독 보조** 포지셔닝 — "AI 생성 초안, 의료인 필수 검토" 문구가
모든 화면·PDF·SR에 표기되는지 확인. SaMD 인허가 전 대외 진단 서비스 표방 금지.
