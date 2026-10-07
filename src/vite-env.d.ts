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
  channel?: 'in-app'
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

/** CSS pixels in the wallet viewport. */
type AppBrowserGuestBounds = {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

type AppBrowserGuestEvent =
  | { id: string; type: 'loading'; url: string }
  | { id: string; type: 'loaded'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'navigated'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'failed'; url: string; description: string }

interface AppBrowserGuestBridge {
  create(options: { id: string; url: string } & AppBrowserGuestBounds): Promise<void>
  setBounds(options: { id: string } & AppBrowserGuestBounds): Promise<void>
  navigate(options: { id: string; action: 'back' | 'forward' | 'reload' }): Promise<void>
  /** JPEG data URL of the page scaled to `width`, or null when nothing is drawn. */
  capture(options: { id: string; width: number }): Promise<{ dataUrl: string | null }>
  destroy(options: { id: string }): Promise<void>
  onEvent(handler: (event: AppBrowserGuestEvent) => void): () => void
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
  /** Keep BRC-100 acquire aware the wallet UI is listening. */
  announceBridgeReady?: () => void
  onDevicePeerHttpRequest?: (handler: (event: HttpRequestEvent) => void) => () => void
  onHttpRequestCancelled: (
    handler: (payload: { request_id: number; reason: string }) => void,
  ) => () => void
  respondHttp: (response: HttpResponseEvent) => void
  /** A permission prompt opened or closed; the bridge holds deadlines while one is open. */
  notePromptOpen?: (open: boolean, requestId?: number) => void
  respondDevicePeerHttp?: (response: HttpResponseEvent) => void
  focusWindow?: () => Promise<void>
  /**
   * The prompt that pulled the wallet forward is answered and no other is
   * waiting — return the desktop to the app that asked. No-op on shells that
   * cannot restore activation order.
   */
  releasePromptFocus?: () => Promise<void>
  openExternal?: (url: string) => Promise<void>
  /** Shell can host embedded `<webview>` app tabs. Desktop only. */
  embeddedAppBrowser?: boolean
  /**
   * Mobile only: a native WebView the shell lays over the browser panel's
   * content area, so app tabs draw where Desktop's `<webview>` would.
   */
  appBrowserGuest?: AppBrowserGuestBridge
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
  directSessionListen?: () => Promise<{ host: string; port: number } | null>
  directSessionConnect?: (args: {
    host: string
    port: number
    timeoutMs: number
    hello: string
  }) => Promise<
    | { ok: true; remoteHello: string; socketId: string }
    | { ok: false; immediate: boolean }
  >
  directSessionSend?: (args: {
    socketId: string
    body: string
    timeoutMs: number
  }) => Promise<boolean>
  directSessionClose?: (socketId: string) => Promise<void>
  directSessionAccept?: (args: { socketId: string; welcome: string }) => Promise<void>
  directSessionReject?: (socketId: string) => Promise<void>
  onDirectSessionHello?: (
    handler: (event: { socketId: string; hello: string }) => void,
  ) => () => void
  onDirectSessionMessage?: (
    handler: (event: { socketId: string; sender: string; body: string }) => void,
  ) => () => void
  onDirectSessionClosed?: (handler: (event: { socketId: string }) => void) => () => void
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
