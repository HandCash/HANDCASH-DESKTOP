import { LockingScript, PrivateKey, Spend, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { bchOutputScript } from '../bch/bitcoincash'
import { btcOutputScript } from '../btc/bitcoin'
import { dogeOutputScript } from '../doge/dogecoin'
import { fromHex, ltcOutputScript, parseLtcTx, serializeLtcTxNoWitness, toHex, type Bytes } from '../ltc/litecoin'
import {
  htlcKind,
  htlcOutput,
  htlcScript,
  htlcSignature,
  htlcSignatureValid,
  readSecret,
  sha256,
  signHtlcSpend,
  type HtlcCoin,
  type HtlcTerms,
} from './htlc'
import type { SwapAsset } from './assets'

const claimKey = PrivateKey.fromString('11'.repeat(32), 'hex')
const refundKey = PrivateKey.fromString('22'.repeat(32), 'hex')
const cosignKey = PrivateKey.fromString('33'.repeat(32), 'hex')
const pub = (k: PrivateKey): Bytes => Uint8Array.from(k.toPublicKey().encode(true) as number[])
const secret = fromHex('ab'.repeat(32))
const locktime = 1_800_000_000

const terms = (chain: SwapAsset): HtlcTerms => ({
  hash: sha256(secret),
  claimPub: pub(claimKey),
  refundPub: pub(refundKey),
  locktime,
  ...(chain === 'bsv' ? { cosignPub: pub(cosignKey) } : {}),
})
const coin = (chain: SwapAsset, amount = 100_000n): HtlcCoin => ({ txid: 'cd'.repeat(32), vout: 1, amount, script: htlcScript(chain, terms(chain)) })
const payTo = fromHex('76a914' + '00'.repeat(20) + '88ac')

describe('HTLC outputs', () => {
  it('locks segwit chains to P2WSH, BCH and Dogecoin to P2SH, BSV bare', () => {
    expect(htlcOutput('ltc', coin('ltc').script).address).toMatch(/^ltc1q[a-z0-9]{58}$/)
    expect(htlcOutput('btc', coin('btc').script).address).toMatch(/^bc1q[a-z0-9]{58}$/)
    expect(htlcOutput('bch', coin('bch').script).address).toMatch(/^bitcoincash:p/)
    expect(htlcOutput('doge', coin('doge').script).address).toMatch(/^A/)
    expect(htlcOutput('bsv', coin('bsv').script)).toEqual({ scriptPubKey: coin('bsv').script, address: null })
    expect(htlcKind('bsv')).toBe('bare')
  })

  it("each chain's own address decoder reads the HTLC address back to its output script", () => {
    const decoders = { ltc: ltcOutputScript, btc: btcOutputScript, bch: bchOutputScript, doge: dogeOutputScript }
    for (const chain of ['ltc', 'btc', 'bch', 'doge'] as const) {
      const out = htlcOutput(chain, coin(chain).script)
      expect(toHex(decoders[chain](out.address!))).toBe(toHex(out.scriptPubKey))
    }
  })

  it('refuses malformed terms', () => {
    expect(() => htlcScript('ltc', { ...terms('ltc'), locktime: 800_000 })).toThrow(/unix time/)
    expect(() => htlcScript('bsv', { ...terms('ltc') })).toThrow(/co-signer/)
    expect(() => htlcScript('ltc', { ...terms('bsv') })).toThrow(/only a BSV/)
    expect(() => htlcScript('ltc', { ...terms('ltc'), hash: new Uint8Array(20) })).toThrow(/32 bytes/)
  })
})

describe('HTLC spends on the coin chains', () => {
  for (const chain of ['ltc', 'btc', 'bch', 'doge'] as const) {
    it(`${chain}: a claim reveals the secret and carries a valid claim signature`, () => {
      const c = coin(chain)
      const { tx, hex, fee } = signHtlcSpend(chain, { coins: [c], to: payTo, key: claimKey, path: { kind: 'claim', preimage: secret }, feeRate: 2 })
      expect(fee).toBeGreaterThan(0n)
      expect(tx.outputs[0]!.value).toBe(c.amount - fee)
      expect(tx.locktime).toBe(0)
      const parsed = parseLtcTx(fromHex(hex))
      expect(toHex(readSecret(chain, parsed, 0, sha256(secret))!)).toBe(toHex(secret))
      const sig = chain === 'ltc' || chain === 'btc' ? parsed.inputs[0]!.witness[0]! : pushesOf(parsed.inputs[0]!.script)[0]!
      expect(htlcSignatureValid(chain, tx, 0, c.script, c.amount, pub(claimKey), sig)).toBe(true)
      expect(htlcSignatureValid(chain, tx, 0, c.script, c.amount, pub(refundKey), sig)).toBe(false)
    })

    it(`${chain}: a refund waits for the locktime and reveals nothing`, () => {
      const c = coin(chain)
      const { tx } = signHtlcSpend(chain, { coins: [c], to: payTo, key: refundKey, path: { kind: 'refund', locktime }, feeRate: 1 })
      expect(tx.locktime).toBe(locktime)
      expect(tx.inputs[0]!.sequence).toBe(0xfffffffe)
      expect(readSecret(chain, tx, 0, sha256(secret))).toBeNull()
    })
  }

  it('refuses a claim with a short secret and a spend the fee eats', () => {
    expect(() => signHtlcSpend('ltc', { coins: [coin('ltc')], to: payTo, key: claimKey, path: { kind: 'claim', preimage: new Uint8Array(16) } })).toThrow(/32 bytes/)
    expect(() => signHtlcSpend('ltc', { coins: [coin('ltc', 100n)], to: payTo, key: claimKey, path: { kind: 'claim', preimage: secret }, feeRate: 5 })).toThrow(/fee/)
  })
})

/** Run input 0 of a BSV spend through the SDK interpreter. */
function bsvValid(lock: Bytes, txHex: string, amount: bigint): boolean {
  const tx = parseLtcTx(fromHex(txHex))
  const input = tx.inputs[0]!
  const spend = new Spend({
    sourceTXID: input.txid,
    sourceOutputIndex: input.vout,
    sourceSatoshis: Number(amount),
    lockingScript: LockingScript.fromHex(toHex(lock)),
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs.map((o) => ({ satoshis: Number(o.value), lockingScript: LockingScript.fromHex(toHex(o.script)) })),
    unlockingScript: UnlockingScript.fromHex(toHex(input.script)),
    inputSequence: input.sequence,
    inputIndex: 0,
    lockTime: tx.locktime,
  })
  try {
    return spend.validate()
  } catch {
    return false
  }
}

describe('HTLC spends on BSV', () => {
  const c = coin('bsv', 5_000n)

  it('a claim with the secret passes the interpreter; a wrong secret does not', () => {
    const ok = signHtlcSpend('bsv', { coins: [c], to: payTo, key: claimKey, path: { kind: 'claim', preimage: secret }, feeRate: 1 })
    expect(bsvValid(c.script, ok.hex, c.amount)).toBe(true)
    const wrong = signHtlcSpend('bsv', { coins: [c], to: payTo, key: claimKey, path: { kind: 'claim', preimage: fromHex('cd'.repeat(32)) }, feeRate: 1 })
    expect(bsvValid(c.script, wrong.hex, c.amount)).toBe(false)
  })

  it('a refund needs the counterparty pre-signature over the same transaction', () => {
    const value = 4_800n
    const unsigned = signHtlcSpend('bsv', { coins: [c], to: payTo, key: refundKey, path: { kind: 'refund', locktime, cosigs: [new Uint8Array(72)] }, value })
    const cosig = htlcSignature('bsv', unsigned.tx, 0, c.script, c.amount, cosignKey)
    const refund = signHtlcSpend('bsv', { coins: [c], to: payTo, key: refundKey, path: { kind: 'refund', locktime, cosigs: [cosig] }, value })
    expect(refund.tx.locktime).toBe(locktime)
    expect(bsvValid(c.script, refund.hex, c.amount)).toBe(true)
    const forged = signHtlcSpend('bsv', { coins: [c], to: payTo, key: refundKey, path: { kind: 'refund', locktime, cosigs: [htlcSignature('bsv', unsigned.tx, 0, c.script, c.amount, claimKey)] }, value })
    expect(bsvValid(c.script, forged.hex, c.amount)).toBe(false)
    const early = signHtlcSpend('bsv', { coins: [c], to: payTo, key: refundKey, path: { kind: 'refund', locktime: locktime + 1, cosigs: [cosig] }, value })
    expect(bsvValid(c.script, early.hex, c.amount)).toBe(false)
  })

  it('the claimer cannot take the refund path alone', () => {
    const value = 4_800n
    const unsigned = signHtlcSpend('bsv', { coins: [c], to: payTo, key: claimKey, path: { kind: 'refund', locktime, cosigs: [new Uint8Array(72)] }, value })
    const cosig = htlcSignature('bsv', unsigned.tx, 0, c.script, c.amount, cosignKey)
    const theft = signHtlcSpend('bsv', { coins: [c], to: payTo, key: claimKey, path: { kind: 'refund', locktime, cosigs: [cosig] }, value })
    expect(bsvValid(c.script, theft.hex, c.amount)).toBe(false)
  })
})

describe('HTLC redeem script on BCH (FORKID sighash = BSV; the interpreter treats CLTV as a no-op)', () => {
  const c = coin('bch', 50_000n)
  const asBareSpend = (hex: string): string => {
    const tx = parseLtcTx(fromHex(hex))
    const pushes = pushesOf(tx.inputs[0]!.script)
    const redeem = pushes[pushes.length - 1]!
    expect(toHex(redeem)).toBe(toHex(c.script))
    tx.inputs[0]!.script = tx.inputs[0]!.script.slice(0, tx.inputs[0]!.script.length - redeem.length - (redeem.length > 75 ? 2 : 1))
    return toHex(serializeLtcTxNoWitness(tx))
  }

  it('claim and refund satisfy the redeem script; swapped keys do not', () => {
    const claim = signHtlcSpend('bch', { coins: [c], to: payTo, key: claimKey, path: { kind: 'claim', preimage: secret }, feeRate: 1 })
    expect(bsvValid(c.script, asBareSpend(claim.hex), c.amount)).toBe(true)
    const refund = signHtlcSpend('bch', { coins: [c], to: payTo, key: refundKey, path: { kind: 'refund', locktime }, feeRate: 1 })
    expect(bsvValid(c.script, asBareSpend(refund.hex), c.amount)).toBe(true)
    const stolen = signHtlcSpend('bch', { coins: [c], to: payTo, key: claimKey, path: { kind: 'refund', locktime }, feeRate: 1 })
    expect(bsvValid(c.script, asBareSpend(stolen.hex), c.amount)).toBe(false)
  })
})

function pushesOf(script: Bytes): Bytes[] {
  const out: Bytes[] = []
  let i = 0
  while (i < script.length) {
    const op = script[i++]!
    if (op >= 1 && op <= 75) {
      out.push(script.slice(i, i + op))
      i += op
    } else if (op === 0x4c) {
      const n = script[i++]!
      out.push(script.slice(i, i + n))
      i += n
    }
  }
  return out
}
