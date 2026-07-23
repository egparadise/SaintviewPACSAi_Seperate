// WebPACS Live(A 직결) — 라이브 검사 StudyUID 레지스트리.
// 뷰어의 rendered URL 은 study_uid 로 조립되므로, 가상 id(vid)로 로드된 검사의 UID 를
// 여기 등록해 두면 페인 단위(비교·Combine 혼합 포함)로 라이브/로컬 루트를 정확히 가른다.
// (cornerstone.ts 가 아닌 독립 모듈 — api.ts 가 cornerstone 번들을 끌지 않게)

export const LIVE_DICOMWEB_ROOT = "/api/webpacs/live/dicom-web";

const uids = new Set<string>();

export function registerLiveStudyUid(uid: string | undefined | null): void {
  if (uid) uids.add(uid);
}

export function isLiveStudyUid(uid: string | undefined | null): boolean {
  return !!uid && uids.has(uid);
}

/** rendered 루트 — 라이브 검사 UID 면 라이브 프록시, 아니면 기본(Orthanc DICOMweb) */
export function renderedRootFor(studyUid: string | undefined | null, fallback: string): string {
  return isLiveStudyUid(studyUid) ? LIVE_DICOMWEB_ROOT : fallback;
}
