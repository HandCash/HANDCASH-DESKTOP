/**
 * Records a call on this device: the mixer's one stream (everyone's audio and,
 * on a video call, everyone's video on one canvas) through a MediaRecorder in
 * one-second parts. Each part is sealed (`recordingCrypto.ts`) before it
 * leaves this module, in order, and the store keeps it on this device. A
 * sealed meta closes the recording. Nothing here touches the network.
 */

import { newRecordingId, sealMeta, sealPart } from './recordingCrypto'

export const RECORDING_PART_MS = 1000
const STOP_WAIT_MS = 3000

/** One person's media for the recording; `key` is 'self' or their identity key. */
export type RecordingSource = { key: string; label: string; stream: MediaStream | null; video: boolean }

export type RecordingMixer = {
  stream: MediaStream
  sync(sources: RecordingSource[]): void
  stop(): void
}

export type RecorderLike = {
  start(timeslice: number): void
  stop(): void
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror: ((event: unknown) => void) | null
}

export type RecordingStore = {
  append(id: string, seq: number, sealed: Uint8Array): Promise<void>
  finish(id: string, sealedMeta: Uint8Array): Promise<void>
}

export type RecorderDeps = {
  key: (id: string) => Promise<CryptoKey>
  store: RecordingStore
  mixer: (video: boolean) => RecordingMixer
  recorder: (stream: MediaStream, mime: string) => RecorderLike
  mime: (video: boolean) => string
  now: () => number
  log?: (what: string, err?: unknown) => void
}

export type ActiveRecording = {
  id: string
  sync(sources: RecordingSource[]): void
  /** Stops and closes the recording; true when every part and the meta were kept. */
  stop(peers: string[]): Promise<boolean>
}

export async function startCallRecording(
  deps: RecorderDeps,
  opts: { callId: string; video: boolean; onProblem: (text: string) => void },
): Promise<ActiveRecording> {
  const log = deps.log ?? (() => undefined)
  const id = newRecordingId()
  const key = await deps.key(id)
  const mime = deps.mime(opts.video)
  const mixer = deps.mixer(opts.video)
  let recorder: RecorderLike
  try {
    recorder = deps.recorder(mixer.stream, mime)
  } catch (err) {
    mixer.stop()
    throw err
  }
  const startedAt = deps.now()
  let seq = 0
  let kept = Promise.resolve()
  let failed = false
  const fail = (err: unknown) => {
    log('recording part not kept', err)
    if (failed) return
    failed = true
    opts.onProblem('The recording couldn’t be saved')
  }
  recorder.ondataavailable = ({ data }) => {
    if (!data.size) return
    const at = seq++
    kept = kept.then(async () => {
      if (failed) return
      const plain = new Uint8Array(await data.arrayBuffer())
      await deps.store.append(id, at, await sealPart(key, id, at, plain))
    }).catch(fail)
  }
  recorder.onerror = fail
  recorder.start(RECORDING_PART_MS)

  let stopping: Promise<boolean> | null = null
  return {
    id,
    sync: (sources) => mixer.sync(sources),
    stop(peers) {
      stopping ??= (async () => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_WAIT_MS)
          recorder.onstop = () => {
            clearTimeout(timer)
            resolve()
          }
          try {
            recorder.stop()
          } catch (err) {
            log('recorder did not stop', err)
            clearTimeout(timer)
            resolve()
          }
        })
        mixer.stop()
        await kept
        if (seq === 0 || failed) return false
        try {
          const meta = { v: 1 as const, callId: opts.callId, peers, startedAt, endedAt: deps.now(), mime, video: opts.video }
          await deps.store.finish(id, await sealMeta(key, id, meta))
          return true
        } catch (err) {
          fail(err)
          return false
        }
      })()
      return stopping
    },
  }
}
