import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LtcChain } from './chain'
import { fromHex, ltcOutputScript, ltcTxid, parseLtcTx, toHex } from './litecoin'
import type { DepositVerdict } from './verify'

const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString()
const durable = new Map<string, string>()
const labelled = new Map<string, string>()
const hctCalls: Array<{ op: string; args: Record<string, unknown>; labels: readonly string[] }> = []
let balance = 0n
let assetKnown = false
let burnFails = false
let verdicts = new Map<string, DepositVerdict>()
let utxos: Array<{ txid: string; vout: number; value: number; confirmed: boolean }> = []
const broadcasts: string[] = []
let broadcastFails = false

const ASSET = 'ab'.repeat(20)

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({
    instance: {
      rootKeyHex: root.toHex(),
      identityKey,
      wallet: {
        listActions: async (args: { labels: string[] }) => ({
          actions: args.labels.filter((l) => labelled.has(l)).map((l) => ({ status: labelled.get(l) })),
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
  verifyLtcDeposit: async (_chain: unknown, o: { txid: string; vout: number }) => verdicts.get(`${o.txid}:${o.vout}`)!,
}))
vi.mock('../hct/wallet', () => {
  const record = (op: string, args: Record<string, unknown>, opts?: { labels?: readonly string[] }) => {
    const txid = `${op.padEnd(8, '0')}${String(hctCalls.length).padStart(56, '0')}`.slice(0, 64)
    hctCalls.push({ op, args, labels: opts?.labels ?? [] })
    for (const l of opts?.labels ?? []) labelled.set(l, 'completed')
    return txid
  }
  return {
    listHctAssets: async () => ({
      assets: assetKnown
        ? [{ assetId: ASSET, kind: 'token', mode: 'open', sym: 'wLTC', authority: true, issuers: [identityKey.toLowerCase()], balance: balance.toString() }]
        : [],
    }),
    issueHctAsset: async (args: { supply: string }, opts: { labels: string[] }) => {
      const txid = record('issue', args, opts)
      assetKnown = true
      balance += BigInt(args.supply)
      return { assetId: ASSET, txid, kind: 'token', supply: args.supply, basket: 'p2pft' }
    },
    mintHctAsset: async (args: { amount: string }, opts: { labels: string[] }) => {
      balance += BigInt(args.amount)
      return { assetId: ASSET, txid: record('mint', args, opts), amount: args.amount }
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

function deposit(n: number, litoshi: bigint, kind: 'credit' | 'pending' = 'credit') {
  utxos.push({ txid: tx(n), vout: 0, value: Number(litoshi), confirmed: kind === 'credit' })
  verdicts.set(`${tx(n)}:0`, kind === 'credit'
    ? { kind: 'credit', txid: tx(n), vout: 0, litoshi, height: 1, confirmations: 6 }
    : { kind: 'pending', txid: tx(n), vout: 0, litoshi, confirmations: 2, needed: 6 })
}

beforeEach(() => {
  durable.clear()
  labelled.clear()
  hctCalls.length = 0
  broadcasts.length = 0
  balance = 0n
  assetKnown = false
  burnFails = false
  broadcastFails = false
  verdicts = new Map()
  utxos = []
  bridge.setWltcDepsForTest({ chain })
})

describe('wLTC bridge', () => {
  it('derives a reserve address apps cannot sign for', async () => {
    const addr = await bridge.getLtcDepositAddress()
    expect(addr.address).toMatch(/^ltc1q[02-9ac-hj-np-z]{38}$/)
    expect(addr).toMatchObject({ network: 'litecoin', asset: 'wLTC', decimals: 8, minConfirmations: 6, assetId: null })
    expect(reservedKeyRefusal('createSignature', { protocolID: [2, 'wLTC  Reserve'], keyID: '1' }, identityKey)).toBe('asset-protocol')
  })

  it('issues wLTC on the first proven deposit, mints on the next, and never twice', async () => {
    deposit(1, 50_000_000n)
    deposit(2, 1_000n, 'pending')
    let result = await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue'])
    expect(hctCalls[0]!.args).toMatchObject({ kind: 'token', sym: 'wLTC', dec: 8, supply: '50000000', auth: true })
    expect(hctCalls[0]!.labels).toEqual([`wltc deposit ${tx(1)}.0`])
    expect(result.deposits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ txid: tx(1), status: 'credited', litoshi: '50000000' }),
        expect.objectContaining({ txid: tx(2), status: 'pending', confirmations: 2, needed: 6 }),
      ]),
    )
    deposit(3, 25_000_000n)
    result = await bridge.listLtcDeposits()
    await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue', 'mint'])
    expect(hctCalls[1]!.args).toMatchObject({ assetId: ASSET, amount: '25000000' })
    expect(result).toMatchObject({ assetId: ASSET, balance: '75000000' })
  })

  it('reports refused deposits and mints nothing for them', async () => {
    utxos.push({ txid: tx(9), vout: 1, value: 5, confirmed: true })
    verdicts.set(`${tx(9)}:1`, { kind: 'refuse', txid: tx(9), vout: 1, reason: 'pow', detail: 'forged' })
    const result = await bridge.listLtcDeposits()
    expect(result.deposits).toEqual([expect.objectContaining({ status: 'refused', reason: 'pow' })])
    expect(hctCalls).toEqual([])
  })

  it('resolves a mint interrupted mid-flight by its label, not by minting again', async () => {
    deposit(4, 10_000n)
    durable.set('acct:handcash.wltc.v1', JSON.stringify({ deposits: { [`${tx(4)}:0`]: { litoshi: '10000', status: 'minting', at: 1 } }, withdrawals: {} }))
    labelled.set(`wltc deposit ${tx(4)}.0`, 'completed')
    await bridge.listLtcDeposits()
    expect(hctCalls).toEqual([])
    const failed = { deposits: { [`${tx(5)}:0`]: { litoshi: '10000', status: 'minting', at: 1 } }, withdrawals: {} }
    deposit(5, 10_000n)
    durable.set('acct:handcash.wltc.v1', JSON.stringify({ ...failed, deposits: { ...failed.deposits, [`${tx(4)}:0`]: { litoshi: '10000', status: 'credited', at: 1 } } }))
    labelled.set(`wltc deposit ${tx(5)}.0`, 'failed')
    await bridge.listLtcDeposits()
    expect(hctCalls.map((c) => c.op)).toEqual(['issue'])
  })

  it('signs the payout, burns amount plus fee, then broadcasts it', async () => {
    deposit(6, 30_000_000n)
    utxos.push({ txid: tx(7), vout: 0, value: 900_000_000, confirmed: true })
    verdicts.set(`${tx(7)}:0`, { kind: 'pending', txid: tx(7), vout: 0, litoshi: 900_000_000n, confirmations: 1, needed: 9 })
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
    expect(balance).toBe(30_000_000n - BigInt(result.burned))
  })

  it('sends nothing when the burn fails', async () => {
    deposit(8, 30_000_000n)
    await bridge.listLtcDeposits()
    burnFails = true
    await expect(bridge.withdrawLtc({ address: DEST, litoshi: '10000000' })).rejects.toThrow(/burn refused/)
    expect(broadcasts).toEqual([])
    expect((await bridge.listLtcDeposits()).withdrawals).toEqual([])
  })

  it('retries a burned payout until it lands and never burns it twice', async () => {
    deposit(10, 30_000_000n)
    await bridge.listLtcDeposits()
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

  it('refuses before signing when wLTC or the reserve falls short', async () => {
    deposit(11, 5_000_000n)
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
