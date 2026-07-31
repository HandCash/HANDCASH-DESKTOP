/// <reference types="vite/client" />

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.svg?url' {
  const src: string
  export default src
}

type DetectedBarcode = {
  rawValue: string
  format: string
}

type BarcodeDetectorOptions = {
  formats?: string[]
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions)
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>
  static getSupportedFormats(): Promise<string[]>
}

type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

type HttpResponseEvent = {
  request_id: number
  status: number
  body: string
}

type BridgeStatus = {
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

interface HandCashBridge {
  platform?: string
  getAppInfo: () => Promise<{
    version: string
    name: string
    isPackaged: boolean
    platform: string
  }>
  getBridgeStatus: () => Promise<BridgeStatus>
  restartBridge: () => Promise<BridgeStatus>
  onBridgeStatus: (handler: (status: BridgeStatus) => void) => () => void
  onHttpRequest: (handler: (event: HttpRequestEvent) => void) => () => void
  onHttpRequestCancelled: (
    handler: (payload: { request_id: number; reason: string }) => void,
  ) => () => void
  respondHttp: (response: HttpResponseEvent) => void
  focusWindow?: () => Promise<void>
  openExternal?: (url: string) => Promise<void>
  storageGetSync?: (key: string) => string | null
  storageSetSync?: (
    key: string,
    value: string,
    opts?: { allowVaultIdentityReplace?: boolean },
  ) => boolean
  safeStorageAvailable?: () => Promise<boolean>
  wipeWalletStorage?: () => Promise<{ removed: number }>
  clipboardWrite?: (text: string) => Promise<void>
  copyScreenshot?: () => Promise<{ ok: true; version: string } | { ok: false; error: string }>
  onScreenshotCopied?: (handler: (payload: { at: number; version: string }) => void) => () => void
  getUpdateStatus?: () => Promise<UpdateStatus>
  checkForUpdates?: () => Promise<UpdateStatus>
  downloadUpdate?: () => Promise<UpdateStatus>
  setUpdateMode?: (mode: UpdateMode) => Promise<UpdateStatus>
  installUpdate?: () => Promise<void>
  onUpdateStatus?: (handler: (status: UpdateStatus) => void) => () => void
}

interface Window {
  handcash?: HandCashBridge
}
