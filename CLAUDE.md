# Saintview Viewer Suite — 프로젝트 불변 규정

이 파일의 규정은 **사용자가 확정한 계약**이다. 다른 작업(i18n 일괄 치환·리팩터·이식·버그 수정)이
이 규정을 바꾸거나 약화시키면 안 된다. 바꿔야 할 이유가 생기면 코드를 고치기 전에 사용자에게 묻는다.

## 뷰어 2D 분할(Layout) 우선순위 — 2026-08-04 사용자 확정

네 기능은 **각기 독립적으로 동작**한다:

| 기능 | 동작 조건 |
|---|---|
| **행잉 Layout (HP)** | **선택되었을 때만** — 걸려 있으면 아래 전부를 무시하고 HP 가 정한다. 기본은 해제 |
| **Mammo Layout (2D-MG)** | **선택되었을 때만** — MG 검사 + 2D-MG 규정 on 일 때만 맘모 규정. 꺼져 있으면 강제하지 않는다 |
| **2D-Common Layout** | 표 적용 1순위 — 해당 모달리티 행(없으면 '*' 행)이 있으면 세 뷰어 모두 이 값 |
| **뷰어별 Layout** (2D-SaintViewer/InViewer/TViewer) | 표 적용 2순위 — Common 에 행이 없을 때 그 뷰어의 행(없으면 '*') |

적용 순서(고정): **① HP(선택 시) → ② Mammo(선택 시) → ③ Common → ④ 뷰어별 → ⑤ 자동 규칙(1×1 등)**

- 구현은 `frontend/src/lib/viewerConfig.ts` 의 `pickHang2d`/`resolveHang2d` **한 곳뿐**이다.
  뷰어(Viewer2D/ViewerInfi)에서 분기를 복사하지 마라 — 복사하면 반드시 갈린다(실제 사고 2회).
- 구 `hanging2d_common_on` 체크박스(공통/뷰어별 **양자택일**)는 폐지됐다. 저장 필드는 호환으로만
  남고 **판정에 쓰지 않는다** — 이 플래그가 false 인 계정에서 Common 표가 통째로 무시되던 것이
  "CT 를 열면 Common 설정이 풀려" 증상이었다.
- 탭 전환·검사 전환은 **예외 없이** 이 순서를 다시 계산한다(이전 화면의 격자 상속 금지).
- 회귀 방어 테스트: `frontend/tests/hang2d_rule.test.mjs` · `hang_switch_rule.test.mjs`.

## Compare(과거검사 비교) 화면 분할 — 2026-08-19 사용자 확정

설정>판독 **'과거검사 비교 표시 = Layout 띄우기(한 화면 1:2 분할)'** 이면:

- **모달리티와 무관하게 1:2 분할**이다. CT·MR 에 별도 Series Layout 이 걸려 있어도 상관없다 —
  이건 Series Layout 이 아니라 **화면 자체를 나누는 기능**이다.
- 비교가 떠 있는 동안 분할의 주인은 Compare 다. `applyHangFor` 는 `compareOwnsLayout()` 이 참이면
  **아무것도 하지 않고 현재 페인 수만 돌려준다**(위 캐스케이드를 바꾸는 게 아니라, 사용자가 방금
  명시적으로 띄운 비교 화면이 있을 때만 적용을 보류하는 것이다).
- 소유권은 **사용자가 직접 분할을 고르면**(툴바 select · Srs 그리드 피커 · HP 해제) 즉시 돌아간다
  (`releaseCompareLayout`). 이 해제가 없으면 한 번 비교한 뒤로 모달리티 Layout 이 영영 안 걸린다.
- 이 설정은 `compare.multi_monitor` 보다 **앞선다** — 화면 분할을 골라 놓고 옆 모니터 창이 뜨면
  애초에 1:2 가 아니다.
- **Combine 은 비교 화면의 두 영역 모두**에 걸린다(M=주 검사, S=과거). 각 페인은 **자기 검사**의
  시리즈로 결합한다(`cmpTreesRef`) — 현재 검사 시리즈를 과거 페인에 넣으면 엉뚱한 영상이 결합된다.
- 회귀 방어 테스트: `frontend/tests/compare_split_rule.test.mjs`.

## 그 외 세션 공통 규율 (요약)

- 프론트 타입 게이트는 `tsc -b` (`--noEmit -p tsconfig.json` 은 앱을 검사하지 않는다).
- `git add -A` 금지 — 같은 저장소에 다른 세션이 있을 수 있다. 내 파일만 골라 커밋한다.
- 새 UI 한국어 문자열은 `tr()` 래핑 + `lib/i18n/msgids.ts` + **9개 언어 사전 전부** 등재
  (tests/i18n_rule.test.mjs 가 강제). 비교값·저장 키·API 값·제품명은 절대 래핑하지 않는다.
- 배포 패키지는 `py -3.11 deploy/make_dist.py` 만 사용(손 조립 금지), 커밋 **후** 재빌드로 SHA 를 맞춘다.
