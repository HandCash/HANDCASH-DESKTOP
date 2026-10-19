import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hash160, ltcTxid, toHex, type LtcTx } from '../ltc/litecoin'
import type { SwapAsset } from './assets'
import { checkedTx, judgeClaimTicket, type ClaimTicket } from './claimTower'
import type { FeeChainReader } from './feeClaim'
import { htlcTxBytes } from './htlc'
import { signSwapOffer, type SignedSwapOffer } from './offer'
import { parseSettleMessage, type SettleMessage } from './settle'
import type { SettleRecord } from './settleStore'

/**
 * Two wallets settle a swap end to end through the real runner, store,
 * decision logic, HTLC scripts and signatures. Only the edges are fakes: one
 * message box, and one chain per coin that refuses double spends and
 * transactions whose lock time has not passed.
 */

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0)
const H = 3_600_000
/** 200 DOGE for 1 LTC: large enough that the LTC leg carries HandCash's fee. */
const PAY = 20_000_000_000n

type Identity = { name: string; root: PrivateKey; key: string }
const ident = (name: string, hex: string): Identity => {
  const root = PrivateKey.fromString(hex.repeat(32), 'hex')
  return { name, root, key: root.toPublicKey().toString() }
}
const maker = ident('maker', 'a1')
const taker = ident('taker', 'b2')
let current: Identity = maker

// ── Chains ──────────────────────────────────────────────────────────────────

type Chain = { txs: Map<string, LtcTx>; spentBy: Map<string, string>; minedAt: Map<string, number>; online: boolean }
/** While set, broadcasts wait in the mempool until `mineAll`. */
let blocksHeld = false
const mempool = new Set<string>()
const mineAll = () => mempool.clear()
const chains = new Map<SwapAsset, Chain>()
const chainOf = (c: SwapAsset): Chain => {
  if (!chains.has(c)) chains.set(c, { txs: new Map(), spentBy: new Map(), minedAt: new Map(), online: true })
  return chains.get(c)!
}
function broadcast(c: SwapAsset, tx: LtcTx): 'sent' | 'known' {
  const ch = chainOf(c)
  const txid = ltcTxid(tx)
  if (ch.txs.has(txid)) return 'known'
  const nowS = Math.floor(Date.now() / 1000)
  if (tx.locktime >= 500_000_000 && tx.locktime > nowS) throw new Error('non-final: lock time not passed')
  for (const i of tx.inputs) {
    const by = ch.spentBy.get(`${i.txid}:${i.vout}`)
    if (by && by !== txid) throw new Error(`double spend of ${i.txid.slice(0, 8)}:${i.vout}`)
  }
  for (const i of tx.inputs) ch.spentBy.set(`${i.txid}:${i.vout}`, txid)
  ch.txs.set(txid, tx)
  ch.minedAt.set(txid, nowS)
  if (blocksHeld) mempool.add(txid)
  return 'sent'
}
const spender = (c: SwapAsset, txid: string, vout: number): LtcTx | null => {
  const by = chainOf(c).spentBy.get(`${txid}:${vout}`)
  return by ? chainOf(c).txs.get(by)! : null
}
/** What `script` holds on `chain`, unspent. */
const heldBy = (c: SwapAsset, script: Uint8Array): bigint => {
  const ch = chainOf(c)
  let sum = 0n
  for (const [txid, tx] of ch.txs) tx.outputs.forEach((o, vout) => {
    if (toHex(o.script) === toHex(script) && !ch.spentBy.has(`${txid}:${vout}`)) sum += o.value
  })
  return sum
}

// ── Coin wallets ────────────────────────────────────────────────────────────

const receiveScriptOf = (who: Identity, c: SwapAsset): Uint8Array => {
  const h = hash160(Uint8Array.from(who.root.toPublicKey().encode(true) as number[]))
  return c === 'ltc' || c === 'btc' ? Uint8Array.from([0x00, 0x14, ...h]) : Uint8Array.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac])
}
const balances = new Map<string, bigint>()
const payments = new Map<string, Record<string, { lock?: { swapId: string } }>>()
let funded = 0
/** How many coming `fundLocks` calls fail before signing anything. */
let failNextFund = 0
let heals = 0
let beforeFund: (() => void) | undefined

function coinWallet(who: Identity, c: SwapAsset) {
  const id = `${who.name}:${c}`
  if (!payments.has(id)) payments.set(id, {})
  return {
    readBalance: () => ({ spendable: String(balances.get(id) ?? 0n), confirming: '0' }),
    balance: async () => balances.get(id) ?? 0n,
    store: { read: () => ({ payments: payments.get(id)! }) },
    async fundLocks(locks: Array<{ script: Uint8Array; litoshi: bigint; address: string }>, meta: { swapId: string }) {
      beforeFund?.()
      if (failNextFund > 0) {
        failNextFund -= 1
        throw new Error('storage busy')
      }
      const total = locks.reduce((s, l) => s + l.litoshi, 0n)
      if ((balances.get(id) ?? 0n) < total) throw new Error('Insufficient funds')
      funded += 1
      const tx: LtcTx = {
        version: 2,
        inputs: [{ txid: (funded.toString(16).padStart(2, '0') + who.name).padEnd(64, '0').replace(/[^0-9a-f]/g, 'e'), vout: 0, script: new Uint8Array(), sequence: 0xffffffff, witness: [] }],
        outputs: locks.map((l) => ({ value: l.litoshi, script: l.script })),
        locktime: 0,
      }
      if (!chainOf(c).online) throw new Error('chain unreachable')
      broadcast(c, tx)
      balances.set(id, (balances.get(id) ?? 0n) - total)
      payments.get(id)![ltcTxid(tx)] = { lock: { swapId: meta.swapId } }
      return { ltcTxid: ltcTxid(tx) }
    },
    async proveLock(o: { txid: string; vout: number }, scriptPubKey: Uint8Array, amount: bigint) {
      const tx = chainOf(c).txs.get(o.txid)
      if (!tx || mempool.has(o.txid)) return { kind: 'unconfirmed' as const }
      const out = tx.outputs[o.vout]
      if (!out || toHex(out.script) !== toHex(scriptPubKey)) return { kind: 'refused' as const, reason: 'wrong-script', detail: 'not the lock' }
      if (out.value !== amount) return { kind: 'refused' as const, reason: 'under-backed', detail: 'short' }
      return { kind: 'buried' as const, blockTime: chainOf(c).minedAt.get(o.txid)! }
    },
    async findLock(_address: string, scriptPubKey: Uint8Array, amount: bigint, with_: { scriptPubKey: Uint8Array; litoshi: bigint }[] = []) {
      if (!chainOf(c).online) throw new Error('chain unreachable')
      const pays = (tx: LtcTx, s: Uint8Array, v: bigint) => {
        const i = tx.outputs.findIndex((o) => o.value === v && toHex(o.script) === toHex(s))
        return i < 0 ? null : i
      }
      for (const [txid, tx] of chainOf(c).txs) {
        const vout = pays(tx, scriptPubKey, amount)
        if (vout !== null) return { txid, vout, also: with_.map((w) => pays(tx, w.scriptPubKey, w.litoshi)) }
      }
      return null
    },
    async spenderOf(o: { txid: string; vout: number }) {
      if (!chainOf(c).online) throw new Error('chain unreachable')
      return spender(c, o.txid, o.vout)
    },
    receiveScript: () => ({ script: receiveScriptOf(who, c), address: `${who.name}-${c}` }),
    feeRate: async () => 1,
    async broadcastRaw(hex: string) {
      if (!chainOf(c).online) throw new Error('chain unreachable')
      return broadcast(c, checkedTx(c, hex))
    },
  }
}

// ── Box, store, ports ───────────────────────────────────────────────────────

let box: Array<{ messageId: string; to: string; sender: string; body: string }> = []
let boxDown = false
let nextMessage = 0
const durable = new Map<string, string>()
const tickets: ClaimTicket[] = []

vi.mock('../durableStorage', async (actual) => ({
  ...(await actual<typeof import('../durableStorage')>()),
  durableGetItem: (k: string) => durable.get(k) ?? null,
  durableSetItem: (k: string, v: string) => (durable.set(k, v), true),
  durableRemoveItem: (k: string) => void durable.delete(k),
}))
vi.mock('../accountLocalKeys', async (actual) => ({
  ...(await actual<typeof import('../accountLocalKeys')>()),
  accountLocalKey: (k: string) => `${k}:${current.key}`,
}))
vi.mock('../coinMethods', () => ({ coinWalletOf: async (c: SwapAsset) => coinWallet(current, c) }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => null }))
vi.mock('./exolixSwap', () => ({ followedSwapRecords: () => [], refreshSwapRecords: async () => undefined }))
vi.mock('./offerBook', () => ({ cancelSwapOffer: async () => undefined, reportSwapOfferFilled: async () => undefined }))
vi.mock('../custodyJournal', () => ({ unspentSwapCustody: () => [] }))
vi.mock('../staleOutputRelease', () => ({ restoreFailedLocalTxsKnownOnChain: async () => (heals++, 0) }))
vi.mock('./settlePorts', () => ({
  requireActiveWallet: () => ({ identityKey: current.key, rootKeyHex: current.root.toHex(), accountIndex: 0, chain: 'main' }),
  async sendSettle(_active: unknown, to: string, message: SettleMessage) {
    if (boxDown) throw new Error('box unreachable')
    box.push({ messageId: String(++nextMessage), to: to.toLowerCase(), sender: current.key.toLowerCase(), body: JSON.stringify(message) })
  },
  async readSettleBox() {
    if (boxDown) return null
    return box.filter((m) => m.to === current.key.toLowerCase()).map((m) => ({ messageId: m.messageId, sender: m.sender, message: parseSettleMessage(m.body) }))
  },
  async ackSettleBox(_active: unknown, ids: string[]) {
    box = box.filter((m) => !(m.to === current.key.toLowerCase() && ids.includes(m.messageId)))
  },
  journalSwapLock: () => undefined,
  journalSwapLockSpent: () => undefined,
  journalBsvSelfPayment: () => undefined,
  reportFeeLock: async () => true,
  bsvLockProvenUnsent: async () => false,
  claimTowerOrigins: async () => ['https://tower.test'],
  async registerClaimTicket(_origin: string, ticket: ClaimTicket) {
    tickets.push(ticket)
    return 'held'
  },
}))

const runner = await import('./settleRunner')
const store = await import('./settleStore')

/** `who` comes online for a few service passes: each pass takes one step per swap, as the app's 5 s tick does. */
const settle = async (who: Identity, passes = 3) => {
  current = who
  for (let i = 0; i < passes; i++) {
    runner.resetSwapSettleForTest()
    await runner.serveSwapSettle({ force: true })
  }
}
const recordOf = (who: Identity, swapId: string): SettleRecord => {
  current = who
  return store.readSettleState().swaps[swapId]!
}
const at = (ms: number) => vi.setSystemTime(ms)

function publish(give: SwapAsset, get: SwapAsset): SignedSwapOffer {
  current = maker
  const offer = signSwapOffer(
    { v: 1, maker: maker.key, give, get, price: { give: '100000000', get: '20000000000' }, minGet: '1000000000', maxGet: '40000000000', createdAt: Date.now() - 60_000, expiresAt: Date.now() + 23 * H, nonce: 'cd'.repeat(32) },
    maker.root,
  )
  store.rememberPublishedOffer(offer)
  return offer
}

async function take(offer: SignedSwapOffer, pay: bigint): Promise<string> {
  current = taker
  runner.resetSwapSettleForTest()
  const record = await runner.takeSwapOffer(offer, pay)
  await vi.waitFor(() => expect(recordOf(taker, record.terms.swapId).own.funding).toBeDefined())
  return record.terms.swapId
}

/** Both wallets online: pass in turn until neither moves. */
async function settleBoth(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle(maker)
    await settle(taker)
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0)
  chains.clear()
  blocksHeld = false
  mempool.clear()
  balances.clear()
  payments.clear()
  durable.clear()
  box = []
  boxDown = false
  tickets.length = 0
  failNextFund = 0
  heals = 0
  beforeFund = undefined
  balances.set('maker:ltc', 1_000_000_000n)
  balances.set('taker:doge', 100_000_000_000n)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') {
    for (const who of [maker, taker]) {
      current = who
      for (const r of Object.values(store.readSettleState().swaps)) process.stdout.write(`${who.name} ${JSON.stringify({ phase: r.phase, outcome: r.outcome, waiting: r.waiting, lastError: r.lastError, declined: r.declined, own: { funding: r.own.funding, refunded: r.own.refunded, feeSettled: r.own.feeSettled }, peer: { funding: !!r.peer.funding, buried: r.peer.buried, claimed: r.peer.claimed, refused: r.peer.refused } })}\n`)
    }
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a direct swap between two wallets', () => {
  it('both online: each claims the other lock, and the fee leg goes back to its payer when HandCash never claims', async () => {
    const offer = publish('ltc', 'doge')
    const swapId = await take(offer, PAY)
    await settleBoth()

    const t = recordOf(taker, swapId)
    const m = recordOf(maker, swapId)
    expect(t.outcome).toBe('swapped')
    expect(m.peer.claimed).toBe(true)
    expect(heldBy('ltc', receiveScriptOf(taker, 'ltc'))).toBeGreaterThan(0n)
    expect(heldBy('doge', receiveScriptOf(maker, 'doge'))).toBeGreaterThan(0n)
    // The maker's fee output waits for HandCash, then returns at the maker's lock time.
    expect(m.outcome).toBeUndefined()
    at(T0 + 49 * H)
    await settleBoth(2)
    expect(recordOf(maker, swapId).outcome).toBe('swapped')
    expect(recordOf(maker, swapId).own.feeSettled).toBe('refunded')
  })

  it('maker away once the taker claims: the watchtower claims for it before the taker may refund', async () => {
    const offer = publish('ltc', 'doge')
    const swapId = await take(offer, PAY)
    await settle(maker) // accepts, sees the taker lock, locks LTC
    await settle(maker) // waiting for the secret: arms the tower
    expect(tickets).toHaveLength(1)
    const m0 = recordOf(maker, swapId)
    expect(m0.peer.claimTemplate).toBeDefined()

    await settle(taker) // claims the maker's LTC: the secret is public
    expect(recordOf(taker, swapId).peer.claimed).toBe(true)

    // The maker stays away. The tower sees the taker's claim and broadcasts the maker's.
    const reader = (c: SwapAsset): FeeChainReader => ({
      txHex: async () => null,
      spenderHex: async (o) => {
        const tx = spender(c, o.txid, o.vout)
        return tx ? htlcTxBytes(c, tx).hex : null
      },
      broadcast: async (hex) => void broadcast(c, checkedTx(c, hex)),
      feeRate: async () => 1,
    })
    const verdict = await judgeClaimTicket(tickets[0]!, reader('ltc'))
    expect(verdict.kind).toBe('claim')
    if (verdict.kind !== 'claim') return
    broadcast('doge', checkedTx('doge', verdict.hex))

    // Past the taker's lock time its refund is refused: the coins are the maker's.
    at(T0 + 73 * H)
    await settle(taker)
    expect(recordOf(taker, swapId).outcome).toBe('swapped')
    expect(heldBy('doge', receiveScriptOf(maker, 'doge'))).toBeGreaterThan(0n)

    // The maker comes back and commits the same claim the tower sent.
    await settle(maker)
    expect(recordOf(maker, swapId).peer.claimed).toBe(true)
    expect(recordOf(maker, swapId).peer.claim?.txid).toBe(verdict.txid)
  })

  it('a lock still waiting for its block is what the swap says it waits on, on both sides', async () => {
    const { describeSwap } = await import('./settleView')
    const offer = publish('ltc', 'doge')
    blocksHeld = true
    const swapId = await take(offer, PAY)
    await settle(maker)
    await settle(taker)
    expect(recordOf(maker, swapId).own.funding).toBeUndefined()
    expect(describeSwap(recordOf(maker, swapId)).status).toBe("The taker's lock is waiting for a DOGE block (about every minute); you lock once it confirms")
    expect(describeSwap(recordOf(taker, swapId)).status).toBe('Your lock is waiting for a DOGE block (about every minute); the maker locks once it confirms')

    blocksHeld = false
    mineAll()
    await settle(taker)
    expect(recordOf(taker, swapId).own.buried).toBe(true)
    expect(describeSwap(recordOf(taker, swapId)).status).toMatch(/^Waiting for the maker to lock; it may be offline, and has until /)
    await settleBoth()
    expect(recordOf(taker, swapId).outcome).toBe('swapped')
  })

  it('maker never locks: the taker takes its lock back at its lock time, not before', async () => {
    const offer = publish('ltc', 'doge')
    balances.set('maker:ltc', 0n)
    const swapId = await take(offer, PAY)
    await settle(maker) // cannot lock: declines
    await settle(taker)
    const lock = recordOf(taker, swapId).own.funding!
    expect(spender('doge', lock.txid, lock.main)).toBeNull()

    at(T0 + 71 * H)
    await settle(taker)
    expect(spender('doge', lock.txid, lock.main)).toBeNull()

    at(T0 + 72 * H + 60_000)
    await settle(taker)
    expect(recordOf(taker, swapId).outcome).toBe('refunded')
    expect(heldBy('doge', receiveScriptOf(taker, 'doge'))).toBeGreaterThan(0n)
  })

  it('taker never claims: the maker refunds at its lock time and the taker refunds at its own', async () => {
    const offer = publish('ltc', 'doge')
    const swapId = await take(offer, PAY)
    await settle(maker)
    // The taker goes away for good until after both lock times.
    at(T0 + 49 * H)
    await settle(maker)
    expect(recordOf(maker, swapId).outcome).toBe('refunded')
    at(T0 + 73 * H)
    await settle(taker)
    expect(recordOf(taker, swapId).outcome).toBe('refunded')
    expect(heldBy('ltc', receiveScriptOf(maker, 'ltc'))).toBeGreaterThan(0n)
    expect(heldBy('doge', receiveScriptOf(taker, 'doge'))).toBeGreaterThan(0n)
  })

  it('a box outage delays nothing the chain can settle', async () => {
    const offer = publish('ltc', 'doge')
    const swapId = await take(offer, PAY)
    await settle(maker)
    boxDown = true
    await settleBoth()
    expect(vi.mocked(console.info).mock.calls.some(([line]) => String(line).includes('counterparty lock found on chain'))).toBe(true)
    expect(recordOf(taker, swapId).outcome).toBe('swapped')
    expect(recordOf(maker, swapId).peer.claimed).toBe(true)
  })

  it('a lock that failed before signing is tried again, not wedged as "started"', async () => {
    const offer = publish('ltc', 'doge')
    const swapId = await take(offer, PAY)
    failNextFund = 1
    await settle(maker, 1) // accepts and tries to lock: the wallet refuses before signing
    expect(recordOf(maker, swapId).own.funding).toBeUndefined()
    expect(recordOf(maker, swapId).own.fundingStartedAt).toBeUndefined()
    await settleBoth()
    expect(recordOf(taker, swapId).outcome).toBe('swapped')
    expect(recordOf(maker, swapId).peer.claimed).toBe(true)
  })

  it('a maker short once it comes to lock heals once, then withdraws; the taker refunds at its lock time', async () => {
    const offer = publish('ltc', 'doge')
    const swapId = await take(offer, PAY)
    beforeFund = () => balances.set('maker:ltc', 0n) // spent elsewhere between the accept and the lock
    await settle(maker)
    expect(heals).toBe(1)
    expect(recordOf(maker, swapId).own.funding).toBeUndefined()
    expect(recordOf(maker, swapId).outcome).toBe('declined')
    await settle(taker)
    expect(recordOf(taker, swapId).declined).toBe('insufficient')
    expect(recordOf(taker, swapId).outcome).toBeUndefined()
    at(T0 + 72 * H + 60_000)
    await settle(taker)
    expect(recordOf(taker, swapId).outcome).toBe('refunded')
    expect(heldBy('doge', receiveScriptOf(taker, 'doge'))).toBeGreaterThan(0n)
  })

  it('a taker short of coins never locks, and the take ends without moving anything', async () => {
    const offer = publish('ltc', 'doge')
    balances.set('taker:doge', 1_000n)
    current = taker
    await expect(runner.takeSwapOffer(offer, PAY)).rejects.toThrow(/Not enough/)
    expect(Object.keys(store.readSettleState().swaps)).toHaveLength(0)
    expect(box).toHaveLength(0)
  })
})
