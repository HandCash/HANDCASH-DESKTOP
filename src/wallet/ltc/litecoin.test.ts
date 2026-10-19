import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { LtcChain } from './chain'
import fixture from './fixtures/deposit.json'
import {
  decodeSegwitAddress,
  encodeSegwitAddress,
  fromHex,
  ltcOutputScript,
  ltcTxid,
  merkleRootFromProof,
  meetsOwnTarget,
  p2wpkhAddress,
  p2wpkhScript,
  p2wpkhSighash,
  parseLtcHeader,
  parseLtcTx,
  serializeLtcTx,
  signP2wpkhInputs,
  toHex,
  type LtcTx,
} from './litecoin'
import { createLtcHeaderChain, memoryLtcHeaderStore, type LtcAnchor, type LtcBurialAnchor } from './headers'
import { checkLtcBurial, locateLtcDeposit, LTC_BURIAL_DEPTH, readLtcDeposit, type LtcBurialProof } from './verify'

describe('litecoin primitives', () => {
  it('computes the BIP143 native P2WPKH digest', () => {
    const tx = parseLtcTx(
      fromHex(
        '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000',
      ),
    )
    const pubkey = fromHex('025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357')
    expect(toHex(p2wpkhSighash(tx, 1, pubkey, 600_000_000n))).toBe('c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670')
  })

  it('decodes bech32 and bech32m and refuses a broken checksum', () => {
    const v0 = decodeSegwitAddress('bc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect(v0 && toHex(v0.program)).toBe('751e76e8199196d454941c45d1b3a323f1433bd6')
    const v1 = decodeSegwitAddress('bc', 'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y')
    expect(v1?.version).toBe(1)
    expect(decodeSegwitAddress('bc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBeNull()
    expect(encodeSegwitAddress('bc', 1, v1!.program)).toBe('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y')
  })

  it('maps Litecoin mainnet addresses to output scripts and refuses others', () => {
    const real = parseLtcTx(fromHex(fixture.hex))
    expect(toHex(ltcOutputScript(fixture.address))).toBe(toHex(real.outputs[fixture.vout]!.script))
    const hash = Array.from({ length: 20 }, (_, i) => i)
    expect(toHex(ltcOutputScript(Utils.toBase58Check(hash, [0x30])))).toBe(`76a914${Utils.toHex(hash)}88ac`)
    expect(toHex(ltcOutputScript(Utils.toBase58Check(hash, [0x32])))).toBe(`a914${Utils.toHex(hash)}87`)
    expect(() => ltcOutputScript(Utils.toBase58Check(hash, [0x00]))).toThrow(/mainnet/)
    expect(() => ltcOutputScript('tltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9')).toThrow()
    expect(() => ltcOutputScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toThrow()
  })

  it('parses a real segwit deposit and re-serializes it byte for byte', () => {
    const tx = parseLtcTx(fromHex(fixture.hex))
    expect(ltcTxid(tx)).toBe(fixture.txid)
    expect(toHex(serializeLtcTx(tx))).toBe(fixture.hex)
    expect(() => parseLtcTx(fromHex(`${fixture.hex}00`))).toThrow(/trailing/)
  })

  it('proves the deposit into its block and the block under real scrypt work', () => {
    const headers = fixture.headers.map((h) => parseLtcHeader(fromHex(h)))
    expect(headers[0]!.hash).toBe(fixture.blockHash)
    expect(toHex(merkleRootFromProof(fixture.txid, fixture.proof.merkle, fixture.proof.pos))).toBe(toHex(headers[0]!.merkleRoot))
    expect(headers.every(meetsOwnTarget)).toBe(true)
  })

  it('signs P2WPKH spends that verify under the BIP143 digest', () => {
    const key = PrivateKey.fromRandom()
    const pubkey = Uint8Array.from(key.toPublicKey().encode(true) as number[])
    const unsigned: LtcTx = {
      version: 2,
      inputs: [
        { txid: 'ab'.repeat(32), vout: 0, script: new Uint8Array(), sequence: 0xfffffffd, witness: [] },
        { txid: 'cd'.repeat(32), vout: 3, script: new Uint8Array(), sequence: 0xfffffffd, witness: [] },
      ],
      outputs: [{ value: 50_000n, script: ltcOutputScript(fixture.address) }],
      locktime: 0,
    }
    const amounts = [40_000n, 20_000n]
    const signed = signP2wpkhInputs(unsigned, amounts.map(() => key), amounts)
    expect(ltcTxid(parseLtcTx(serializeLtcTx(signed)))).toBe(ltcTxid(signed))
    signed.inputs.forEach((input, vin) => {
      const [sig, pk] = input.witness
      expect(sig![sig!.length - 1]).toBe(1)
      expect(toHex(pk!)).toBe(toHex(pubkey))
      const digest = p2wpkhSighash(signed, vin, pubkey, amounts[vin]!)
      const parsed = Signature.fromDER(Array.from(sig!.subarray(0, -1)))
      expect(ECDSA.verify(new BigNumber(toHex(digest), 16), parsed, PublicKey.fromString(toHex(pubkey)))).toBe(true)
    })
    expect(p2wpkhAddress(pubkey).startsWith('ltc1q')).toBe(true)
  })

})

const reserve = parseLtcTx(fromHex(fixture.hex)).outputs[fixture.vout]!.script
const outpoint = { txid: fixture.txid, vout: fixture.vout }
const value = BigInt(fixture.value)
const proofOf = (over: Partial<LtcBurialProof> = {}): LtcBurialProof => ({
  tx: fixture.hex,
  path: fixture.proof.merkle,
  pos: fixture.proof.pos,
  height: fixture.height,
  header: fixture.headers[0]!,
  ...over,
})
const anchorOf = (answer: LtcBurialAnchor): LtcAnchor & { asked: Array<[number, string, number]> } => {
  const asked: Array<[number, string, number]> = []
  return {
    asked,
    check: async (height, hash, depth) => {
      asked.push([height, hash, depth])
      return answer
    },
  }
}
const BURIED = anchorOf({ kind: 'buried' })

describe('checkLtcBurial', () => {
  it('accepts a real deposit its anchor holds six deep, asking about the proof block', async () => {
    const anchor = anchorOf({ kind: 'buried' })
    expect(await checkLtcBurial(proofOf(), outpoint, reserve, value, anchor)).toEqual({ ok: true, litoshi: value })
    expect(anchor.asked).toEqual([[fixture.height, fixture.blockHash, LTC_BURIAL_DEPTH]])
  })

  it('is missing, not invalid, while the block is shallow or the chain cannot be read', async () => {
    expect(await checkLtcBurial(proofOf(), outpoint, reserve, value, anchorOf({ kind: 'shallow', confirmations: 3 }))).toMatchObject({ ok: false, reason: 'shallow', missing: true })
    expect(await checkLtcBurial(proofOf(), outpoint, reserve, value, anchorOf({ kind: 'unavailable', detail: 'offline' }))).toMatchObject({ ok: false, reason: 'unanchored', missing: true })
  })

  it('refuses a block the anchored chain does not hold', async () => {
    expect(await checkLtcBurial(proofOf(), outpoint, reserve, value, anchorOf({ kind: 'off-chain' }))).toMatchObject({ ok: false, reason: 'off-chain', missing: false })
  })

  it('refuses a mint larger than the deposit', async () => {
    expect(await checkLtcBurial(proofOf(), outpoint, reserve, value + 1n, BURIED)).toMatchObject({ ok: false, reason: 'under-backed' })
  })

  it('refuses an output that does not pay the reserve', async () => {
    expect(await checkLtcBurial(proofOf(), outpoint, p2wpkhScript(fromHex(`02${'11'.repeat(32)}`)), 1n, BURIED)).toMatchObject({ ok: false, reason: 'wrong-script' })
  })

  it('refuses bytes that do not hash to the txid', async () => {
    expect(await checkLtcBurial(proofOf(), { ...outpoint, txid: 'ee'.repeat(32) }, reserve, 1n, BURIED)).toMatchObject({ ok: false, reason: 'tx-mismatch' })
  })

  it('refuses a forged merkle path, or a header that is not the deposit block', async () => {
    const path = [...fixture.proof.merkle]
    path[0] = '00'.repeat(32)
    expect(await checkLtcBurial(proofOf({ path }), outpoint, reserve, 1n, BURIED)).toMatchObject({ ok: false, reason: 'merkle' })
    expect(await checkLtcBurial(proofOf({ header: fixture.headers[1]! }), outpoint, reserve, 1n, BURIED)).toMatchObject({ ok: false, reason: 'merkle' })
  })

  it('checks end to end against a header chain synced over the real blocks', async () => {
    const parsed = fixture.headers.map((h) => parseLtcHeader(fromHex(h)))
    const source = {
      tipHeight: async () => fixture.height + fixture.headers.length - 1,
      headerPage: async (top: number) =>
        fixture.headers.map((h, i) => ({ height: fixture.height + i, header: fromHex(h) })).filter((r) => r.height <= top && r.height > top - 10),
    } as unknown as LtcChain
    const chain = createLtcHeaderChain({
      source,
      checkpoint: { height: fixture.height - 1, hash: parsed[0]!.prevHash, bits: parsed[0]!.bits, time: parsed[0]!.time - 150, windowEnds: {} },
      now: () => parsed[parsed.length - 1]!.time * 1000,
      store: memoryLtcHeaderStore(),
    })
    expect(await checkLtcBurial(proofOf(), outpoint, reserve, value, chain)).toEqual({ ok: true, litoshi: value })
  })
})

describe('explorer reads', () => {
  function chainOf(over: Partial<LtcChain> & { tip?: number } = {}): LtcChain {
    const parsed = fixture.headers.map((h) => parseLtcHeader(fromHex(h)))
    return {
      tipHeight: async () => over.tip ?? fixture.height + fixture.headers.length - 1,
      blockHashAt: async (height) => parsed[height - fixture.height]!.hash,
      header: async (hash) => fromHex(fixture.headers[parsed.findIndex((h) => h.hash === hash)]!),
      headerPage: async () => [],
      txHex: async () => fixture.hex,
      txStatus: async () => ({ confirmed: true, blockHeight: fixture.height }),
      merkleProof: async () => ({ blockHeight: fixture.height, merkle: fixture.proof.merkle, pos: fixture.proof.pos }),
      addressUtxos: async () => [],
      broadcast: async () => '',
      feeRate: async () => 1,
      ...over,
    }
  }

  it('sees a deposit paying the reserve, and refuses one that does not', async () => {
    expect(await readLtcDeposit(chainOf(), outpoint, reserve)).toEqual({ kind: 'seen', ...outpoint, litoshi: value })
    expect(await readLtcDeposit(chainOf(), outpoint, p2wpkhScript(fromHex(`02${'11'.repeat(32)}`)))).toMatchObject({ kind: 'refuse', reason: 'wrong-script' })
  })

  it('builds a burial proof from the block an explorer names, never asking it how deep', async () => {
    const tipHeight = vi.fn(async () => fixture.height)
    const located = await locateLtcDeposit(chainOf({ tipHeight }), fixture.txid)
    expect(located).toEqual({ kind: 'in-block', proof: proofOf() })
    expect(tipHeight).not.toHaveBeenCalled()
    if (located.kind !== 'in-block') return
    expect(await checkLtcBurial(located.proof, outpoint, reserve, value, BURIED)).toEqual({ ok: true, litoshi: value })
    expect(await checkLtcBurial(located.proof, outpoint, reserve, value, anchorOf({ kind: 'shallow', confirmations: 4 }))).toMatchObject({
      ok: false,
      reason: 'shallow',
      confirmations: 4,
    })
  })

  it('reports an unconfirmed deposit, and one the explorers forget', async () => {
    expect(await locateLtcDeposit(chainOf({ txStatus: async () => ({ confirmed: false }) }), fixture.txid)).toEqual({ kind: 'unconfirmed' })
    const gone = chainOf({ txStatus: async () => Promise.reject(new Error('Litecoin explorer /tx/ab 404')) })
    expect(await locateLtcDeposit(gone, fixture.txid)).toEqual({ kind: 'gone' })
    await expect(locateLtcDeposit(chainOf({ txStatus: async () => Promise.reject(new Error('timeout')) }), fixture.txid)).rejects.toThrow(/timeout/)
  })

  it('refuses an explorer that answers with a different block', async () => {
    await expect(locateLtcDeposit(chainOf({ header: async () => fromHex(fixture.headers[1]!) }), fixture.txid)).rejects.toThrow(/does not hash/)
  })
})
