// HTJ2K 인코더 CLI — OpenJPH WASM(@cornerstonejs/codec-openjph, 프론트 의존성 재사용).
// 사용: node htj2k_encode.mjs <jobs.json>
// jobs.json: [{ "raw": "<raw 픽셀 파일>", "out": "<출력 코드스트림>", "width", "height",
//               "bitsPerSample", "isSigned", "componentCount" }, ...]  — 배치 처리(WASM 1회 초기화)
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
// 프론트 node_modules 의 코덱 재사용 (backend 자체 node_modules 불필요)
const codecPath = join(here, "..", "..", "frontend", "node_modules", "@cornerstonejs", "codec-openjph", "dist", "openjphjs.js");
const factory = require2(codecPath);

const jobs = JSON.parse(readFileSync(process.argv[2], "utf-8"));

(factory.default ?? factory)().then((mod) => {
  const results = [];
  for (const j of jobs) {
    try {
      const enc = new mod.HTJ2KEncoder();
      const frameInfo = {
        width: j.width, height: j.height,
        bitsPerSample: j.bitsPerSample, isSigned: !!j.isSigned,
        componentCount: j.componentCount ?? 1,
        isUsingColorTransform: (j.componentCount ?? 1) > 1,
      };
      const raw = readFileSync(j.raw);
      const buf = enc.getDecodedBuffer(frameInfo);
      buf.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      enc.setQuality(true, 0);          // 무손실
      enc.setProgressionOrder(2);       // RPCL — Progressive Rendering 친화
      enc.setTLMMarker(true);           // 타일 파트 색인 — 부분 디코딩 가속
      enc.encode();
      const out = enc.getEncodedBuffer();
      writeFileSync(j.out, Buffer.from(out));
      results.push({ out: j.out, ok: true, size: out.length });
    } catch (e) {
      results.push({ out: j.out, ok: false, error: String(e).slice(0, 200) });
    }
  }
  console.log(JSON.stringify(results));
}).catch((e) => { console.error("WASM 초기화 실패:", e); process.exit(1); });
