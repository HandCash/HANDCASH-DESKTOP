import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import log from 'electron-log'
import { startHttpServer, type BridgeServerHandle } from './httpServer.js'
import {
  listLanIpv4Addresses,
  startDevicePeerServer,
} from './devicePeerServer.js'
import { durableGet, durableSafeStorageAvailable, durableSet, durableWipeWallet } from './durableStore.js'
import {
  brc39ArchiveRootPath,
  listArchiveForIdentity,
  readBrc39ArchiveSnapshot,
  writeBrc39ArchiveSnapshot,
} from './brc39Archive.js'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  initAutoUpdater,
  quitAndInstall,
  setUpdateMode,
  type UpdateMode,
} from './autoUpdate.js'
import {
  shouldLoadViaLocalhostOrigin,
  startPackagedUiServer,
  stopPackagedUiServer,
  UI_ORIGIN,
} from './uiServer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

/**
 * Renderer origin:
 * - Dev: Vite on http://localhost:5173
 * - Packaged: prefer the same localhost origin when that IndexedDB partition holds
 *   the toolbox UTXO set (common after npm run dev). Vault keys are durable/OS-sealed
 *   and origin-independent. Otherwise file:// (file__0.*).
 */
const DEV_ORIGIN = UI_ORIGIN

log.transports.file.level = 'info'

let mainWindow: BrowserWindow | null = null
let bridge: BridgeServerHandle | null = null
let bridgeError: string | null = null
let devicePeer: Awaited<ReturnType<typeof startDevicePeerServer>> | null = null
let packagedUiOrigin: string | null = null

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('--disable-gpu-sandbox')
  app.commandLine.appendSwitch('--enable-features', 'WaylandWindowDecorations')
}

function getIconPath(): string | undefined {
  return path.join(__dirname, '../build/icon.png')
}

function isAppUrl(url: string): boolean {
  if (url.startsWith(DEV_ORIGIN) || url.startsWith('http://127.0.0.1:5173')) return true
  if (packagedUiOrigin && url.startsWith(packagedUiOrigin)) return true
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
    // http(s) for links; mailto for user-controlled key-slice / share handoff.
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function bridgeStatus() {
  const lanUrls =
    devicePeer?.lanUrls ??
    listLanIpv4Addresses().map((ip) => `http://${ip}:3340`)
  return {
    online: bridge !== null,
    httpsUrl: bridge?.httpsUrl ?? 'https://127.0.0.1:2121',
    httpUrl: bridge?.httpUrl ?? 'http://127.0.0.1:3321',
    devicePeerPort: 3340,
    devicePeerLanUrls: lanUrls,
    devicePeerOnline: devicePeer !== null,
    error: bridgeError,
  }
}

function notifyBridgeStatus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('bridge-status', bridgeStatus())
}

/** Capture the main window and put a PNG on the system clipboard. */
async function copyAppScreenshotToClipboard(): Promise<
  { ok: true; version: string } | { ok: false; error: string }
> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'No window to capture' }
  }
  const version = app.getVersion()
  const badge = `HandCash ${version} BETA`
  let badgeInjected = false
  try {
    // Stamp version onto the capture so shares advertise the build.
    await mainWindow.webContents.executeJavaScript(
      `(() => {
        const existing = document.getElementById('hc-screenshot-badge');
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.id = 'hc-screenshot-badge';
        el.setAttribute('aria-hidden', 'true');
        el.textContent = ${JSON.stringify(badge)};
        el.style.cssText = [
          'position:fixed',
          'right:14px',
          'bottom:14px',
          'z-index:2147483647',
          'padding:6px 10px',
          'border-radius:8px',
          'border:1px solid rgba(56,211,133,0.55)',
          'background:rgba(6,12,10,0.88)',
          'color:#38d385',
          'font:700 12px/1.2 "IBM Plex Sans",system-ui,sans-serif',
          'letter-spacing:0.06em',
          'text-transform:uppercase',
          'pointer-events:none',
          'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
        ].join(';');
        document.body.appendChild(el);
      })()`,
    )
    badgeInjected = true
    // Let layout paint the badge before capture.
    await new Promise((r) => setTimeout(r, 40))

    const image = await mainWindow.capturePage()
    if (image.isEmpty()) {
      return { ok: false, error: 'Capture was empty' }
    }
    clipboard.writeImage(image)
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot:copied', { at: Date.now(), version })
    }
    log.info('App screenshot copied to clipboard', version)
    return { ok: true, version }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error('Screenshot to clipboard failed', error)
    return { ok: false, error }
  } finally {
    if (badgeInjected && mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.webContents
        .executeJavaScript(
          `document.getElementById('hc-screenshot-badge')?.remove()`,
        )
        .catch(() => {})
    }
  }
}

function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'selectAll' as const }] : [
          { role: 'selectAll' as const },
        ]),
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Copy Screenshot',
          accelerator: 'CommandOrControl+Shift+S',
          click: () => {
            void copyAppScreenshotToClipboard()
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

  // Packaged wallets that started life under `npm run dev` keep UTXOs in the
  // localhost IndexedDB partition — load that origin so balance is not zero.
  if (isDev) {
    void mainWindow.loadURL(DEV_ORIGIN)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else if (packagedUiOrigin) {
    void mainWindow.loadURL(packagedUiOrigin)
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
  try {
    if (!devicePeer) {
      devicePeer = await startDevicePeerServer(mainWindow)
      log.info('Device peer online', devicePeer.lanUrls)
    }
  } catch (err) {
    log.warn('Device peer server failed', err)
    devicePeer = null
  }
  notifyBridgeStatus()
}

app.whenReady().then(async () => {
  // Init updater before the window so the first getUpdateStatus() has the real version
  // (not the default 0.0.0) when Settings mounts.
  initAutoUpdater({
    getMainWindow: () => mainWindow,
    currentVersion: app.getVersion(),
    isDev,
  })

  if (!isDev && shouldLoadViaLocalhostOrigin()) {
    try {
      packagedUiOrigin = await startPackagedUiServer(path.join(__dirname, '../dist'))
    } catch (err) {
      log.warn('Packaged localhost UI server failed — falling back to file://', err)
      packagedUiOrigin = null
    }
  }

  createWindow()
  installAppMenu()
  await ensureBridge()

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
  void devicePeer?.stop()
  devicePeer = null
  void stopPackagedUiServer()
})

ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  name: app.getName(),
  isPackaged: app.isPackaged,
  platform: process.platform,
}))

ipcMain.handle('app:get-log-info', () => {
  try {
    const file = log.transports.file.getFile()
    const filePath = file.path
    return {
      file: filePath,
      dir: path.dirname(filePath),
    }
  } catch (err) {
    log.warn('get-log-info failed', err)
    return { file: null, dir: null }
  }
})

ipcMain.handle('app:open-logs', async () => {
  try {
    const file = log.transports.file.getFile()
    const filePath = file.path
    // Reveal the active log file in Finder / Explorer / file manager.
    shell.showItemInFolder(filePath)
    return { ok: true as const, file: filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('open-logs failed', err)
    return { ok: false as const, error: message }
  }
})

ipcMain.handle('app:read-logs', async (_event, opts: unknown) => {
  try {
    const file = log.transports.file.getFile()
    const filePath = file.path
    const maxBytes =
      opts &&
      typeof opts === 'object' &&
      'maxBytes' in opts &&
      typeof (opts as { maxBytes: unknown }).maxBytes === 'number'
        ? Math.min(Math.max((opts as { maxBytes: number }).maxBytes, 4_096), 1_048_576)
        : 256_000
    const buf = await fs.readFile(filePath)
    const slice = buf.byteLength > maxBytes ? buf.subarray(buf.byteLength - maxBytes) : buf
    return {
      ok: true as const,
      text: slice.toString('utf8'),
      bytes: slice.byteLength,
      truncated: buf.byteLength > maxBytes,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('read-logs failed', err)
    return { ok: false as const, error: message }
  }
})

ipcMain.handle('app:upload-logs', async (_event, url: unknown) => {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false as const, error: 'Upload URL required' }
  }
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return { ok: false as const, error: 'Invalid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false as const, error: 'URL must be http(s)' }
  }
  try {
    const file = log.transports.file.getFile()
    const filePath = file.path
    const body = await fs.readFile(filePath)
    const res = await fetch(parsed.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-HandCash-Log': path.basename(filePath),
        'X-HandCash-Version': app.getVersion(),
        'X-HandCash-Platform': process.platform,
      },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false as const,
        error: `Upload failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      }
    }
    log.info('logs uploaded', { url: parsed.origin, bytes: body.byteLength })
    return { ok: true as const, bytes: body.byteLength, status: res.status }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('upload-logs failed', err)
    return { ok: false as const, error: message }
  }
})

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
  if (devicePeer) {
    await devicePeer.stop()
    devicePeer = null
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

ipcMain.handle('storage:wipe-wallet', () => durableWipeWallet())

ipcMain.handle('brc39-archive:write', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid UTXO archive payload')
  }
  const body = payload as {
    identityKey?: unknown
    exportedAt?: unknown
    bytesBase64?: unknown
  }
  if (typeof body.identityKey !== 'string' || typeof body.bytesBase64 !== 'string') {
    throw new Error('Invalid UTXO archive payload')
  }
  const bytes = Buffer.from(body.bytesBase64, 'base64')
  return writeBrc39ArchiveSnapshot({
    identityKey: body.identityKey,
    bytes,
    exportedAt: typeof body.exportedAt === 'number' ? body.exportedAt : undefined,
  })
})

ipcMain.handle('brc39-archive:list', (_event, identityKey: unknown) => {
  if (typeof identityKey !== 'string') return []
  return listArchiveForIdentity(identityKey)
})

ipcMain.handle('brc39-archive:read', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid UTXO archive read')
  }
  const body = payload as { identityKey?: unknown; id?: unknown }
  if (typeof body.identityKey !== 'string' || typeof body.id !== 'string') {
    throw new Error('Invalid UTXO archive read')
  }
  const { bytes, meta } = readBrc39ArchiveSnapshot({
    identityKey: body.identityKey,
    id: body.id,
  })
  return { meta, bytesBase64: bytes.toString('base64') }
})

ipcMain.handle('brc39-archive:root', () => brc39ArchiveRootPath())

ipcMain.handle('clipboard:write', (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('Invalid clipboard text')
  clipboard.writeText(text)
})

ipcMain.handle(
  'clipboard:write-image',
  (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid image payload')
    const mime = (payload as { mime?: unknown }).mime
    const base64 = (payload as { base64?: unknown }).base64
    if (typeof mime !== 'string' || !mime.toLowerCase().startsWith('image/')) {
      throw new Error('Invalid image type')
    }
    if (typeof base64 !== 'string' || !base64) throw new Error('Invalid image data')
    const buf = Buffer.from(base64, 'base64')
    if (buf.length === 0 || buf.length > 20 * 1024 * 1024) {
      throw new Error('Invalid image size')
    }
    const image = nativeImage.createFromBuffer(buf)
    if (image.isEmpty()) throw new Error('Could not decode image')
    clipboard.writeImage(image)
  },
)

ipcMain.handle(
  'dialog:save-image',
  async (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false as const, error: 'Invalid image payload' }
    }
    const filename = (payload as { filename?: unknown }).filename
    const mime = (payload as { mime?: unknown }).mime
    const base64 = (payload as { base64?: unknown }).base64
    if (typeof filename !== 'string' || !filename.trim()) {
      return { ok: false as const, error: 'Invalid filename' }
    }
    if (typeof mime !== 'string' || !mime.toLowerCase().startsWith('image/')) {
      return { ok: false as const, error: 'Invalid image type' }
    }
    if (typeof base64 !== 'string' || !base64) {
      return { ok: false as const, error: 'Invalid image data' }
    }
    const buf = Buffer.from(base64, 'base64')
    if (buf.length === 0 || buf.length > 20 * 1024 * 1024) {
      return { ok: false as const, error: 'Invalid image size' }
    }
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const ext = path.extname(filename).replace('.', '').toLowerCase() || 'png'
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined, {
      defaultPath: filename.replace(/[/\\]/g, '-'),
      filters: [
        { name: 'Image', extensions: [ext] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (canceled || !filePath) return { ok: true as const, canceled: true }
    await fs.writeFile(filePath, buf)
    return { ok: true as const, path: filePath }
  },
)

ipcMain.handle('clipboard:screenshot', async () => copyAppScreenshotToClipboard())
