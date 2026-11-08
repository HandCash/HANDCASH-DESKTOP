import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from '../appActivity'
import type { LtcChain } from '../ltc/chain'
import { bip143Sighash, fromHex, ltcTxid, parseLtcTx, Reader, toHex } from '../ltc/litecoin'
import type { DepositLocation, DepositSighting } from '../ltc/verify'
import { btcCoinAddress, btcCoinScript } from '../btc/bitcoin'
import { dogeCoinAddress, dogeCoinScript, legacySighash, parseDogeTx } from '../doge/dogecoin'

const root = PrivateKey.fromRandom()
const durable = new Map<string, string>()
const recorded: Array<Omit<ActivityEntry, 'id' | 'at'>> = []
let sightings = new Map<string, DepositSighting>()
let locations = new Map<string, DepositLocation>()
let utxos: Array<{ txid: string; vout: number; value: number; confirmed: boolean }> = []
let broadcasts: string[] = []
const rulesSeen: string[] = []

const PROOF = { tx: '00', path: [], pos: 0, height: 7, header: '00'.repeat(80) }

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({ instance: { rootKeyHex: root.toHex(), identityKey: root.toPublicKey().toString() } }),
}))
vi.mock('../paymentPolicy', () => ({ assertOnlineForPayment: () => {} }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => null }))
vi.mock('../accountMove', () => ({ ensureHoldingFresh: async () => {} }))
vi.mock('../accountLocalKeys', () => ({ accountLocalKey: (key: string) => `acct:${key}`, accountLocalKeyFor: (key: string) => `acct:${key}` }))
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => (durable.set(key, value), true),
}))
vi.mock('../appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'handcash',
  recordAppActivity: (entry: Omit<ActivityEntry, 'id' | 'at'>) => recorded.push(entry),
  upgradeActivityRows: () => 0,
}))
vi.mock('../ltc/verify', async (load) => ({
  ...(await load<typeof import('../ltc/verify')>()),
  readLtcDeposit: async (_chain: unknown, o: { txid: string; vout: number }, _script: unknown, rules: { label: string }) => {
    rulesSeen.push(rules.label)
    return sightings.get(`${o.txid}:${o.vout}`)!
  },
  locateLtcDeposit: async (_chain: unknown, txid: string) => locations.get(txid) ?? { kind: 'unconfirmed' },
  checkLtcBurial: async (_p: unknown, _o: unknown, _s: unknown, _m: unknown, _a: unknown, rules: { label: string; depth: number }) => {
    rulesSeen.push(`${rules.label} ${rules.depth}`)
    return { ok: true, litoshi: 0n }
  },
}))

const chainFor = (parse: (raw: Uint8Array) => ReturnType<typeof parseLtcTx>): LtcChain => {
  const txidOfHex = (hex: string) => ltcTxid(parse(fromHex(hex)))
  return {
    tipHeight: async () => 100,
    blockHashAt: async () => '00'.repeat(32),
    header: async () => new Uint8Array(80),
    headerPage: async () => [],
    txHex: async () => '',
    txStatus: async (txid) => {
      if (broadcasts.some((hex) => txidOfHex(hex) === txid)) return { confirmed: false }
      throw new Error('transaction not found')
    },
    merkleProof: async () => ({ blockHeight: 1, merkle: [], pos: 0 }),
    addressUtxos: async () => utxos,
    broadcast: async (hex) => {
      broadcasts.push(hex)
      return txidOfHex(hex)
    },
    feeRate: async () => 1,
  }
}

const { btcWallet, BTC_DUST } = await import('../btc/btcWallet')
const { dogeWallet, DOGE_DUST } = await import('../doge/dogeWallet')
const { ltcKey } = await import('../ltc/ltcWallet')
const { bchWallet } = await import('../bch/bchWallet')

const tx = (n: number) => n.toString(16).padStart(64, '0')
const pubOf = (key: PrivateKey) => Uint8Array.from(key.toPublicKey().encode(true) as number[])

function receive(n: number, units: bigint, buried = true) {
  utxos.push({ txid: tx(n), vout: 0, value: Number(units), confirmed: buried })
  sightings.set(`${tx(n)}:0`, { kind: 'seen', txid: tx(n), vout: 0, litoshi: units })
  if (buried) locations.set(tx(n), { kind: 'in-block', proof: PROOF })
}

beforeEach(() => {
  durable.clear()
  recorded.length = 0
  rulesSeen.length = 0
  sightings = new Map()
  locations = new Map()
  utxos = []
  broadcasts = []
  btcWallet.setSourceForTest(chainFor(parseLtcTx))
  dogeWallet.setSourceForTest(chainFor(parseDogeTx))
  btcWallet.resetWatchForTest()
  dogeWallet.resetWatchForTest()
})

describe('native coins on keys of their own', () => {
  it('derives a separate key and record for every chain', () => {
    const keys = [ltcKey(root), bchWallet.coinKey(root), btcWallet.coinKey(root), dogeWallet.coinKey(root)].map((k) => k.toHex())
    expect(new Set(keys).size).toBe(4)
    expect(btcWallet.getAddress()).toBe(btcCoinAddress(pubOf(btcWallet.coinKey(root))))
    expect(dogeWallet.getAddress()).toBe(dogeCoinAddress(pubOf(dogeWallet.coinKey(root))))
    expect([...durable.keys()].sort()).toEqual(['acct:handcash.btc.v1', 'acct:handcash.doge.v1'])
  })
})

describe('native Bitcoin', () => {
  it('proves coins three deep with Bitcoin rules and books Bitcoin rows', async () => {
    receive(1, 50_000n, false)
    let report = await btcWallet.refresh()
    expect(report.balance).toEqual({ spendable: '0', confirming: '50000' })
    expect(recorded).toMatchObject([{ method: 'btc-receive', txid: tx(1), item: { name: 'BTC', backedBy: 'btc', amt: '50000', dec: 8 } }])
    locations.set(tx(1), { kind: 'in-block', proof: PROOF })
    report = await btcWallet.refresh()
    expect(report.balance).toEqual({ spendable: '50000', confirming: '0' })
    expect(rulesSeen).toEqual(['Bitcoin', 'Bitcoin 3'])
  })

  it('pays a bc1 address with BIP143 witness signatures that verify, opted in to replacement', async () => {
    receive(1, 100_000n)
    receive(2, 30_000n)
    await btcWallet.refresh()
    const dest = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
    const paid = await btcWallet.send({ address: dest, litoshi: '60000' }, { origin: 'app.example' })
    expect(paid.status).toBe('sent')
    const signed = parseLtcTx(fromHex(broadcasts[0]!))
    expect(ltcTxid(signed)).toBe(paid.ltcTxid)
    expect(toHex(signed.outputs[0]!.script)).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6')
    const own = pubOf(btcWallet.coinKey(root))
    expect(toHex(signed.outputs[1]!.script)).toBe(toHex(btcCoinScript(own)))
    const amounts = new Map([[tx(1), 100_000n], [tx(2), 30_000n]])
    signed.inputs.forEach((input, vin) => {
      expect(input.script).toHaveLength(0)
      expect(input.sequence).toBe(0xfffffffd)
      const [sigWithType, pubkey] = input.witness
      expect(toHex(pubkey!)).toBe(toHex(own))
      const digest = bip143Sighash(signed, vin, own, amounts.get(input.txid)!, 1)
      const sig = Signature.fromDER(Array.from(sigWithType!.slice(0, -1)))
      expect(ECDSA.verify(new BigNumber(toHex(digest), 16), sig, PublicKey.fromString(toHex(own)))).toBe(true)
    })
    expect(recorded.at(-1)).toMatchObject({ method: 'btc-send', txid: paid.ltcTxid })
    expect(btcWallet.readBalance().spendable).toBe((130_000n - 60_000n - BigInt(paid.fee)).toString())
  })

  it('refuses 1… addresses (they read as BSV), other chains, dust and its own address', async () => {
    receive(1, 100_000n)
    await btcWallet.refresh()
    const preflight = (address: string, units: string) => () => btcWallet.preflightSend({ address, litoshi: units })
    expect(preflight('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '5000')).toThrow(expect.objectContaining({ chain: 'btc', reason: 'bad-args' }))
    expect(preflight('ltc1q6r9l4272gn3ee99lecsdgqyd6ykwxavyttj3ft', '5000')).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', (BTC_DUST - 1n).toString())).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight(btcWallet.getAddress(), '5000')).toThrow(expect.objectContaining({ reason: 'own-address' }))
    expect(broadcasts).toHaveLength(0)
  })
})

describe('native Dogecoin', () => {
  it('proves coins twenty deep with Dogecoin rules and books Dogecoin rows', async () => {
    receive(1, 500_000_000n)
    await dogeWallet.refresh()
    expect(dogeWallet.readBalance()).toMatchObject({ spendable: '500000000' })
    expect(recorded).toMatchObject([{ method: 'doge-receive', item: { name: 'DOGE', backedBy: 'doge', dec: 8 } }])
    expect(rulesSeen).toEqual(['Dogecoin', 'Dogecoin 20'])
  })

  it('pays a D… address with legacy signatures that verify', async () => {
    receive(1, 500_000_000n)
    receive(2, 300_000_000n)
    await dogeWallet.refresh()
    const dest = dogeCoinAddress(pubOf(PrivateKey.fromRandom()))
    const paid = await dogeWallet.send({ address: dest, litoshi: '600000000' }, { origin: 'app.example' })
    const signed = parseDogeTx(fromHex(broadcasts[0]!))
    expect(ltcTxid(signed)).toBe(paid.ltcTxid)
    const own = pubOf(dogeWallet.coinKey(root))
    expect(toHex(signed.outputs[1]!.script)).toBe(toHex(dogeCoinScript(own)))
    signed.inputs.forEach((input, vin) => {
      expect(input.witness).toHaveLength(0)
      const r = new Reader(input.script)
      const sigWithType = r.bytes(r.u8())
      expect(toHex(r.bytes(r.u8()))).toBe(toHex(own))
      const digest = legacySighash(signed, vin, dogeCoinScript(own))
      const sig = Signature.fromDER(Array.from(sigWithType.slice(0, -1)))
      expect(ECDSA.verify(new BigNumber(toHex(digest), 16), sig, PublicKey.fromString(toHex(own)))).toBe(true)
    })
    expect(recorded.at(-1)).toMatchObject({ method: 'doge-send', txid: paid.ltcTxid })
  })

  it('refuses Bitcoin and Litecoin addresses, and dust', async () => {
    receive(1, 500_000_000n)
    await dogeWallet.refresh()
    const preflight = (address: string, units: string) => () => dogeWallet.preflightSend({ address, litoshi: units })
    const dest = dogeCoinAddress(pubOf(PrivateKey.fromRandom()))
    expect(preflight('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '100000000')).toThrow(expect.objectContaining({ chain: 'doge', reason: 'bad-args' }))
    expect(preflight('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', '100000000')).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight(dest, (DOGE_DUST - 1n).toString())).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(broadcasts).toHaveLength(0)
  })
})

describe('swap claims', () => {
  it('spends a broadcast claim at once and never books it as a deposit', async () => {
    await btcWallet.recordClaim(tx(9), 40_000n)
    receive(9, 40_000n, false)
    const report = await btcWallet.refresh()
    expect(report.balance).toEqual({ spendable: '40000', confirming: '0' })
    expect(recorded).toEqual([])
    expect(btcWallet.readCoinViews()).toEqual([])
    const paid = await btcWallet.send({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', litoshi: '20000' }, { origin: 'app.example' })
    expect(paid.status).toBe('sent')
    expect(parseLtcTx(fromHex(broadcasts[0]!)).inputs.map((input) => input.txid)).toEqual([tx(9)])
  })
})
