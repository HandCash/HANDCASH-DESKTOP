/// <reference types="vite/client" />

/** Injected by the host shell's Vite config (Desktop or Mobile package.json version). */
declare const __APP_VERSION__: string | undefined

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
  onDevicePeerHttpRequest?: (handler: (event: HttpRequestEvent) => void) => () => void
  onHttpRequestCancelled: (
    handler: (payload: { request_id: number; reason: string }) => void,
  ) => () => void
  respondHttp: (response: HttpResponseEvent) => void
  respondDevicePeerHttp?: (response: HttpResponseEvent) => void
  focusWindow?: () => Promise<void>
  openExternal?: (url: string) => Promise<void>
  /**
   * Mobile only: open a BRC-100 web app in the wallet's in-app browser, which
   * can reach the local bridge. Absent on Desktop, where the OS browser can.
   */
  openAppBrowser?: (
    url: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  getLogInfo?: () => Promise<{ file: string | null; dir: string | null }>
  openLogs?: () => Promise<{ ok: true; file: string } | { ok: false; error: string }>
  readLogs?: (opts?: {
    maxBytes?: number
  }) => Promise<
    | { ok: true; text: string; bytes: number; truncated: boolean }
    | { ok: false; error: string }
  >
  uploadLogs?: (
    url: string,
  ) => Promise<
    { ok: true; bytes: number; status: number } | { ok: false; error: string }
  >
  storageGetSync?: (key: string) => string | null
  storageSetSync?: (
    key: string,
    value: string,
    opts?: { allowVaultIdentityReplace?: boolean },
  ) => boolean
  safeStorageAvailable?: () => Promise<boolean>
  deviceAuthStatus?: () => Promise<{
    available: boolean
    enrolled: boolean
    label: string
    strongBox?: boolean
  }>
  deviceAuthEnroll?: (
    secret: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  deviceAuthUnlock?: (
    reason?: string,
  ) => Promise<{ ok: true; secret: string } | { ok: false; error: string }>
  deviceAuthClear?: () => Promise<{ ok: true } | { ok: false; error: string }>
  wipeWalletStorage?: () => Promise<{ removed: number }>
  archiveBrc39Snapshot?: (payload: {
    identityKey: string
    bytesBase64: string
    exportedAt?: number
  }) => Promise<{
    created: boolean
    meta: {
      id: string
      identityKey: string
      exportedAt: number
      bytes: number
      sha256: string
      path: string
    }
  }>
  listBrc39Archive?: (identityKey: string) => Promise<
    Array<{
      id: string
      identityKey: string
      exportedAt: number
      bytes: number
      sha256: string
      path: string
    }>
  >
  readBrc39Archive?: (payload: { identityKey: string; id: string }) => Promise<{
    meta: {
      id: string
      identityKey: string
      exportedAt: number
      bytes: number
      sha256: string
      path: string
    }
    bytesBase64: string
  }>
  brc39ArchiveRoot?: () => Promise<string>
  clipboardWrite?: (text: string) => Promise<void>
  clipboardWriteImage?: (payload: { mime: string; base64: string }) => Promise<void>
  shareText?: (payload: {
    title: string
    text: string
  }) => Promise<
    { ok: true; canceled?: boolean } | { ok: false; error: string }
  >
  saveImageFile?: (payload: {
    filename: string
    mime: string
    base64: string
  }) => Promise<{ ok: true; canceled?: boolean; path?: string } | { ok: false; error: string }>
  copyScreenshot?: () => Promise<{ ok: true; version: string } | { ok: false; error: string }>
  onScreenshotCopied?: (handler: (payload: { at: number; version: string }) => void) => () => void
  getUpdateStatus?: () => Promise<UpdateStatus>
  checkForUpdates?: () => Promise<UpdateStatus>
  downloadUpdate?: () => Promise<UpdateStatus>
  setUpdateMode?: (mode: UpdateMode) => Promise<UpdateStatus>
  installUpdate?: () => Promise<void>
  onUpdateStatus?: (handler: (status: UpdateStatus) => void) => () => void
  getOmarchyTheme?: () => Promise<
    | {
        ok: true
        detected: true
        colors: {
          mode: 'light' | 'dark'
          name: string
          background: string
          darkBackground: string
          darkerBackground: string
          lighterBackground: string
          foreground: string
          darkForeground: string
          lightForeground: string
          brightForeground: string
          accent: string
          muted: string
          selection: string
          red: string
          green: string
        }
      }
    | { ok: true; detected: false }
    | { ok: false; error: string }
  >
  onOmarchyTheme?: (
    handler: (
      payload:
        | {
            ok: true
            detected: true
            colors: {
              mode: 'light' | 'dark'
              name: string
              background: string
              darkBackground: string
              darkerBackground: string
              lighterBackground: string
              foreground: string
              darkForeground: string
              lightForeground: string
              brightForeground: string
              accent: string
              muted: string
              selection: string
              red: string
              green: string
            }
          }
        | { ok: true; detected: false }
        | { ok: false; error: string },
    ) => void,
  ) => () => void
}

interface Window {
  handcash?: HandCashBridge
}
