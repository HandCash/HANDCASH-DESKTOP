import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@aeon-ui/panda/styles.css'
import '@aeon-ui/panda/theme-runtime.css'
import './styles/handcash.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
