import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { p2pkhScriptHex, scriptPaysAddress } from './ordinalOwnership'

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
})
