/**
 * Payee-side ingest + broadcast efficiency rules.
 *
 * Guards two things that must not drift:
 * - `skipIfOnChain` is opt-in. BRC-29 receive may skip a redundant postBeef
 *   (sender already broadcast); item peerDeliver must not, because the payee is
 *   normally the first broadcaster and an existence probe is pure latency.
 * - independent tips ingest concurrently, bounded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef } from '@bsv/sdk'

const postBeef = vi.fn(async () => [
  { status: 'success', txidResults: [{ status: 'success' }] },
])
const txExistsOnChain = vi.fn(async (): Promise<boolean | null> => null)
const internalizeAction = vi.fn(async () => ({ accepted: true }))
const fetchBalanceSats = vi.fn(async () => 91_000)

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    address: '1someaddress',
    identityKey: '03' + 'aa'.repeat(32),
    services: { postBeef },
    wallet: { internalizeAction },
  }),
  fetchBalanceSats: () => fetchBalanceSats(),
}))

vi.mock('./legacyScan', () => ({
  txExistsOnChain: () => txExistsOnChain(),
}))

vi.mock('./legacyBeef', () => ({
  withVisibleOnChainBeef: <T>(fn: () => Promise<T>) => fn(),
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: async () => ({ toBinaryAtomic: () => [1, 2, 3] }),
  isAtomicBeefInBackoff: () => false,
  rememberBeefBinary: () => {},
  rememberBeefTree: () => {},
}))

vi.mock('./ghostTxSuppress', () => ({
  isGhostTxSuppressed: () => false,
  rememberGhostTx: () => {},
}))

vi.mock('./appActivity', () => ({
  hasActivityTxid: () => false,
  hasSettledActivityTxid: () => false,
  noteInboundReceivePending: () => {},
  noteInboundReceiveComplete: () => {},
  noteOutboundSendPending: () => {},
  noteOutboundSendComplete: () => {},
  failOutboundSendPending: () => {},
  clearInboundReceivePending: () => {},
}))

vi.mock('./messageStore', () => ({
  listThreads: () => [],
  listMessages: () => [],
  updateMessage: () => null,
}))

vi.mock('./friends', () => ({
  validateIdentityKey: () => null,
  normalizeIdentityKey: (k: string) => k.trim().toLowerCase(),
}))

vi.mock('./deviceSync', () => ({ scheduleHistoryBackupPush: () => {} }))
vi.mock('./walletHealth', () => ({ setSyncHealth: () => {} }))
vi.mock('./toast', () => ({ toastSuccess: () => {} }))
vi.mock('./fx', () => ({ formatPrimaryFromSats: () => '$1.00' }))
vi.mock('./displayCurrency', () => ({ getDisplayCurrency: () => 'USD' }))
vi.mock('./pendingSend', () => ({
  beginPendingSend: () => ({ id: 'p1' }),
  completePendingSend: () => {},
  clearPendingSend: () => {},
}))
vi.mock('./staleOutputRelease', () => ({
  isAlreadySpentInputError: () => false,
  onAlreadySpentSend: async () => {},
}))
vi.mock('./paymentPolicy', () => ({ assertOnlineForPayment: () => {} }))
vi.mock('./paymentProgress', () => ({
  setPaymentProgress: () => {},
  clearPaymentProgress: () => {},
}))
vi.mock('./spendGuard', () => ({
  runExclusiveSpend: <T>(fn: () => Promise<T>) => fn(),
  prepareSpendHeal: async () => 100_000,
}))
vi.mock('./actionReview', () => ({
  releaseStuckNosends: async () => {},
  sendWithHasFailure: () => false,
}))
vi.mock('./pendingBrc29Outbox', () => ({
  enqueuePendingBrc29Remit: () => {},
  flushPendingBrc29Outbox: async () => 0,
}))

const SENDER = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const ATOMIC = [1, 2, 3]

beforeEach(() => {
  postBeef.mockClear()
  txExistsOnChain.mockClear()
  txExistsOnChain.mockResolvedValue(null)
  internalizeAction.mockClear()
  internalizeAction.mockImplementation(async () => ({ accepted: true }))
  fetchBalanceSats.mockClear()
  vi.spyOn(Beef, 'fromBinary').mockReturnValue(new Beef())
})

describe('broadcastAtomicBeef', () => {
  it('skips a redundant postBeef when the tx is already on chain', async () => {
    txExistsOnChain.mockResolvedValue(true)
    const { broadcastAtomicBeef } = await import('./sendBrc29Payment')

    const ok = await broadcastAtomicBeef('a'.repeat(64), ATOMIC, {
      skipIfOnChain: true,
    })

    expect(ok).toBe(true)
    expect(txExistsOnChain).toHaveBeenCalledTimes(1)
    expect(postBeef).not.toHaveBeenCalled()
  })

  it('still broadcasts when the network has not seen the tx', async () => {
    txExistsOnChain.mockResolvedValue(false)
    const { broadcastAtomicBeef } = await import('./sendBrc29Payment')

    await expect(
      broadcastAtomicBeef('a'.repeat(64), ATOMIC, { skipIfOnChain: true }),
    ).resolves.toBe(true)
    expect(postBeef).toHaveBeenCalledTimes(1)
  })

  it('broadcasts when provider silence makes existence unknown', async () => {
    txExistsOnChain.mockResolvedValue(null)
    const { broadcastAtomicBeef } = await import('./sendBrc29Payment')

    await expect(
      broadcastAtomicBeef('a'.repeat(64), ATOMIC, { skipIfOnChain: true }),
    ).resolves.toBe(true)
    expect(postBeef).toHaveBeenCalledTimes(1)
  })

  it('never probes existence by default — item peerDeliver pays no extra RTT', async () => {
    const { broadcastAtomicBeef } = await import('./sendBrc29Payment')

    await expect(broadcastAtomicBeef('a'.repeat(64), ATOMIC)).resolves.toBe(true)
    expect(txExistsOnChain).not.toHaveBeenCalled()
    expect(postBeef).toHaveBeenCalledTimes(1)
  })

  it('refuses an invalid txid or empty body without touching the network', async () => {
    const { broadcastAtomicBeef } = await import('./sendBrc29Payment')

    await expect(broadcastAtomicBeef('nope', ATOMIC)).resolves.toBe(false)
    await expect(broadcastAtomicBeef('a'.repeat(64), [])).resolves.toBe(false)
    expect(postBeef).not.toHaveBeenCalled()
  })

  it('reports failure instead of throwing when postBeef rejects', async () => {
    postBeef.mockRejectedValueOnce(new Error('provider down') as never)
    const { broadcastAtomicBeef } = await import('./sendBrc29Payment')

    await expect(broadcastAtomicBeef('a'.repeat(64), ATOMIC)).resolves.toBe(false)
  })
})

describe('internalizeBrc29Payment broadcast overlap', () => {
  it('confirms broadcast and internalizes without serializing the two', async () => {
    let postBeefDone = false
    let internalizeStartedBeforePostBeefDone = false
    postBeef.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30))
      postBeefDone = true
      return [{ status: 'success', txidResults: [{ status: 'success' }] }]
    })
    internalizeAction.mockImplementationOnce(async () => {
      if (!postBeefDone) internalizeStartedBeforePostBeefDone = true
      return { accepted: true }
    })

    const { internalizeBrc29Payment } = await import('./sendBrc29Payment')
    const result = await internalizeBrc29Payment({
      txid: 'c'.repeat(64),
      remittance: { derivationPrefix: 'pre', derivationSuffix: 'suf', outputIndex: 0 },
      senderIdentityKey: SENDER,
      satoshis: 500,
      tx: ATOMIC,
    })

    expect(result.accepted).toBe(true)
    expect(internalizeStartedBeforePostBeefDone).toBe(true)
    expect(postBeef).toHaveBeenCalledTimes(1)
  })
})

describe('ingestPaymentsFromTipHints', () => {
  const hint = (n: number) => ({
    txid: n.toString(16).padStart(2, '0').repeat(32),
    senderIdentityKey: SENDER,
    satoshis: 100 + n,
    brc29: { derivationPrefix: 'pre', derivationSuffix: 'suf', outputIndex: 0 },
    tx: ATOMIC,
  })

  it('ingests independent tips concurrently, bounded at three', async () => {
    let inFlight = 0
    let peak = 0
    internalizeAction.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 40))
      inFlight -= 1
      return { accepted: true }
    })

    const { ingestPaymentsFromTipHints } = await import('./sendBrc29Payment')
    const hints = Array.from({ length: 7 }, (_, i) => hint(i + 1))
    const result = await ingestPaymentsFromTipHints(hints)

    expect(result.imported).toBe(7)
    expect(result.importedTxids).toHaveLength(7)
    // Parallelism under load can peak at 2–3; never serial (1) and never over the cap.
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
    // Seven tips on real timers, each logging its ingest phases — the default 5s
    // budget is close enough to the observed runtime to flake under full-suite load.
  }, 20_000)

  it('reports the last known balance and no ghosts on a clean pass', async () => {
    const { ingestPaymentsFromTipHints } = await import('./sendBrc29Payment')
    const result = await ingestPaymentsFromTipHints([hint(1), hint(2)])

    expect(result.imported).toBe(2)
    expect(result.ghostTxids).toEqual([])
    expect(result.balanceSats).toBe(91_000)
  })

  it('deduplicates repeated hints for the same txid', async () => {
    const { ingestPaymentsFromTipHints } = await import('./sendBrc29Payment')
    const result = await ingestPaymentsFromTipHints([hint(1), hint(1), hint(1)])

    expect(result.imported).toBe(1)
    expect(internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('drops malformed txids before any ingest work', async () => {
    const { ingestPaymentsFromTipHints } = await import('./sendBrc29Payment')
    const result = await ingestPaymentsFromTipHints(['nope', 'also-not-a-txid'])

    expect(result.imported).toBe(0)
    expect(internalizeAction).not.toHaveBeenCalled()
  })

  /** The failure path sleeps between retries — don't pay that in CI. */
  const ingestSkippingRetryDelay = async (
    hints: Parameters<
      Awaited<typeof import('./sendBrc29Payment')>['ingestPaymentsFromTipHints']
    >[0],
  ) => {
    const { ingestPaymentsFromTipHints } = await import('./sendBrc29Payment')
    vi.useFakeTimers()
    try {
      const pending = ingestPaymentsFromTipHints(hints)
      await vi.runAllTimersAsync()
      return await pending
    } finally {
      vi.useRealTimers()
    }
  }

  it('ghosts a tip only when the chain confirms it is absent', async () => {
    internalizeAction.mockImplementation(async () => {
      throw new Error('no such output')
    })
    txExistsOnChain.mockResolvedValue(false)

    // No inline BEEF: nothing left to internalize, so a 404 is decisive.
    const result = await ingestSkippingRetryDelay([{ ...hint(1), tx: undefined }])

    expect(result.imported).toBe(0)
    expect(result.ghostTxids).toEqual([hint(1).txid])
  })

  it('does not ghost a tip while the chain answer is inconclusive', async () => {
    internalizeAction.mockImplementation(async () => {
      throw new Error('no such output')
    })
    txExistsOnChain.mockResolvedValue(null)

    const result = await ingestSkippingRetryDelay([{ ...hint(1), tx: undefined }])

    expect(result.ghostTxids).toEqual([])
  })

  it('retries a failed tip once before giving up', async () => {
    let attempts = 0
    internalizeAction.mockImplementation(async () => {
      attempts += 1
      throw new Error('no such output')
    })
    txExistsOnChain.mockResolvedValue(null)

    await ingestSkippingRetryDelay([{ ...hint(1), tx: undefined }])

    expect(attempts).toBe(2)
  })
})
