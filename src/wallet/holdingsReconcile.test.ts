import { Script, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutpointSpendProbe } from './createActionInputFate'

const store = new Map<string, string>()
const sent = new Set<string>()
const sealed = new Map<string, string>()
const consumed: string[] = []
const relinquished: string[] = []
const restored: string[] = []
const restoreProofs: boolean[] = []
const claims: Array<{ txid: string; only: string[] }> = []
const claimProofs: string[][] = []
const markedAtClaim: string[] = []
const probes = new Map<string, OutpointSpendProbe>()
const rawTxs = new Map<string, string>()
const NO_ROW = { kind: 'refused', reason: 'no-row' } as const
const env = {
  idle: true,
  restoreOutcome: NO_ROW as { kind: string; reason?: string; was?: string },
  reservedBy: null as string | null,
}

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))
vi.mock('./accountLocalKeys', () => ({ accountLocalKey: (base: string) => `${base}:acct` }))
vi.mock('./sentItemGuard', () => ({
  isItemSent: (op: string) => sent.has(op),
  isItemAbandoned: () => false,
  markItemsConsumed: (ops: string[]) => consumed.push(...ops),
}))
vi.mock('./utxoLockManager', () => ({
  isUtxoBlockedFromRestore: () => false,
  sealedSpenderOf: (op: string) => sealed.get(op) ?? null,
}))
vi.mock('./walletCoordinator', () => ({ walletRegionsIdle: () => env.idle }))
vi.mock('./createActionInputFate', () => ({
  probeOutpointSpends: async (ops: string[]) =>
    new Map(ops.map((op) => [op, probes.get(op) ?? { kind: 'unknown' }])),
}))
vi.mock('./oneSatImport', () => ({
  fetchRawTxHex: async (txid: string) => rawTxs.get(txid) ?? null,
}))
vi.mock('./staleOutputRelease', () => ({
  assetRowReservation: async () => env.reservedBy,
  restoreAssetOutpoint: async (
    _active: unknown,
    op: string,
    opts?: { provenUnspent?: boolean },
  ) => {
    restored.push(op)
    restoreProofs.push(opts?.provenUnspent === true)
    return env.restoreOutcome
  },
}))
vi.mock('./recoverFromTx', () => ({
  recoverFromTx: async (
    txid: string,
    opts: { only: Set<string>; provenUnspent?: ReadonlySet<string> },
  ) => {
    const { isOneSatOutpointKnown } = await import('./oneSatImportGuard')
    claims.push({ txid, only: [...opts.only] })
    claimProofs.push([...(opts.provenUnspent ?? [])])
    markedAtClaim.push(...[...opts.only].filter((op) => isOneSatOutpointKnown(op)))
    return { ours: 1, spent: 0, tokens: 1, items: 0, unrecognized: 0, skipped: 0 }
  },
}))
vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    wallet: {
      relinquishOutput: async ({ output }: { output: string }) => {
        relinquished.push(output)
      },
    },
  }),
}))
vi.mock('./collectables', () => ({ listCollectables: async () => [] }))
vi.mock('./token/list', () => ({ listFungibles: async () => [] }))

const A = `${'aa'.repeat(32)}.0`
const B = `${'bb'.repeat(32)}.1`

/** A spender whose body consumes `outpoint`, published to the raw-tx source. */
function spenderOf(outpoint: string): string {
  const [txid, vout] = outpoint.split('.')
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: txid!,
    sourceOutputIndex: Number(vout),
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  })
  tx.addOutput({ lockingScript: new Script(), satoshis: 1 })
  const id = tx.id('hex')
  rawTxs.set(id, tx.toHex())
  return id
}

describe('chooseReconcileFate', () => {
  it('settles each gap only on a chain answer', async () => {
    const { chooseReconcileFate } = await import('./holdingsReconcile')
    const base = { sentHere: false, abandoned: false, reserved: false, spenderProven: true }
    const spent = { kind: 'spent', spender: 'ff'.repeat(32) } as const
    const unspent = { kind: 'unspent' } as const
    const unknown = { kind: 'unknown' } as const

    expect(chooseReconcileFate({ ...base, gap: 'left-basket', probe: spent })).toMatchObject({ kind: 'close', reason: 'spent' })
    expect(chooseReconcileFate({ ...base, gap: 'left-basket', probe: unspent })).toEqual({ kind: 'restore' })
    expect(chooseReconcileFate({ ...base, gap: 'left-basket', probe: unknown })).toEqual({ kind: 'recheck', reason: 'chain-unknown' })
    expect(chooseReconcileFate({ ...base, reserved: true, gap: 'left-basket', probe: unspent })).toEqual({ kind: 'recheck', reason: 'reserved' })

    expect(chooseReconcileFate({ ...base, gap: 'off-chain-index', probe: spent })).toMatchObject({ kind: 'retire' })
    expect(chooseReconcileFate({ ...base, gap: 'off-chain-index', probe: unspent })).toEqual({ kind: 'close', reason: 'chain-agrees' })
    expect(chooseReconcileFate({ ...base, gap: 'off-chain-index', probe: unknown })).toEqual({ kind: 'recheck', reason: 'chain-unknown' })

    for (const gap of ['left-basket', 'off-chain-index'] as const) {
      expect(chooseReconcileFate({ ...base, sentHere: true, gap, probe: unspent })).toEqual({ kind: 'close', reason: 'sent-here' })
      expect(chooseReconcileFate({ ...base, spenderProven: false, gap, probe: spent })).toEqual({
        kind: 'recheck',
        reason: 'spender-unproven',
      })
    }
  })
})

describe('holdings reconcile ledger', () => {
  beforeEach(async () => {
    store.clear()
    sent.clear()
    sealed.clear()
    probes.clear()
    consumed.length = 0
    relinquished.length = 0
    restored.length = 0
    restoreProofs.length = 0
    claims.length = 0
    claimProofs.length = 0
    markedAtClaim.length = 0
    rawTxs.clear()
    env.idle = true
    env.restoreOutcome = NO_ROW
    env.reservedBy = null
    vi.resetModules()
    vi.useFakeTimers()
  })

  async function due() {
    const mod = await import('./holdingsReconcile')
    vi.setSystemTime(Date.now() + mod.RECONCILE_SETTLE_MS + 1)
    await mod.runReconcile()
    return mod
  }

  it('files a departure and closes it when a read lists the outpoint again', async () => {
    const { reportHoldings, listHoldingsEntries } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    expect(listHoldingsEntries().map((e) => e.outpoint)).toEqual([A])
    reportHoldings({ asset: 'token', listed: new Set([A]) })
    expect(listHoldingsEntries()).toEqual([])
  })

  it('closes a departure when the other basket lists the outpoint', async () => {
    const { reportHoldings, listHoldingsEntries } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'item', listed: new Set(), leftBasket: [{ outpoint: A }] })
    reportHoldings({ asset: 'token', listed: new Set([A]) })
    expect(listHoldingsEntries()).toEqual([])
  })

  it('never files an outpoint this wallet sent', async () => {
    const { reportHoldings, listHoldingsEntries } = await import('./holdingsReconcile')
    sent.add(A)
    reportHoldings({ asset: 'item', listed: new Set(), leftBasket: [{ outpoint: A }] })
    expect(listHoldingsEntries()).toEqual([])
  })

  it('waits out the settle window before asking the chain', async () => {
    const { reportHoldings, runReconcile } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    await runReconcile()
    expect(restored).toEqual([])
  })

  it('keeps an unknown answer and backs off', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    const mod = await due()
    const [entry] = mod.listHoldingsEntries()
    expect(entry).toMatchObject({ outpoint: A, checks: 1 })
    expect(entry!.nextAt).toBeGreaterThan(Date.now())
  })

  it('restores an unspent departure, and claims it when the row is missing', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    const mod = await due()
    // Once from the fate, once after the claim filed the row back.
    expect(restored).toEqual([A, A])
    expect(claims).toEqual([{ txid: A.split('.')[0], only: [A] }])
    expect(mod.listHoldingsEntries().map((e) => e.outpoint)).toEqual([A])
  })

  it('restores and claims on the chain answer it just took, never a second explorer round', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    await due()
    expect(restoreProofs).toEqual([true, true])
    expect(claimProofs).toEqual([[A]])
  })

  it('does not claim a row it restored on the first check', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    env.restoreOutcome = { kind: 'restored', was: 'spendable=false spender=none' }
    await due()
    expect(restored).toEqual([A])
    expect(claims).toEqual([])
  })

  it('holds a row our own spend sealed until the chain answers, and never closes it on the seal', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    sealed.set(A, 'cd'.repeat(32))
    probes.set(A, { kind: 'unspent' })
    let mod = await due()
    expect(restored).toEqual([])
    expect(mod.listHoldingsEntries()).toMatchObject([{ outpoint: A, checks: 1 }])

    probes.set(A, { kind: 'spent', spender: spenderOf(A) })
    vi.setSystemTime(Date.now() + 10 * 60_000)
    mod = await import('./holdingsReconcile')
    await mod.runReconcile()
    expect(mod.listHoldingsEntries()).toEqual([])
  })

  it('claims only a missing row — a reserved or sent row is not re-imported', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    env.restoreOutcome = { kind: 'refused', reason: 'reserved' }
    await due()
    expect(claims).toEqual([])
  })

  it('claims an output whose old import mark outlived its row', async () => {
    const { markOneSatImported, isOneSatOutpointKnown } = await import('./oneSatImportGuard')
    markOneSatImported([A, B])
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    await due()
    expect(claims).toEqual([{ txid: A.split('.')[0], only: [A] }])
    expect(markedAtClaim).toEqual([])
    expect(isOneSatOutpointKnown(B)).toBe(true)
  })

  it('closes a departure the chain proves spent', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'item', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'spent', spender: spenderOf(A) })
    const mod = await due()
    expect(restored).toEqual([])
    expect(mod.listHoldingsEntries()).toEqual([])
  })

  it('keeps an outpoint an index calls spent until the spender body consumes it', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({
      asset: 'item',
      listed: new Set([A, B]),
      offChainIndex: [{ outpoint: A }, { outpoint: B }],
    })
    // A real transaction, but one that spends B — and no body at all for A's claim.
    probes.set(A, { kind: 'spent', spender: spenderOf(B) })
    probes.set(B, { kind: 'spent', spender: 'ee'.repeat(32) })
    const mod = await due()
    expect(consumed).toEqual([])
    expect(relinquished).toEqual([])
    expect(mod.listHoldingsEntries().map((e) => e.outpoint).sort()).toEqual([A, B])
  })

  it('never restores or re-claims a row a local transaction still reserves', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'item', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    env.reservedBy = 'nosend'
    const mod = await due()
    expect(restored).toEqual([])
    expect(claims).toEqual([])
    expect(mod.listHoldingsEntries()).toMatchObject([{ outpoint: A, checks: 1 }])
  })

  it('retires a listed item the chain proves spent, and leaves one it agrees with', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({
      asset: 'item',
      listed: new Set([A, B]),
      offChainIndex: [{ outpoint: A }, { outpoint: B }],
    })
    probes.set(A, { kind: 'spent', spender: spenderOf(A) })
    probes.set(B, { kind: 'unspent' })
    const mod = await due()
    expect(consumed).toEqual([A])
    expect(relinquished).toEqual([A])
    expect(mod.listHoldingsEntries()).toEqual([])
    // The index lagging on B is not asked about again on the next read.
    mod.reportHoldings({ asset: 'item', listed: new Set([B]), offChainIndex: [{ outpoint: B }] })
    expect(mod.listHoldingsEntries()).toEqual([])
  })

  it('mutates nothing while the wallet is busy', async () => {
    const { reportHoldings } = await import('./holdingsReconcile')
    reportHoldings({ asset: 'token', listed: new Set(), leftBasket: [{ outpoint: A }] })
    probes.set(A, { kind: 'unspent' })
    env.idle = false
    const mod = await due()
    expect(restored).toEqual([])
    expect(mod.listHoldingsEntries()).toMatchObject([{ outpoint: A, checks: 0 }])
  })
})
