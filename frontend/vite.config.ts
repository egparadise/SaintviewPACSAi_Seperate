import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const rootDir = dirname(fileURLToPath(import.meta.url))

// 자체서명 HTTPS 전용 — 모니터 감지(getScreenDetails) 등 secure context 필수 API가
// 원격 PC(다른 좌석·Tailscale) 접속에서도 동작해야 하므로 http 폴백 없이 HTTPS 로 고정한다.
// (http 로 조용히 내려가면 원격 다중 모니터 인식이 소리 없이 죽는다 — 기동 거부가 낫다)
// 인증서 생성: start_saintview.bat 이 없으면 자동 생성. 수동 생성은 frontend 에서
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/dev.key -out certs/dev.crt -days 3650 \
//     -subj "/CN=saintview-dev" \
//     -addext "subjectAltName=IP:<tailscaleIP>,IP:127.0.0.1,DNS:localhost,DNS:<host>.ts.net"
// 클라이언트는 최초 1회 '안전하지 않음' 경고를 넘기면 secure context 로 동작(내부 tail넷 전용).
function httpsOption() {
  const key = resolve(rootDir, 'certs/dev.key')
  const cert = resolve(rootDir, 'certs/dev.crt')
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error(
      '[vite] HTTPS 전용 — certs/dev.key|crt 가 없어 기동할 수 없습니다. ' +
      'start_saintview.bat 실행(자동 생성) 또는 vite.config.ts 상단의 openssl 명령으로 생성하세요.',
    )
  }
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

// https://vite.dev/config/
// Cornerstone3D 공식 Vite 가이드: codec(CJS/WASM) ESM 변환 + 워커 설정
// [Viewer Suite] 함수형 config — HTTPS 강제(인증서 필수)는 dev 서빙(serve)에만 적용.
// build 는 정적 산출물 생성이라 인증서가 필요 없다(신규 체크아웃에서 빌드 가능해야 함).
// dev(serve)와 preview(프로덕션 dist 서빙)가 동일한 프록시·HTTPS 를 쓰도록 공유 정의.
// ⚠ 프록시 대상은 반드시 127.0.0.1 — 'localhost' 는 IPv6(::1) 우선 조회 후 IPv4 폴백으로
// 연결당 ~200ms 가 붙어 프레임 로딩이 눈에 띄게 느려진다(실측: localhost 219ms vs 127.0.0.1 11ms).
const proxyConfig = {
  '/api': process.env.SV_API_URL ?? 'http://127.0.0.1:8010',            // 백엔드 FastAPI
  '/dicom-web': process.env.SV_DICOMWEB_URL ?? 'http://127.0.0.1:3001', // Orthanc DICOMweb (OHIF nginx 경유)
  '/orthanc': {                            // 썸네일 프리뷰 — Orthanc 네이티브 /instances/.../preview
    target: process.env.SV_ORTHANC_URL ?? 'http://127.0.0.1:8043',
    rewrite: (p: string) => p.replace(/^\/orthanc/, ''),
    // preview 캐시 1시간 — 200 응답에만(오류 캐시 고정 방지), immutable 금지(동일 SOP 재전송 대비)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configure: (proxy: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proxy.on('proxyRes', (proxyRes: any, req: any) => {
        if (proxyRes.statusCode === 200 && /\/instances\/[^/]+\/preview/.test(req.url ?? '')) {
          proxyRes.headers['cache-control'] = 'private, max-age=3600'
        }
      })
    },
  },
}

// 버전 정보 주입 — package.json 의 version 이 단일 소스, 적용일자는 빌드 시각.
// 설정창 헤더·[정보] 항목이 이 값을 표시한다(lib/appVersion.ts).
const pkgVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version ?? '0.0.0'
const buildDate = new Date().toISOString().slice(0, 10)

// ⚡ 사전 압축 — 빌드 산출물 옆에 .gz/.br 를 만들어 둔다.
// nginx 가 `gzip_static on;`(+`brotli_static on;`)이면 이 파일을 그대로 보내므로
// **런타임 CPU 0 으로 전송량이 1/4** 이 된다(실측: index-*.js 823KB → gzip 약 200KB).
// 실서버 점검에서 nginx gzip 이 꺼져 있어 823KB 를 그대로 보내고 있었다.
function precompress() {
  return {
    name: 'sv-precompress',
    apply: 'build' as const,
    closeBundle() {
      const dir = new URL('./dist/assets/', import.meta.url)
      let n = 0, saved = 0
      for (const f of readdirSync(dir)) {
        if (!/\.(js|css|svg|json|html)$/.test(f)) continue
        const p = new URL(f, dir)
        const raw = readFileSync(p)
        if (raw.length < 1024) continue
        const gz = gzipSync(raw, { level: 9 })
        writeFileSync(new URL(f + '.gz', dir), gz)
        const br = brotliCompressSync(raw)
        writeFileSync(new URL(f + '.br', dir), br)
        n++; saved += raw.length - br.length
      }
      if (n) console.log(`  사전 압축 ${n}개 (.gz/.br) — 절감 ${(saved / 1024 / 1024).toFixed(2)}MB`)
    },
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  plugins: [viteCommonjs(), react(), precompress()],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es' as const,
  },
  // [Viewer Suite] 프록시 대상은 env 로 지정 — 기본값은 스위트 자체 스택(API 8010·OHIF 3001·Orthanc 8043).
  // 외부 기존 서버에 붙일 때: SV_API_URL/SV_DICOMWEB_URL/SV_ORTHANC_URL 로 대상 서버를 지정하거나
  // frontend/.env 의 VITE_API_BASE 에 절대 URL 을 넣는다(docs/INTEGRATION.md 참조).
  server: {
    host: '0.0.0.0',
    allowedHosts: true,      // Vite Host 헤더 체크 우회(Tailscale IP·MagicDNS 호스트 허용)
    https: command === 'serve' ? httpsOption() : undefined,   // dev 전용 HTTPS 강제(자체서명, http 폴백 없음)
    proxy: proxyConfig,
  },
  // ⚡ preview = 프로덕션 dist 서빙. 운영 기동은 이 모드를 쓴다(dev 모드는 새 뷰어 창마다
  // 비압축 모듈 수십 개·6.8MB 를 내려받아 창 열기가 눈에 띄게 느리다 — 실측 dev 6.8MB/53요청
  // vs prod 0.7MB/3요청). dev 와 동일한 프록시·HTTPS 를 쓰도록 같은 설정을 공유한다.
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
    https: httpsOption(),
    proxy: proxyConfig,
  },
}))
