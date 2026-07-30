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
  storageSetSync?: (key: string, value: string) => boolean
  clipboardWrite?: (text: string) => Promise<void>
}

interface Window {
  handcash?: HandCashBridge
}
