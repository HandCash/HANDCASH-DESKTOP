import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@aeon-ui/panda/styles.css'
import '@aeon-ui/panda/theme-runtime.css'
import './styles/handcash.css'
import { App } from './App'

// macOS Electron uses hiddenInset title bar — traffic lights overlap content without extra top padding.
if (window.handcash?.platform === 'darwin') {
  document.documentElement.classList.add('platform-darwin')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
