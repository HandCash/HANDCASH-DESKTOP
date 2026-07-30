import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import log from 'electron-log'
import { startHttpServer, type BridgeServerHandle } from './httpServer.js'
import { durableGet, durableSafeStorageAvailable, durableSet } from './durableStore.js'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  initAutoUpdater,
  quitAndInstall,
  setUpdateMode,
  type UpdateMode,
} from './autoUpdate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

/** Vite / `npm run dev` origin. Packaged builds use file:// so existing IndexedDB stays intact.
 * Vault keys live in durable prefs (origin-independent + OS-sealed when available).
 * Do not flip packaged back to localhost without a proven IDB migration — that orphaned keys before. */
const DEV_ORIGIN = 'http://localhost:5173'

log.transports.file.level = 'info'

let mainWindow: BrowserWindow | null = null
let bridge: BridgeServerHandle | null = null
let bridgeError: string | null = null

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('--disable-gpu-sandbox')
  app.commandLine.appendSwitch('--enable-features', 'WaylandWindowDecorations')
}

function getIconPath(): string | undefined {
  return path.join(__dirname, '../build/icon.png')
}

function isAppUrl(url: string): boolean {
  if (url.startsWith(DEV_ORIGIN) || url.startsWith('http://127.0.0.1:5173')) return true
  if (url.startsWith('file://')) {
    const distRoot = path.join(__dirname, '../dist')
    try {
      return decodeURIComponent(fileURLToPath(url)).startsWith(distRoot)
    } catch {
      return false
    }
  }
  return false
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function bridgeStatus() {
  return {
    online: bridge !== null,
    httpsUrl: bridge?.httpsUrl ?? 'https://127.0.0.1:2121',
    httpUrl: bridge?.httpUrl ?? 'http://127.0.0.1:3321',
    error: bridgeError,
  }
}

function notifyBridgeStatus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('bridge-status', bridgeStatus())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'HandCash',
    icon: getIconPath(),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem') {
      callback(true)
      return
    }
    callback(false)
  })

  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'mediaKeySystem'
  })

  // Packaged: file:// keeps the existing Chromium IndexedDB (file__0.*).
  // Serving on localhost:5173 looks empty — LevelDB cannot be reliably copied across origins.
  if (isDev) {
    void mainWindow.loadURL(DEV_ORIGIN)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    notifyBridgeStatus()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    notifyBridgeStatus()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const handleNavigation = (event: Electron.Event, url: string) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', handleNavigation)
  mainWindow.webContents.on('will-redirect', handleNavigation)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function ensureBridge(): Promise<void> {
  if (bridge) return
  if (!mainWindow) throw new Error('No window for BRC-100 bridge')
  try {
    bridge = await startHttpServer(mainWindow)
    bridgeError = null
    log.info('BRC-100 bridge online', bridge.httpsUrl, bridge.httpUrl)
  } catch (err) {
    bridge = null
    bridgeError = err instanceof Error ? err.message : String(err)
    log.error('BRC-100 bridge failed to start', bridgeError)
  }
  notifyBridgeStatus()
}

app.whenReady().then(async () => {
  createWindow()
  await ensureBridge()

  initAutoUpdater({
    getMainWindow: () => mainWindow,
    currentVersion: app.getVersion(),
    isDev,
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      void ensureBridge()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void bridge?.stop()
  bridge = null
})

ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  name: app.getName(),
  isPackaged: app.isPackaged,
  platform: process.platform,
}))

ipcMain.handle('updater:get-status', () => getUpdateStatus())

ipcMain.handle('updater:check', async () => checkForUpdates({ reason: 'manual' }))

ipcMain.handle('updater:download', async () => downloadUpdate())

ipcMain.handle('updater:set-mode', (_event, mode: unknown) => {
  if (mode === 'default' || mode === 'manual' || mode === 'none') {
    return setUpdateMode(mode as UpdateMode)
  }
  return getUpdateStatus()
})

ipcMain.handle('updater:install', () => {
  quitAndInstall()
})

ipcMain.handle('bridge:get-status', () => bridgeStatus())

ipcMain.handle('bridge:restart', async () => {
  if (bridge) {
    await bridge.stop()
    bridge = null
  }
  await ensureBridge()
  return bridgeStatus()
})

ipcMain.handle('app:focus-window', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.dock?.show()
  app.focus({ steal: true })
})

ipcMain.handle('app:open-external', async (_event, url: unknown) => {
  if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
    throw new Error('Invalid external URL')
  }
  await shell.openExternal(url)
})

ipcMain.on('storage:get-sync', (event, key: unknown) => {
  event.returnValue = typeof key === 'string' ? durableGet(key) : null
})

ipcMain.on('storage:set-sync', (event, key: unknown, value: unknown, opts: unknown) => {
  const allow =
    opts &&
    typeof opts === 'object' &&
    !Array.isArray(opts) &&
    (opts as { allowVaultIdentityReplace?: unknown }).allowVaultIdentityReplace === true
  event.returnValue =
    typeof key === 'string' && typeof value === 'string'
      ? durableSet(key, value, allow ? { allowVaultIdentityReplace: true } : undefined)
      : false
})

ipcMain.handle('storage:safe-storage-available', () => durableSafeStorageAvailable())

ipcMain.handle('clipboard:write', (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('Invalid clipboard text')
  clipboard.writeText(text)
})
