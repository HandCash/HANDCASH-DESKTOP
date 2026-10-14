import { LockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { buildRetiredFungibleOrigin } from '../retiredFungible.testFixtures'
import { hasOrdEnvelope, parseOrdEnvelope } from '../ordinalOwnership'
import {
  BSV21_TAG_HEX,
  decodeBrc162Payload,
  decodeBsv21Binary,
  decodeDeployCbor,
  encodeBsv21Binary,
  iconOutpointFromPayload,
  tokenIdFromCanonicalWire,
  tokenIdFromWire,
  tokenIdToCanonicalWire,
  tokenIdToWire,
} from './decode162'

const P2PKH_REST = `76a914${'11'.repeat(20)}88ac`
const TXID = '00112233445566778899aabbccddeeff'.repeat(2)
const TOKEN_ID = `${TXID}_7`
const TOKEN_ID_V0 = `${TXID}_0`
const INTERNAL_TXID = TXID.match(/../g)!.reverse().join('')
const hexBytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
const PNG = { mediaType: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4]) }

describe('BRC-162 current layout', () => {
  it('round-trips a deploy with an embedded icon and no tag', () => {
    const script = encodeBsv21Binary({
      amount: 21000000n,
      payload: { sym: 'GOLD', dec: 8, iconImage: PNG },
      rest: P2PKH_REST,
    })
    const hex = script.toHex()
    expect(hex.startsWith('00')).toBe(true)
    expect(hex.includes(BSV21_TAG_HEX)).toBe(false)
    const decoded = decodeBsv21Binary(hex)
    expect(decoded).toMatchObject({
      layout: 'brc162',
      role: 'deploy',
      amount: 21000000n,
      restScriptHex: P2PKH_REST,
      payload: { sym: 'GOLD', dec: 8, iconImage: PNG },
    })
    expect(decoded?.tokenId).toBeUndefined()
    expect(
      decodeBsv21Binary(
        encodeBsv21Binary({ amount: decoded!.amount, payload: decoded!.payload, rest: P2PKH_REST }),
      ),
    ).toEqual(decoded)
  })

  it('writes a 32-byte id for an output-0 deploy and 36 bytes otherwise', () => {
    expect(tokenIdToCanonicalWire(TOKEN_ID_V0)).toHaveLength(32)
    expect(tokenIdToCanonicalWire(TOKEN_ID)).toHaveLength(36)

    const v0 = encodeBsv21Binary({ tokenId: TOKEN_ID_V0, amount: 5000, rest: P2PKH_REST }).toHex()
    expect(v0).toBe(`20${INTERNAL_TXID}0288136d${P2PKH_REST}`)
    expect(decodeBsv21Binary(v0)).toMatchObject({
      layout: 'brc162',
      role: 'value',
      tokenId: TOKEN_ID_V0,
      amount: 5000n,
      restScriptHex: P2PKH_REST,
    })

    const v7 = encodeBsv21Binary({ tokenId: TOKEN_ID, amount: 5000, rest: P2PKH_REST }).toHex()
    expect(v7).toBe(`24${INTERNAL_TXID}070000000288136d${P2PKH_REST}`)
    expect(decodeBsv21Binary(v7)?.tokenId).toBe(TOKEN_ID)
  })

  it('rejects a 36-byte id that names output 0', () => {
    expect(tokenIdFromCanonicalWire(hexBytes(`${INTERNAL_TXID}00000000`))).toBeNull()
    expect(decodeBsv21Binary(`24${INTERNAL_TXID}00000000516d${P2PKH_REST}`)).toBeNull()
  })

  it('rejects a non-minimal amount', () => {
    expect(decodeBsv21Binary(`0001016d${P2PKH_REST}`)).toBeNull()
  })

  it('marks a remainder that starts with <push> OP_DROP with OP_0 OP_DROP', () => {
    const rest = `010175${P2PKH_REST}`
    const hex = encodeBsv21Binary({ tokenId: TOKEN_ID, amount: 17, rest }).toHex()
    expect(hex).toBe(`24${INTERNAL_TXID}0700000001116d0075${rest}`)
    expect(decodeBsv21Binary(hex)).toMatchObject({ amount: 17n, restScriptHex: rest })
    expect(decodeBsv21Binary(hex)?.payload).toBeUndefined()
  })

  it('keeps an output with an invalid payload a token without attributes', () => {
    const decoded = decodeBsv21Binary(`00516d04deadbeef75${P2PKH_REST}`)
    expect(decoded).toMatchObject({ layout: 'brc162', role: 'deploy', amount: 1n, restScriptHex: P2PKH_REST })
    expect(decoded?.payload).toBeUndefined()
  })

  it('refuses pointer icons and required processing when encoding', () => {
    expect(() =>
      encodeBsv21Binary({ amount: 1, payload: { icon: Uint8Array.from([1, 0, 0, 0]) } }),
    ).toThrow(/embedded/)
    expect(() => encodeBsv21Binary({ amount: 1, payload: { requiresProcessing: true } })).toThrow(
      /required processing/,
    )
  })

  it('names the deploy itself as the outpoint of an embedded icon', () => {
    expect(iconOutpointFromPayload({ iconImage: PNG }, TOKEN_ID_V0)).toBe(TOKEN_ID_V0)
  })

  it('does not classify a token script as an ord / 1sat envelope', () => {
    const script = encodeBsv21Binary({ amount: 100, payload: { sym: 'GOLD' }, rest: P2PKH_REST }).toHex()
    expect(parseOrdEnvelope(script)).toBeNull()
    expect(hasOrdEnvelope(script)).toBe(false)
    const onesat = buildRetiredFungibleOrigin({
      address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      sym: 'GOLD',
      amt: 100,
      maxSupply: 100,
    }).lockingScript
    expect(hasOrdEnvelope(onesat)).toBe(true)
    expect(decodeBsv21Binary(onesat)).toBeNull()
  })

  it('rejects scripts without a token prefix', () => {
    expect(decodeBsv21Binary(P2PKH_REST)).toBeNull()
    expect(decodeBsv21Binary('51')).toBeNull()
    expect(decodeBsv21Binary('')).toBeNull()
    expect(
      decodeBsv21Binary(LockingScript.fromASM('OP_DUP OP_HASH160 OP_0 OP_EQUALVERIFY OP_CHECKSIG')),
    ).toBeNull()
  })

  it('refuses to encode authority (amount 0)', () => {
    expect(() => encodeBsv21Binary({ amount: 0 })).toThrow(/authority/)
    expect(() => encodeBsv21Binary({ tokenId: TOKEN_ID, amount: 0n })).toThrow(/authority/)
  })
})

describe('decodeBrc162Payload — strict DAG-CBOR', () => {
  it('reads sym, dec and an [mediaType, bytes] icon', () => {
    expect(decodeBrc162Payload(hexBytes('a2' + '63646563' + '02' + '6373796d' + '64474f4c44'))).toEqual({
      sym: 'GOLD',
      dec: 2,
    })
    expect(
      decodeBrc162Payload(hexBytes('a1' + '6469636f6e' + '82' + '69696d6167652f706e67' + '4401020304')),
    ).toEqual({ iconImage: PNG })
  })

  it('ignores unknown keys', () => {
    expect(decodeBrc162Payload(hexBytes('a2' + '6178' + '01' + '6373796d' + '64474f4c44'))).toEqual({
      sym: 'GOLD',
    })
  })

  it.each([
    ['keys out of length-first order', 'a2' + '6373796d' + '64474f4c44' + '6178' + '01'],
    ['duplicate keys', 'a2' + '6373796d' + '6141' + '6373796d' + '6142'],
    ['a non-text key', 'a1' + '01' + '02'],
    ['a non-minimal length', 'a1' + '6373796d' + '7804' + '474f4c44'],
    ['an indefinite-length map', 'bf' + '6373796d' + '64474f4c44' + 'ff'],
    ['a half-precision float', 'a1' + '6166' + 'f93e00'],
    ['a tag other than 42', 'a1' + '6373796d' + 'c100'],
    ['invalid UTF-8', 'a1' + '6373796d' + '62c328'],
    ['trailing bytes', 'a1' + '6373796d' + '64474f4c44' + '00'],
    ['a non-map top level', '83010203'],
  ])('carries no attributes for %s', (_label, hex) => {
    expect(decodeBrc162Payload(hexBytes(hex))).toEqual({})
  })

  it('flags a non-empty req and ignores an empty one', () => {
    expect(decodeBrc162Payload(hexBytes('a1' + '63726571' + '80'))).toEqual({})
    expect(decodeBrc162Payload(hexBytes('a1' + '63726571' + 'a0'))).toEqual({})
    expect(decodeBrc162Payload(hexBytes('a1' + '63726571' + '8101'))).toEqual({ requiresProcessing: true })
    expect(decodeBrc162Payload(hexBytes('a1' + '63726571' + '01'))).toEqual({ requiresProcessing: true })
  })
})

describe('draft-tagged layout (held tokens)', () => {
  it('round-trips a tagged deploy with a pointer icon', () => {
    const icon = Uint8Array.from([1, 0, 0, 0])
    const script = encodeBsv21Binary({
      layout: 'draft-tagged',
      amount: 21000000n,
      payload: { sym: 'GOLD', dec: 8, icon },
      rest: P2PKH_REST,
    })
    const hex = script.toHex()
    expect(hex.startsWith('05' + BSV21_TAG_HEX)).toBe(true)
    const decoded = decodeBsv21Binary(hex)
    expect(decoded).toMatchObject({
      layout: 'draft-tagged',
      role: 'deploy',
      amount: 21000000n,
      restScriptHex: P2PKH_REST,
      payload: { sym: 'GOLD', dec: 8, icon },
    })
    expect(
      decodeBsv21Binary(
        encodeBsv21Binary({
          layout: 'draft-tagged',
          amount: decoded!.amount,
          payload: decoded!.payload,
          rest: P2PKH_REST,
        }),
      ),
    ).toEqual(decoded)
  })

  it('writes the full 36-byte id even for an output-0 deploy', () => {
    const wire = tokenIdToWire(TOKEN_ID_V0)
    expect(tokenIdFromWire(wire)).toBe(TOKEN_ID_V0)
    const hex = encodeBsv21Binary({
      layout: 'draft-tagged',
      tokenId: TOKEN_ID_V0,
      amount: 5000,
      rest: P2PKH_REST,
    }).toHex()
    expect(hex).toBe(`05${BSV21_TAG_HEX}24${INTERNAL_TXID}000000006d02881300${'6d'}${P2PKH_REST}`)
    expect(decodeBsv21Binary(hex)).toMatchObject({
      layout: 'draft-tagged',
      role: 'value',
      tokenId: TOKEN_ID_V0,
      amount: 5000n,
    })
  })

  it('refuses an embedded image in a tagged deploy', () => {
    expect(() =>
      encodeBsv21Binary({ layout: 'draft-tagged', amount: 1, payload: { iconImage: PNG } }),
    ).toThrow(/pointer/)
  })

  it('rejects a non-CBOR tagged payload', () => {
    const nope = [...new TextEncoder().encode('nope')].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(decodeBsv21Binary(`05${BSV21_TAG_HEX}006d5104${nope}6d`)).toBeNull()
  })
})

describe('decodeDeployCbor (draft-tagged) — "unknown keys are ignored"', () => {
  const hex = hexBytes

  it('keeps sym/dec/icon beside unknown values of every major type', () => {
    // {"sym":"GOLD","dec":2,"neg":-5,"arr":[1,"x",{}],"f":1.5,"t":true,"tag":1(0),"big":2^63,"icon":h'01020304'}
    const bytes = hex(
      'a9' +
        '6373796d' + '64474f4c44' +
        '63646563' + '02' +
        '636e6567' + '24' +
        '63617272' + '83' + '01' + '6178' + 'a0' +
        '6166' + 'f93e00' +
        '6174' + 'f5' +
        '63746167' + 'c100' +
        '63626967' + '1b8000000000000000' +
        '6469636f6e' + '4401020304',
    )
    const payload = decodeDeployCbor(bytes)
    expect(payload).toEqual({ sym: 'GOLD', dec: 2, icon: Uint8Array.from([1, 2, 3, 4]) })
  })

  it('accepts indefinite-length maps and strings', () => {
    // {_ "sym": (_ "GO" "LD"), "x": [_ 1 2] }
    const bytes = hex('bf' + '6373796d' + '7f' + '62474f' + '624c44' + 'ff' + '6178' + '9f0102ff' + 'ff')
    expect(decodeDeployCbor(bytes)).toEqual({ sym: 'GOLD' })
  })

  it('still refuses truncated or non-map payloads', () => {
    expect(decodeDeployCbor(hex('a2' + '6373796d' + '64474f'))).toBeNull()
    expect(decodeDeployCbor(hex('83010203'))).toBeNull()
    expect(decodeDeployCbor(hex('a16373796d64474f4c4400'))).toBeNull()
  })
})
