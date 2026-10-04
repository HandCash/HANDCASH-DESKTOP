import { describe, expect, it } from 'vitest'
import { P2PKH, PrivateKey, Script } from '@bsv/sdk'
import { hasOrdEnvelope, p2pkhScriptHex, scriptPaysAddress } from './ordinalOwnership'
import { encodeBsv21Binary } from './token/decode162'

const ADDRESS = PrivateKey.fromRandom().toAddress()
const OTHER = PrivateKey.fromRandom().toAddress()

/** `OP_FALSE OP_IF "ord" OP_1 <text/plain> OP_0 <hi> OP_ENDIF` */
const ORD_ENVELOPE = '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

describe('ordinal ownership', () => {
  it('matches a bare transferred tip', () => {
    expect(scriptPaysAddress(p2pkhScriptHex(ADDRESS), ADDRESS)).toBe(true)
  })

  it('matches an inscribed tip with the envelope after the P2PKH', () => {
    const script = p2pkhScriptHex(ADDRESS) + ORD_ENVELOPE
    expect(scriptPaysAddress(script, ADDRESS)).toBe(true)
  })

  it('matches an inscribed tip with the envelope before the P2PKH', () => {
    const script = ORD_ENVELOPE + p2pkhScriptHex(ADDRESS)
    expect(scriptPaysAddress(script, ADDRESS)).toBe(true)
  })

  it('is case insensitive', () => {
    expect(scriptPaysAddress(p2pkhScriptHex(ADDRESS).toUpperCase(), ADDRESS)).toBe(true)
  })

  it('rejects another key', () => {
    expect(scriptPaysAddress(p2pkhScriptHex(OTHER), ADDRESS)).toBe(false)
  })

  it('rejects a script that only contains the pattern off a byte boundary', () => {
    const script = 'f' + p2pkhScriptHex(ADDRESS)
    expect(scriptPaysAddress(script, ADDRESS)).toBe(false)
  })

  it('rejects empty or missing scripts', () => {
    expect(scriptPaysAddress(undefined, ADDRESS)).toBe(false)
    expect(scriptPaysAddress('', ADDRESS)).toBe(false)
  })

  it('matches a tip with trailing OP_RETURN data after the key spend', () => {
    const script = ORD_ENVELOPE + p2pkhScriptHex(ADDRESS) + '6a' + '044d415020'
    expect(scriptPaysAddress(script, ADDRESS)).toBe(true)
  })

  it('matches a BRC-162 token tip by its remainder lock', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    const ours = encodeBsv21Binary({ tokenId, amount: 7n, rest: new P2PKH().lock(ADDRESS) }).toHex()
    const theirs = encodeBsv21Binary({ tokenId, amount: 7n, rest: new P2PKH().lock(OTHER) }).toHex()
    const inscribed = encodeBsv21Binary({
      tokenId,
      amount: 7n,
      rest: Script.fromHex(p2pkhScriptHex(ADDRESS) + ORD_ENVELOPE),
    }).toHex()
    expect(scriptPaysAddress(ours, ADDRESS)).toBe(true)
    expect(scriptPaysAddress(inscribed, ADDRESS)).toBe(true)
    expect(scriptPaysAddress(theirs, ADDRESS)).toBe(false)
  })

  it('rejects the template carried as data rather than as the lock', () => {
    const template = p2pkhScriptHex(ADDRESS)
    const asData = '006a19' + template
    const inEnvelopeBody = '0063036f726451' + '0a746578742f706c61696e' + '0019' + template + '68' + p2pkhScriptHex(OTHER)
    expect(scriptPaysAddress(asData, ADDRESS)).toBe(false)
    expect(scriptPaysAddress(inEnvelopeBody, ADDRESS)).toBe(false)
  })

  it('rejects a second lock or contract code beside the key spend', () => {
    const ours = p2pkhScriptHex(ADDRESS)
    expect(scriptPaysAddress(ours + p2pkhScriptHex(OTHER), ADDRESS)).toBe(false)
    expect(scriptPaysAddress(`5175${ours}`, ADDRESS)).toBe(false)
    expect(scriptPaysAddress(`${ours}ac`, ADDRESS)).toBe(false)
  })

  it('recognizes a complete ord envelope and rejects a truncated one', () => {
    expect(hasOrdEnvelope(ORD_ENVELOPE)).toBe(true)
    expect(hasOrdEnvelope(ORD_ENVELOPE.slice(0, -2))).toBe(false)
  })
})
