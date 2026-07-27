import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary, installGlobalCrashLog } from './components/ErrorBoundary'

// 비동기/이벤트 핸들러에서 던진 것은 ErrorBoundary 가 못 잡는다 — 전역으로도 남긴다
installGlobalCrashLog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary where="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
