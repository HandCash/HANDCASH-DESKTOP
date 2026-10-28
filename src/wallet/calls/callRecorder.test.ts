import { describe, expect, it } from 'vitest'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { startCallRecording, type RecorderLike, type RecordingSource } from './callRecorder'
import { openMeta, openPart, recordingKey } from './recordingCrypto'

function fakes(opts: { failAppend?: number } = {}) {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const parts = new Map<number, Uint8Array>()
  const metas = new Map<string, Uint8Array>()
  const synced: RecordingSource[][] = []
  const problems: string[] = []
  let rec: (RecorderLike & { started?: number }) | null = null
  let mixerStopped = 0
  const deps = {
    key: (id: string) => recordingKey(wallet, id),
    store: {
      append: async (_id: string, seq: number, sealed: Uint8Array) => {
        if (seq === opts.failAppend) throw new Error('disk full')
        parts.set(seq, sealed)
      },
      finish: async (id: string, sealed: Uint8Array) => {
        metas.set(id, sealed)
      },
    },
    mixer: () => ({
      stream: {} as MediaStream,
      sync: (s: RecordingSource[]) => synced.push(s),
      stop: () => {
        mixerStopped += 1
      },
    }),
    recorder: () => {
      rec = {
        start(timeslice: number) {
          rec!.started = timeslice
        },
        stop() {
          queueMicrotask(() => rec!.onstop?.())
        },
        ondataavailable: null,
        onstop: null,
        onerror: null,
      }
      return rec
    },
    mime: (video: boolean) => (video ? 'video/webm' : 'audio/webm'),
    now: () => 1000,
  }
  const emit = (bytes: number[]) => rec!.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) })
  return { wallet, deps, parts, metas, synced, problems, emit, rec: () => rec!, mixerStopped: () => mixerStopped }
}

describe('call recorder', () => {
  it('seals every part in order and closes the recording with sealed meta only this account opens', async () => {
    const f = fakes()
    const r = await startCallRecording(f.deps, { callId: 'c1', video: true, onProblem: (t) => f.problems.push(t) })
    expect(f.rec().started).toBe(1000)
    r.sync([{ key: 'self', label: 'You', stream: null, video: false }])
    expect(f.synced).toHaveLength(1)
    f.emit([1, 2, 3])
    f.emit([])
    f.emit([4, 5])
    expect(await r.stop(['02' + 'a'.repeat(64)])).toBe(true)
    expect(f.mixerStopped()).toBe(1)
    expect([...f.parts.keys()]).toEqual([0, 1])
    const key = await recordingKey(f.wallet, r.id)
    expect([...(await openPart(key, r.id, 0, f.parts.get(0)!))]).toEqual([1, 2, 3])
    expect([...(await openPart(key, r.id, 1, f.parts.get(1)!))]).toEqual([4, 5])
    expect(await openMeta(key, r.id, f.metas.get(r.id)!)).toMatchObject({ callId: 'c1', mime: 'video/webm', video: true, peers: ['02' + 'a'.repeat(64)] })
    expect(f.problems).toEqual([])
    expect(await r.stop([])).toBe(true)
  })

  it('says so when a part could not be kept, and does not close a broken recording', async () => {
    const f = fakes({ failAppend: 1 })
    const r = await startCallRecording(f.deps, { callId: 'c1', video: false, onProblem: (t) => f.problems.push(t) })
    f.emit([1])
    f.emit([2])
    f.emit([3])
    expect(await r.stop([])).toBe(false)
    expect(f.problems).toEqual(['The recording couldn’t be saved'])
    expect([...f.parts.keys()]).toEqual([0])
    expect(f.metas.size).toBe(0)
  })

  it('keeps nothing when nothing was recorded', async () => {
    const f = fakes()
    const r = await startCallRecording(f.deps, { callId: 'c1', video: false, onProblem: (t) => f.problems.push(t) })
    expect(await r.stop([])).toBe(false)
    expect(f.metas.size).toBe(0)
    expect(f.problems).toEqual([])
  })
})
