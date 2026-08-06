import { beforeEach, describe, expect, it, vi } from 'vitest'

const OUTPOINT = `${'ab'.repeat(32)}.0`
const WRONG_ORIGIN = `${'ab'.repeat(32)}_0`
const TRUE_ORIGIN = `${'cd'.repeat(32)}_1`

const held = vi.fn(() => [] as Array<Record<string, unknown>>)
const resolved = vi.fn(() => null as Record<string, unknown> | null)
const verdict = vi.fn(() => null as Record<string, unknown> | null)

vi.mock('./collectables', () => ({ getCachedCollectables: () => held() }))
vi.mock('./inscriptionCache', () => ({
  getResolvedInscription: () => resolved(),
  isThinResolution: (r: { mimeType?: string; traits?: unknown[] } | null) =>
    !r || (!r.mimeType && (r.traits?.length ?? 0) === 0),
}))
vi.mock('./provenCache', () => ({ getProvenVerdict: () => verdict() }))
vi.mock('./oneSatImport', () => ({
  contentUrlForOrigin: (origin: string) => `https://content.test/${origin}`,
}))
vi.mock('./session', () => ({ getActiveWallet: () => ({ chain: 'main' }) }))

const { viewActivityItem } = await import('./activityItemView')

const frozen = {
  name: 'pixel foxes',
  origin: WRONG_ORIGIN,
  outpoint: OUTPOINT,
  imageUrl: `https://content.test/${WRONG_ORIGIN}`,
}

describe('viewActivityItem', () => {
  beforeEach(() => {
    held.mockReturnValue([])
    resolved.mockReturnValue(null)
    verdict.mockReturnValue(null)
  })

  it('paints a held tip from the inventory', () => {
    held.mockReturnValue([
      {
        outpoint: OUTPOINT,
        name: 'Pixel Foxes',
        origin: TRUE_ORIGIN,
        imageUrl: `https://content.test/${TRUE_ORIGIN}`,
        app: 'Market',
      },
    ])

    expect(viewActivityItem(frozen)).toMatchObject({
      name: 'Pixel Foxes',
      origin: TRUE_ORIGIN,
      app: 'Market',
    })
  })

  it('repairs a sent tip from a verdict that outlived it', () => {
    // Nothing holds this outpoint any more and its resolution is thin, which is
    // exactly the record of the transfer that sent the item away.
    verdict.mockReturnValue({ tier: 'brc150', origin: TRUE_ORIGIN, verifiedAt: 1 })

    expect(viewActivityItem(frozen)).toMatchObject({
      origin: TRUE_ORIGIN,
      imageUrl: `https://content.test/${TRUE_ORIGIN}`,
    })
  })

  it('prefers a proven origin over a resolved one', () => {
    resolved.mockReturnValue({
      origin: WRONG_ORIGIN,
      name: 'Pixel Foxes',
      mimeType: 'image/png',
      traits: [],
    })
    verdict.mockReturnValue({ tier: 'brc150', origin: TRUE_ORIGIN, verifiedAt: 1 })

    expect(viewActivityItem(frozen)).toMatchObject({
      name: 'Pixel Foxes',
      origin: TRUE_ORIGIN,
    })
  })

  it('leaves the row alone when nothing knows better', () => {
    expect(viewActivityItem(frozen)).toBe(frozen)
  })

  it('leaves a row with no outpoint alone', () => {
    const noOutpoint = { name: 'x', origin: WRONG_ORIGIN }
    expect(viewActivityItem(noOutpoint)).toBe(noOutpoint)
  })
})
