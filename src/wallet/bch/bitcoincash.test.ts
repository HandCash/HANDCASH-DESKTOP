import { BigNumber, ECDSA, PrivateKey, PublicKey, Signature } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { bip143Sighash, fromHex, hash160, ltcTxid, merkleRootFromProof, parseLtcHeader, sameBytes, targetFromBits, toHex, u32le } from '../ltc/litecoin'
import {
  ASERT_ANCHOR,
  bchCoinAddress,
  bchOutputScript,
  decodeCashAddr,
  encodeCashAddr,
  formatBch,
  nextBchBits,
  parseBchTx,
  serializeBchTx,
  sha256dPowHash,
  signP2pkhForkIdInputs,
} from './bitcoincash'
import fixture from './fixtures/chain.json'

const headersOf = (hex: string, start: number) =>
  Array.from({ length: hex.length / 160 }, (_, i) => ({ height: start + i, header: parseLtcHeader(fromHex(hex.slice(i * 160, i * 160 + 160))) }))

describe('CashAddr', () => {
  const hash = fromHex('76a04053bda0a88bda5177b86a15c3b29f559873')

  it('matches the specification test vectors', () => {
    expect(encodeCashAddr('p2pkh', hash)).toBe('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')
    expect(encodeCashAddr('p2sh', hash)).toBe('bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq')
  })

  it('round-trips, with or without the prefix, in either single case', () => {
    const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
    for (const form of [address, address.slice('bitcoincash:'.length), address.toUpperCase()]) {
      const decoded = decodeCashAddr(form)
      expect(decoded.kind).toBe('p2pkh')
      expect(toHex(decoded.hash)).toBe(toHex(hash))
    }
    const big = new Uint8Array(32).fill(7)
    expect(toHex(decodeCashAddr(encodeCashAddr('p2sh', big)).hash)).toBe(toHex(big))
    expect(decodeCashAddr(encodeCashAddr('p2pkh', hash, { tokenAware: true })).tokenAware).toBe(true)
  })

  it('refuses bad checksums, mixed case, other networks and legacy addresses', () => {
    const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
    expect(() => decodeCashAddr(address.replace(/a$/, 'q'))).toThrow(/checksum/)
    expect(() => decodeCashAddr('bitcoincash:Qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')).toThrow(/mixed case/)
    expect(() => decodeCashAddr('bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')).toThrow(/mainnet/)
    expect(() => decodeCashAddr('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu')).toThrow()
    expect(() => bchOutputScript('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9')).toThrow()
  })

  it('locks P2PKH, P2SH and P2SH32 scripts', () => {
    expect(toHex(bchOutputScript(encodeCashAddr('p2pkh', hash)))).toBe(`76a914${toHex(hash)}88ac`)
    expect(toHex(bchOutputScript(encodeCashAddr('p2sh', hash)))).toBe(`a914${toHex(hash)}87`)
    const h32 = new Uint8Array(32).fill(1)
    expect(toHex(bchOutputScript(encodeCashAddr('p2sh', h32)))).toBe(`aa20${toHex(h32)}87`)
  })
})

describe('ASERT', () => {
  const anchor = headersOf(fixture.anchor.hex, fixture.anchor.start)
  const recent = headersOf(fixture.recent.hex, fixture.recent.start)

  it('agrees with the anchor block on chain', () => {
    const [parent, block] = anchor
    expect(block!.height).toBe(ASERT_ANCHOR.height)
    expect(block!.header.bits).toBe(ASERT_ANCHOR.bits)
    expect(parent!.header.time).toBe(ASERT_ANCHOR.parentTime)
  })

  it('gives every recent block exactly the bits it carries', () => {
    for (let i = 1; i < recent.length; i++) {
      expect(nextBchBits(recent[i]!.height, recent[i - 1]!.header.time), `block ${recent[i]!.height}`).toBe(recent[i]!.header.bits)
    }
  })

  it('every recent header links and meets its target by double SHA-256', () => {
    for (let i = 1; i < recent.length; i++) {
      const { header } = recent[i]!
      expect(header.prevHash).toBe(recent[i - 1]!.header.hash)
      expect(sha256dPowHash(header.raw) <= targetFromBits(header.bits)!).toBe(true)
    }
  })
})

describe('transactions', () => {
  it('reads a real transaction and proves it into its block', () => {
    const tx = parseBchTx(fromHex(fixture.tx.raw))
    expect(ltcTxid(tx)).toBe(fixture.tx.txid)
    expect(toHex(serializeBchTx(tx))).toBe(fixture.tx.raw)
    const block = headersOf(fixture.recent.hex, fixture.recent.start).find((h) => h.height === fixture.tx.height)!
    expect(sameBytes(merkleRootFromProof(fixture.tx.txid, fixture.tx.merkle, fixture.tx.pos), block.header.merkleRoot)).toBe(true)
  })

  it('refuses a segwit marker', () => {
    const raw = fromHex(fixture.tx.raw)
    const marked = Uint8Array.from([...raw.slice(0, 4), 0x00, 0x01, ...raw.slice(4)])
    expect(() => parseBchTx(marked)).toThrow(/segwit/)
  })

  it('computes the digest a real mainnet P2PKH spend signed', () => {
    const tx = parseBchTx(fromHex(fixture.spend.raw))
    expect(ltcTxid(tx)).toBe(fixture.spend.txid)
    const script = tx.inputs[fixture.spend.vin]!.script
    const der = script.slice(1, 1 + script[0]! - 1)
    expect(script[script[0]!]).toBe(0x41)
    const pubkey = script.slice(script[0]! + 2)
    expect(toHex(bchOutputScript(bchCoinAddress(pubkey)))).toBe(fixture.spend.prevScript)
    const digest = bip143Sighash(tx, fixture.spend.vin, pubkey, BigInt(fixture.spend.amount), 0x41)
    const ok = ECDSA.verify(new BigNumber(toHex(digest), 16), Signature.fromDER(Array.from(der)), PublicKey.fromString(toHex(pubkey)))
    expect(ok).toBe(true)
    const wrongType = bip143Sighash(tx, fixture.spend.vin, pubkey, BigInt(fixture.spend.amount), 0x01)
    expect(ECDSA.verify(new BigNumber(toHex(wrongType), 16), Signature.fromDER(Array.from(der)), PublicKey.fromString(toHex(pubkey)))).toBe(false)
  })

  it('signs P2PKH inputs under SIGHASH_ALL|FORKID into the scriptSig', () => {
    const key = PrivateKey.fromRandom()
    const pubkey = Uint8Array.from(key.toPublicKey().encode(true) as number[])
    const tx = {
      version: 2,
      inputs: [{ txid: 'ab'.repeat(32), vout: 1, script: new Uint8Array(), sequence: 0xffffffff, witness: [] }],
      outputs: [{ value: 10_000n, script: bchOutputScript(bchCoinAddress(pubkey)) }],
      locktime: 0,
    }
    const signed = signP2pkhForkIdInputs(tx, [key], [20_000n])
    const script = signed.inputs[0]!.script
    const sigLen = script[0]!
    expect(script[sigLen]).toBe(0x41)
    expect(toHex(script.slice(sigLen + 2))).toBe(toHex(pubkey))
    const digest = bip143Sighash(signed, 0, pubkey, 20_000n, 0x41)
    expect(ECDSA.verify(new BigNumber(toHex(digest), 16), Signature.fromDER(Array.from(script.slice(1, sigLen))), key.toPublicKey())).toBe(true)
    expect(signed.inputs[0]!.witness).toEqual([])
    expect(toHex(serializeBchTx(signed)).slice(0, 8)).toBe(toHex(u32le(2)))
    expect(toHex(hash160(pubkey))).toBe(toHex(decodeCashAddr(bchCoinAddress(pubkey)).hash))
  })

  it('formats amounts', () => {
    expect(formatBch(123_450_000n)).toBe('1.2345')
    expect(formatBch(546n)).toBe('0.00000546')
    expect(formatBch(200_000_000n)).toBe('2')
  })
})
