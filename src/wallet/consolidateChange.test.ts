import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_FRAGMENTS_TO_CONSOLIDATE } from './changeConsolidationPath'

// --- mocked wallet surface -------------------------------------------------
const createAction = vi.fn(async (_args: unknown) => ({
  txid: 'c'.repeat(64),
  tx: [1, 2, 3, 4],
  sendWithResults: [{ txid: 'c'.repeat(64), status: 'unproven' }],
}))
const internalizeAction = vi.fn(async (_args: unknown) => ({ accepted: true }))
const getPublicKey = vi.fn(async () => ({
  publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
}))
const createHmac = vi.fn(async () => ({
  hmac: Array.from({ length: 32 }, (_, i) => i),
}))
const findOutputs = vi.fn(async (_args: unknown) => [] as unknown[])
const runAsStorageProvider = vi.fn(async (fn: (sp: unknown) => Promise<unknown>) =>
  fn({ findOutputs }),
)

const shouldYield = vi.fn(() => false)
const recomposeActive = vi.fn(() => false)
const sealSpentInputsOfSignedTx = vi.fn(async (..._a: unknown[]) => 1)
const ensurePaymentBroadcasted = vi.fn(async (..._a: unknown[]) => undefined)

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02'.padEnd(66, 'a'),
    chain: 'main',
    wallet: {
      createAction: (args: unknown) => createAction(args),
      internalizeAction: (args: unknown) => internalizeAction(args),
      getPublicKey: () => getPublicKey(),
      createHmac: () => createHmac(),
      storage: { runAsStorageProvider },
    },
  }),
}))

vi.mock('./spendGuard', () => ({
  runExclusiveSpend: <T>(fn: () => Promise<T>) => fn(),
}))

vi.mock('./walletCoordinator', () => ({
  shouldYieldChainIngestToSpend: () => shouldYield(),
  isRecomposeCoordinatorActive: () => recomposeActive(),
}))

vi.mock('./paymentPolicy', () => ({
  assertOnlineForPayment: () => undefined,
}))

vi.mock('./legacyBeef', () => ({
  withVisibleOnChainBeef: <T>(fn: () => Promise<T>) => fn(),
}))

vi.mock('./staleOutputRelease', () => ({
  sealSpentInputsOfSignedTx: (...a: unknown[]) => sealSpentInputsOfSignedTx(...a),
}))

vi.mock('./deviceSync', () => ({
  scheduleHistoryBackupPush: () => undefined,
}))

vi.mock('./sendBrc29Payment', () => ({
  BRC29_PROTOCOL_ID: [2, '3241645161d8'],
  atomicBeefFromCreateAction: (r: { tx?: number[] }) => r?.tx,
  ensurePaymentBroadcasted: (...a: unknown[]) => ensurePaymentBroadcasted(...a),
}))

vi.mock('./actionReview', () => ({
  releaseStuckNosends: async () => undefined,
  sendWithHasFailure: () => false,
  isIteratorCrashError: () => false,
  isReviewActionsError: () => false,
  recoverFromReviewActions: async () => undefined,
  formatReviewActionsError: () => 'review actions',
}))

const offsetOf = (args: unknown): number =>
  (args as { paged: { offset: number } }).paged.offset

function changeRows(count: number, sats: number) {
  return Array.from({ length: count }, () => ({
    satoshis: sats,
    change: true,
    spendable: true,
    basket: 'default',
  }))
}

describe('maybeConsolidateChange', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    shouldYield.mockReturnValue(false)
    recomposeActive.mockReturnValue(false)
    findOutputs.mockResolvedValue([])
    runAsStorageProvider.mockImplementation(async (fn) => fn({ findOutputs }))
    const mod = await import('./consolidateChange')
    mod.__resetConsolidationCooldownForTests()
  })

  it('collapses a fragmented pool with one maxPossibleSatoshis self-payment', async () => {
    findOutputs.mockImplementation(async (args: unknown) =>
      offsetOf(args) === 0 ? changeRows(MIN_FRAGMENTS_TO_CONSOLIDATE + 5, 5_000) : [],
    )
    const { maybeConsolidateChange, MAX_POSSIBLE_SATOSHIS } = await import(
      './consolidateChange'
    )

    const outcome = await maybeConsolidateChange()
    expect(outcome.ran).toBe(true)

    expect(createAction).toHaveBeenCalledTimes(1)
    const args = createAction.mock.calls[0]?.[0] as {
      outputs: Array<{ satoshis: number }>
    }
    expect(args.outputs[0]?.satoshis).toBe(MAX_POSSIBLE_SATOSHIS)
    // Consumed coins are retired, broadcast is confirmed, and the single output
    // is internalized back into managed change.
    expect(sealSpentInputsOfSignedTx).toHaveBeenCalledTimes(1)
    expect(ensurePaymentBroadcasted).toHaveBeenCalledTimes(1)
    expect(internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('skips a pool that is not fragmented enough — no transaction', async () => {
    findOutputs.mockImplementation(async (args: unknown) =>
      offsetOf(args) === 0 ? changeRows(5, 5_000) : [],
    )
    const { maybeConsolidateChange } = await import('./consolidateChange')
    const outcome = await maybeConsolidateChange()
    expect(outcome).toEqual({ ran: false, reason: 'tooFewFragments' })
    expect(createAction).not.toHaveBeenCalled()
  })

  it('never counts 1sat or bsv21 baskets as consolidatable change', async () => {
    findOutputs.mockImplementation(async (args: unknown) => {
      if (offsetOf(args) !== 0) return []
      return [
        ...changeRows(5, 5_000),
        ...Array.from({ length: 100 }, () => ({
          satoshis: 1,
          change: true,
          spendable: true,
          basket: '1sat',
        })),
        ...Array.from({ length: 100 }, () => ({
          satoshis: 500,
          change: true,
          spendable: true,
          basket: 'bsv21',
        })),
      ]
    })
    const { maybeConsolidateChange } = await import('./consolidateChange')
    const outcome = await maybeConsolidateChange()
    // Only the 5 real change outputs count — assets are ignored entirely.
    expect(outcome).toEqual({ ran: false, reason: 'tooFewFragments' })
    expect(createAction).not.toHaveBeenCalled()
  })

  it('yields when a spend is already waiting', async () => {
    shouldYield.mockReturnValue(true)
    const { maybeConsolidateChange } = await import('./consolidateChange')
    const outcome = await maybeConsolidateChange()
    expect(outcome).toEqual({ ran: false, reason: 'spendPending' })
    expect(runAsStorageProvider).not.toHaveBeenCalled()
  })

  it('stands down while a recompose owns the session', async () => {
    recomposeActive.mockReturnValue(true)
    const { maybeConsolidateChange } = await import('./consolidateChange')
    const outcome = await maybeConsolidateChange()
    expect(outcome).toEqual({ ran: false, reason: 'spendPending' })
    expect(createAction).not.toHaveBeenCalled()
  })

  it('cools down after an attempt so it does not retry on every poll', async () => {
    findOutputs.mockImplementation(async (args: unknown) =>
      offsetOf(args) === 0 ? changeRows(MIN_FRAGMENTS_TO_CONSOLIDATE + 5, 5_000) : [],
    )
    const { maybeConsolidateChange } = await import('./consolidateChange')
    const first = await maybeConsolidateChange()
    expect(first.ran).toBe(true)
    const second = await maybeConsolidateChange()
    expect(second).toEqual({ ran: false, reason: 'cooldown' })
    expect(createAction).toHaveBeenCalledTimes(1)
  })
})
