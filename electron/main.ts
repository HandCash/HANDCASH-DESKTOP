import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import log from 'electron-log'
import electronUpdater from 'electron-updater'
import { startHttpServer, type BridgeServerHandle } from './httpServer.js'
import { durableGet, durableSet } from './durableStore.js'

const { autoUpdater } = electronUpdater

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

log.transports.file.level = 'info'
autoUpdater.logger = log
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

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

/**
 * Vite `npm run dev` stores IndexedDB under origin http://localhost:5173.
 * Packaged builds use file:// — a different origin — so balance/UTXOs look empty.
 * One-time copy when the packaged DB is still empty.
 */
function migrateIndexedDbFromViteDev(): void {
  try {
    const userData = app.getPath('userData')
    const marker = path.join(userData, 'migrated-idb-from-vite-v1')
    if (fs.existsSync(marker)) return

    const idbRoot = path.join(userData, 'IndexedDB')
    const from = path.join(idbRoot, 'http_localhost_5173.indexeddb.leveldb')
    const to = path.join(idbRoot, 'file__0.indexeddb.leveldb')
    if (!fs.existsSync(from)) {
      fs.writeFileSync(marker, JSON.stringify({ skipped: 'no-vite-idb', at: Date.now() }))
      return
    }

    const fromSize = dirBytes(from)
    const toSize = fs.existsSync(to) ? dirBytes(to) : 0
    // Only replace an empty/tiny packaged DB with the Vite one.
    if (toSize > 100_000 && toSize >= fromSize * 0.5) {
      fs.writeFileSync(
        marker,
        JSON.stringify({ skipped: 'packaged-idb-already-populated', toSize, fromSize, at: Date.now() }),
      )
      return
    }

    fs.mkdirSync(idbRoot, { recursive: true })
    fs.rmSync(to, { recursive: true, force: true })
    fs.cpSync(from, to, { recursive: true })
    fs.writeFileSync(
      marker,
      JSON.stringify({ migrated: true, fromSize, toSizeBefore: toSize, at: Date.now() }),
    )
    log.info('Migrated IndexedDB from Vite localhost origin to file:// origin', { fromSize })
  } catch (err) {
    log.warn('IndexedDB vite→packaged migration failed', err)
  }
}

function dirBytes(dir: string): number {
  let total = 0
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    total += st.isDirectory() ? dirBytes(p) : st.size
  }
  return total
}

function isAppUrl(url: string): boolean {
  if (isDev) return url.startsWith('http://localhost:5173')
  return url.startsWith('file://')
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

  if (isDev) {
    void mainWindow.loadURL('http://localhost:5173')
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
  if (!isDev) {
    migrateIndexedDbFromViteDev()
  }
  createWindow()
  await ensureBridge()

  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.warn('autoUpdater check failed', err)
    })
  }

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

ipcMain.on('storage:set-sync', (event, key: unknown, value: unknown) => {
  event.returnValue =
    typeof key === 'string' && typeof value === 'string' ? durableSet(key, value) : false
})

ipcMain.handle('clipboard:write', (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('Invalid clipboard text')
  clipboard.writeText(text)
})
