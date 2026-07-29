// 다운로드 모드 저장소 — OPFS(Origin Private File System) + IndexedDB 인덱스.
//
// 왜 OPFS 인가: 사용자가 확정한 요구는 "저장 위치는 **프롬프트 없음 · 탐색기에 안 보임**".
//   File System Access API(showDirectoryPicker)는 매번 권한 프롬프트가 뜨고 실제 폴더가 보인다.
//   OPFS 는 오리진 전용 샌드박스라 프롬프트가 없고 탐색기에 노출되지 않는다. 다른 저장소로
//   갈아타면 이 요구가 깨지므로 대체 금지(비보안 컨텍스트 폴백만 예외 — dlSupportReason 참조).
//
// 폴더 구조: v1/{검사일}/{환자ID}__{StudyUID 끝12}/{Modality}/{Thumbnail|DICOM}/{sop}.jpg
//   ⚠ 사용자 확정 구조는 '날짜-환자-Modality 아래 Thumbnail/DICOM' 이지만, 거기에
//     **StudyUID 끝 12자를 덧붙였다**. 같은 날·같은 환자·같은 모달리티 검사가 2건이면
//     충돌하기 때문이다. 이건 가정이 아니라 이미 당한 사고다(63cdafc — 반출 ZIP 이 앞 검사를
//     못 꺼내고 ISO 는 바이트를 이어붙여 손상된 DICOM 을 구웠다). 폴더명 'DICOM' 은 사용자
//     멘탈모델을 유지하려고 이름만 계승한다 — **실제 내용물은 서버 렌더 JPEG 이다**
//     (받는 형식이 '서버 렌더 JPEG' 로 확정돼 있다. 원본 DICOM 이 아니다).
//
// 원자성: 쓰기는 `{sop}.jpg.part` → move() → **IndexedDB 인덱스 커밋** 순서다.
//   조회는 항상 인덱스 → OPFS 순서이므로 인덱스에 없는 파일은 구조적으로 읽히지 않는다.
//   그래서 move() 를 못 쓰는 브라우저(Safari 등)에서도 '잘린 파일을 서빙'하는 일이 없다.
//   ★ 근거: 백엔드가 정확히 이 실수로 죽었다 — write_bytes() 가 'wb' 로 파일을 0바이트로 자른
//     뒤 채워서, 그 사이에 읽은 스레드가 빈/잘린 프레임을 받았다(3e2099f, tmp+os.replace 로 수정).
//
// 이 모듈에는 브라우저 표준 API 외 의존이 없어야 한다(imageFormat.ts 와 같은 규약 —
// cornerstone·api.ts import 금지. 뷰어 청크를 부풀리지 않는다).

const DB_NAME = "sv_dl";
const DB_VER = 1;
const STORE = "idx";
const ROOT = "v1";

/** 인덱스 레코드 — 진실은 OPFS 이고 이것은 캐시다. 읽기 실패 시 항목을 지우고 미스로 강등한다. */
export interface DlIdxRec {
  k: string;          // `${kind}|${sopUid}`  (kind: 'th'=썸네일 | 'full'=본 영상)
  path: string[];     // 전체 경로 세그먼트(마지막이 파일명)
  dir: string[];      // 검사 폴더 세그먼트(= 삭제 단위. 검사 단위 LRU 는 이 폴더를 통째로 지운다)
  bytes: number;
  studyUid: string;
  ts: number;         // 저장 시각
  lastUsed: number;   // 마지막 사용(검사 단위 LRU 기준)
  // ★ 검사일('YYYYMMDD' 또는 'YYYY-MM-DD'. 없으면 'nodate'/빈 값) — **자동 삭제 기준이 '과거
  //   검사일부터'라서** 필요하다. 예전엔 경로 세그먼트 dir[1] 에만 있었고 레코드에는 없어서,
  //   축출 순서를 검사일로 정할 방법이 구조적으로 없었다(그래서 '오래된 검사부터'라는 설정 문구와
  //   실제 동작 = lastUsed LRU 가 어긋나 있었다).
  //   ⚠ 옛 레코드에는 이 필드가 없다. IndexedDB 는 스키마리스라 마이그레이션 없이 붙고,
  //     읽는 쪽(planEvictions)이 dir[1] 폴백을 갖는다. DB_VER 은 **새 인덱스를 만들 때만** 올린다.
  studyDate?: string;
}

/* ── 지원 여부 ── */
let supportReason: string | null = null;

/** "" = 사용 가능. 그 외 문자열은 사용자에게 보여 줄 **사유**다.
 *  ⚠ 조용히 실패하면 '켰는데 안 빨라진다'는 진단 불가 버그가 된다. 반드시 사유를 낸다. */
export function dlSupportReason(): string {
  if (supportReason !== null) return supportReason;
  let r = "";
  // ★ VITE_VIEWER_BASE 배치에서는 기능 자체를 끈다 — 뷰어 창이 다른 포트=다른 오리진이면
  //   OPFS 가 공유되지 않아 **워크리스트 창이 받은 것을 뷰어가 못 본다**. 이 가드가 없으면
  //   '받았는데 안 빨라진다'는 재현 불가 버그가 된다(어떤 병원에서만 안 빨라진다).
  if (String(import.meta.env.VITE_VIEWER_BASE ?? "").trim())
    r = "뷰어 창이 별도 포트(VITE_VIEWER_BASE)로 뜨는 배치입니다 — 창끼리 저장소를 공유할 수 없어 사용할 수 없습니다.";
  else if (!window.isSecureContext) r = "보안 컨텍스트(HTTPS 또는 localhost)가 아닙니다 — 브라우저가 OPFS 를 막습니다.";
  else if (!navigator.storage?.getDirectory) r = "이 브라우저는 OPFS(navigator.storage.getDirectory)를 지원하지 않습니다.";
  else if (!window.indexedDB) r = "이 브라우저는 IndexedDB 를 지원하지 않습니다(저장 인덱스에 필요).";
  supportReason = r;
  return r;
}

/* ── IndexedDB 인덱스 ── */
let dbp: Promise<IDBDatabase> | null = null;

function idb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "k" });
        os.createIndex("studyUid", "studyUid", { unique: false });
        os.createIndex("lastUsed", "lastUsed", { unique: false });
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  dbp = dbp.catch((e) => { dbp = null; throw e; });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const rq = fn(t.objectStore(STORE));
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
}

function idxGet(k: string): Promise<DlIdxRec | undefined> {
  return tx<DlIdxRec | undefined>("readonly", (os) => os.get(k) as IDBRequest<DlIdxRec | undefined>);
}
function idxPut(rec: DlIdxRec): Promise<unknown> {
  return tx("readwrite", (os) => os.put(rec) as IDBRequest<unknown>);
}
function idxDel(k: string): Promise<unknown> {
  return tx("readwrite", (os) => os.delete(k) as IDBRequest<unknown>);
}
function idxAll(): Promise<DlIdxRec[]> {
  return tx<DlIdxRec[]>("readonly", (os) => os.getAll() as IDBRequest<DlIdxRec[]>);
}
function idxByStudy(uid: string): Promise<DlIdxRec[]> {
  return tx<DlIdxRec[]>("readonly", (os) =>
    os.index("studyUid").getAll(IDBKeyRange.only(uid)) as IDBRequest<DlIdxRec[]>);
}

/* ── OPFS 경로 ── */
/** 경로 세그먼트 안전화 — `/`·`\`·`..` 로 폴더를 벗어나거나 OPFS 가 거부하는 이름을 만들지 않는다. */
function seg(s: string, max = 64): string {
  const v = (s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, max);
  return v || "_";
}

export type DlKind = "th" | "full";

/** 캐시 키 — sop_uid 는 전역 유일하므로 검사/시리즈를 키에 넣을 필요가 없다.
 *  kind 를 앞에 두는 이유: 썸네일과 본 영상이 같은 sop 를 공유하기 때문.
 *
 *  ★ 앞의 `live|` 는 **소스 구분자**다. 지금 저장본은 전부 A(원격 PACS) 가 렌더한 것인데,
 *    미러 배치(로컬 Orthanc + Live 병행)에서는 같은 검사가 두 경로에 있고 SOP Instance UID 가
 *    **동일**하다. 소스를 키에 안 넣으면 나중에 로컬 모드로 범위를 넓혔을 때 A 판본과 로컬 판본이
 *    같은 칸을 다툰다(로컬에서 인스턴스를 지우거나 재임포트한 검사면 화면이 A 판본으로 굳는다).
 *  ★ fmtTag(본 영상만) 는 **형식 구분자**다 — imageFormat.fixedFormatTag() 를 그대로 받는다.
 *    관리자가 png ↔ jpeg 를 바꾸면 이미 받아 둔 바이트는 다른 형식이므로 키가 갈려야 한다.
 *    썸네일은 A 가 배치로 구워 둔 512px JPEG 고정이라 형식 태그가 없다. */
export function dlKey(kind: DlKind, sopUid: string, fmtTag = ""): string {
  return kind === "full" ? `live|full|${fmtTag || "def"}|${sopUid}` : `live|th|${sopUid}`;
}

export interface DlMeta {
  studyUid: string;
  patientKey: string;
  studyDate: string;   // YYYY-MM-DD (없으면 nodate)
  modality: string;
}

/** 저장 경로 계산 — **순수 함수**(회귀 테스트가 이걸 직접 부른다: tests/dl_path_rule.test.mjs).
 *  dir 은 '검사 폴더' = 검사 단위 LRU·무효화의 삭제 단위다. */
export function dlPathFor(
  kind: DlKind, sopUid: string, m: DlMeta, fmtTag = "",
): { path: string[]; dir: string[] } {
  const date = seg(m.studyDate || "nodate", 10);
  // StudyUID 끝 12자 — 같은 날·같은 환자·같은 모달리티 검사 충돌 방지(위 주석 참조)
  const folder = `${seg(m.patientKey || "unknown", 40)}__${seg((m.studyUid || "").slice(-12), 12)}`;
  const dir = [ROOT, date, folder];
  // 파일명에 형식을 반영한다 — 키만 갈라 두면 png/jpeg 두 저장본이 **같은 파일**을 덮어써서
  // 인덱스는 둘인데 바이트는 하나(나중에 쓴 쪽)가 된다. 확장자가 곧 형식 태그다.
  const ext = kind === "full" && fmtTag === "png" ? "png" : "jpg";
  const path = [...dir, seg(m.modality || "OT", 8), kind === "th" ? "Thumbnail" : "DICOM", `${seg(sopUid, 80)}.${ext}`];
  return { path, dir };
}

async function dirOf(segs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  let d = await navigator.storage.getDirectory();
  for (const s of segs) {
    try { d = await d.getDirectoryHandle(s, { create }); }
    catch { return null; }
  }
  return d;
}

type MovableFileHandle = FileSystemFileHandle & {
  move?: (dest: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

/** 파일 쓰기 — `{name}.part` 에 먼저 쓰고 move() 로 승격. move() 미지원이면 최종 이름에 직접 쓴다.
 *  어느 쪽이든 **인덱스 커밋 전**이라 이 구간의 파일은 조회 경로에 노출되지 않는다(원자 경계는 인덱스). */
async function writeFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob): Promise<void> {
  const tmp = `${name}.part`;
  const th = (await dir.getFileHandle(tmp, { create: true })) as MovableFileHandle;
  const w = await th.createWritable();
  try { await w.write(blob); } finally { await w.close(); }
  if (typeof th.move === "function") { await th.move(dir, name); return; }
  const fh = await dir.getFileHandle(name, { create: true });
  const w2 = await fh.createWritable();
  try { await w2.write(blob); } finally { await w2.close(); }
  try { await dir.removeEntry(tmp); } catch { /* 남아도 인덱스에 없어 읽히지 않는다 */ }
}

/* ── 공개 표면 ── */

/** 저장본 조회(+ 소속 검사) — 없으면 null.
 *  인덱스에는 있는데 파일이 사라졌으면 인덱스를 정리하고 미스로 강등한다.
 *
 *  ★ studyUid 를 함께 돌려주는 이유: 조회 캐시(dlCache)가 key→검사 소속을 알아야 무효화를
 *    **검사 단위로 좁힐 수 있다**. 예전에는 몰라서 축출 1건마다 열려 있는 모든 뷰어 창의 blob URL
 *    캐시(최대 1200 프레임)를 통째로 버렸고, 판독 중 화면이 주기적으로 서버 렌더로 되돌아갔다. */
export async function opfsGetRec(key: string): Promise<{ blob: Blob; studyUid: string } | null> {
  if (dlSupportReason()) return null;
  let rec: DlIdxRec | undefined;
  try { rec = await idxGet(key); } catch { return null; }
  if (!rec) return null;
  try {
    const dir = await dirOf(rec.path.slice(0, -1), false);
    if (!dir) throw new Error("nodir");
    const fh = await dir.getFileHandle(rec.path[rec.path.length - 1], { create: false });
    const f = await fh.getFile();
    if (!f.size) throw new Error("empty");
    // lastUsed 갱신 — 검사 단위 LRU 의 기준. 실패해도 무해하므로 조회 결과를 막지 않는다.
    // ⚠ 매 조회마다 쓰면 CT 한 시리즈 스크롤에 IDB 쓰기가 수천 번 난다. LRU 는 '검사 단위'라
    //   분 단위 해상도면 충분하다 — 5분보다 오래된 값일 때만 갱신한다.
    const now = Date.now();
    if (now - rec.lastUsed > 300_000) void idxPut({ ...rec, lastUsed: now }).catch(() => {});
    return { blob: f, studyUid: rec.studyUid || "" };
  } catch {
    void idxDel(key).catch(() => {});   // 진실은 OPFS — 인덱스가 틀렸으면 인덱스를 버린다
    return null;
  }
}

export async function opfsGet(key: string): Promise<Blob | null> {
  return (await opfsGetRec(key))?.blob ?? null;
}

/** 존재 확인 — 인덱스만 본다(바이트를 읽지 않는다).
 *  스케줄러가 '이미 받은 것 건너뛰기'에 쓴다. 인덱스가 틀렸더라도 실제 조회(opfsGet)가
 *  그때 정리하므로, 여기서 파일까지 여는 비용을 치를 이유가 없다. */
export async function opfsHas(key: string): Promise<boolean> {
  if (dlSupportReason()) return false;
  try { return !!(await idxGet(key)); } catch { return false; }
}

/** 아직 받지 않은 작업만 남긴다 — 스케줄러 pump 의 '이미 있는 키는 재요청하지 않는다' 규칙 본체.
 *
 *  ★ 이 규칙이 **재개**를 성립시킨다. 뷰어를 닫으면 다운로드가 멈추고(dlStop) 다시 열면 되살아나는데
 *    (dlResume), 재개는 그 검사를 처음부터 다시 훑는다. 여기서 이미 있는 키를 걸러내지 않으면
 *    닫았다 여는 것을 반복할 때마다 같은 바이트를 원격 A 에서 다시 내려받는다.
 *  ⚠ 존재 확인은 **묶어서 동시에** 돌린다(IDB get 뿐이다). 완전 직렬이면 큰 시리즈에서 첫 fetch 가
 *    그만큼 늦어지고, 전부 한꺼번에 띄우면 수천 개 트랜잭션이 한 번에 몰린다.
 *  has 를 인자로 받는 이유: OPFS·IndexedDB 가 없는 node 테스트에서도 규칙 자체를 검증할 수 있게
 *    (planViewerOpen 과 같은 계약 — 판정은 인자만 본다). */
export async function pendingTasks<T extends { key: string }>(
  tasks: readonly T[], has: (key: string) => Promise<boolean>,
): Promise<T[]> {
  const out: T[] = [];
  const CHUNK = 64;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const part = tasks.slice(i, i + CHUNK);
    const flags = await Promise.all(part.map((t) => has(t.key).catch(() => false)));
    part.forEach((t, n) => { if (!flags[n]) out.push(t); });
  }
  return out;
}

/** 자격 확인 — 토큰이 이미 지워졌으면 **아무것도 쓰지 않는다**.
 *  로그아웃/세션 만료 순간 in-flight 였던 fetch 가 200 으로 끝나면, opfsWipe() 가 v1/ 트리를
 *  지운 **뒤에** opfsPut 이 `create:true` 로 트리를 되살리고 인덱스까지 커밋해 환자 영상이
 *  다시 브라우저에 남는다. 스케줄러 정지(sv-auth-cleared)만으로는 이 레이스 창이 안 닫힌다.
 *  ⚠ 이 모듈은 api.ts·imageFormat 를 import 하지 않는 규약이라 저장소를 직접 본다(같은 키). */
function hasAuthToken(): boolean {
  try { return !!(localStorage.getItem("sv_token") ?? sessionStorage.getItem("sv_token")); }
  catch { return false; }
}

/** 저장 — 파일 기록이 끝난 뒤에만 인덱스에 커밋한다(원자 경계). */
export async function opfsPut(
  key: string, blob: Blob, kind: DlKind, sopUid: string, m: DlMeta, fmtTag = "",
): Promise<boolean> {
  if (dlSupportReason()) return false;
  if (!blob.size) return false;
  if (!hasAuthToken()) return false;   // 자격 소멸 후 재기록 금지(위 주석)
  const { path, dir } = dlPathFor(kind, sopUid, m, fmtTag);
  try {
    // 먼저 인덱스에서 지운다 — 같은 키를 덮어쓰는 동안 조회가 옛 경로를 읽지 않게(쓰기 중 노출 차단)
    await idxDel(key).catch(() => {});
    const d = await dirOf(path.slice(0, -1), true);
    if (!d) return false;
    await writeFile(d, path[path.length - 1], blob);
    const now = Date.now();
    await idxPut({ k: key, path, dir, bytes: blob.size, studyUid: m.studyUid, ts: now, lastUsed: now,
                   studyDate: m.studyDate || "" });
    return true;
  } catch {
    return false;
  }
}

/** 검사 하나를 통째로 폐기 — A 에서 픽셀이 바뀌었을 때(SSE changed_studies)·상한 초과 축출에서 호출한다.
 *  반환값 = **인덱스에서 실제로 빠진 바이트**(회계 기준은 인덱스다. 아래 ⚠ 참조).
 *
 *  ⚠ 폴더는 recs[0].dir 하나가 아니라 **레코드에 나온 모든 dir** 을 지운다. 검사 폴더는
 *    {검사일}/{환자ID__UID12} 라서, 워크리스트가 준 검사일·환자ID 가 중간에 바뀌면(재조회로
 *    값이 교정되는 경우가 있다) 같은 검사의 파일이 두 폴더에 걸린다. 한 폴더만 지우면 나머지는
 *    인덱스에도 없고 폴더도 남는 **고아 파일**이 되어 opfsUsage·opfsPrune 양쪽에서 안 보인다
 *    (= 설정상 2GB 인데 실제 점유는 그보다 크다).
 *  ⚠ freed 는 removeEntry 성공 여부가 아니라 **인덱스 삭제**를 센다. 인덱스가 이 모듈의 회계
 *    장부이고(opfsUsage 도 인덱스 합계다) 조회 가능성도 인덱스가 결정하기 때문이다. */
export async function opfsEvictStudy(studyUid: string): Promise<number> {
  if (dlSupportReason()) return 0;
  let recs: DlIdxRec[] = [];
  try { recs = await idxByStudy(studyUid); } catch { return 0; }
  if (!recs.length) return 0;
  // 인덱스를 먼저 지운다 — 파일 삭제가 중간에 실패해도 '낡은 영상이 계속 히트'하는 일은 없다
  let freed = 0;
  for (const r of recs) {
    try { await idxDel(r.k); freed += r.bytes || 0; } catch { /* 항목 단위 무시 */ }
  }
  const dirs = new Map<string, string[]>();
  for (const r of recs) if (r.dir?.length) dirs.set(r.dir.join("/"), r.dir);
  for (const dir of dirs.values()) {
    try {
      const parent = await dirOf(dir.slice(0, -1), false);
      if (parent) await parent.removeEntry(dir[dir.length - 1], { recursive: true });
    } catch { /* 폴더가 이미 없거나 잠김 — 인덱스가 비었으므로 조회되지 않는다 */ }
  }
  return freed;
}

/** 전부 비우기 — **로그아웃·세션 만료·계정 전환 시 필수**.
 *  환자 영상이 브라우저에 영구히 남는 표면을 새로 만드는 일이다. 공용 판독 PC 에서 로그아웃
 *  후에도 남으면 사고다(09 세션이 같은 논리로 픽셀 쿠키 sv_pix 폐기를 강제했다). */
export async function opfsWipe(): Promise<void> {
  // ★ 순서가 규칙이다: **파일 먼저, 인덱스 나중**.
  //   중간에 끊길 수 있는 경로(401 → 곧 location.reload)에서 어느 쪽으로 실패하는지가 갈린다.
  //   · 인덱스 먼저 지우면: '앱에는 안 보이는데 OPFS 에는 환자 영상이 그대로' — 공용 판독 PC 사고.
  //     게다가 다시 지울 계기가 없다(opfsWipe 는 setToken(null) 에서만 불린다).
  //   · 파일 먼저 지우면: '인덱스는 있는데 파일 없음' → opfsGet 이 조회 때 스스로 인덱스를 버린다.
  //   안전한 방향으로 실패하도록 파일을 먼저 지운다.
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(ROOT, { recursive: true });
  } catch { /* 없으면 성공과 같다 */ }
  try {
    const db = await idb();
    await new Promise<void>((res) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).clear();
      t.oncomplete = () => res(); t.onerror = () => res(); t.onabort = () => res();
    });
  } catch { /* 인덱스가 남아도 위에서 파일을 지웠으므로 조회는 미스로 자가 정리된다 */ }
}

export interface DlUsage { bytes: number; files: number; studies: number; quota: number }

export async function opfsUsage(): Promise<DlUsage> {
  const out: DlUsage = { bytes: 0, files: 0, studies: 0, quota: 0 };
  try {
    const est = await navigator.storage?.estimate?.();
    out.quota = est?.quota ?? 0;
  } catch { /* 무시 */ }
  try {
    const recs = await idxAll();
    const st = new Set<string>();
    for (const r of recs) { out.bytes += r.bytes || 0; out.files++; st.add(r.studyUid); }
    out.studies = st.size;
  } catch { /* 무시 */ }
  return out;
}

/* ── 상한 초과 자동 삭제 ────────────────────────────────────────────────────
 * 축출 **순서 결정**은 아래 planEvictions 하나에 모은다. 이유가 둘 있다:
 *  ① 예전 opfsPrune 은 첫 줄이 dlSupportReason()(= import.meta.env·window·navigator)이라
 *     node --test 가 부를 수 없었고, 그래서 축출 규칙 회귀 테스트가 **0건**이었다. 설정 문구는
 *     '오래된 검사부터'인데 실제 동작은 lastUsed LRU 였던 것도 그래서 아무도 못 잡았다.
 *  ② 정책이 둘(date/lru)로 늘어나도 **보호 규칙(보고 있는 검사는 안 지운다)이 갈리지 않게**
 *     하려면 두 정책이 같은 함수를 통과해야 한다.
 */

/** 축출 기준. date = 검사일이 오래된 것부터(기본·설정 문구와 일치) / lru = 마지막 사용이 오래된 것부터.
 *  ⚠ lastUsed 는 5분 스로틀(opfsGet)이라 '정확한 최근 사용'이 아니다 — 5분보다 짧은 차이는 안 보인다. */
export type EvictPolicy = "date" | "lru";

/** planEvictions 가 보는 최소 레코드(DlIdxRec 의 부분집합) — 테스트가 손으로 만들 수 있게. */
export interface EvictRec {
  studyUid: string;
  bytes: number;
  lastUsed: number;
  studyDate?: string;   // 새 레코드
  dir?: string[];       // 옛 레코드 폴백(dir[1] = 검사일 세그먼트)
}

export interface EvictPlan {
  /** 지울 검사 uid — 지울 순서 그대로 */
  evict: string[];
  freedBytes: number;
  totalBytes: number;
  /** 보호된 검사를 건너뛰느라 상한을 못 맞췄다 — 호출부는 '더 받지 않기'로 대응해야 한다 */
  blockedByProtection: boolean;
}

/** 'YYYYMMDD' | 'YYYY-MM-DD' → 정렬용 숫자(YYYYMMDD). 모르면 0.
 *  워크리스트 행의 study_date 는 'YYYYMMDD' 이고(worklistQuery.studyEpoch 와 같은 입력),
 *  폴더 세그먼트도 그것을 seg() 한 값이라 둘 다 받는다. 'nodate' 는 0 이 된다. */
export function studyDateRank(s: string | undefined): number {
  const d = String(s ?? "").replace(/\D/g, "");
  if (d.length !== 8) return 0;
  const n = Number(d);
  return Number.isFinite(n) && n >= 10000101 ? n : 0;
}

/** 축출 계획 — **순수 함수**(브라우저 API 의존 0. tests/dl_evict_rule.test.mjs 가 직접 부른다).
 *
 *  규칙:
 *   · 삭제 단위는 **검사**다. 이미지 단위로 지우면 반쪽짜리 검사가 남아 '빠르다'는 체감이 깨진다.
 *   · policy=date  → 검사일 오름차순(과거 검사부터). 동률은 lastUsed 로 깬다.
 *   · policy=lru   → lastUsed 오름차순. 동률은 검사일로 깬다.
 *   · **검사일을 모르는 검사(nodate/파싱불가)는 가장 뒤로 민다.** 모르는 것을 1순위로 만들면
 *     방금 받은 검사가 제일 먼저 날아간다(= 받자마자 지우는 되돌이).
 *   · protectedUids 는 건너뛴다. 그것 때문에 상한을 못 맞추면 blockedByProtection 을 낸다 —
 *     이 신호가 없으면 '상한보다 큰 검사 하나' 상황에서 받는 중인 검사를 스스로 지우고 다시 받는
 *     무한 루프가 된다(원격 PACS 를 영원히 두들기는 부하 경로).
 */
export function planEvictions(i: {
  records: readonly EvictRec[];
  limitBytes: number;
  policy?: EvictPolicy;
  protectedUids?: Iterable<string>;
}): EvictPlan {
  const policy: EvictPolicy = i.policy === "lru" ? "lru" : "date";   // 오타·미지정은 전부 기본(date)
  const prot = new Set<string>();
  for (const u of i.protectedUids ?? []) if (u) prot.add(u);
  const byStudy = new Map<string, { bytes: number; lastUsed: number; rank: number }>();
  let total = 0;
  for (const r of i.records ?? []) {
    const uid = r?.studyUid;
    if (!uid) continue;
    const b = Number(r.bytes) || 0;
    total += b;
    const cur = byStudy.get(uid) ?? { bytes: 0, lastUsed: 0, rank: 0 };
    cur.bytes += b;
    const lu = Number(r.lastUsed) || 0;
    if (lu > cur.lastUsed) cur.lastUsed = lu;
    if (!cur.rank) cur.rank = studyDateRank(r.studyDate) || studyDateRank(r.dir?.[1]);
    byStudy.set(uid, cur);
  }
  const plan: EvictPlan = { evict: [], freedBytes: 0, totalBytes: total, blockedByProtection: false };
  if (!(i.limitBytes > 0) || total <= i.limitBytes) return plan;
  const UNKNOWN = Number.MAX_SAFE_INTEGER;   // 검사일 미상 = 가장 마지막에 지운다(위 규칙)
  const order = [...byStudy.entries()].sort(([ua, a], [ub, b]) => {
    const ra = a.rank || UNKNOWN, rb = b.rank || UNKNOWN;
    if (policy === "date") {
      if (ra !== rb) return ra - rb;
      if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
    } else {
      if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
      if (ra !== rb) return ra - rb;
    }
    return ua < ub ? -1 : ua > ub ? 1 : 0;   // 완전 순서 — 엔진 정렬 안정성에 기대지 않는다
  });
  for (const [uid, v] of order) {
    if (total - plan.freedBytes <= i.limitBytes) break;
    if (prot.has(uid)) continue;              // 보고 있는·받는 중인 검사는 지우지 않는다
    plan.evict.push(uid);
    plan.freedBytes += v.bytes;
  }
  plan.blockedByProtection = total - plan.freedBytes > i.limitBytes;
  return plan;
}

export interface PruneOpts {
  policy: EvictPolicy;
  /** 지우면 안 되는 검사 — 받는 중 + 살아 있는 뷰어 창이 물고 있는 검사(dlScheduler.protectedUids).
   *  ⚠ **명시 인자**다. 예전 시그니처(limitBytes 하나)를 유지하면 보호가 조용히 무동작이 된다 —
   *    이 저장소가 두 번 겪은 유형이라 호출부가 빈 배열을 넘기지 않는지 테스트로 못 박는다. */
  protectedUids: Iterable<string>;
  /** true = 계획만 세우고 지우지 않는다(자동 삭제 OFF 에서 '상한 도달' 판정에만 쓴다) */
  dryRun?: boolean;
}
export interface PruneResult {
  /** 축출 전 인덱스 합계 */
  totalBytes: number;
  freed: number;
  /** 실제로 지운 검사 uid — 호출부가 doneUids 정리·캐시 무효화에 쓴다 */
  evicted: string[];
  blocked: boolean;
}

/** 상한 초과분 정리 — planEvictions 의 계획을 실행하는 껍데기.
 *  ★ 항목 하나의 실패로 루프가 끊기면 상한이 조용히 무시된다(백엔드 _prune_cache 가 정확히
 *    그렇게 죽었다 — 3e2099f). try/catch 를 **항목 단위**로 건다. */
export async function opfsPrune(limitBytes: number, opts: PruneOpts): Promise<PruneResult> {
  const out: PruneResult = { totalBytes: 0, freed: 0, evicted: [], blocked: false };
  if (dlSupportReason() || !(limitBytes > 0)) return out;
  let recs: DlIdxRec[];
  try { recs = await idxAll(); } catch { return out; }
  const plan = planEvictions({
    records: recs, limitBytes, policy: opts.policy, protectedUids: opts.protectedUids,
  });
  out.totalBytes = plan.totalBytes;
  out.blocked = plan.blockedByProtection;
  if (opts.dryRun) return out;
  for (const uid of plan.evict) {
    try {
      const n = await opfsEvictStudy(uid);
      if (n > 0) { out.freed += n; out.evicted.push(uid); }
    } catch { /* 이 검사만 건너뛴다 — 루프는 계속(위 주석) */ }
  }
  return out;
}

/** 영속 권한 요청 — 안 하면 브라우저가 압박 시 **조용히** 통째로 지운다. 부팅 시 1회. */
export async function opfsPersist(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch { return false; }
}

/** 실효 상한 — 설정값과 브라우저 할당량의 절반 중 작은 쪽(할당량을 다 쓰면 evict 가 일어난다). */
export async function opfsLimitBytes(prefGb: number): Promise<number> {
  const pref = Math.max(0.5, prefGb || 2) * 1024 * 1024 * 1024;
  try {
    const est = await navigator.storage?.estimate?.();
    const q = est?.quota ?? 0;
    return q > 0 ? Math.min(pref, q * 0.5) : pref;
  } catch { return pref; }
}
