import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import log from 'electron-log'
import electronUpdater from 'electron-updater'
import { startHttpServer, type BridgeServerHandle } from './httpServer.js'
import { durableGet, durableSet } from './durableStore.js'

const { autoUpdater } = electronUpdater

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

/** Same origin as Vite — IndexedDB/localStorage stay shared across `npm run dev` and packaged. */
const APP_ORIGIN = 'http://localhost:5173'
const APP_PORT = 5173

log.transports.file.level = 'info'
autoUpdater.logger = log
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

let mainWindow: BrowserWindow | null = null
let bridge: BridgeServerHandle | null = null
let bridgeError: string | null = null
let staticServer: http.Server | null = null

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('--disable-gpu-sandbox')
  app.commandLine.appendSwitch('--enable-features', 'WaylandWindowDecorations')
}

function getIconPath(): string | undefined {
  return path.join(__dirname, '../build/icon.png')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

/**
 * Serve packaged `dist/` on localhost:5173 so Chromium uses the same origin
 * (and IndexedDB) as `npm run dev`. LevelDB copies between file:// and http:// are unreliable.
 */
async function ensurePackagedStaticServer(): Promise<void> {
  if (isDev || staticServer) return
  const distRoot = path.join(__dirname, '../dist')
  const server = http.createServer((req, res) => {
    try {
      const raw = decodeURIComponent((req.url ?? '/').split('?')[0] || '/')
      let rel = raw === '/' ? '/index.html' : raw
      if (rel.includes('\0') || rel.includes('..')) {
        res.writeHead(400).end('Bad request')
        return
      }
      let filePath = path.join(distRoot, rel)
      if (!filePath.startsWith(distRoot)) {
        res.writeHead(403).end('Forbidden')
        return
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distRoot, 'index.html')
      }
      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
      fs.createReadStream(filePath).pipe(res)
    } catch (err) {
      log.warn('static serve error', err)
      res.writeHead(500).end('Error')
    }
  })

  await new Promise<void>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.info(`Port ${APP_PORT} already in use — loading ${APP_ORIGIN} (Vite or prior server)`)
        staticServer = null
        resolve()
        return
      }
      log.error('Packaged static server failed', err)
      resolve()
    })
    server.listen(APP_PORT, '127.0.0.1', () => {
      staticServer = server
      log.info(`Packaged UI serving at ${APP_ORIGIN}`)
      resolve()
    })
  })
}

function isAppUrl(url: string): boolean {
  return url.startsWith(APP_ORIGIN) || url.startsWith('http://127.0.0.1:5173')
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

  void mainWindow.loadURL(APP_ORIGIN)
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
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
  await ensurePackagedStaticServer()
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
  staticServer?.close()
  staticServer = null
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
