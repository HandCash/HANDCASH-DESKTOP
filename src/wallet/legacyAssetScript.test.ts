import { describe, expect, it } from 'vitest'
import { LockingScript } from '@bsv/sdk'
import { isBareP2pkhScript, runJigVouts } from './legacyAssetScript'
import { chooseLegacyFundingScript } from './legacySweepPath'

const P2PKH = '76a914aabbccddeeff00112233445566778899aabbccdd88ac'
const hexOf = (text: string) => Buffer.from(text, 'utf8').toString('hex')
const push = (text: string) => `${text.length.toString(16).padStart(2, '0')}${hexOf(text)}`
const runMarker = (payload: string) => `006a${push('run')}0105${push('app')}${push(payload)}`
const tx = (...scripts: string[]) => ({
  outputs: scripts.map((hex) => ({ lockingScript: LockingScript.fromHex(hex) })),
})

describe('runJigVouts', () => {
  it('claims one output per entry of the RUN payload, and not the change after them', () => {
    const payload = JSON.stringify({ in: 0, ref: [], out: ['aa', 'bb'], del: [], cre: [], exec: [] })
    expect([...runJigVouts(tx(runMarker(payload), P2PKH, P2PKH, P2PKH) as never)]).toEqual([1, 2])
  })

  it('claims every later output when the payload cannot be read', () => {
    expect([...runJigVouts(tx(runMarker('not json'), P2PKH, P2PKH) as never)]).toEqual([1, 2])
  })

  it('claims nothing in a transaction with no RUN marker', () => {
    const memo = `006a${push('memo')}`
    expect(runJigVouts(tx(P2PKH, memo, P2PKH) as never).size).toBe(0)
  })
})

describe('chooseLegacyFundingScript', () => {
  it('sweeps a bare P2PKH that no marker claims', () => {
    expect(chooseLegacyFundingScript({ lockingScriptHex: P2PKH, runJig: false })).toEqual({
      path: 'sweep',
    })
  })

  it('holds a RUN jig, whatever its value', () => {
    expect(chooseLegacyFundingScript({ lockingScriptHex: P2PKH, runJig: true })).toEqual({
      path: 'hold',
      reason: 'runJig',
    })
  })

  it('holds anything wider than a bare P2PKH', () => {
    for (const lockingScriptHex of [`${P2PKH}6a${push('x')}`, `0063036f726468${P2PKH}`, '', null]) {
      expect(chooseLegacyFundingScript({ lockingScriptHex, runJig: false })).toEqual({
        path: 'hold',
        reason: 'notPlainP2pkh',
      })
    }
  })

  it('reads bare P2PKH exactly', () => {
    expect(isBareP2pkhScript(P2PKH.toUpperCase())).toBe(true)
    expect(isBareP2pkhScript(`${P2PKH}00`)).toBe(false)
  })
})
