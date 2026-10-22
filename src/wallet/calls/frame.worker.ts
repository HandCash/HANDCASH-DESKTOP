/// <reference lib="webworker" />
/**
 * Call media encryption off the UI thread: every `RTCRtpScriptTransform` of a
 * call lands here with its direction's key and is sealed or opened frame by
 * frame. A far side whose frames stop opening is reported once.
 */
import { frameTransform, type FrameKind, type FrameMode } from './frameCrypto'

type FrameTransformer = {
  options: { mode: FrameMode; kind: FrameKind; key: CryptoKey }
  readable: ReadableStream
  writable: WritableStream
}

const scope = self as unknown as {
  onrtctransform: ((event: { transformer: FrameTransformer }) => void) | null
  postMessage: (message: unknown) => void
}

scope.onrtctransform = ({ transformer }) => {
  const { mode, kind, key } = transformer.options
  transformer.readable
    .pipeThrough(frameTransform(key, mode, kind, () => scope.postMessage('unreadable')))
    .pipeTo(transformer.writable)
    .catch(() => undefined)
}
