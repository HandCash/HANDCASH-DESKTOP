import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signSwapOffer, type SignedSwapOffer } from './offer'
import { proposeTerms, type SwapTerms } from './settle'
import type { SettleRecord } from './settleStore'

const makerRoot = PrivateKey.fromString('a1'.repeat(32), 'hex')
const takerRoot = PrivateKey.fromString('b2'.repeat(32), 'hex')
const maker = makerRoot.toPublicKey().toString()
const taker = takerRoot.toPublicKey().toString()

const state: { swaps: Record<string, SettleRecord> } = { swaps: {} }
const sendSettle = vi.fn(async () => undefined)

vi.mock('./settleStore', () => ({
  readSettleState: () => state,
  writeSettleState: (next: typeof state) => Object.assign(state, next),
  putSwap: (r: SettleRecord) => {
    state.swaps[r.terms.swapId] = r
  },
  updateSwap: () => undefined,
  activeSwaps: () => [],
  markOfferCancelled: () => undefined,
  rememberPublishedOffer: () => undefined,
}))

vi.mock('./settlePorts', () => ({
  requireActiveWallet: () => ({ identityKey: taker, rootKeyHex: takerRoot.toHex(), accountIndex: 1, chain: 'main' }),
  sendSettle: (...args: unknown[]) => (sendSettle as (...a: unknown[]) => Promise<undefined>)(...args),
  readSettleBox: async () => [],
  ackSettleBox: async () => undefined,
  journalSwapLock: () => undefined,
  journalSwapLockSpent: () => undefined,
  reportFeeLock: async () => undefined,
}))

vi.mock('../coinMethods', () => ({
  coinWalletOf: async () => ({ balance: async () => 10n ** 12n, store: { read: () => ({ payments: {} }) } }),
}))

const custody: { op: string; units: number; r: Record<string, unknown> }[] = []
vi.mock('../custodyJournal', () => ({ unspentSwapCustody: () => custody }))

const { ownTakenOf, replaySwapCustody, takeSwapOffer } = await import('./settleRunner')

function offer(minGet: bigint, maxGet: bigint): SignedSwapOffer {
  const now = Date.now()
  return signSwapOffer(
    {
      v: 1,
      maker,
      give: 'ltc',
      get: 'bsv',
      price: { give: '30000000', get: '100000000' },
      minGet: minGet.toString(),
      maxGet: maxGet.toString(),
      createdAt: now - 60_000,
      expiresAt: now + 3_600_000,
      nonce: 'cc'.repeat(32),
    },
    makerRoot,
  )
}

function heldTake(o: SignedSwapOffer, pay: bigint, swapId: string, outcome?: SettleRecord['outcome']): void {
  const r = proposeTerms(o, pay, { identityKey: taker, root: takerRoot }, { now: Date.now(), swapId })
  if (!r.ok) throw new Error(r.reason)
  const terms: SwapTerms = r.terms
  state.swaps[swapId] = { v: 1, role: 'taker', counterparty: maker, terms, own: {}, peer: {}, createdAt: 0, updatedAt: 0, ...(outcome ? { outcome } : {}) }
}

describe('taking an offer this wallet already took', () => {
  beforeEach(() => {
    state.swaps = {}
    sendSettle.mockClear()
  })

  it('refuses a second take of a whole offer before anything is sent or locked', async () => {
    const o = offer(10_000_000n, 10_000_000n)
    heldTake(o, 10_000_000n, '01'.repeat(16))
    await expect(takeSwapOffer(o, 10_000_000n)).rejects.toThrow(/already took this offer/)
    expect(sendSettle).not.toHaveBeenCalled()
  })

  it('refuses a part larger than what its own takes left, naming what is left', async () => {
    const o = offer(10_000_000n, 30_000_000n)
    heldTake(o, 15_000_000n, '02'.repeat(16))
    await expect(takeSwapOffer(o, 20_000_000n)).rejects.toThrow(/at most 0\.15 BSV/)
    expect(sendSettle).not.toHaveBeenCalled()
  })

  it('counts declined and expired takes as giving their room back', () => {
    const o = offer(10_000_000n, 30_000_000n)
    heldTake(o, 10_000_000n, '03'.repeat(16), 'declined')
    heldTake(o, 10_000_000n, '04'.repeat(16), 'expired')
    heldTake(o, 10_000_000n, '05'.repeat(16))
    expect(ownTakenOf().get(o.nonce)).toBe(10_000_000n)
  })
})

describe('rebuilding a lost swap from the custody journal', () => {
  beforeEach(() => {
    state.swaps = {}
    custody.length = 0
  })

  it('joins every lock of one swap and restores the presigned claim with its self-payment', async () => {
    const swapId = '06'.repeat(16)
    const r = proposeTerms(offer(10_000_000n, 10_000_000n), 10_000_000n, { identityKey: taker, root: takerRoot }, { now: Date.now(), swapId })
    if (!r.ok) throw new Error(r.reason)
    const terms = JSON.stringify({ ...r.terms, makerPub: maker })
    const base = { p: 'swap lock', swapId, role: 'maker', terms }
    const claim = { hex: 'ab'.repeat(200), at: 120, prefix: 'p', suffix: 's' }
    custody.push(
      { op: `${'aa'.repeat(32)}.0`, units: 3_000_000, r: { ...base, chain: 'ltc', side: 'own' } },
      { op: `${'aa'.repeat(32)}.1`, units: 30_000, r: { ...base, chain: 'ltc', side: 'fee' } },
      { op: `${'bb'.repeat(32)}.0`, units: 10_000_000, r: { ...base, chain: 'bsv', side: 'peer', claim } },
    )
    const active = { identityKey: maker, rootKeyHex: makerRoot.toHex(), accountIndex: 0, chain: 'main' } as unknown as Parameters<typeof replaySwapCustody>[0]
    await replaySwapCustody(active)
    const rec = state.swaps[swapId]!
    expect(rec.own.funding).toEqual({ txid: 'aa'.repeat(32), main: 0, fee: 1 })
    expect(rec.peer.funding).toEqual({ txid: 'bb'.repeat(32), main: 0 })
    expect(rec.peer.claimTemplate).toEqual({
      chain: 'bsv',
      hex: claim.hex,
      secretAt: 120,
      remittance: { derivationPrefix: 'p', derivationSuffix: 's', senderIdentityKey: maker },
    })
  })

  it('leaves a swap this install still holds alone', async () => {
    const swapId = '07'.repeat(16)
    heldTake(offer(10_000_000n, 10_000_000n), 10_000_000n, swapId)
    const before = structuredClone(state.swaps[swapId])
    custody.push({ op: `${'cc'.repeat(32)}.0`, units: 1, r: { p: 'swap lock', swapId, role: 'taker', side: 'own', chain: 'bsv', terms: JSON.stringify(before!.terms) } })
    await replaySwapCustody({ identityKey: taker, rootKeyHex: takerRoot.toHex(), accountIndex: 1, chain: 'main' } as unknown as Parameters<typeof replaySwapCustody>[0])
    expect(state.swaps[swapId]).toEqual(before)
  })
})
