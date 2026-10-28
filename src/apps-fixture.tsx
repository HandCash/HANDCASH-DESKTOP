import { createRoot } from 'react-dom/client'
import 'aeon-ui-engine/aeon.css'
import '@aeon-ui/panda/electron.css'
import './styles/handcash.css'

import './styles/apps-page.css'
import './styles/layout-compact.css'
import './wallet/browserPolyfills'
import { startHandCashTheme } from './wallet/handcashTheme'
import { ChartAppsPanel } from './components/ChartAppsPanel'

startHandCashTheme()

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 460, padding: 24 }} id="apps"><ChartAppsPanel /></div>,
)
