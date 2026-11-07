import { createECDH, createHash, createPublicKey, verify as nodeVerify } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CURVE, Signature } from '@noble/secp256k1'
import { BigNumber, ECDSA, KeyDeriver, PrivateKey, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { decodeHex, encodeHex } from '../../meridian/encoding'
import { CoinPrivateKey, coinPublicKey, deriveCoinPrivateKey, deriveCoinPublicKey, deriveInvoicePrivateKey, signCoinDigest, verifyCoinDigest } from './coinCrypto'

// Public synthetic keys only. SDK is a test oracle, never a runtime fallback.
const root = CoinPrivateKey.fromHex('11'.repeat(32))
const legacy = PrivateKey.fromHex(root.toHex())
const peer = PrivateKey.fromHex('33'.repeat(32))
const paths = [
  ['wltc reserve', '1f5c57e2fe75c32612bfe0f467d41d7a0b62dd30f016f14fa3f32ef2357578f0'],
  ['btc coin', 'cc772b2f9244754ceb6fc10f10761eff32ed8ab714c64d2446ddcf06ac56ac35'],
  ['bch coin', 'f8d61ba7b5c6a3101e750bec6effb2001f19a6ebe0f94018aa3fd493728fdbd7'],
  ['doge coin', 'c01e4444a8357298fa6311d80cb25668c9f0161785184a8dd92529148a6486df'],
  ['arc usd', 'fc7973577a39d802f16f73d28f66c857534bfd7becf38325bb7f829b0c20b007'],
] as const

describe('separately licensed coin crypto adapters', () => {
  it.each(paths)('preserves the recorded legacy %s self key', (name, hex) => {
    expect(deriveCoinPrivateKey(root, [2, name], '1').toHex()).toBe(hex)
  })

  it('matches the published BRC-42 Key Derivation mathematical vector', () => {
    // https://github.com/bitcoin-sv/BRCs/blob/d403af3417815919218468556503b627cd272abc/key-derivation/0042.md
    // Compatibility evidence only; documentation rights remain a legal-review gate.
    const recipient = new CoinPrivateKey('6a1751169c111b4667a6539ee1be6b7cd9f6e9c8fe011a5f2fe31e03a15e0ede')
    expect(deriveInvoicePrivateKey(recipient, '033f9160df035156f1c48e75eae99914fa1a1546bec19781e8eddb900200bff9d1', 'f3WCaUmnN9U=').toHex())
      .toBe('761656715bbfa172f8f9f58f5af95d9d0dfd69014cfdcacc9a245a10ff8893ef')
  })

  it.each(['self', 'anyone', peer.toPublicKey().toString()])('matches legacy derivation for %s, including payment and swap paths', (counterparty) => {
    for (const name of [...paths.map(([name]) => name), 'ltc payment', 'btc payment', 'bch payment', 'doge payment', 'swap settle', 'swap order']) {
      for (const id of ['1', '00'.repeat(32), 'invoice/é/backup']) {
        const protocol: [2, string] = [2, name]
        const expected = new KeyDeriver(legacy).derivePrivateKey(protocol, id, counterparty)
        expect(deriveCoinPrivateKey(root, protocol, id, counterparty).toHex()).toBe(expected.toHex().padStart(64, '0'))
        expect(encodeHex(deriveCoinPublicKey(root, protocol, id, counterparty)))
          .toBe(new KeyDeriver(legacy).derivePublicKey(protocol, id, counterparty).toString())
      }
    }
  })

  it('preserves sender/recipient reciprocity and serialized-root recovery', () => {
    const protocol: [2, string] = [2, 'btc payment']
    const recipient = new CoinPrivateKey(peer.toHex())
    const sent = deriveCoinPublicKey(root, protocol, 'receipt-1', peer.toPublicKey().toString())
    const restored = CoinPrivateKey.fromHex(root.toHex())
    const paid = deriveCoinPrivateKey(recipient, protocol, 'receipt-1', encodeHex(coinPublicKey(restored)))
    expect(coinPublicKey(paid)).toEqual(sent)
    expect(deriveCoinPrivateKey(restored, [2, 'btc coin'], '1').toHex()).toBe(paths[1][1])
  })

  it('uses only serialized bytes, not SDK methods, at the custody boundary', () => {
    const key = { toHex: () => root.toHex(), toPublicKey: () => { throw Error('must not delegate') } }
    expect(coinPublicKey(key)).toEqual(coinPublicKey(root))
    expect(deriveCoinPrivateKey(key, [2, 'btc coin'], '1').toHex()).toBe(paths[1][1])
  })

  it('matches independent Node secp256k1 public keys and verifies with OpenSSL', () => {
    const ecdh = createECDH('secp256k1')
    ecdh.setPrivateKey(Buffer.from(root.toHex(), 'hex'))
    expect(encodeHex(coinPublicKey(root))).toBe(ecdh.getPublicKey('hex', 'compressed'))
    const message = new TextEncoder().encode('offline coin compatibility')
    const digest = new Uint8Array(createHash('sha256').update(message).digest())
    const sig = signCoinDigest(digest, root)
    const spki = Buffer.concat([Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'), Buffer.from(coinPublicKey(root, false))])
    expect(nodeVerify('sha256', message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig)).toBe(true)
  })

  it('preserves deterministic low-S DER bytes and rejects changed messages', () => {
    const digest = decodeHex('22'.repeat(32))
    const signature = signCoinDigest(digest, root)
    expect(encodeHex(signature)).toBe('3045022100cfd18ee918d6729134adbc61212142cf71fcf186dfc3123cfca8f7062e0fad5a0220703cc467d9857349ddb6e148bd1663f5050f3f6b9d788d64349c357f14eb4a5f')
    expect(encodeHex(signature)).toBe(Utils.toHex(ECDSA.sign(new BigNumber(Array.from(digest)), legacy, true).toDER() as number[]))
    expect(verifyCoinDigest(digest, coinPublicKey(root), signature)).toBe(true)
    expect(verifyCoinDigest(decodeHex('23'.repeat(32)), coinPublicKey(root), signature)).toBe(false)
    expect(() => signCoinDigest(new Uint8Array(31), root)).toThrow()
  })

  it('matches legacy RFC6979 signatures at scalar and digest boundaries', () => {
    for (const hex of ['1', '2', (CURVE.n - 1n).toString(16), root.toHex()]) {
      const key = new CoinPrivateKey(hex)
      for (const digestHex of ['00'.repeat(32), 'ff'.repeat(32), CURVE.n.toString(16)]) {
        const digest = decodeHex(digestHex)
        const expected = ECDSA.sign(new BigNumber(Array.from(digest)), PrivateKey.fromHex(key.toHex()), true)
        const actual = signCoinDigest(digest, key)
        expect(encodeHex(actual)).toBe(Utils.toHex(expected.toDER() as number[]))
        expect(verifyCoinDigest(digest, coinPublicKey(key), actual)).toBe(true)
      }
    }
  })

  it('still accepts valid historical high-S signatures', () => {
    const digest = decodeHex('22'.repeat(32))
    const low = ECDSA.sign(new BigNumber(Array.from(digest)), legacy, true)
    const r = BigInt('0x' + low.r.toString(16))
    const s = CURVE.n - BigInt('0x' + low.s.toString(16))
    const integer = (n: bigint) => {
      let hex = n.toString(16)
      if (hex.length % 2) hex = '0' + hex
      if (parseInt(hex.slice(0, 2), 16) & 128) hex = '00' + hex
      return '02' + (hex.length / 2).toString(16).padStart(2, '0') + hex
    }
    const body = integer(r) + integer(s)
    const der = decodeHex('30' + (body.length / 2).toString(16) + body)
    expect(new Signature(r, s).hasHighS()).toBe(true)
    expect(verifyCoinDigest(digest, coinPublicKey(root), der)).toBe(true)
  })

  it('keeps SDK runtime imports out of the other-coin modules', () => {
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) scan(path)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          // legChains retains SDK BEEF/P2PKH only for its explicit BSV paths.
          if (path.endsWith(join('swap', 'legChains.ts'))) continue
          expect(readFileSync(path, 'utf8'), path).not.toMatch(/@bsv\/sdk/)
        }
      }
    }
    for (const dir of ['primitives', 'coins', 'ltc', 'btc', 'bch', 'doge', 'arcUsdc', 'swap']) scan(join('src/wallet', dir))
  })

  it.each(['', '0', 'ff'.repeat(32), '01'.repeat(33), 'zz'])('rejects invalid private key %s', (hex) => {
    expect(() => new CoinPrivateKey(hex)).toThrow()
  })

  it.each(['', '3006020100020100', '3006020180020101', '300702020001020101', '300602010102010100'])('rejects malformed or zero DER integers: %s', (hex) => {
    expect(verifyCoinDigest(decodeHex('22'.repeat(32)), coinPublicKey(root), decodeHex(hex))).toBe(false)
  })

  it('rejects invalid peers and derivation domains', () => {
    expect(() => deriveCoinPrivateKey(root, [2, 'btc coin'], '1', '02' + 'ff'.repeat(32))).toThrow()
    for (const name of ['tiny', 'btc  coin', 'btc protocol', 'btc/coin']) {
      expect(() => deriveCoinPrivateKey(root, [2, name], '1')).toThrow()
    }
    expect(() => deriveCoinPrivateKey(root, [2, 'btc coin'], '')).toThrow()
    expect(() => deriveCoinPrivateKey(root, [2, 'btc coin'], 'é'.repeat(517))).toThrow()
  })
})
