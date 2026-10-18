import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LtcChain } from './chain'
import { fromHex, ltcOutputScript, ltcTxid, parseLtcTx, toHex } from './litecoin'
import type { BurialFetch, DepositSighting } from './verify'

const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString()
const durable = new Map<string, string>()
const labelled = new Map<string, { status: string; txid: string }>()
const hctCalls: Array<{ op: string; args: Record<string, unknown>; labels: readonly string[]; backing?: unknown }> = []
let balance = 0n
/** Units of each backed mint (by BSV txid) still waiting for their burial proof. */
const lockedBy = new Map<string, bigint>()
let assetKnown = false
let burnFails = false
let sightings = new Map<string, DepositSighting>()
let burials = new Map<string, BurialFetch>()
let utxos: Array<{ txid: string; vout: number; value: number; confirmed: boolean }> = []
const broadcasts: string[] = []
let broadcastFails = false

const ASSET = 'ab'.repeat(20)
const PROOF = { tx: '00', path: [], pos: 0, headers: ['00'.repeat(80)] }

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({
    instance: {
      rootKeyHex: root.toHex(),
      identityKey,
      wallet: {
        listActions: async (args: { labels: string[] }) => ({
          actions: args.labels.filter((l) => labelled.has(l)).map((l) => labelled.get(l)!),
        }),
      },
    },
  }),
}))
vi.mock('../accountLocalKeys', () => ({ accountLocalKey: (key: string) => `acct:${key}` }))
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => (durable.set(key, value), true),
}))
vi.mock('../appActivity', () => ({ recordAppActivity: () => {}, WALLET_ACTIVITY_ORIGIN: 'handcash' }))
vi.mock('./verify', async (load) => ({
  ...(await load<typeof import('./verify')>()),
  readLtcDeposit: async (_chain: unknown, o: { txid: string; vout: number }) => sightings.get(`${o.txid}:${o.vout}`)!,
  fetchLtcBurial: async (_chain: unknown, txid: string) => burials.get(txid) ?? { kind: 'pending', confirmations: 0, needed: 2 },
}))
vi.mock('../hct/wallet', () => {
  class HctRefusal extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message)
    }
  }
  const record = (op: string, args: Record<string, unknown>, opts?: { labels?: readonly string[]; backing?: unknown }) => {
    const txid = `${op.padEnd(8, '0')}${String(hctCalls.length).padStart(56, '0')}`.slice(0, 64)
    hctCalls.push({ op, args, labels: opts?.labels ?? [], ...(opts?.backing ? { backing: opts.backing } : {}) })
    for (const l of opts?.labels ?? []) labelled.set(l, { status: 'completed', txid })
    return txid
  }
  const locked = () => [...lockedBy.values()].reduce((a, b) => a + b, 0n)
  return {
    HctRefusal,
    listHctAssets: async () => ({
      assets: assetKnown
        ? [{ assetId: ASSET, kind: 'token', mode: 'open', sym: 'wLTC', authority: true, issuers: [identityKey.toLowerCase()], balance: balance.toString(), backedBy: 'ltc', ...(locked() > 0n ? { locked: locked().toString() } : {}) }]
        : [],
    }),
    issueHctAsset: async (args: { supply: string }, opts: { labels: string[]; backing?: unknown }) => {
      const txid = record('issue', args, opts)
      assetKnown = true
      balance += BigInt(args.supply)
      lockedBy.set(txid, BigInt(args.supply))
      return { assetId: ASSET, txid, kind: 'token', supply: args.supply, basket: 'p2pft' }
    },
    mintHctAsset: async (args: { amount: string }, opts: { labels: string[]; backing?: unknown }) => {
      const deployLocked = [...lockedBy.keys()].some((t) => t.startsWith('issue'))
      if (deployLocked) throw new HctRefusal('awaiting-backing', 'The first deposit has no burial proof yet; this mint waits for it.')
      const txid = record('mint', args, opts)
      balance += BigInt(args.amount)
      lockedBy.set(txid, BigInt(args.amount))
      return { assetId: ASSET, txid, amount: args.amount }
    },
    adoptSignedHctAction: async (txid: string) => {
      hctCalls.push({ op: 'adopt', args: { txid }, labels: [] })
    },
    proveHctBacking: async (assetId: string, txid: string) => {
      hctCalls.push({ op: 'prove', args: { assetId, txid }, labels: [] })
      lockedBy.delete(txid)
    },
    burnHctUnits: async (args: { amount: bigint }, opts: { labels: string[] }) => {
      if (burnFails) throw new Error('burn refused')
      balance -= args.amount
      return { assetId: ASSET, txid: record('burn', args, opts), amount: args.amount.toString() }
    },
  }
})

const chain: LtcChain = {
  tipHeight: async () => 100,
  blockHashAt: async () => '00'.repeat(32),
  header: async () => new Uint8Array(80),
  txHex: async () => '',
  txStatus: async (txid) => {
    if (broadcasts.some((hex) => ltcTxid(parseLtcTx(fromHex(hex))) === txid)) return { confirmed: false }
    throw new Error('not found')
  },
  merkleProof: async () => ({ blockHeight: 1, merkle: [], pos: 0 }),
  addressUtxos: async () => utxos,
  broadcast: async (hex) => {
    if (broadcastFails) throw new Error('explorer down')
    broadcasts.push(hex)
    return ltcTxid(parseLtcTx(fromHex(hex)))
  },
  feeRate: async () => 2,
}

const bridge = await import('./bridge')
const { reservedKeyRefusal } = await import('../vaultAccounts')

const DEST = 'ltc1q6r9l4272gn3ee99lecsdgqyd6ykwxavyttj3ft'
const tx = (n: number) => n.toString(16).padStart(64, '0')

/** A deposit seen paying the reserve; `buried` gives it a burial proof on the next pass. */
function deposit(n: number, litoshi: bigint, buried = true) {
  utxos.push({ txid: tx(n), vout: 0, value: Number(litoshi), confirmed: buried })
  sightings.set(`${tx(n)}:0`, { kind: 'seen', txid: tx(n), vout: 0, litoshi })
  if (buried) burials.set(tx(n), { kind: 'buried', proof: PROOF })
}

/** Credit the deposits seen, then (next pass) prove the ones buried. */
async function settle() {
  await bridge.listLtcDeposits()
  return bridge.listLtcDeposits()
}

beforeEach(() => {
  durable.clear()
  labelled.clear()
  hctCalls.length = 0
  broadcasts.length = 0
  lockedBy.clear()
  balance = 0n
  assetKnown = false
  burnFails = false
  broadcastFails = false
  sightings = new Map()
  burials = new Map()
  utxos = []
  bridge.setWltcDepsForTest({ chain })
})

describe('wLTC bridge', () => {
  it('derives a reserve address apps cannot sign for', async () => {
    const addr = await bridge.getLtcDepositAddress()
    expect(addr.address).toMatch(/^ltc1q[02-9ac-hj-np-z]{38}$/)
    expect(addr).toMatchObject({ network: 'litecoin', asset: 'wLTC', decimals: 8, minConfirmations: 2, assetId: null })
    expect(reservedKeyRefusal('createSignature', { protocolID: [2, 'wLTC  Reserve'], keyID: '1' }, identityKey)).toBe('asset-protocol')
  })

  it('credits a deposit at first sight as backed wLTC, locked until its burial proof', async () => {
    deposit(1, 50_000_000n, false)
    const result = await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue'])
    expect(hctCalls[0]!.args).toMatchObject({ kind: 'token', sym: 'wLTC', dec: 8, supply: '50000000', auth: true })
    expect(hctCalls[0]!.labels).toEqual([`wltc deposit ${tx(1)}.0`])
    const { scriptHex } = { scriptHex: toHex(ltcOutputScript(result.address)) }
    expect(hctCalls[0]!.backing).toEqual({ deposit: { txid: tx(1), vout: 0 }, bk: { chain: 'ltc', reserve: scriptHex } })
    expect(result).toMatchObject({ assetId: ASSET, balance: '50000000', locked: '50000000' })
    expect(result.deposits).toEqual([expect.objectContaining({ txid: tx(1), status: 'credited', proven: false, needed: 2 })])
    burials.set(tx(1), { kind: 'buried', proof: PROOF })
    const after = await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue', 'prove'])
    expect(after).toMatchObject({ balance: '50000000', locked: '0' })
    expect(after.deposits).toEqual([expect.objectContaining({ txid: tx(1), status: 'credited', proven: true })])
  })

  it('holds later deposits while the first is unproven, then mints each once with its backing', async () => {
    deposit(1, 50_000_000n, false)
    deposit(2, 1_000n, false)
    const first = await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue'])
    expect(first.deposits).toEqual(expect.arrayContaining([expect.objectContaining({ txid: tx(2), status: 'waiting', needed: 2 })]))
    burials.set(tx(1), { kind: 'buried', proof: PROOF })
    await bridge.listLtcDeposits()
    await bridge.listLtcDeposits()
    await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue', 'prove', 'mint'])
    expect(hctCalls[2]!.args).toMatchObject({ assetId: ASSET, amount: '1000' })
    expect(hctCalls[2]!.backing).toEqual({ deposit: { txid: tx(2), vout: 0 } })
  })

  it('voids a deposit the explorers forget, and never frees its wLTC', async () => {
    deposit(3, 20_000n, false)
    await bridge.listLtcDeposits()
    burials.set(tx(3), { kind: 'gone' })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(now)
    expect((await bridge.listLtcDeposits()).deposits).toEqual([expect.objectContaining({ status: 'credited', proven: false })])
    clock.mockReturnValue(now + 31 * 60_000)
    const result = await bridge.listLtcDeposits()
    clock.mockRestore()
    expect(result.deposits).toEqual([expect.objectContaining({ txid: tx(3), status: 'void' })])
    expect(result.locked).toBe('20000')
    expect(hctCalls.map((c) => c.op)).toEqual(['issue'])
  })

  it('reports refused deposits and mints nothing for them', async () => {
    utxos.push({ txid: tx(9), vout: 1, value: 5, confirmed: true })
    sightings.set(`${tx(9)}:1`, { kind: 'refuse', txid: tx(9), vout: 1, reason: 'wrong-script', detail: 'not the reserve' })
    const result = await bridge.listLtcDeposits()
    expect(result.deposits).toEqual([expect.objectContaining({ status: 'refused', reason: 'wrong-script' })])
    expect(hctCalls).toEqual([])
  })

  it('resolves a mint interrupted mid-flight by its label, not by minting again', async () => {
    deposit(4, 10_000n)
    durable.set('acct:handcash.wltc.v1', JSON.stringify({ deposits: { [`${tx(4)}:0`]: { litoshi: '10000', status: 'minting', at: 1, proven: false } }, withdrawals: {} }))
    labelled.set(`wltc deposit ${tx(4)}.0`, { status: 'completed', txid: 'cd'.repeat(32) })
    await bridge.listLtcDeposits()
    expect(hctCalls.filter((c) => c.op !== 'prove')).toEqual([])
    const failed = { deposits: { [`${tx(5)}:0`]: { litoshi: '10000', status: 'minting', at: 1 } }, withdrawals: {} }
    deposit(5, 10_000n)
    durable.set('acct:handcash.wltc.v1', JSON.stringify({ ...failed, deposits: { ...failed.deposits, [`${tx(4)}:0`]: { litoshi: '10000', status: 'credited', at: 1 } } }))
    labelled.set(`wltc deposit ${tx(5)}.0`, { status: 'failed', txid: 'ef'.repeat(32) })
    await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['adopt', 'issue', 'prove'])
    expect(hctCalls[0]!.args).toEqual({ txid: 'cd'.repeat(32) })
  })

  it('drops a credit whose mint never signed and mints the deposit again', async () => {
    deposit(12, 839_066n)
    durable.set('acct:handcash.wltc.v1', JSON.stringify({ deposits: { [`${tx(12)}:0`]: { litoshi: '839066', status: 'credited', at: 1 } }, withdrawals: {} }))
    labelled.set(`wltc deposit ${tx(12)}.0`, { status: 'unsigned', txid: '' })
    const result = await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue', 'prove'])
    expect(hctCalls[0]!.args).toMatchObject({ supply: '839066' })
    expect(result).toMatchObject({ balance: '839066', locked: '0' })
    expect(result.deposits).toEqual([expect.objectContaining({ txid: tx(12), status: 'credited', proven: true, bsvTxid: expect.stringMatching(/^issue/) })])
  })

  it('adopts a mint an earlier session signed once, and keeps its credit', async () => {
    deposit(13, 10_000n)
    const earlier = '13'.repeat(32)
    durable.set('acct:handcash.wltc.v1', JSON.stringify({ deposits: { [`${tx(13)}:0`]: { litoshi: '10000', status: 'credited', bsvTxid: earlier, at: 1 } }, withdrawals: {} }))
    await bridge.listLtcDeposits()
    await bridge.listLtcDeposits()
    expect(hctCalls).toEqual([{ op: 'adopt', args: { txid: earlier }, labels: [] }])
  })

  it('signs the payout from proven deposits only, burns amount plus fee, then broadcasts it', async () => {
    deposit(6, 30_000_000n)
    await settle()
    deposit(7, 900_000_000n, false)
    await bridge.listLtcDeposits()
    const result = await bridge.withdrawLtc({ address: DEST, litoshi: '10000000' })
    expect(result.status).toBe('sent')
    expect(BigInt(result.burned)).toBe(10_000_000n + BigInt(result.fee))
    const burn = hctCalls.find((c) => c.op === 'burn')!
    expect(burn.args).toMatchObject({ assetId: ASSET, amount: BigInt(result.burned), holder: bridge.WLTC_BURN_HOLDER, memo: `wltc-redeem ${result.ltcTxid}` })
    expect(burn.labels).toEqual([`wltc redeem ${result.ltcTxid}`])
    const payout = parseLtcTx(fromHex(broadcasts[0]!))
    expect(ltcTxid(payout)).toBe(result.ltcTxid)
    expect(payout.inputs.map((i) => i.txid)).toEqual([tx(6)])
    expect(toHex(payout.outputs[0]!.script)).toBe(toHex(ltcOutputScript(DEST)))
    expect(payout.outputs[0]!.value).toBe(10_000_000n)
    expect(payout.outputs[1]!.value).toBe(30_000_000n - BigInt(result.burned))
  })

  it('sends nothing when the burn fails', async () => {
    deposit(8, 30_000_000n)
    await settle()
    burnFails = true
    await expect(bridge.withdrawLtc({ address: DEST, litoshi: '10000000' })).rejects.toThrow(/burn refused/)
    expect(broadcasts).toEqual([])
    expect((await bridge.listLtcDeposits()).withdrawals).toEqual([])
  })

  it('retries a burned payout until it lands and never burns it twice', async () => {
    deposit(10, 30_000_000n)
    await settle()
    broadcastFails = true
    const result = await bridge.withdrawLtc({ address: DEST, litoshi: '10000000' })
    expect(result.status).toBe('burned')
    expect((await bridge.listLtcDeposits()).withdrawals).toEqual([expect.objectContaining({ ltcTxid: result.ltcTxid, status: 'burned', lastError: expect.stringMatching(/explorer down/) })])
    broadcastFails = false
    const after = await bridge.listLtcDeposits()
    expect(after.withdrawals).toEqual([expect.objectContaining({ ltcTxid: result.ltcTxid, status: 'sent' })])
    expect(hctCalls.filter((c) => c.op === 'burn')).toHaveLength(1)
    expect(broadcasts).toHaveLength(1)
  })

  it('refuses before signing when wLTC or the reserve falls short, and never pays from an unproven deposit', async () => {
    deposit(11, 5_000_000n, false)
    await bridge.listLtcDeposits()
    await expect(bridge.withdrawLtc({ address: DEST, litoshi: '1000000' })).rejects.toMatchObject({ reason: 'reserve-short' })
    burials.set(tx(11), { kind: 'buried', proof: PROOF })
    await bridge.listLtcDeposits()
    await expect(bridge.withdrawLtc({ address: DEST, litoshi: '5000000' })).rejects.toMatchObject({ reason: 'reserve-short' })
    await expect(bridge.withdrawLtc({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', litoshi: '5000' })).rejects.toMatchObject({ reason: 'bad-args' })
    balance = 1_000n
    await expect(bridge.withdrawLtc({ address: DEST, litoshi: '1000000' })).rejects.toMatchObject({ reason: 'insufficient' })
    expect(hctCalls.filter((c) => c.op === 'burn')).toEqual([])
    expect(broadcasts).toEqual([])
  })

  it('folds a remainder too small for change into the fee and the burn', () => {
    const reserve = ltcOutputScript(DEST)
    const plan = bridge.planLtcWithdrawal([{ txid: tx(1), vout: 0, litoshi: 100_500n }], reserve, reserve, 100_000n, 1)
    expect(plan?.tx.outputs).toHaveLength(1)
    expect(plan?.burn).toBe(100_500n)
    expect(bridge.planLtcWithdrawal([{ txid: tx(1), vout: 0, litoshi: 100_000n }], reserve, reserve, 100_000n, 1)).toBeNull()
  })
})
