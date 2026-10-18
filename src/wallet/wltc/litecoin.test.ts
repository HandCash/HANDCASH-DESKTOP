import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
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
import { checkHeaderRun, confirmationsFor, verifyLtcDeposit } from './verify'

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
    expect(checkHeaderRun(headers)).toEqual({ ok: true })
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
    const signed = signP2wpkhInputs(unsigned, key, amounts)
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

  it('buries bigger deposits deeper', () => {
    expect(confirmationsFor(1n)).toBe(6)
    expect(confirmationsFor(600_000_000n)).toBe(6)
    expect(confirmationsFor(1_000_000_001n)).toBe(11)
    expect(confirmationsFor(10n ** 15n)).toBe(576)
  })
})

describe('verifyLtcDeposit', () => {
  const headers = fixture.headers.map((h) => parseLtcHeader(fromHex(h)))
  const reserve = parseLtcTx(fromHex(fixture.hex)).outputs[fixture.vout]!.script

  function chainOf(over: Partial<LtcChain> & { tip?: number; headerList?: string[] } = {}): LtcChain {
    const list = over.headerList ?? fixture.headers
    const parsed = list.map((h) => parseLtcHeader(fromHex(h)))
    return {
      tipHeight: async () => over.tip ?? fixture.height + fixture.headers.length - 1,
      blockHashAt: async (height) => parsed[height - fixture.height]!.hash,
      header: async (hash) => fromHex(list[parsed.findIndex((h) => h.hash === hash)]!),
      txHex: async () => fixture.hex,
      txStatus: async () => ({ confirmed: true, blockHeight: fixture.height }),
      merkleProof: async () => ({ blockHeight: fixture.height, merkle: fixture.proof.merkle, pos: fixture.proof.pos }),
      addressUtxos: async () => [],
      broadcast: async () => '',
      feeRate: async () => 1,
      ...over,
    }
  }
  const outpoint = { txid: fixture.txid, vout: fixture.vout }

  it('credits a real deposit once it is buried', async () => {
    const verdict = await verifyLtcDeposit(chainOf(), outpoint, reserve)
    expect(verdict).toMatchObject({ kind: 'credit', litoshi: BigInt(fixture.value), height: fixture.height })
  })

  it('waits while the deposit is shallow or unconfirmed', async () => {
    expect(await verifyLtcDeposit(chainOf({ tip: fixture.height + 2 }), outpoint, reserve)).toMatchObject({ kind: 'pending', confirmations: 3, needed: 6 })
    expect(await verifyLtcDeposit(chainOf({ txStatus: async () => ({ confirmed: false }) }), outpoint, reserve)).toMatchObject({ kind: 'pending', confirmations: 0 })
  })

  it('refuses an output that does not pay the reserve', async () => {
    expect(await verifyLtcDeposit(chainOf(), outpoint, p2wpkhScript(fromHex(`02${'11'.repeat(32)}`)))).toMatchObject({ kind: 'refuse', reason: 'wrong-script' })
  })

  it('refuses bytes that do not hash to the txid', async () => {
    const other = { ...outpoint, txid: 'ee'.repeat(32) }
    expect(await verifyLtcDeposit(chainOf(), other, reserve)).toMatchObject({ kind: 'refuse', reason: 'tx-mismatch' })
  })

  it('refuses a forged merkle path', async () => {
    const merkle = [...fixture.proof.merkle]
    merkle[0] = '00'.repeat(32)
    const chain = chainOf({ merkleProof: async () => ({ blockHeight: fixture.height, merkle, pos: fixture.proof.pos }) })
    expect(await verifyLtcDeposit(chain, outpoint, reserve)).toMatchObject({ kind: 'refuse', reason: 'merkle' })
  })

  it('refuses a header without its proof of work', async () => {
    const forged = [...fixture.headers]
    forged[3] = `${forged[3]!.slice(0, 152)}00000000`
    expect(await verifyLtcDeposit(chainOf({ headerList: forged }), outpoint, reserve)).toMatchObject({ kind: 'refuse', reason: 'pow' })
    const run = checkHeaderRun(forged.slice(3, 4).map((h) => parseLtcHeader(fromHex(h))))
    expect(run).toMatchObject({ ok: false, reason: 'pow' })
  })

  it('refuses headers that do not chain', () => {
    expect(checkHeaderRun([headers[0]!, headers[2]!])).toMatchObject({ ok: false, reason: 'chain-link' })
  })

  it('refuses headers easier than the difficulty floor', async () => {
    expect(await verifyLtcDeposit(chainOf(), outpoint, reserve, { floor: 1n << 190n })).toMatchObject({ kind: 'refuse', reason: 'difficulty-floor' })
  })

  it('refuses an explorer that answers with a different block', async () => {
    const chain = chainOf({ header: async () => fromHex(fixture.headers[1]!) })
    expect(await verifyLtcDeposit(chain, outpoint, reserve)).toMatchObject({ kind: 'refuse', reason: 'header-hash' })
  })
})
