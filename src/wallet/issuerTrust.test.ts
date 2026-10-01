import { describe, expect, it } from 'vitest'
import { bapFingerprint, identityNameSkeleton, issuerTrustFrom, type VerifiedIssuer } from './issuerTrust'

const HANDCASH: VerifiedIssuer = { bapId: 'BapHandCashListed1111', name: 'HandCash' }

function trust(stored: Array<{ bapId: string; name: string }> = [], listed: VerifiedIssuer[] = [HANDCASH]) {
  return issuerTrustFrom({
    listed: (bapId) => listed.find((e) => e.bapId === bapId) ?? null,
    listedEntries: listed,
    storedIdentities: () => stored,
  })
}

describe('identityNameSkeleton', () => {
  it('folds case, accents, spacing and look-alike characters', () => {
    expect(identityNameSkeleton('HandCash')).toBe('handcash')
    expect(identityNameSkeleton('Hand Cash!')).toBe('handcash')
    expect(identityNameSkeleton('HÁNDCÄSH')).toBe('handcash')
    expect(identityNameSkeleton('Hand$ash')).toBe(identityNameSkeleton('Handsash'))
    expect(identityNameSkeleton('rnoney')).toBe(identityNameSkeleton('money'))
    expect(identityNameSkeleton('vvallet')).toBe(identityNameSkeleton('wallet'))
    expect(identityNameSkeleton('B1ll')).toBe(identityNameSkeleton('Bill'))
    expect(identityNameSkeleton('G0LD')).toBe(identityNameSkeleton('gold'))
  })

  it('is empty for names with no letters or digits', () => {
    expect(identityNameSkeleton(' — ')).toBe('')
  })
})

describe('issuerTrustFrom', () => {
  it('gives a listed BAP ID no caution', () => {
    const t = trust()
    expect(t.listed(HANDCASH.bapId)).toEqual(HANDCASH)
    expect(t.caution(HANDCASH.bapId, 'HandCash')).toBeNull()
  })

  it('flags a name that reads like a listed issuer under another BAP ID', () => {
    expect(trust().caution('BapImposter', 'Hand Ca$h')).toEqual({ kind: 'imitates-listed', listed: HANDCASH })
  })

  it('counts other stored identities that read the same', () => {
    const t = trust([
      { bapId: 'BapA', name: 'Gallery' },
      { bapId: 'BapB', name: 'GALLERY' },
      { bapId: 'BapC', name: 'Ga11ery' },
      { bapId: 'BapD', name: 'Studio' },
    ])
    expect(t.caution('BapA', 'Gallery')).toEqual({ kind: 'shared-name', others: 2 })
    expect(t.caution('BapD', 'Studio')).toBeNull()
  })

  it('prefers the listed imitation over a shared name', () => {
    const t = trust([
      { bapId: 'BapX', name: 'HandCash' },
      { bapId: 'BapY', name: 'handcash' },
    ])
    expect(t.caution('BapX', 'HandCash')?.kind).toBe('imitates-listed')
  })

  it('has nothing to say about a blank name', () => {
    expect(trust([{ bapId: 'BapA', name: '' }, { bapId: 'BapB', name: '' }]).caution('BapA', '...')).toBeNull()
  })
})

describe('bapFingerprint', () => {
  it('is deterministic, mirrored and shortens long IDs', () => {
    const id = '1AbCdEfGhJkLmNpQrStUvW'
    const a = bapFingerprint(id)
    expect(bapFingerprint(id)).toEqual(a)
    expect(a.short).toBe('1AbCdE…tUvW')
    expect(a.cells).toHaveLength(25)
    expect(a.hue).toBeGreaterThanOrEqual(0)
    expect(a.hue).toBeLessThan(360)
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 5; col++) expect(a.cells[row * 5 + col]).toBe(a.cells[row * 5 + (4 - col)])
  })

  it('draws different identicons for IDs that share their short form', () => {
    const a = bapFingerprint('1AbCdEaaaaaaaaaaaatUvW')
    const b = bapFingerprint('1AbCdEbbbbbbbbbbbbtUvW')
    expect(a.short).toBe(b.short)
    expect({ hue: a.hue, cells: a.cells }).not.toEqual({ hue: b.hue, cells: b.cells })
  })

  it('keeps short IDs whole', () => {
    expect(bapFingerprint('ShortId').short).toBe('ShortId')
  })
})
