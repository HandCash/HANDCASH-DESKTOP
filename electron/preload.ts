import { contextBridge, ipcRenderer } from 'electron'

export type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

export type HttpResponseEvent = {
  request_id: number
  status: number
  body: string
}

export type BridgeStatus = {
  online: boolean
  httpsUrl: string
  httpUrl: string
  devicePeerPort?: number
  devicePeerLanUrls?: string[]
  devicePeerOnline?: boolean
  error: string | null
}

type UpdateMode = 'default' | 'manual' | 'none'

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error'

type UpdateStatus = {
  phase: UpdatePhase
  mode: UpdateMode
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  error: string | null
  canInstall: boolean
}

const handcash = {
  platform: process.platform,
  getAppInfo: () =>
    ipcRenderer.invoke('app:get-info') as Promise<{
      version: string
      name: string
      isPackaged: boolean
      platform: string
    }>,
  getBridgeStatus: () => ipcRenderer.invoke('bridge:get-status') as Promise<BridgeStatus>,
  restartBridge: () => ipcRenderer.invoke('bridge:restart') as Promise<BridgeStatus>,
  onBridgeStatus: (handler: (status: BridgeStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: BridgeStatus) => handler(status)
    ipcRenderer.on('bridge-status', listener)
    return () => ipcRenderer.removeListener('bridge-status', listener)
  },
  onHttpRequest: (handler: (event: HttpRequestEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: HttpRequestEvent) => {
      handler(payload)
    }
    ipcRenderer.on('http-request', listener)
    // Registering the listener *is* the readiness signal — the bridge holds
    // requests until it knows someone is listening.
    ipcRenderer.send('bridge:renderer-ready')
    return () => ipcRenderer.removeListener('http-request', listener)
  },
  onDevicePeerHttpRequest: (handler: (event: HttpRequestEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: HttpRequestEvent) => {
      handler(payload)
    }
    ipcRenderer.on('device-peer-http-request', listener)
    return () => ipcRenderer.removeListener('device-peer-http-request', listener)
  },
  onHttpRequestCancelled: (handler: (payload: { request_id: number; reason: string }) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      payload: { request_id: number; reason: string },
    ) => handler(payload)
    ipcRenderer.on('http-request-cancelled', listener)
    return () => ipcRenderer.removeListener('http-request-cancelled', listener)
  },
  respondHttp: (response: HttpResponseEvent) => {
    ipcRenderer.send('http-response', response)
  },
  respondDevicePeerHttp: (response: HttpResponseEvent) => {
    ipcRenderer.send('device-peer-http-response', response)
  },
  focusWindow: () => ipcRenderer.invoke('app:focus-window') as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
  getLogInfo: () =>
    ipcRenderer.invoke('app:get-log-info') as Promise<{
      file: string | null
      dir: string | null
    }>,
  openLogs: () =>
    ipcRenderer.invoke('app:open-logs') as Promise<
      { ok: true; file: string } | { ok: false; error: string }
    >,
  readLogs: (opts?: { maxBytes?: number }) =>
    ipcRenderer.invoke('app:read-logs', opts) as Promise<
      | { ok: true; text: string; bytes: number; truncated: boolean }
      | { ok: false; error: string }
    >,
  uploadLogs: (url: string) =>
    ipcRenderer.invoke('app:upload-logs', url) as Promise<
      | { ok: true; bytes: number; status: number }
      | { ok: false; error: string }
    >,
  storageGetSync: (key: string) =>
    ipcRenderer.sendSync('storage:get-sync', key) as string | null,
  storageSetSync: (
    key: string,
    value: string,
    opts?: { allowVaultIdentityReplace?: boolean },
  ) => ipcRenderer.sendSync('storage:set-sync', key, value, opts) as boolean,
  safeStorageAvailable: () =>
    ipcRenderer.invoke('storage:safe-storage-available') as Promise<boolean>,
  wipeWalletStorage: () =>
    ipcRenderer.invoke('storage:wipe-wallet') as Promise<{ removed: number }>,
  archiveBrc39Snapshot: (payload: {
    identityKey: string
    bytesBase64: string
    exportedAt?: number
  }) =>
    ipcRenderer.invoke('brc39-archive:write', payload) as Promise<{
      created: boolean
      meta: {
        id: string
        identityKey: string
        exportedAt: number
        bytes: number
        sha256: string
        path: string
      }
    }>,
  listBrc39Archive: (identityKey: string) =>
    ipcRenderer.invoke('brc39-archive:list', identityKey) as Promise<
      Array<{
        id: string
        identityKey: string
        exportedAt: number
        bytes: number
        sha256: string
        path: string
      }>
    >,
  readBrc39Archive: (payload: { identityKey: string; id: string }) =>
    ipcRenderer.invoke('brc39-archive:read', payload) as Promise<{
      meta: {
        id: string
        identityKey: string
        exportedAt: number
        bytes: number
        sha256: string
        path: string
      }
      bytesBase64: string
    }>,
  brc39ArchiveRoot: () => ipcRenderer.invoke('brc39-archive:root') as Promise<string>,
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text) as Promise<void>,
  clipboardWriteImage: (payload: { mime: string; base64: string }) =>
    ipcRenderer.invoke('clipboard:write-image', payload) as Promise<void>,
  saveImageFile: (payload: { filename: string; mime: string; base64: string }) =>
    ipcRenderer.invoke('dialog:save-image', payload) as Promise<
      { ok: true; canceled?: boolean; path?: string } | { ok: false; error: string }
    >,
  copyScreenshot: () =>
    ipcRenderer.invoke('clipboard:screenshot') as Promise<
      { ok: true; version: string } | { ok: false; error: string }
    >,
  onScreenshotCopied: (handler: (payload: { at: number; version: string }) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      payload: { at: number; version: string },
    ) => handler(payload)
    ipcRenderer.on('screenshot:copied', listener)
    return () => ipcRenderer.removeListener('screenshot:copied', listener)
  },
  getUpdateStatus: () => ipcRenderer.invoke('updater:get-status') as Promise<UpdateStatus>,
  checkForUpdates: () => ipcRenderer.invoke('updater:check') as Promise<UpdateStatus>,
  downloadUpdate: () => ipcRenderer.invoke('updater:download') as Promise<UpdateStatus>,
  setUpdateMode: (mode: UpdateMode) =>
    ipcRenderer.invoke('updater:set-mode', mode) as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.invoke('updater:install') as Promise<void>,
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: UpdateStatus) => handler(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },
}

contextBridge.exposeInMainWorld('handcash', handcash)

declare global {
  interface Window {
    handcash: typeof handcash
  }
}
