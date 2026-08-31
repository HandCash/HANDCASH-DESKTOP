import { describe, expect, it } from 'vitest'
import {
  cancelPendingPermissions,
  requestActionApproval,
  resolvePermission,
  subscribePermissionRequests,
  summarizeAction,
  type PendingPrompt,
} from './permissions'

describe('market listing permission summary', () => {
  it('carries the held tip so the prompt can show it from wallet data', () => {
    const summary = summarizeAction('createMarketListingAdvert', {
      outpoint: `${'b'.repeat(64)}_0`,
      priceSats: 42,
    })
    expect(summary.itemOutpoint).toBe(`${'b'.repeat(64)}.0`)
  })

  it('ignores anything the app says about the item itself', () => {
    const summary = summarizeAction('createMarketListingAdvert', {
      outpoint: `${'b'.repeat(64)}_0`,
      priceSats: 42,
      itemPreview: { name: 'Rare Fox #1', imageUrl: 'https://attacker.example/art.png' },
    })
    expect(summary.itemOutpoint).toBe(`${'b'.repeat(64)}.0`)
    expect(JSON.stringify(summary)).not.toContain('attacker.example')
    expect(JSON.stringify(summary)).not.toContain('Rare Fox')
  })

  it('omits the preview when the outpoint is not a real outpoint', () => {
    expect(
      summarizeAction('createMarketListingAdvert', {
        outpoint: 'not-an-outpoint',
        priceSats: 42,
      }).itemOutpoint,
    ).toBeUndefined()
  })

  it('shows market listing content on purchase approval from nested listing', () => {
    const outpoint = `${'c'.repeat(64)}_0`
    const summary = summarizeAction('purchaseMarketListing', {
      listing: {
        outpoint,
        assetType: 'ordinal',
        name: 'Rare Fox',
        contentUrl: 'https://cdn.example/fox.png',
        priceSats: 500,
      },
    })
    expect(summary.itemOutpoint).toBe(`${'c'.repeat(64)}.0`)
    expect(summary.itemName).toBe('Rare Fox')
    expect(summary.itemImageUrl).toBe('https://cdn.example/fox.png')
    expect(summary.previewKind).toBe('collectable')
    expect(summary.summary).toContain('Rare Fox')
  })

  it('shows token sym on BSV-21 purchase intent', () => {
    const origin = `${'d'.repeat(64)}_0`
    const summary = summarizeAction('createMarketPurchaseIntent', {
      listing: {
        outpoint: `${'e'.repeat(64)}_0`,
        assetType: 'bsv21',
        origin,
        sym: 'HNDC',
        priceSats: 100,
      },
    })
    expect(summary.tokenId).toBe(origin)
    expect(summary.itemName).toBe('HNDC')
    expect(summary.previewKind).toBe('token')
  })

  it('never lets one approval authorize a different market request', async () => {
    cancelPendingPermissions()
    let current: PendingPrompt | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      current = next
    })
    try {
      const firstOutpoint = `${'a'.repeat(64)}_0`
      const secondOutpoint = `${'b'.repeat(64)}_1`
      const first = requestActionApproval('market.handcash.io', 'createMarketListingAdvert', {
        outpoint: firstOutpoint,
        priceSats: 42,
      })
      const second = requestActionApproval('market.handcash.io', 'createMarketListingAdvert', {
        outpoint: secondOutpoint,
        priceSats: 99,
      })

      const firstPrompt = current as PendingPrompt | null
      expect(firstPrompt?.kind).toBe('action')
      if (!firstPrompt || firstPrompt.kind !== 'action') throw new Error('missing first prompt')
      expect(firstPrompt.itemOutpoint).toBe(firstOutpoint.replace('_', '.'))
      expect(resolvePermission(firstPrompt.id, 'allow')).toBe(true)
      await expect(first).resolves.toBe('allow')

      const secondPrompt = current as PendingPrompt | null
      expect(secondPrompt?.kind).toBe('action')
      if (!secondPrompt || secondPrompt.kind !== 'action') {
        throw new Error('missing second prompt')
      }
      expect(secondPrompt.id).not.toBe(firstPrompt.id)
      expect(secondPrompt.itemOutpoint).toBe(secondOutpoint.replace('_', '.'))
      expect(resolvePermission(secondPrompt.id, 'deny')).toBe(true)
      await expect(second).resolves.toBe('deny')
    } finally {
      unsubscribe()
      cancelPendingPermissions()
    }
  })
})
