import { BigNumber, ECDSA, KeyDeriver, PrivateKey, PublicKey, Signature } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from '../appActivity'
import type { LtcChain } from '../ltc/chain'
import { bip143Sighash, fromHex, ltcTxid, parseLtcTx, sameBytes, serializeLtcTx, toHex } from '../ltc/litecoin'
import type { DepositLocation, DepositSighting } from '../ltc/verify'
import { btcCoinScript, btcOutputScript } from '../btc/bitcoin'
import type { CoinPaymentNotice } from './coinWallet'
import type { CoinRecipientSupport } from '../walletProtocols'

const alice = PrivateKey.fromRandom()
const bob = PrivateKey.fromRandom()
const identityOf = (key: PrivateKey) => key.toPublicKey().toString()
let current = alice
const durable = new Map<string, string>()
const recorded: Array<Omit<ActivityEntry, 'id' | 'at'>> = []
let locations = new Map<string, DepositLocation>()
/** Unspent outputs on chain, by locking script. */
let chainUtxos = new Map<string, Array<{ txid: string; vout: number; value: number; confirmed: boolean }>>()
/** Raw transactions a source knows, by txid. */
let rawTxs = new Map<string, string>()
let broadcasts: string[] = []
let notices: Array<{ to: string; box: string; plaintext: string }> = []
let deliveryFails: string | null = null
let support: CoinRecipientSupport = { kind: 'supported' }

const PROOF = { tx: '00', path: [], pos: 0, height: 7, header: '00'.repeat(80) }

vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({ instance: { rootKeyHex: current.toHex(), identityKey: identityOf(current) } }),
}))
vi.mock('../paymentPolicy', () => ({ assertOnlineForPayment: () => {} }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => null }))
vi.mock('../accountMove', () => ({ ensureHoldingFresh: async () => {} }))
vi.mock('../accountLocalKeys', () => ({
  accountLocalKey: (key: string) => `${identityOf(current).slice(0, 8)}:${key}`,
  accountLocalKeyFor: (key: string, owner: { identityKey: string }) => `${owner.identityKey.slice(0, 8)}:${key}`,
}))
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => (durable.set(key, value), true),
}))
vi.mock('../appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'handcash',
  recordAppActivity: (entry: Omit<ActivityEntry, 'id' | 'at'>) => recorded.push(entry),
  upgradeActivityRows: () => 0,
}))
vi.mock('../walletProtocols', () => ({ coinRecipientSupport: async () => support }))
vi.mock('../messageTransport', () => ({
  sendSealedToPeerBox: async (_root: string, to: string, box: string, plaintext: string) => {
    if (deliveryFails) throw new Error(deliveryFails)
    notices.push({ to, box, plaintext })
  },
}))
vi.mock('../ltc/verify', async (load) => ({
  ...(await load<typeof import('../ltc/verify')>()),
  // The real check, against the transactions this test's chain knows.
  readLtcDeposit: async (_chain: unknown, o: { txid: string; vout: number }, script: Uint8Array): Promise<DepositSighting> => {
    const hex = rawTxs.get(o.txid)
    if (!hex) throw new Error('transaction not found')
    const output = parseLtcTx(fromHex(hex)).outputs[o.vout]
    if (!output || !sameBytes(output.script, script)) return { kind: 'refuse', txid: o.txid, vout: o.vout, reason: 'wrong-script', detail: 'not this key' }
    return { kind: 'seen', txid: o.txid, vout: o.vout, litoshi: output.value }
  },
  locateLtcDeposit: async (_chain: unknown, txid: string) => locations.get(txid) ?? { kind: 'unconfirmed' },
  checkLtcBurial: async () => ({ ok: true, litoshi: 0n }),
}))

const chain: LtcChain = {
  tipHeight: async () => 100,
  blockHashAt: async () => '00'.repeat(32),
  header: async () => new Uint8Array(80),
  headerPage: async () => [],
  txHex: async (txid) => rawTxs.get(txid) ?? '',
  txStatus: async (txid) => {
    if (rawTxs.has(txid)) return { confirmed: false }
    throw new Error('transaction not found')
  },
  merkleProof: async () => ({ blockHeight: 1, merkle: [], pos: 0 }),
  addressUtxos: async (address) => chainUtxos.get(toHex(btcOutputScript(address))) ?? [],
  broadcast: async (hex) => {
    broadcasts.push(hex)
    const tx = parseLtcTx(fromHex(hex))
    const txid = ltcTxid(tx)
    rawTxs.set(txid, hex)
    for (const input of tx.inputs) {
      for (const [script, list] of chainUtxos) chainUtxos.set(script, list.filter((u) => !(u.txid === input.txid && u.vout === input.vout)))
    }
    tx.outputs.forEach((output, vout) => {
      const script = toHex(output.script)
      chainUtxos.set(script, [...(chainUtxos.get(script) ?? []), { txid, vout, value: Number(output.value), confirmed: false }])
    })
    return txid
  },
  feeRate: async () => 1,
}

const { btcWallet } = await import('../btc/btcWallet')
const { forgetCustodyJournalCache, unspentCoinCustody } = await import('../custodyJournal')
const PROTOCOL: [2, string] = [2, 'btc coin payment']
const pubOf = (key: PrivateKey) => Uint8Array.from(key.toPublicKey().encode(true) as number[])

const as = async <T>(who: PrivateKey, task: () => Promise<T>): Promise<T> => {
  current = who
  return task()
}

/** Alice holds one buried coin on her own key. */
async function fundedAlice(units: bigint) {
  current = alice
  const funding = { txid: 'ee'.repeat(32), vout: 0, script: new Uint8Array(), sequence: 0xffffffff, witness: [] }
  const tx = { version: 2, inputs: [funding], outputs: [{ value: units, script: btcCoinScript(pubOf(btcWallet.coinKey(alice))) }], locktime: 0 }
  const txid = ltcTxid(tx)
  chainUtxos.set(toHex(tx.outputs[0]!.script), [{ txid, vout: 0, value: Number(units), confirmed: true }])
  rawTxs.set(txid, toHex(serializeLtcTx(tx)))
  locations.set(txid, { kind: 'in-block', proof: PROOF })
  await btcWallet.refresh()
}

beforeEach(() => {
  durable.clear()
  recorded.length = 0
  locations = new Map()
  chainUtxos = new Map()
  rawTxs = new Map()
  broadcasts = []
  notices = []
  deliveryFails = null
  support = { kind: 'supported' }
  current = alice
  forgetCustodyJournalCache()
  btcWallet.setSourceForTest(chain)
  btcWallet.resetWatchForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('coins sent to an identity (BRC-213 §7)', () => {
  it('locks the payment to a fresh child of the recipient, who reads the notice, proves the coin and spends it', async () => {
    await fundedAlice(100_000n)
    const paid = await as(alice, () => btcWallet.send({ identityKey: identityOf(bob), litoshi: '40000' }, { toLabel: '$bob' }))
    expect(paid.status).toBe('sent')
    await btcWallet.refresh()

    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ to: identityOf(bob), box: 'coin-payment' })
    const notice = JSON.parse(notices[0]!.plaintext) as CoinPaymentNotice
    expect(notice).toMatchObject({ v: 1, t: 'coin-payment', chain: 'btc', txid: paid.ltcTxid, vout: 0 })
    expect(notice.keyId).toMatch(/^[0-9a-f]{32}$/)
    expect(Object.keys(notice).sort()).toEqual(['chain', 'keyId', 't', 'txid', 'v', 'vout'])

    // Only Bob derives the key the output pays; Alice's notice names it, never carries it.
    const bobKey = new KeyDeriver(bob).derivePrivateKey(PROTOCOL, notice.keyId, identityOf(alice))
    const signed = parseLtcTx(fromHex(broadcasts[0]!))
    expect(toHex(signed.outputs[0]!.script)).toBe(toHex(btcCoinScript(pubOf(bobKey))))
    expect(toHex(signed.outputs[0]!.script)).not.toBe(toHex(btcCoinScript(pubOf(btcWallet.coinKey(bob)))))
    expect(recorded.at(-1)).toMatchObject({ method: 'btc-send', note: expect.stringContaining('To $bob') })
    const report = await btcWallet.refresh()
    expect(report.payments[0]).toMatchObject({ ltcTxid: paid.ltcTxid, to: { identityKey: identityOf(bob), notified: true } })

    expect(await as(bob, () => btcWallet.ingestPaymentNotice(identityOf(alice), notice))).toBe('recorded')
    expect(await btcWallet.ingestPaymentNotice(identityOf(alice), notice)).toBe('recorded')
    expect(recorded.filter((r) => r.method === 'btc-receive' && r.from === identityOf(alice).toLowerCase())).toHaveLength(1)
    expect(btcWallet.readBalance()).toEqual({ spendable: '0', confirming: '40000' })

    locations.set(paid.ltcTxid, { kind: 'in-block', proof: PROOF })
    await btcWallet.refresh()
    expect(btcWallet.readBalance()).toEqual({ spendable: '40000', confirming: '0' })

    const spent = await btcWallet.send({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', litoshi: '20000' })
    const bobTx = parseLtcTx(fromHex(broadcasts.at(-1)!))
    expect(ltcTxid(bobTx)).toBe(spent.ltcTxid)
    const [sigWithType, pubkey] = bobTx.inputs[0]!.witness
    expect(toHex(pubkey!)).toBe(toHex(pubOf(bobKey)))
    const digest = bip143Sighash(bobTx, 0, pubOf(bobKey), 40_000n, 1)
    const sig = Signature.fromDER(Array.from(sigWithType!.slice(0, -1)))
    expect(ECDSA.verify(new BigNumber(toHex(digest), 16), sig, PublicKey.fromString(toHex(pubOf(bobKey))))).toBe(true)
    // Change returns to Bob's own key, not the sender's child.
    expect(toHex(bobTx.outputs[1]!.script)).toBe(toHex(btcCoinScript(pubOf(btcWallet.coinKey(bob)))))
  })

  it('gives every payment its own key', async () => {
    await fundedAlice(200_000n)
    await btcWallet.send({ identityKey: identityOf(bob), litoshi: '30000' })
    await btcWallet.send({ identityKey: identityOf(bob), litoshi: '30000' })
    await btcWallet.refresh()
    const scripts = broadcasts.map((hex) => toHex(parseLtcTx(fromHex(hex)).outputs[0]!.script))
    expect(new Set(scripts).size).toBe(2)
    expect(new Set(notices.map((n) => (JSON.parse(n.plaintext) as CoinPaymentNotice).keyId)).size).toBe(2)
  })

  it('refuses before signing unless the recipient says it receives the coin', async () => {
    await fundedAlice(100_000n)
    for (const [answer, reason] of [
      [{ kind: 'unsupported' }, 'unsupported-recipient'],
      [{ kind: 'unknown' }, 'unsupported-recipient'],
      [{ kind: 'unreachable', reason: 'offline' }, 'recipient-unchecked'],
    ] as const) {
      support = answer
      await expect(btcWallet.preflightRecipient({ identityKey: identityOf(bob), litoshi: '40000' })).rejects.toMatchObject({ chain: 'btc', reason })
      await expect(btcWallet.send({ identityKey: identityOf(bob), litoshi: '40000' })).rejects.toMatchObject({ reason })
    }
    expect(broadcasts).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })

  it('refuses its own identity, a malformed key, and naming both an address and an identity', async () => {
    await fundedAlice(100_000n)
    const preflight = (args: Parameters<typeof btcWallet.preflightSend>[0]) => () => btcWallet.preflightSend(args)
    expect(preflight({ identityKey: identityOf(alice), litoshi: '40000' })).toThrow(expect.objectContaining({ reason: 'own-address' }))
    expect(preflight({ identityKey: 'zz', litoshi: '40000' })).toThrow(expect.objectContaining({ reason: 'bad-args' }))
    expect(preflight({ identityKey: identityOf(bob), address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', litoshi: '40000' })).toThrow(
      expect.objectContaining({ reason: 'bad-args' }),
    )
  })

  it('a notice that fails to deliver is retried and never touches the payment', async () => {
    await fundedAlice(100_000n)
    deliveryFails = 'box down'
    const paid = await btcWallet.send({ identityKey: identityOf(bob), litoshi: '40000' })
    let report = await btcWallet.refresh()
    expect(paid.status).toBe('sent')
    expect(report.payments[0]).toMatchObject({ status: 'sent', to: { notified: false } })
    expect(notices).toHaveLength(0)
    deliveryFails = null
    const later = Date.now() + 31_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    report = await btcWallet.refresh()
    expect(report.payments[0]).toMatchObject({ to: { notified: true } })
    expect(notices).toHaveLength(1)
  })

  it('journals the coin before the notice is acknowledged, restores it when the record is lost, and retires it once spent', async () => {
    await fundedAlice(100_000n)
    const paid = await btcWallet.send({ identityKey: identityOf(bob), litoshi: '40000' })
    await btcWallet.refresh()
    const notice = JSON.parse(notices[0]!.plaintext) as CoinPaymentNotice
    current = bob
    const owner = { identityKey: identityOf(bob), accountIndex: 0, chain: 'main' as const }
    await btcWallet.ingestPaymentNotice(identityOf(alice), notice)
    expect(unspentCoinCustody(owner, 'btc')).toEqual([
      { op: `${paid.ltcTxid}.0`, units: 40_000, r: { p: 'coin payment', chain: 'btc', sender: identityOf(alice).toLowerCase(), keyId: notice.keyId } },
    ])
    expect(unspentCoinCustody(owner, 'ltc')).toEqual([])

    // The device is wiped of its coin record; the journal (backed up off-device) is all that is left.
    for (const key of [...durable.keys()]) if (key.endsWith('handcash.btc.v1')) durable.delete(key)
    expect(btcWallet.readBalance()).toEqual({ spendable: '0', confirming: '0' })
    locations.set(paid.ltcTxid, { kind: 'in-block', proof: PROOF })
    await btcWallet.refresh()
    expect(btcWallet.readBalance()).toEqual({ spendable: '40000', confirming: '0' })

    const spent = await btcWallet.send({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', litoshi: '20000' })
    expect(unspentCoinCustody(owner, 'btc')).toHaveLength(1)
    vi.spyOn(chain, 'txStatus').mockImplementation(async (txid) => {
      if (txid === spent.ltcTxid) return { confirmed: true }
      if (rawTxs.has(txid)) return { confirmed: false }
      throw new Error('transaction not found')
    })
    await btcWallet.refresh()
    expect(unspentCoinCustody(owner, 'btc')).toEqual([])
  })

  it('refuses a notice whose output does not pay the key derived for its sender, and malformed notices', async () => {
    await fundedAlice(100_000n)
    const paid = await btcWallet.send({ identityKey: identityOf(bob), litoshi: '40000' })
    await btcWallet.refresh()
    const notice = JSON.parse(notices[0]!.plaintext) as CoinPaymentNotice
    const mallory = PrivateKey.fromRandom()
    current = bob
    // Claimed by someone other than the payer: the derived key differs, so the output is not theirs to announce.
    expect(await btcWallet.ingestPaymentNotice(identityOf(mallory), notice)).toBe('refused')
    expect(await btcWallet.ingestPaymentNotice(identityOf(alice), { ...notice, keyId: 'ab'.repeat(16) })).toBe('refused')
    expect(await btcWallet.ingestPaymentNotice(identityOf(alice), { ...notice, chain: 'ltc' })).toBe('refused')
    expect(await btcWallet.ingestPaymentNotice(identityOf(alice), { ...notice, keyId: 'short' })).toBe('refused')
    expect(btcWallet.readBalance()).toEqual({ spendable: '0', confirming: '0' })
    rawTxs.delete(paid.ltcTxid)
    await expect(btcWallet.ingestPaymentNotice(identityOf(alice), notice)).rejects.toThrow('transaction not found')
  })
})
