import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary, installGlobalCrashLog } from './components/ErrorBoundary'

import { initPwa } from './lib/pwa'

// 비동기/이벤트 핸들러에서 던진 것은 ErrorBoundary 가 못 잡는다 — 전역으로도 남긴다
installGlobalCrashLog()
// PWA 설치 이벤트(beforeinstallprompt)는 부팅 직후 오므로 여기서 잡아 둔다(하단 Download 버튼이 사용)
initPwa()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary where="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
