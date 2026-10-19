import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from '../appActivity'
import type { LtcChain } from './chain'
import { fromHex, ltcTxid, p2wpkhAddress, parseLtcTx } from './litecoin'
import type { BurialCheck, DepositLocation, DepositSighting } from './verify'

const root = PrivateKey.fromRandom()
const durable = new Map<string, string>()
const recorded: Array<Omit<ActivityEntry, 'id' | 'at'>> = []
let rows: ActivityEntry[] = []
let sightings = new Map<string, DepositSighting>()
let locations = new Map<string, DepositLocation>()
let depths = new Map<string, BurialCheck>()
let utxos: Array<{ txid: string; vout: number; value: number; confirmed: boolean }> = []
let broadcasts: string[] = []
let mined = new Set<string>()
let broadcastFails = false
let lost = false
let online = true
let heldElsewhere: string | null = null
let holdingChecks = 0

const PROOF = { tx: '00', path: [], pos: 0, height: 7, header: '00'.repeat(80) }

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({ instance: { rootKeyHex: root.toHex(), identityKey: root.toPublicKey().toString() } }),
}))
vi.mock('../paymentPolicy', () => ({
  assertOnlineForPayment: () => {
    if (!online) throw new Error('You are offline. Payments need a connection.')
  },
}))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => heldElsewhere }))
vi.mock('../accountMove', () => ({ ensureHoldingFresh: async () => void (holdingChecks += 1) }))
vi.mock('../accountLocalKeys', () => ({ accountLocalKey: (key: string) => `acct:${key}`, accountLocalKeyFor: (key: string) => `acct:${key}` }))
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => (durable.set(key, value), true),
}))
vi.mock('../appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'handcash',
  recordAppActivity: (entry: Omit<ActivityEntry, 'id' | 'at'>) => recorded.push(entry),
  upgradeActivityRows: (upgrade: (e: ActivityEntry) => Omit<ActivityEntry, 'id' | 'at'> | null) => {
    let changed = 0
    rows = rows.map((e) => {
      const next = upgrade(e)
      if (!next) return e
      changed += 1
      return { ...next, id: e.id, at: e.at } as ActivityEntry
    })
    return changed
  },
}))
vi.mock('./verify', async (load) => ({
  ...(await load<typeof import('./verify')>()),
  readLtcDeposit: async (_chain: unknown, o: { txid: string; vout: number }) => sightings.get(`${o.txid}:${o.vout}`)!,
  locateLtcDeposit: async (_chain: unknown, txid: string) => locations.get(txid) ?? { kind: 'unconfirmed' },
  checkLtcBurial: async (_proof: unknown, o: { txid: string }) => depths.get(o.txid) ?? { ok: true, litoshi: 0n },
}))

const txidOfHex = (hex: string) => ltcTxid(parseLtcTx(fromHex(hex)))

const chain: LtcChain = {
  tipHeight: async () => 100,
  blockHashAt: async () => '00'.repeat(32),
  header: async () => new Uint8Array(80),
  headerPage: async () => [],
  txHex: async () => '',
  txStatus: async (txid) => {
    if (mined.has(txid)) return { confirmed: true }
    if (!lost && broadcasts.some((hex) => txidOfHex(hex) === txid)) return { confirmed: false }
    throw new Error('not found')
  },
  merkleProof: async () => ({ blockHeight: 1, merkle: [], pos: 0 }),
  addressUtxos: async () => utxos,
  broadcast: async (hex) => {
    if (broadcastFails) throw new Error('explorer down')
    broadcasts.push(hex)
    return txidOfHex(hex)
  },
  feeRate: async () => 2,
}

const ltc = await import('./ltcWallet')

const DEST = 'ltc1q6r9l4272gn3ee99lecsdgqyd6ykwxavyttj3ft'
const tx = (n: number) => n.toString(16).padStart(64, '0')
const ownAddress = () => p2wpkhAddress(Uint8Array.from(ltc.ltcKey(root).toPublicKey().encode(true) as number[]))

/** Litecoin paying this wallet; `buried` gives it a burial proof on the next pass. */
function receive(n: number, litoshi: bigint, buried = true) {
  utxos.push({ txid: tx(n), vout: 0, value: Number(litoshi), confirmed: buried })
  sightings.set(`${tx(n)}:0`, { kind: 'seen', txid: tx(n), vout: 0, litoshi })
  if (buried) locations.set(tx(n), { kind: 'in-block', proof: PROOF })
}

beforeEach(() => {
  durable.clear()
  recorded.length = 0
  rows = []
  sightings = new Map()
  locations = new Map()
  depths = new Map()
  utxos = []
  broadcasts = []
  mined = new Set()
  broadcastFails = false
  lost = false
  online = true
  heldElsewhere = null
  holdingChecks = 0
  ltc.setLtcDepsForTest({ chain })
  ltc.resetLtcWatchForTest()
})

describe('native Litecoin', () => {
  it('records received litecoin as a Litecoin row, spendable only once buried on its own chain', async () => {
    receive(1, 500_000n, false)
    let report = await ltc.refreshLtc()
    expect(report.balance).toEqual({ spendable: '0', confirming: '500000' })
    expect(recorded).toMatchObject([{ method: 'ltc-receive', kind: 'earned', txid: tx(1), item: { name: 'LTC', amt: '500000', dec: 8 } }])

    locations.set(tx(1), { kind: 'in-block', proof: PROOF })
    report = await ltc.refreshLtc()
    expect(report.balance).toEqual({ spendable: '500000', confirming: '0' })
    expect(ltc.readLtcCoinViews()[0]!.phase).toMatchObject({ kind: 'movable', height: 7 })
  })

  it('never counts a coin its own chain finds too shallow', async () => {
    receive(1, 500_000n)
    depths.set(tx(1), { ok: false, reason: 'shallow', confirmations: 3, detail: '3 of 6' } as BurialCheck)
    const report = await ltc.refreshLtc()
    expect(report.balance.spendable).toBe('0')
    expect(report.coins[0]!.phase).toMatchObject({ kind: 'confirming', confirmations: 3, needed: 6 })
  })

  it('pays an LTC address on Litecoin, keeps the change spendable, and wraps nothing', async () => {
    receive(1, 1_000_000n)
    await ltc.refreshLtc()
    const paid = await ltc.sendLtc({ address: DEST, litoshi: '300000' })
    expect(paid.status).toBe('sent')
    expect(broadcasts).toHaveLength(1)
    expect(txidOfHex(broadcasts[0]!)).toBe(paid.ltcTxid)
    const fee = BigInt(paid.fee)
    expect(ltc.readLtcBalance().spendable).toBe((1_000_000n - 300_000n - fee).toString())
    expect(recorded.at(-1)).toMatchObject({ method: 'ltc-send', kind: 'spent', txid: paid.ltcTxid, item: { amt: '300000' } })
  })

  it('refuses its own address, a bad address, dust and more than it can spend, before signing', async () => {
    receive(1, 100_000n)
    await ltc.refreshLtc()
    expect(() => ltc.preflightSendLtc({ address: ownAddress(), litoshi: '5000' })).toThrow(expect.objectContaining({ reason: 'own-address' }))
    expect(() => ltc.preflightSendLtc({ address: 'not-an-address', litoshi: '5000' })).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(() => ltc.preflightSendLtc({ address: DEST, litoshi: '10' })).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(() => ltc.preflightSendLtc({ address: DEST, litoshi: '200000' })).toThrow(expect.objectContaining({ reason: 'insufficient' }))
    expect(broadcasts).toHaveLength(0)
  })

  it('is guarded as a BSV spend: online, held here, holding re-checked, and booked to the app that asked', async () => {
    receive(1, 1_000_000n)
    await ltc.refreshLtc()

    online = false
    await expect(ltc.sendLtc({ address: DEST, litoshi: '300000' })).rejects.toThrow(/offline/)
    online = true

    heldElsewhere = 'This wallet is held on another device.'
    expect(() => ltc.preflightSendLtc({ address: DEST, litoshi: '300000' })).toThrow(expect.objectContaining({ reason: 'held-elsewhere' }))
    await expect(ltc.sendLtc({ address: DEST, litoshi: '300000' })).rejects.toMatchObject({ reason: 'held-elsewhere' })
    heldElsewhere = null
    expect(broadcasts).toHaveLength(0)

    const paid = await ltc.sendLtc({ address: DEST, litoshi: '300000' }, { origin: 'arcade.example' })
    expect(holdingChecks).toBe(1)
    expect(recorded.at(-1)).toMatchObject({ origin: 'arcade.example', method: 'ltc-send', txid: paid.ltcTxid })
  })

  it('keeps a payment Litecoin did not take, and broadcasts it on the next pass', async () => {
    receive(1, 1_000_000n)
    await ltc.refreshLtc()
    broadcastFails = true
    const paid = await ltc.sendLtc({ address: DEST, litoshi: '300000' })
    expect(paid.status).toBe('queued')
    // Signed and recorded: its coins are spent, so nothing double-spends them.
    expect(BigInt(ltc.readLtcBalance().spendable)).toBe(0n)
    broadcastFails = false
    await ltc.watchLtc()
    expect(broadcasts.map(txidOfHex)).toEqual([paid.ltcTxid])
  })

  it('re-broadcasts a sent payment the network lost, until it is in a block', async () => {
    receive(1, 1_000_000n)
    await ltc.refreshLtc()
    const paid = await ltc.sendLtc({ address: DEST, litoshi: '300000' })
    lost = true
    await ltc.watchLtc()
    expect(broadcasts).toHaveLength(2)
    mined.add(paid.ltcTxid)
    await ltc.watchLtc()
    expect((await ltc.refreshLtc()).payments[0]).toMatchObject({ ltcTxid: paid.ltcTxid, confirmed: true })
  })

  it('carries the wLTC record over once: coins, owed payments and their rows, now naming Litecoin transactions', () => {
    const payout = tx(9)
    durable.set(
      'acct:handcash.wltc.v1',
      JSON.stringify({
        deposits: {
          [`${tx(1)}:0`]: { litoshi: '800000', status: 'credited', at: 1, bsvTxid: 'aa'.repeat(32), proven: true },
          [`${tx(2)}:0`]: { litoshi: '5000', status: 'minting', at: 2 },
        },
        withdrawals: {
          [payout]: { address: DEST, litoshi: '200000', fee: '300', hex: '00', inputs: [`${tx(1)}:0`], change: { vout: 1, litoshi: '599700' }, status: 'sent', at: 3, attempts: 0, bsvTxid: 'bb'.repeat(32), burn: '200300' },
          [tx(8)]: { address: DEST, litoshi: '1', fee: '1', hex: '00', inputs: [], status: 'signed', at: 4, attempts: 0 },
        },
      }),
    )
    rows = [
      { id: 'a', at: 1, origin: 'handcash', kind: 'earned', sats: 0, method: 'wltc-credit', txid: 'aa'.repeat(32), note: 'Litecoin deposit' },
      { id: 'b', at: 2, origin: 'handcash', kind: 'spent', sats: 0, method: 'wltc-withdraw', txid: 'bb'.repeat(32), note: 'To x' },
    ] as ActivityEntry[]
    ltc.ensureLtcMigrated()
    expect(ltc.readLtcBalance()).toEqual({ spendable: '599700', confirming: '0' })
    expect(rows).toMatchObject([
      { id: 'a', method: 'ltc-receive', txid: tx(1), item: { amt: '800000' } },
      { id: 'b', method: 'ltc-send', txid: payout, item: { amt: '200000' } },
    ])
    ltc.ensureLtcMigrated()
    expect(ltc.readLtcBalance().spendable).toBe('599700')
  })
})
