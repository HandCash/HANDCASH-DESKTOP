import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from '../appActivity'
import type { LtcChain } from '../ltc/chain'
import { bip143Sighash, fromHex, ltcTxid, toHex } from '../ltc/litecoin'
import type { BurialCheck, DepositLocation, DepositSighting } from '../ltc/verify'
import { bchCoinAddress, bchCoinScript, encodeCashAddr, parseBchTx } from './bitcoincash'

const root = PrivateKey.fromRandom()
const durable = new Map<string, string>()
const recorded: Array<Omit<ActivityEntry, 'id' | 'at'>> = []
let sightings = new Map<string, DepositSighting>()
let locations = new Map<string, DepositLocation>()
let depths = new Map<string, BurialCheck>()
let utxos: Array<{ txid: string; vout: number; value: number; confirmed: boolean }> = []
let broadcasts: string[] = []
let heldElsewhere: string | null = null
const rulesSeen: string[] = []

const PROOF = { tx: '00', path: [], pos: 0, height: 7, header: '00'.repeat(80) }

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({ instance: { rootKeyHex: root.toHex(), identityKey: root.toPublicKey().toString() } }),
}))
vi.mock('../paymentPolicy', () => ({ assertOnlineForPayment: () => {} }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => heldElsewhere }))
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
  checkLtcBurial: async (_p: unknown, o: { txid: string }, _s: unknown, _m: unknown, _a: unknown, rules: { label: string; depth: number }) => {
    rulesSeen.push(`${rules.label} ${rules.depth}`)
    return depths.get(o.txid) ?? { ok: true, litoshi: 0n }
  },
}))

const txidOfHex = (hex: string) => ltcTxid(parseBchTx(fromHex(hex)))

const chain: LtcChain = {
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

const { bchWallet, BCH_DUST } = await import('./bchWallet')

const DEST = encodeCashAddr('p2pkh', fromHex('76a04053bda0a88bda5177b86a15c3b29f559873'))
const tx = (n: number) => n.toString(16).padStart(64, '0')
const ownPub = () => Uint8Array.from(bchWallet.coinKey(root).toPublicKey().encode(true) as number[])

function receive(n: number, sats: bigint, buried = true) {
  utxos.push({ txid: tx(n), vout: 0, value: Number(sats), confirmed: buried })
  sightings.set(`${tx(n)}:0`, { kind: 'seen', txid: tx(n), vout: 0, litoshi: sats })
  if (buried) locations.set(tx(n), { kind: 'in-block', proof: PROOF })
}

beforeEach(() => {
  durable.clear()
  recorded.length = 0
  rulesSeen.length = 0
  sightings = new Map()
  locations = new Map()
  depths = new Map()
  utxos = []
  broadcasts = []
  heldElsewhere = null
  bchWallet.setSourceForTest(chain)
  bchWallet.resetWatchForTest()
})

describe('native Bitcoin Cash', () => {
  it('holds its coins on a key of its own, under its own record, apart from Litecoin', async () => {
    const { ltcKey } = await import('../ltc/ltcWallet')
    expect(bchWallet.coinKey(root).toHex()).not.toBe(ltcKey(root).toHex())
    expect(bchWallet.getAddress()).toBe(bchCoinAddress(ownPub()))
    expect(bchWallet.getAddress()).toMatch(/^bitcoincash:q/)
    expect([...durable.keys()]).toEqual(['acct:handcash.bch.v1'])
  })

  it('reads an unused address once per install, then leaves the network alone until it is shown', async () => {
    const reads = vi.spyOn(chain, 'addressUtxos')
    try {
      expect(await bchWallet.watch()).toBe('scanned')
      bchWallet.resetWatchForTest()
      expect(await bchWallet.watch()).toBe('idle')
      expect(reads).toHaveBeenCalledTimes(1)
      bchWallet.getAddress()
      expect(await bchWallet.watch()).toBe('scanned')
      expect(reads).toHaveBeenCalledTimes(2)
    } finally {
      reads.mockRestore()
    }
  })

  it('reads and proves coins with Bitcoin Cash rules, six deep, and books Bitcoin Cash rows', async () => {
    receive(1, 500_000n, false)
    let report = await bchWallet.refresh()
    expect(report.balance).toEqual({ spendable: '0', confirming: '500000' })
    expect(recorded).toMatchObject([{ method: 'bch-receive', kind: 'earned', txid: tx(1), item: { name: 'BCH', origin: 'bch', backedBy: 'bch', amt: '500000', dec: 8 } }])
    locations.set(tx(1), { kind: 'in-block', proof: PROOF })
    report = await bchWallet.refresh()
    expect(report.balance).toEqual({ spendable: '500000', confirming: '0' })
    expect(rulesSeen).toEqual(['Bitcoin Cash', 'Bitcoin Cash 6'])
  })

  it('pays a CashAddr with a FORKID signature that verifies, at no less than one sat per byte', async () => {
    receive(1, 1_000_000n)
    receive(2, 40_000n)
    await bchWallet.refresh()
    const paid = await bchWallet.send({ address: DEST, litoshi: '300000' }, { origin: 'app.example' })
    expect(paid.status).toBe('sent')
    const raw = fromHex(broadcasts[0]!)
    const signed = parseBchTx(raw)
    expect(ltcTxid(signed)).toBe(paid.ltcTxid)
    expect(signed.outputs[0]).toMatchObject({ value: 300_000n })
    expect(toHex(signed.outputs[1]!.script)).toBe(toHex(bchCoinScript(ownPub())))
    expect(BigInt(paid.fee)).toBeGreaterThanOrEqual(BigInt(raw.length))
    signed.inputs.forEach((input, vin) => {
      const sigLen = input.script[0]!
      expect(input.script[sigLen]).toBe(0x41)
      const pubkey = input.script.slice(sigLen + 2)
      const digest = bip143Sighash(signed, vin, pubkey, 1_000_000n, 0x41)
      const sig = Signature.fromDER(Array.from(input.script.slice(1, sigLen)))
      expect(ECDSA.verify(new BigNumber(toHex(digest), 16), sig, PublicKey.fromString(toHex(pubkey)))).toBe(true)
      expect(input.sequence).toBe(0xffffffff)
    })
    expect(recorded.at(-1)).toMatchObject({ origin: 'app.example', method: 'bch-send', txid: paid.ltcTxid, note: expect.stringMatching(/BCH network fee$/) })
    expect(bchWallet.readBalance().spendable).toBe((1_040_000n - 300_000n - BigInt(paid.fee)).toString())
  })

  it('refuses legacy, Litecoin and testnet addresses, dust, its own address and more than it holds', async () => {
    receive(1, 100_000n)
    await bchWallet.refresh()
    const preflight = (address: string, litoshi: string) => () => bchWallet.preflightSend({ address, litoshi })
    expect(preflight('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', '5000')).toThrow(expect.objectContaining({ chain: 'bch', reason: 'bad-args' }))
    expect(preflight('ltc1q6r9l4272gn3ee99lecsdgqyd6ykwxavyttj3ft', '5000')).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight('bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', '5000')).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight(DEST, (BCH_DUST - 1n).toString())).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight(bchCoinAddress(ownPub()), '5000')).toThrow(expect.objectContaining({ reason: 'own-address' }))
    expect(preflight(DEST, '200000')).toThrow(expect.objectContaining({ reason: 'insufficient' }))
    heldElsewhere = 'held on another device'
    expect(preflight(DEST, '5000')).toThrow(expect.objectContaining({ reason: 'held-elsewhere' }))
    expect(broadcasts).toHaveLength(0)
  })
})
