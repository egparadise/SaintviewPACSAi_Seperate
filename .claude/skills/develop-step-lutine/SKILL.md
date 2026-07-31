---
name: develop-step-lutine
description: Saintview Viewer Suite 의 표준 개발·검증·배포 절차(Develop step lutine). 증상 규명 → 재현 테스트 → 수정 → 게이트 반복 → 커밋/푸시 → 배포 패키지 → Obsidian 기록까지 한 바퀴를 그대로 돈다. 사용자가 "점검하고 문제 있으면 고쳐라", "배포할 수 있게 빌드", "init commit push obsidian report", "증상이 있다"(sv70 오류·먹통·화면 이상) 라고 할 때 사용한다.
---

# Develop step lutine — 표준 개발 한 바퀴

이 저장소에서 **실제로 효과가 있었던** 절차다. 순서를 지키는 것이 목적이다.

---

## 0. 시작 전 — 환경 확인 (건너뛰지 말 것)

```bash
cd C:/Project/SaintviewViewerSuite && git status --short
git log --oneline -1        # HEAD 가 내가 알던 커밋인가 — 다른 세션이 밀었을 수 있다
```

- **다른 세션이 같은 저장소에서 작업 중일 수 있다.** 내 것이 아닌 변경·미추적 파일이 보이면
  기억해 두고, 마지막 커밋에서 **`git add -A` 를 절대 쓰지 않는다.**
- 실서버(sv70) 커밋이 로컬보다 뒤처져 있는지 확인한다 — 이미 고친 것이 배포만 안 됐을 수 있다.

---

## 1. 증상 규명 — 추측하지 말고 확정한다

### 1-a. 사용자가 준 증거를 먼저 읽는다
스크린샷의 수치(Z%, 분할, 체크박스 유무), 오류 로그의 타임스탬프 묶음(같은 ms = 동시 실패),
URL 의 `study=`(9천만 이상이면 Live), `mm=`(모니터 번호).

### 1-b. 코드로 확정할 수 있는 것만 말한다
"느릴 것 같다" 는 진단이 아니다. **"이 조건이면 스레드 N개가 T초간 묶인다"** 로 말한다.

### 1-c. 규모가 크면 Workflow 로 다축 병렬 정독
서로 눈이 다른 축을 세운다. 예: `상한 없는 원격 호출` / `로그인 경로` / `해당 화면` / `회복 시간`.

**프롬프트에 '이미 확정된 사실' 을 박아 둔다** — 같은 것을 다시 조사하느라 예산을 쓰지 않게.

지적마다 **반박자 2명**(refute + trace)을 붙이고 다수결로 살린다.
확신이 없으면 `refuted=true` 로 기울인다 — 거짓 양성이 판독 코드에 들어가는 것이 더 해롭다.

⚠ 에이전트가 한도로 죽으면 **"통과" 라고 말하지 않는다.** 실패 수를 밝히고 직접 정독으로 대체한다.

---

## 2. 재현 → 수정 (순서를 뒤집지 않는다)

**결함은 테스트로 먼저 재현한다.** 고쳤다고 믿었는데 안 고쳐진 사례가 이 저장소에 여러 번 있다.

```bash
py -3.11 -m pytest tests/test_새로쓴것.py -q   # 먼저 실패하는 것을 본다
# → 수정 → 다시 통과하는 것을 본다
```

수정할 때 지키는 것:

| 규율 | 이유 |
|---|---|
| 호출자 0인 함수는 **삭제** | 테스트만 초록이면 '있는 기능' 으로 착각한다 |
| 규칙은 **순수 함수 한 곳**에 | 두 곳에 있으면 반드시 갈린다(뷰어 3종에서 실제로 갈렸다) |
| 주석에 **왜** 를 적는다 | "무엇" 은 코드가 말한다. 사고 재발을 막는 것은 "왜" 다 |
| 판독 안전 > 편의 | 잘려 보이는 것보다 확대를 포기하는 것이 안전하다 |

---

## 3. 게이트 — **여러 번** 돌린다

```bash
cd frontend && npx tsc -b                                        # ⚠ --noEmit -p 는 앱을 안 검사한다
cd frontend && node --test --experimental-strip-types "tests/*.test.mjs"
cd backend  && py -3.11 -m pytest -q
cd frontend && npm run build
```

3회 반복 스크립트:

```bash
for i in 1 2 3; do
  echo "═══ $i 회차 ═══"
  printf "  tsc -b      : "; (cd frontend && npx tsc -b >/dev/null 2>&1 && echo clean || echo FAIL)
  printf "  node --test : "; (cd frontend && node --test --experimental-strip-types "tests/*.test.mjs" 2>&1 | grep -E "^ℹ (pass|fail)" | tr '\n' ' '); echo
  printf "  pytest      : "; (cd backend && py -3.11 -m pytest -q 2>&1 | tail -1)
  printf "  build       : "; (cd frontend && npm run build 2>&1 | grep -E "built in|error TS" | tail -1)
done
```

**1회로는 order-dependent 결함이 안 보인다**(pytest-randomly). 실패가 나오면:

```bash
# 이름을 잡을 때까지 반복하고 출력을 보존한다
for i in $(seq 1 5); do
  py -3.11 -m pytest -q -rf > /tmp/r$i.txt 2>&1 || true
  tail -1 /tmp/r$i.txt
  grep -E "^FAILED" /tmp/r$i.txt | head -3 && break
done
```

실패가 재현되지 않으면 **다른 세션이 파일을 쓰는 중일 수 있다**(테스트 수가 늘었는지 확인).

---

## 4. 커밋 — 내 파일만

```bash
git add <내가 바꾼 파일들>        # ⚠ git add -A 금지
git diff --cached --name-only     # 남의 것이 섞였는지 눈으로 확인
git commit -F - <<'MSG'
...
MSG
git push origin main
```

커밋 메시지에 담는 것:
- **증상**(사용자 표현 그대로)
- **원인**(파일:줄, 왜 그렇게 되는지)
- **수정**과 그 선택의 이유
- **게이트 결과**(숫자)
- ⚠ **코드로 뒷받침되는 것만 쓴다.** 과장하면 다음 사람이 믿고 검증을 건너뛴다.

---

## 5. 배포 패키지

```bash
py -3.11 deploy/make_dist.py      # ⚠ 손으로 조립하지 않는다
```

산출: `build/SaintviewViewerSuite-dist-<YYYYMMDD>-<sha>.zip`

검증:

```bash
py -3.11 -c "
import zipfile,os
p='build/…zip'; z=zipfile.ZipFile(p); n=z.namelist()
print(len(n),'files · testzip:', z.testzip() or 'OK')
print(z.read([x for x in n if x.endswith('VERSION.txt')][0]).decode())
for k in ['VERSION.txt','start_viewer_suite.bat','frontend/dist/index.html','backend/migrations/']:
    print(k, any(k in x for x in n))
"
```

적용: `sudo sh update_server.sh --apply /경로/SaintviewViewerSuite-dist-…`

---

## 6. Obsidian 기록

Vault: `C:/Users/egpar/OneDrive - Inviz/15.Vibe Cording/Obsidian/SaintviewPACSai_Seperate`

| 문서 | 내용 |
|---|---|
| `NN 세션 리포트 …` | 시간대별 요청→대응, 원인·수정, **Frontend/Backend/DB/Storage 별** 개발·개선·에러·수정 |
| `17 핵심 기능 — 반드시 알아야 할 것` | **바꾸면 안 되는 규정**(분할 우선순위·판독 안전·동시성 예산) |
| `18 개선 내역 — 편의·성능` | 규정이 아닌 개선분 — 핵심과 **분리해서** 적는다 |
| `Study/NN …` | 학습 — 기능 기술·요소 기술·코딩 개발 기술·함수 기술·AI 기술로 나눠 세세하게 |
| `00 INDEX (MOC)` · `01 작업 타임라인` | 링크 추가 |

기록에 **반드시** 포함: 사용한 prompt·context·skill·hook·agent·workflow(에이전트 수·실패 수),
그리고 **못 한 것과 그 이유**.

---

## 7. 요구 누락 감사 (주기적으로)

세션 기록에서 사람이 친 발화만 뽑아 구현 증거와 대조한다.
절차는 [[15 반복 사용 — 검증 루틴]] 에 스크립트로 있다.

⚠ 압축(compaction)으로 원본 턴이 사라질 수 있다 — `attachment.queued_command` 와
요약본에서 복원해 인벤토리에 넣는다.

---

## 이 저장소에서 실제로 났던 실패 유형 (같은 것을 찾아라)

| 유형 | 실례 |
|---|---|
| 호출자 0 | `invalidate_tree` · `fromLegacyXmode` — 커밋은 "고쳤다" 고 했다 |
| mock 이 문제 경로를 비켜감 | ZIP 테스트가 `_read` 를 12바이트로 mock |
| 공허한 테스트 | 기간 필터 테스트의 검사일이 오늘이라 항상 통과 |
| 문자열 자르기 충돌 | `sop[:32]` — 시리즈 캐시가 한 장으로 덮였다 |
| 인자는 받는데 아무도 안 넘김 | `register_study(body_part=…)` 호출부 5곳 전부 생략 |
| 상한이 일부 경로에만 | `a_pixel_slot` 이 썸네일·인코딩·조회를 못 막았다 |
| 재계산 지점 부재 | `pickHang2d` 가 첫 로드에서 한 번만 — 탭 전환에 없었다 |
| 리포터가 정보를 버림 | `String(xhr)` → `[object XMLHttpRequest]` |
| 비동기 setState 직후 옛 state 읽기 | `setLayout` 후 `LAYOUTS[layout].count` |
| 이스케이프가 도구를 거치며 소실 | 정규식 문자 클래스의 역슬래시 |
| **공유 가드에 예외를 무조건 넣음** | `_require_study` 에 협진 예외 → 그 가드를 쓰던 **쓰기 9개**가 함께 열렸다. 예외는 **기본 거부 + 호출부 opt-in** 이어야 새 코드가 자동으로 안전하다 |
| **422 로 통과하는 공허한 단언** | 권한 차단 테스트가 틀린 본문을 보내 `422`(검증 실패)로 통과 — 게이트가 사라져도 초록. 차단 테스트는 **유효 본문**으로 보내고 허용 코드에서 422 를 뺀다 |
| **캐시를 '바꾼 쪽' 기준으로만 무효화** | 제어권 승인은 Master 소켓이 처리하는데 알아야 하는 건 게스트 소켓 — 소켓 로컬 캐시라 TTL 만큼 옛 값을 믿었다. **공유 리비전 + TTL** 두 축이 필요 |
| **렌더 안에서 컴포넌트 정의** | `const Section = () => …` 를 컴포넌트 본문에 두면 매 렌더 새 타입 → 재마운트 → **입력 포커스가 한 글자마다 날아간다** |
| **순수 규칙이 `window` 에 묶임** | `window.setTimeout` → node 테스트 불가 → 사실상 검증 없이 흘러간다. `lib/*.ts` 규칙 모듈은 전역 API 만 쓴다 |
| **모듈 전역을 렌더에서 읽기** | `collab.status` 를 렌더 중 읽어 표시등을 그림 → 값이 바뀌어도 다시 그릴 이유가 없어 **끊겨도 초록불**. 구독해야 한다 |

### 신규 기능일 때 추가로 볼 것

증상 수정이 아니라 **기능 추가**면 아래를 반드시 훑는다(이번에 4건이 여기서 나왔다).

```bash
# ① 호출자 0 — 백엔드
for f in backend/app/services/새모듈.py; do
  grep -oP '^def \K\w+' "$f" | grep -v '^_' | while read fn; do
    n=$(grep -rn "\b$fn\b" backend/app backend/tests --include=*.py | grep -v "def $fn" | wc -l)
    [ "$n" -eq 0 ] && echo "❌ 호출자 0: $fn"
  done
done
# ② 호출자 0 — 프론트 export / 훅 반환 멤버 / 안 넘기는 옵션
grep -oP 'export (function|const) \K\w+' src/lib/새모듈.ts | while read fn; do …; done
# ③ 형식·규칙이 여러 곳에서 손으로 다뤄지는지 (교차 언어면 특히)
grep -rn '접두사:\|split(":")' backend/app frontend/src
```

**교차 언어 계약(프론트↔백엔드 문자열 형식)은 양쪽 테스트에 같은 리터럴을 박는다.**
한쪽만 바뀌면 반드시 하나가 깨진다. 예: `dm_room(7,3) == "dm:3:7"` 을 pytest·node 양쪽에.
