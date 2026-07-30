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
    return () => ipcRenderer.removeListener('http-request', listener)
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
  focusWindow: () => ipcRenderer.invoke('app:focus-window') as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
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
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text) as Promise<void>,
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
