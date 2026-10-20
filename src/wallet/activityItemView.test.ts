import { beforeEach, describe, expect, it, vi } from 'vitest'

const OUTPOINT = `${'ab'.repeat(32)}.0`
const WRONG_ORIGIN = `${'ab'.repeat(32)}_0`
const TRUE_ORIGIN = `${'cd'.repeat(32)}_1`

const held = vi.fn(() => [] as Array<Record<string, unknown>>)
const resolved = vi.fn(() => null as Record<string, unknown> | null)
const verdict = vi.fn(() => null as Record<string, unknown> | null)
const localArt = vi.fn(() => undefined as string | undefined)

vi.mock('./collectables', () => ({ getCachedCollectables: () => held() }))
vi.mock('./localItemArt', () => ({
  getItemArtDataUrl: (origin: string) => localArt(origin),
}))
vi.mock('./inscriptionCache', () => ({
  getResolvedInscription: () => resolved(),
  getResolvedInscriptionByOrigin: () => resolved(),
  isThinResolution: (r: { mimeType?: string; traits?: unknown[] } | null) =>
    !r || (!r.mimeType && (r.traits?.length ?? 0) === 0),
}))
vi.mock('./provenCache', () => ({ getProvenVerdict: () => verdict() }))
vi.mock('./oneSatImport', () => ({
  contentUrlForOrigin: (origin: string) => `https://content.test/${origin}`,
}))
const IDENTITY = `02${'ef'.repeat(32)}`
vi.mock('./session', () => ({ getActiveWallet: () => ({ chain: 'main', identityKey: IDENTITY }) }))

const { viewActivityItem } = await import('./activityItemView')
const { rememberHeldBntAssets } = await import('./bnt/heldAssets')

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
    localArt.mockReturnValue(undefined)
    rememberHeldBntAssets(IDENTITY, [])
  })

  it('leaves a token row alone', () => {
    const token = { name: 'DEMO', tokenId: 'ab'.repeat(20) }
    expect(viewActivityItem(token)).toBe(token)
  })

  it('paints a held BNT token and item with their deploy art', () => {
    const icon = 'data:image/png;base64,aWNvbg=='
    const picture = 'data:image/png;base64,cGljdHVyZQ=='
    rememberHeldBntAssets(IDENTITY.toUpperCase(), [
      { assetId: 'ab'.repeat(20), kind: 'token', sym: 'E2E2', imageUrl: icon },
      { assetId: 'cd'.repeat(20), kind: 'item', name: 'Live test picture', imageUrl: picture },
    ])
    expect(viewActivityItem({ name: 'E2E2', tokenId: 'AB'.repeat(20), amt: '24' })).toEqual({ name: 'E2E2', tokenId: 'AB'.repeat(20), amt: '24', imageUrl: icon })
    expect(viewActivityItem({ name: 'Live test picture', origin: 'cd'.repeat(20) }).imageUrl).toBe(picture)
    const own = { name: 'E2E2', tokenId: 'ab'.repeat(20), imageUrl: 'data:image/png;base64,b3du' }
    expect(viewActivityItem(own)).toBe(own)
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

  it('prefers full-resolution local mint art over the inventory HTTP image', () => {
    localArt.mockReturnValue('data:image/png;base64,full-resolution')
    held.mockReturnValue([
      {
        outpoint: OUTPOINT,
        name: 'Pixel Foxes',
        origin: TRUE_ORIGIN,
        imageUrl: `https://content.test/${TRUE_ORIGIN}`,
      },
    ])

    expect(viewActivityItem(frozen).imageUrl).toBe(
      'data:image/png;base64,full-resolution',
    )
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

  it('adds an origin content fallback when no held outpoint is available', () => {
    const noOutpoint = { name: 'x', origin: WRONG_ORIGIN }
    expect(viewActivityItem(noOutpoint)).toEqual({
      ...noOutpoint,
      imageUrl: `https://content.test/${WRONG_ORIGIN}`,
    })
  })

  it('takes the first held tip in list order, by outpoint or origin', () => {
    held.mockReturnValue([
      { outpoint: `${'11'.repeat(32)}.0`, origin: WRONG_ORIGIN.toUpperCase(), name: 'by origin' },
      { outpoint: OUTPOINT.replace('.0', '_0'), origin: TRUE_ORIGIN, name: 'by outpoint' },
    ])
    expect(viewActivityItem(frozen).name).toBe('by origin')

    held.mockReturnValue([
      { outpoint: OUTPOINT, origin: TRUE_ORIGIN, name: 'by outpoint' },
      { outpoint: `${'11'.repeat(32)}.0`, origin: WRONG_ORIGIN, name: 'by origin' },
    ])
    expect(viewActivityItem(frozen).name).toBe('by outpoint')
  })

  it('sees a replaced inventory and stays fast on a large one', () => {
    const many = Array.from({ length: 3_000 }, (_, i) => ({
      outpoint: `${i.toString(16).padStart(64, '0')}.0`,
      origin: `${i.toString(16).padStart(64, '0')}_0`,
      name: `item ${i}`,
    }))
    held.mockReturnValue(many)
    const started = performance.now()
    for (const c of many) viewActivityItem({ name: 'x', outpoint: c.outpoint })
    expect(performance.now() - started).toBeLessThan(250)

    held.mockReturnValue([{ ...many[7]!, name: 'renamed' }])
    expect(viewActivityItem({ name: 'x', outpoint: many[7]!.outpoint }).name).toBe('renamed')
  })
})
