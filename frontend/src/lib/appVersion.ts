// 앱 버전 정보 — 지속적인 버전 관리를 위한 **단일 소스**.
//
// 버전 번호는 `frontend/package.json` 의 version 을 vite 가 빌드 시 주입한다(정의: vite.config.ts
// define.__APP_VERSION__). 릴리스 때 package.json 의 version 하나만 올리면 설정창 표기가 따라간다.
// 적용일자는 빌드 시각(빌드한 날)을 자동 기록한다 — 배포본이 언제 만들어졌는지가 곧 적용일자.

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

/** 예: "1.1.0" */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

/** 빌드(배포본 생성) 일자 — 예: "2026-07-27" */
export const BUILD_DATE: string =
  typeof __BUILD_DATE__ !== "undefined" ? __BUILD_DATE__ : "";

/** 제조사 — 정보 항목·문서 표기 공용 */
export const VENDOR = "Inviz Corporation";

/** 제품명 */
export const PRODUCT_NAME = "Saintview PACS AI Viewer";
