import { LockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { buildOnesatFtMintLockingScript } from './onesatFtInscribe'
import { hasOrdEnvelope, parseOrdEnvelope } from './ordinalOwnership'
import {
  BSV21_TAG_HEX,
  decodeBsv21Binary,
  encodeBsv21Binary,
  tokenIdFromWire,
  tokenIdToWire,
} from './bsv21Binary'

const P2PKH_REST = `76a914${'11'.repeat(20)}88ac`
const TOKEN_ID = `${'00112233445566778899aabbccddeeff'.repeat(2)}_7`

describe('bsv21Binary encode/decode', () => {
  it('round-trips a fixed-supply deploy with CBOR payload and remainder', () => {
    const icon = Uint8Array.from([1, 2, 3, 4])
    const script = encodeBsv21Binary({
      amount: 21000000n,
      payload: { sym: 'GOLD', dec: 8, icon },
      rest: P2PKH_REST,
    })
    const hex = script.toHex().toLowerCase()
    expect(hex.startsWith('05' + BSV21_TAG_HEX)).toBe(true)
    expect(hex.endsWith(P2PKH_REST)).toBe(true)

    const decoded = decodeBsv21Binary(hex)
    expect(decoded).not.toBeNull()
    expect(decoded).toMatchObject({
      role: 'deploy',
      amount: 21000000n,
      restScriptHex: P2PKH_REST,
    })
    expect(decoded?.tokenId).toBeUndefined()
    expect(decoded?.payload?.sym).toBe('GOLD')
    expect(decoded?.payload?.dec).toBe(8)
    expect(decoded?.payload?.icon).toEqual(icon)

    const again = decodeBsv21Binary(
      encodeBsv21Binary({
        amount: decoded!.amount,
        payload: decoded!.payload,
        rest: decoded!.restScriptHex,
      }),
    )
    expect(again).toEqual(decoded)
  })

  it('encodes a transfer with a 36-byte token id and empty payload', () => {
    const wire = tokenIdToWire(TOKEN_ID)
    expect(wire).toHaveLength(36)
    expect(tokenIdFromWire(wire)).toBe(TOKEN_ID)
    // Display txid is reversed onto the wire.
    const display = TOKEN_ID.slice(0, 64)
    const expectedInternal = display
      .match(/../g)!
      .map((b) => Number.parseInt(b, 16))
      .reverse()
    expect(Array.from(wire.slice(0, 32))).toEqual(expectedInternal)
    expect(Array.from(wire.slice(32))).toEqual([7, 0, 0, 0])

    const script = encodeBsv21Binary({
      tokenId: TOKEN_ID,
      amount: 5000,
      rest: P2PKH_REST,
    })
    const decoded = decodeBsv21Binary(script)
    expect(decoded).toMatchObject({
      role: 'value',
      tokenId: TOKEN_ID,
      amount: 5000n,
      restScriptHex: P2PKH_REST,
    })
    expect(decoded?.tokenIdWire).toEqual(wire)
    expect(decoded?.payload).toBeUndefined()
  })

  it('accepts dotted token ids and leaves a non-P2PKH remainder', () => {
    const rest = '51'
    const decoded = decodeBsv21Binary(
      encodeBsv21Binary({
        tokenId: TOKEN_ID.replace('_', '.'),
        amount: '17',
        rest,
      }),
    )
    expect(decoded).toMatchObject({
      role: 'value',
      tokenId: TOKEN_ID,
      amount: 17n,
      restScriptHex: rest,
    })
  })

  it('rejects non-BSV21 scripts', () => {
    expect(decodeBsv21Binary(P2PKH_REST)).toBeNull()
    expect(decodeBsv21Binary('51')).toBeNull()
    expect(decodeBsv21Binary('')).toBeNull()
    expect(
      decodeBsv21Binary(
        LockingScript.fromASM('OP_DUP OP_HASH160 OP_0 OP_EQUALVERIFY OP_CHECKSIG'),
      ),
    ).toBeNull()
  })

  it('does not classify a 162 script as an ord / 1sat envelope', () => {
    const script = encodeBsv21Binary({
      amount: 100,
      payload: { sym: 'GOLD' },
      rest: P2PKH_REST,
    }).toHex()
    expect(parseOrdEnvelope(script)).toBeNull()
    expect(hasOrdEnvelope(script)).toBe(false)

    const onesat = buildOnesatFtMintLockingScript({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sym: 'GOLD',
      amt: 100,
      maxSupply: 100,
    }).lockingScript
    expect(hasOrdEnvelope(onesat)).toBe(true)
    expect(decodeBsv21Binary(onesat)).toBeNull()
  })

  it('refuses to encode authority (amount 0)', () => {
    expect(() => encodeBsv21Binary({ amount: 0 })).toThrow(/authority/)
    expect(() =>
      encodeBsv21Binary({ tokenId: TOKEN_ID, amount: 0n }),
    ).toThrow(/authority/)
  })

  it('rejects a non-CBOR payload push', () => {
    // BSV21 OP_0 OP_2DROP OP_1 <"nope"> OP_2DROP
    const hex =
      '05' +
      BSV21_TAG_HEX +
      '00' +
      '6d' +
      '51' +
      '04' +
      [...new TextEncoder().encode('nope')].map((b) => b.toString(16).padStart(2, '0')).join('') +
      '6d'
    expect(decodeBsv21Binary(hex)).toBeNull()
  })
})
