import { afterEach, describe, expect, it, vi } from 'vitest'
import { Beef, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { assign, createActor, setup, toPromise } from 'xstate'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))

import type { ComputeReply, ComputeRequest } from '../../ports/computePort'
import { bytesToBase64 } from '../base64Binary'
import { ordEnvelopeHex } from '../ordScriptPush'
import { p2pkhScriptHex } from '../ordinalOwnership'
import {
  computeActor,
  createWorkerComputePort,
  inProcessComputePort,
  setComputePortForTests,
  type ComputeWorker,
} from './computeClient'
import { handleComputeRequest } from './computeOps'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

function remittance(body = PNG, contentType = 'image/png') {
  const originTx = new Transaction()
  originTx.addInput({ sourceTXID: 'cd'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromHex(''), sequence: 0xffffffff })
  originTx.addOutput({
    lockingScript: Script.fromHex(ordEnvelopeHex(contentType, body) + p2pkhScriptHex(PrivateKey.fromRandom().toAddress())),
    satoshis: 1,
  })
  const beef = new Beef()
  beef.mergeRawTx(originTx.toBinary())
  return { origin: `${originTx.id('hex')}_0`, beefB64: bytesToBase64(new Uint8Array(beef.toBinary())) }
}

/** A worker that runs the real handler on a later task, as a thread would. */
function inProcessWorker(opts: { crash?: boolean } = {}) {
  const spawned: ComputeWorker[] = []
  const terminated: ComputeWorker[] = []
  const spawn = () => {
    const worker: ComputeWorker = {
      onmessage: null,
      onerror: null,
      postMessage(request: ComputeRequest) {
        setTimeout(() => {
          if (opts.crash) {
            worker.onerror?.({ message: 'worker died' } as ErrorEvent)
            return
          }
          const { reply } = handleComputeRequest(structuredClone(request))
          worker.onmessage?.({ data: reply } as MessageEvent<ComputeReply>)
        }, 0)
      },
      terminate() {
        terminated.push(worker)
      },
    } as ComputeWorker
    spawned.push(worker)
    return worker
  }
  return { spawn, spawned, terminated }
}

afterEach(() => {
  vi.useRealTimers()
  setComputePortForTests(null)
})

describe('compute port', () => {
  it('decodes remittance art in the worker exactly as in process', async () => {
    const request = remittance()
    const { spawn, spawned } = inProcessWorker()
    const port = createWorkerComputePort(spawn)

    const viaWorker = await port.run('itemArtFromProvenance', request)
    const inline = await inProcessComputePort.run('itemArtFromProvenance', request)

    expect(viaWorker).toEqual({ mime: 'image/png', body: PNG })
    expect(viaWorker).toEqual(inline)
    expect(spawned).toHaveLength(1)
  })

  it('answers concurrent requests by id from one worker', async () => {
    const art = remittance()
    const text = remittance(new TextEncoder().encode('hello'), 'text/plain')
    const { spawn, spawned } = inProcessWorker()
    const port = createWorkerComputePort(spawn)

    const [a, b, c] = await Promise.all([
      port.run('itemArtFromProvenance', art),
      port.run('itemArtFromProvenance', text),
      port.run('itemArtFromProvenance', { origin: 'not-an-origin', beefB64: '' }),
    ])

    expect(a?.mime).toBe('image/png')
    expect(b).toBeNull()
    expect(c).toBeNull()
    expect(spawned).toHaveLength(1)
  })

  it('hands back only the body bytes, ready to transfer', () => {
    const { reply, transfer } = handleComputeRequest({ id: 7, op: 'itemArtFromProvenance', input: remittance() })

    expect(reply).toMatchObject({ id: 7, ok: true })
    const body = (reply as { output: { body: Uint8Array } }).output.body
    expect(body.buffer.byteLength).toBe(PNG.length)
    expect(transfer).toEqual([body.buffer])
  })

  it('reports an unknown op as a failed reply, not a thrown worker', () => {
    const { reply } = handleComputeRequest({ id: 1, op: 'nope', input: {} } as unknown as ComputeRequest)
    expect(reply).toEqual({ id: 1, ok: false, error: 'Unknown compute op: nope' })
  })

  it('computes inline when the worker dies or cannot start', async () => {
    const request = remittance()
    const crashing = inProcessWorker({ crash: true })
    const port = createWorkerComputePort(crashing.spawn)

    await expect(port.run('itemArtFromProvenance', request)).resolves.toMatchObject({ mime: 'image/png' })
    await expect(port.run('itemArtFromProvenance', request)).resolves.toMatchObject({ mime: 'image/png' })
    expect(crashing.spawned).toHaveLength(1)

    const unstartable = createWorkerComputePort(() => {
      throw new Error('no workers here')
    })
    await expect(unstartable.run('itemArtFromProvenance', request)).resolves.toMatchObject({ mime: 'image/png' })
  })

  it('lets the worker go after a quiet spell and starts a fresh one on demand', async () => {
    vi.useFakeTimers()
    const request = remittance()
    const { spawn, spawned, terminated } = inProcessWorker()
    const port = createWorkerComputePort(spawn, { idleMs: 1_000 })

    const first = port.run('itemArtFromProvenance', request)
    await vi.advanceTimersByTimeAsync(0)
    await first
    expect(terminated).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(terminated).toEqual([spawned[0]])

    const second = port.run('itemArtFromProvenance', request)
    await vi.advanceTimersByTimeAsync(0)
    await second
    expect(spawned).toHaveLength(2)
  })

  it('runs as a chart actor', async () => {
    setComputePortForTests(inProcessComputePort)
    const request = remittance()
    const chart = setup({ actors: { art: computeActor('itemArtFromProvenance') } }).createMachine({
      initial: 'decoding',
      context: { mime: null as string | null },
      states: {
        decoding: {
          invoke: {
            src: 'art',
            input: request,
            onDone: { target: 'done', actions: assign({ mime: ({ event }) => event.output?.mime ?? null }) },
          },
        },
        done: { type: 'final' },
      },
      output: ({ context }) => context.mime,
    })

    await expect(toPromise(createActor(chart).start())).resolves.toBe('image/png')
  })
})
