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

## 5. 운영 검증
- [ ] 스모크: `python harness/smoke_dicom_pipeline.py` PASS
- [ ] 실장비 1대에서 C-STORE 수신 → 워크리스트 표시 → AI 초안 → 확정 → PDF/SR 왕복
- [ ] AI 품질 기준선: 파일럿 2주 후 `/api/admin/ai-quality` 수용률 리뷰(설계 §10)
- [ ] 장애 시나리오: Orthanc 중단 시 워커 재시도, Claude API 장애 시 mock 폴백 여부 결정

## 규제 메모 (설계 §8.3)
파일럿은 **원내 연구/판독 보조** 포지셔닝 — "AI 생성 초안, 의료인 필수 검토" 문구가
모든 화면·PDF·SR에 표기되는지 확인. SaMD 인허가 전 대외 진단 서비스 표방 금지.
