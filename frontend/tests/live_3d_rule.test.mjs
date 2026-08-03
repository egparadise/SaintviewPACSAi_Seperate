// Live(원격 PACS 직결) 검사 3D — 재발 방지 계약.
//
// 실제 사고: 3D(MPR/MIP)가 로컬 Orthanc QIDO 에만 질의 → Live 검사는 검색 결과가
// 빈 배열(200 [])이라 "영상 시리즈가 없습니다" 로 죽었다. 스크린샷 재현 경로:
// Live MR 검사 열기 → [3D] → 시리즈 콤보 공백 + 오류 문구.
//
// 계약:
//  ① UID→vid 역참조(liveVidOf) — 3D 는 studyUid 만 들고 있으므로 이 맵이 없으면
//     Live 시리즈 트리(vid 기반 API)를 되찾을 수 없다.
//  ② Viewer3D 는 Live 검사에서 QIDO 대신 시리즈 트리를 쓰고, 픽셀은 원본 DICOM
//     파일(wadouri + LIVE_DICOMWEB_ROOT)로 받는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// liveUids.ts 는 dlCache(브라우저 OPFS) 체인을 import 해서 node 테스트로 실행할 수 없다 —
// 소스 계약 검사로 고정한다(런타임 왕복은 뷰어 E2E 의 몫).
test("① UID→vid 역참조 — 맵과 양쪽 등록이 존재한다", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "liveUids.ts"), "utf8");
  assert.ok(src.includes("vidByUid"), "UID→vid 맵이 사라졌다");
  assert.ok(/registerLiveStudyVid[^}]*uids\.add\(uid\);?\s*vidByUid\.set\(uid, vid\)/s.test(src),
    "registerLiveStudyVid 는 live UID 등록(uids.add)과 vid 맵을 **함께** 채워야 한다");
  assert.ok(src.includes("export function liveVidOf"), "liveVidOf 역참조가 없다");
});

test("② Viewer3D — Live 분기: 시리즈 트리 + wadouri 원본 파일", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "pages", "Viewer3D.tsx"), "utf8");
  assert.ok(src.includes("isLiveStudyUid(studyUid)"),
    "Live 분기가 사라졌다 — QIDO 만 남으면 Live 3D 가 다시 죽는다");
  assert.ok(src.includes("liveVidOf(studyUid)"), "UID→vid 역참조가 없다");
  assert.ok(src.includes("api.seriesTree("), "Live 시리즈 목록은 시리즈 트리에서 와야 한다");
  assert.ok(src.includes("wadouri:") && src.includes("LIVE_DICOMWEB_ROOT"),
    "Live 볼륨 픽셀은 원본 DICOM(wadouri + Live 프록시)이어야 한다");
});

test("③ 등록 지점 — api.study/seriesTree 가 vid 를 함께 등록한다", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "api.ts"), "utf8");
  const n = (src.match(/registerLiveStudyVid\(/g) ?? []).length;
  assert.ok(n >= 2, `registerLiveStudyVid 등록 지점이 ${n}곳 — study()·seriesTree() 두 곳 이상이어야 한다`);
});
