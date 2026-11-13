import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// the owner's sheet and text size, set on the page before the first paint
import './stores/appearance'
import { registerWorker } from './lib/push'

registerWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
