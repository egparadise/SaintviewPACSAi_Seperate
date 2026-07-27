// 검사 DICOM 내보내기 — 워크리스트에서 고른 검사를 원본 DICOM 으로 반출.
//
// 대상 3가지
//  · 폴더/USB : 브라우저 폴더 선택 후 **파일 단위로 직접 기록**(진행률 표시). USB 도 폴더로 고르면 된다.
//               File System Access API 가 있는 브라우저(Chrome·Edge)에서만 — 없으면 ZIP 으로 안내.
//  · ZIP      : 서버가 묶어 내려준다. 어느 브라우저에서나 동작.
//  · CD용 ISO : 서버가 ISO9660 이미지를 만든다.
//               ⚠ **웹 페이지는 광학 드라이브를 제어할 수 없다**(브라우저 권한 밖).
//                  구울 수 있는 이미지까지 만들어 주고, 굽기는 OS 기능을 쓴다
//                  (윈도: ISO 우클릭 → '디스크 이미지 굽기').
import { useEffect, useState } from "react";
import { api, type StudyRow } from "../api";

type Dest = "folder" | "zip" | "iso";

interface ManifestFile { path: string; sop_uid: string; series_uid: string }
interface ManifestStudy {
  id: number; patient_key: string; patient_name: string; study_date: string;
  modality: string; study_desc: string; count: number; files: ManifestFile[];
}

const hasFsAccess = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export function ExportDialog({ rows, onClose, onCsv }: {
  rows: StudyRow[]; onClose: () => void;
  /** 예전 Export(워크리스트 목록 CSV) — 영상이 아니라 표가 필요할 때 쓰라고 남겨 둔다 */
  onCsv?: () => void;
}) {
  const [dest, setDest] = useState<Dest>(hasFsAccess() ? "folder" : "zip");
  const [man, setMan] = useState<{ studies: ManifestStudy[]; total_files: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [msg, setMsg] = useState("");
  const ids = rows.map((r) => r.id).join(",");

  useEffect(() => {
    if (!ids) return;
    setMsg("목록 확인 중…");
    api.exportManifest(ids)
      .then((m) => { setMan(m); setMsg(""); })
      .catch((e) => setMsg(e instanceof Error ? e.message : "목록 조회 실패"));
  }, [ids]);

  /** 폴더/USB — 한 장씩 받아 그대로 기록. 중간에 실패해도 나머지는 계속 간다. */
  const saveToFolder = async () => {
    if (!man) return;
    const pick = (window as unknown as {
      showDirectoryPicker: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    let root: FileSystemDirectoryHandle;
    try {
      root = await pick({ mode: "readwrite" });
    } catch { return; }                       // 사용자가 취소
    setBusy(true); setDone(0); setMsg("");
    let ok = 0, fail = 0;
    for (const st of man.studies) {
      for (const f of st.files) {
        try {
          const parts = f.path.split("/");
          let dir = root;
          for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
          const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
          const w = await fh.createWritable();
          await w.write(await api.exportFile(st.id, f.sop_uid));
          await w.close();
          ok++;
        } catch { fail++; }
        setDone((n) => n + 1);
      }
    }
    setBusy(false);
    setMsg(fail ? `완료 — ${ok}장 저장, ${fail}장 실패` : `완료 — ${ok}장을 선택한 폴더에 저장했습니다`);
  };

  const download = (fmt: "zip" | "iso") => {
    setMsg(fmt === "iso"
      ? "ISO 생성 중… 영상 수에 따라 시간이 걸립니다(내려받기가 시작되면 완료)"
      : "ZIP 생성 중… 내려받기가 시작되면 완료입니다");
    window.location.href = api.exportPackageUrl(ids, fmt);
  };

  const total = man?.total_files ?? 0;
  const run = () => { if (dest === "folder") void saveToFolder(); else download(dest); };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.55)",
                  display: "grid", placeItems: "center" }} onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()}
           style={{ width: 520, maxHeight: "82vh", overflow: "auto", background: "var(--bg-panel)",
                    border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>DICOM 내보내기</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
          선택한 검사 <b>{rows.length}건</b>
          {man && <> · 영상 <b>{total}장</b></>}
          {rows.length > 1 && " (Ctrl·Shift 로 여러 건 선택)"}
        </div>

        {man && (
          <div style={{ maxHeight: 120, overflow: "auto", border: "1px solid var(--border)",
                        borderRadius: 5, padding: 6, marginBottom: 10, fontSize: 11.5 }}>
            {man.studies.map((s) => (
              <div key={s.id} style={{ display: "flex", gap: 6 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.patient_name} ({s.patient_key}) · {s.study_date} · {s.modality} {s.study_desc}
                </span>
                <b>{s.count}장</b>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {([
            ["folder", "폴더 / USB 에 저장", hasFsAccess()
              ? "폴더를 고르면 그 안에 DICOM 을 그대로 기록합니다. USB 드라이브를 고르면 USB 로 나갑니다."
              : "이 브라우저는 폴더 저장을 지원하지 않습니다 (Chrome·Edge 필요) — ZIP 을 쓰세요."],
            ["zip", "ZIP 파일로 내려받기", "어느 브라우저에서나 동작합니다. 받은 뒤 압축을 풀어 사용합니다."],
            ["iso", "CD 굽기용 ISO 만들기",
              "ISO 이미지를 만들어 내려받습니다. 굽기는 OS 기능을 쓰세요 " +
              "(윈도: ISO 우클릭 → '디스크 이미지 굽기'). 웹 페이지는 광학 드라이브를 직접 제어할 수 없습니다."],
          ] as [Dest, string, string][]).map(([k, label, help]) => (
            <label key={k} style={{ display: "flex", gap: 7, alignItems: "flex-start",
                                    opacity: k === "folder" && !hasFsAccess() ? 0.55 : 1 }}>
              <input type="radio" name="dest" checked={dest === k} disabled={k === "folder" && !hasFsAccess()}
                     onChange={() => setDest(k)} style={{ marginTop: 3 }} />
              <span>
                <b style={{ fontSize: 12.5 }}>{label}</b>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>{help}</div>
              </span>
            </label>
          ))}
        </div>

        {busy && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ height: 6, background: "var(--bg-canvas)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${total ? (done / total) * 100 : 0}%`,
                            background: "var(--accent)", transition: "width .15s" }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
              {done} / {total} 장
            </div>
          </div>
        )}
        {msg && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>{msg}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {onCsv && (
            <button style={{ marginRight: "auto", fontSize: 11 }} disabled={busy}
                    title="영상이 아니라 워크리스트 목록만 표로 내려받습니다"
                    onClick={onCsv}>목록 CSV</button>
          )}
          <button onClick={onClose} disabled={busy}>닫기</button>
          <button className="primary" onClick={run} disabled={busy || !man || total === 0}>
            {busy ? "내보내는 중…" : "내보내기"}
          </button>
        </div>
      </div>
    </div>
  );
}
