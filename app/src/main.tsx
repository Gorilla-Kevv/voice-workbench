import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppErrorBoundary } from '@/components/features/ErrorBoundary'
import './index.css'
import App from './App.tsx'

// 错误边界放在最外层：任何渲染期异常都会变成一张可读的错误卡片，
// 而不是让 React 卸载整棵树后留下一片无从下手的白屏。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
