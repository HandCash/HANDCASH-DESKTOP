import { afterEach, describe, expect, it } from 'vitest'
import {
  clearHeldBntAssets,
  heldBntAssets,
  heldBntAssetsListed,
  rememberHeldBntAssets,
} from './heldAssets'

afterEach(() => clearHeldBntAssets())

describe('heldBntAssets (Aeon store)', () => {
  it('lists nothing until remember for that identity',
    () => {
      expect(heldBntAssetsListed('aa')).toBe(false)
      expect(heldBntAssets('aa')).toEqual([])
      rememberHeldBntAssets('AA', [{ assetId: 't1', kind: 'token', sym: 'TOK' }])
      expect(heldBntAssetsListed('aa')).toBe(true)
      expect(heldBntAssets('aa')).toEqual([{ assetId: 't1', kind: 'token', sym: 'TOK' }])
      expect(heldBntAssetsListed('bb')).toBe(false)
    },
  )

  it('replaces entities on the same identity and drops ones no longer held', () => {
    rememberHeldBntAssets('aa', [
      { assetId: 't1', kind: 'token' },
      { assetId: 'i1', kind: 'item' },
    ])
    rememberHeldBntAssets('aa', [{ assetId: 't1', kind: 'token', name: 'Renamed' }])
    expect(heldBntAssets('aa')).toEqual([{ assetId: 't1', kind: 'token', name: 'Renamed' }])
  })

  it('clears when the identity changes', () => {
    rememberHeldBntAssets('aa', [{ assetId: 't1', kind: 'token' }])
    rememberHeldBntAssets('bb', [{ assetId: 't2', kind: 'token' }])
    expect(heldBntAssets('aa')).toEqual([])
    expect(heldBntAssets('bb')).toEqual([{ assetId: 't2', kind: 'token' }])
  })

  it('clears on clearHeldBntAssets', () => {
    rememberHeldBntAssets('aa', [{ assetId: 't1', kind: 'token' }])
    clearHeldBntAssets()
    expect(heldBntAssetsListed('aa')).toBe(false)
    expect(heldBntAssets('aa')).toEqual([])
  })
})
