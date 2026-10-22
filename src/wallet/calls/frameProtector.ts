/**
 * Puts `frameCrypto` on a media leg: every sender seals with this side's key,
 * every receiver opens with the far side's. Uses `RTCRtpScriptTransform` (a
 * worker) where Chromium has it, else encoded insertable streams on the main
 * thread. VP8 is preferred for video, whose payload header is known to stay
 * readable with the rest of the frame sealed.
 */

import { frameTransform, type FrameKind } from './frameCrypto'
import type { CallKeys } from './mediaKeys'

export type FrameProtector = {
  /** Extra peer connection configuration the protector needs. */
  config: Partial<RTCConfiguration> & { encodedInsertableStreams?: boolean }
  sender: (sender: RTCRtpSender, pc: RTCPeerConnection) => void
  receiver: (receiver: RTCRtpReceiver) => void
  close: () => void
}

type ScriptTransformCtor = new (worker: Worker, options: unknown) => unknown
type EncodedStreams = { readable: ReadableStream; writable: WritableStream }

function scriptTransform(): ScriptTransformCtor | undefined {
  return (globalThis as { RTCRtpScriptTransform?: ScriptTransformCtor }).RTCRtpScriptTransform
}

function encodedStreams(): boolean {
  const proto = (globalThis as { RTCRtpSender?: { prototype: object } }).RTCRtpSender?.prototype
  return !!proto && 'createEncodedStreams' in proto
}

/** Whether this window can encrypt call media end to end. */
export function frameEncryptionAvailable(): boolean {
  return !!scriptTransform() || encodedStreams()
}

function kindOf(track: MediaStreamTrack | null): FrameKind {
  return track?.kind === 'video' ? 'video' : 'audio'
}

function preferVp8(sender: RTCRtpSender, pc: RTCPeerConnection): void {
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
  const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs
  if (!transceiver?.setCodecPreferences || !codecs?.length) return
  const vp8 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp8')
  if (!vp8.length) return
  try {
    transceiver.setCodecPreferences([...vp8, ...codecs.filter((c) => !vp8.includes(c))])
  } catch {
    /* the transceiver is stopping */
  }
}

export function createFrameProtector(keys: CallKeys, onUnreadable: () => void): FrameProtector {
  const Transform = scriptTransform()
  if (Transform) {
    const worker = new Worker(new URL('./frame.worker.ts', import.meta.url), { type: 'module', name: 'call-frames' })
    worker.addEventListener('message', (event) => {
      if (event.data === 'unreadable') onUnreadable()
    })
    const attach = (target: RTCRtpSender | RTCRtpReceiver, mode: 'seal' | 'open') => {
      const key = mode === 'seal' ? keys.send : keys.receive
      ;(target as { transform?: unknown }).transform = new Transform(worker, { mode, kind: kindOf(target.track), key })
    }
    return {
      config: {},
      sender: (sender, pc) => {
        if (sender.track?.kind === 'video') preferVp8(sender, pc)
        attach(sender, 'seal')
      },
      receiver: (receiver) => attach(receiver, 'open'),
      close: () => worker.terminate(),
    }
  }
  const pipe = (target: RTCRtpSender | RTCRtpReceiver, mode: 'seal' | 'open') => {
    const { readable, writable } = (target as unknown as { createEncodedStreams: () => EncodedStreams }).createEncodedStreams()
    const key = mode === 'seal' ? keys.send : keys.receive
    readable
      .pipeThrough(frameTransform(key, mode, kindOf(target.track), onUnreadable))
      .pipeTo(writable)
      .catch(() => undefined)
  }
  return {
    config: { encodedInsertableStreams: true },
    sender: (sender, pc) => {
      if (sender.track?.kind === 'video') preferVp8(sender, pc)
      pipe(sender, 'seal')
    },
    receiver: (receiver) => pipe(receiver, 'open'),
    close: () => undefined,
  }
}
