import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateRustEngineAccount,
  getActiveRustEngineFence,
  hydrateTxidsViaRustEngine,
  lockRustEngine,
  mirrorBrc38ToRustEngine,
  resetRustEngineBridgeForTests,
  runRustProofPoll,
  sealRustDeltaSegment,
  subscribeRustEnginePatches,
  verifyBeefViaRustEngine,
  verifyBrc150ViaRustEngine,
  type RustEnginePatch,
} from './rustEngineBridge'
import { encryptBrc39Document, resetBrc39WorkerForTests } from './brc39Encrypt'

describe('rustEngineBridge & native BRC-39 delegation', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    resetRustEngineBridgeForTests()
    resetBrc39WorkerForTests()
  })

  afterEach(() => {
    resetRustEngineBridgeForTests()
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window
    } else {
      globalThis.window = originalWindow
    }
  })

  it('tracks generation fences, filters stale patches, deduplicates BRC-38 mirror, and hydrates inputs', async () => {
    let patchCb: ((p: RustEnginePatch) => void) | null = null
    const importBrc38 = vi.fn(async () => ({
      transactions: 2,
      utxos: 4,
      items: 1,
      blobsWritten: 2,
      skippedRetiredProofReqs: 1,
    }))
    const lock = vi.fn(async () => true)
    const hydrateInputs = vi.fn(async () => ({
      found: {
        ['aa'.repeat(32)]: {
          kind: 'beef',
          bytesBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
          fromCache: true,
        },
      },
      missing: [],
    }))
    const encryptBrc39 = vi.fn(async () => new Uint8Array(64).fill(0x57))
    const verifyBeef = vi.fn(async () => ({
      valid: true,
      subjectTxid: 'aa'.repeat(32),
      txCount: 2,
      bumpCount: 1,
      error: null,
    }))
    const verifyBrc150 = vi.fn(async () => ({
      status: 'proven' as const,
      originOutpoint: `${'bb'.repeat(32)}.0`,
      tipOutpoint: `${'aa'.repeat(32)}.0`,
      path: [`${'aa'.repeat(32)}.0`, `${'bb'.repeat(32)}.0`],
      contentType: 'image/png',
    }))
    const runProofPoll = vi.fn(async () => ({
      tipHeight: 976500,
      broadcastsAccepted: 1,
      proofsSettled: 2,
    }))
    const sealDeltaSegment = vi.fn(async () => ({
      segmentId: 'seg-1234',
      rootHash: 'cc'.repeat(32),
      factCount: 3,
      sealedAtMs: 9999,
      uploadedAtMs: null,
    }))

    ;(globalThis as Record<string, unknown>).window = {
      handcash: {
        engine: {
          activateAccount: vi.fn(async (accountId: string) => ({
            accountId,
            generation: 3,
            balance: {
              spendableSats: 50_000,
              pendingChangeSats: 0,
              displayedSats: 50_000,
              spendableUtxoCount: 2,
              itemCount: 5,
            },
          })),
          lock,
          importBrc38,
          hydrateInputs,
          encryptBrc39,
          verifyBeef,
          verifyBrc150,
          runProofPoll,
          sealDeltaSegment,
          onPatch: (cb: (p: RustEnginePatch) => void) => {
            patchCb = cb
            return () => {
              patchCb = null
            }
          },
        },
      },
    }

    const received: RustEnginePatch[] = []
    const unsub = subscribeRustEnginePatches((p) => received.push(p))

    const fence = await activateRustEngineAccount('acct-1')
    expect(fence).toEqual({ accountId: 'acct-1', generation: 3 })
    expect(getActiveRustEngineFence()).toEqual({ accountId: 'acct-1', generation: 3 })

    // Stale generation or wrong account patches are dropped.
    patchCb?.({
      accountId: 'acct-1',
      generation: 2,
      seq: 1,
      dirty: { balance: true, items: false, activity: false, sync: false },
      balance: null,
    })
    patchCb?.({
      accountId: 'acct-other',
      generation: 3,
      seq: 2,
      dirty: { balance: true, items: false, activity: false, sync: false },
      balance: null,
    })
    patchCb?.({
      accountId: 'acct-1',
      generation: 3,
      seq: 3,
      dirty: { balance: true, items: true, activity: false, sync: false },
      balance: null,
    })
    expect(received.map((p) => p.seq)).toEqual([3])

    // Identical BRC-38 mirror is deduplicated.
    const doc = '{"brc":38,"tables":{"outputs":[]}}'
    await mirrorBrc38ToRustEngine(doc)
    await mirrorBrc38ToRustEngine(doc)
    expect(importBrc38).toHaveBeenCalledTimes(1)

    // Rate-limited input hydration decodes base64 cleanly.
    const hydrated = await hydrateTxidsViaRustEngine(['AA'.repeat(32)], true)
    expect(Array.from(hydrated.get('aa'.repeat(32))!.bytes)).toEqual([1, 2, 3, 4])

    // encryptBrc39Document delegates to native Rust Argon2id off-thread.
    const sealed = await encryptBrc39Document(doc, 'pw')
    expect(encryptBrc39).toHaveBeenCalledWith(doc, 'pw')
    expect(sealed.length).toBe(64)

    // Phase 2 off-thread SPV, BRC-150, proof monitor, and delta segment sealing.
    const spv = await verifyBeefViaRustEngine(new Uint8Array([1, 0, 0xbe, 0xef]))
    expect(spv?.valid).toBe(true)
    const brc150 = await verifyBrc150ViaRustEngine(`${'aa'.repeat(32)}.0`)
    expect(brc150?.status).toBe('proven')
    const poll = await runRustProofPoll()
    expect(poll?.proofsSettled).toBe(2)
    const seg = await sealRustDeltaSegment()
    expect(seg?.factCount).toBe(3)

    await lockRustEngine()
    expect(lock).toHaveBeenCalledOnce()
    expect(getActiveRustEngineFence()).toBeNull()
    unsub()
  })
})
