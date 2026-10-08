import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GpTxo, ResolvedInscription } from './oneSatImport'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))
vi.mock('./appLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./appLog')>()),
  appendAppLog: vi.fn(),
}))

const SIGNER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
const ORIGIN = `${'a'.repeat(64)}_0`
const OTHER = `${'b'.repeat(64)}_0`

const resolved = (origin: string, extra: Partial<ResolvedInscription> = {}): ResolvedInscription => ({
  origin,
  name: 'Dragon',
  mimeType: 'image/png',
  traits: [],
  extras: [],
  ...extra,
})

const row = (outpoint: string, sigma: unknown): GpTxo => ({
  outpoint,
  origin: { outpoint, data: { sigma } },
})

describe('indexedOriginSigner', () => {
  it('reads the origin’s valid BSM signer and never a tip’s own Sigma', async () => {
    const { indexedOriginSigner } = await import('./oneSatImport')
    expect(indexedOriginSigner(row(ORIGIN, [{ algorithm: 'BSM', address: SIGNER, valid: true }]), ORIGIN)).toBe(SIGNER)
    expect(indexedOriginSigner(row(ORIGIN, [{ algorithm: 'BSM', address: SIGNER, valid: false }]), ORIGIN)).toBeNull()
    expect(
      indexedOriginSigner({ outpoint: OTHER, origin: ORIGIN, data: { sigma: [{ address: SIGNER }] } }, OTHER),
    ).toBeNull()
    expect(
      indexedOriginSigner({ outpoint: ORIGIN, origin: ORIGIN, data: { sigma: [{ address: SIGNER }] } }, ORIGIN),
    ).toBe(SIGNER)
  })
})

describe('backfillOriginSigners', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('asks the index once per origin for hits cached without a signer and writes them together', async () => {
    const cache = await import('./inscriptionCache')
    const { backfillOriginSigners } = await import('./originSigners')
    cache.rememberResolvedInscription('t1.0', resolved(ORIGIN))
    cache.rememberResolvedInscription('t2.0', resolved(ORIGIN))
    cache.rememberResolvedInscription('t3.0', resolved(OTHER))
    cache.rememberResolvedInscription('t4.0', resolved(OTHER, { signer: SIGNER }))
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual([ORIGIN, OTHER])
      return new Response(
        JSON.stringify([row(ORIGIN, [{ algorithm: 'BSM', address: SIGNER }]), row(OTHER, [])]),
      )
    })

    const outpoints = ['t1.0', 't2.0', 't3.0', 't4.0']
    expect(await backfillOriginSigners({ chain: 'main', outpoints, fetchImpl })).toBe(3)
    expect(cache.getResolvedInscription('t1.0')?.signer).toBe(SIGNER)
    expect(cache.getResolvedInscription('t2.0')?.signer).toBe(SIGNER)
    expect(cache.getResolvedInscription('t3.0')?.signer).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    expect(await backfillOriginSigners({ chain: 'main', outpoints, fetchImpl })).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('resolves an origin no hit names whole, so a tip moved in by an import shelves under its creator', async () => {
    const cache = await import('./inscriptionCache')
    const { backfillOriginSigners } = await import('./originSigners')
    const tip = `${'c'.repeat(64)}.0`
    const items = [{ outpoint: tip, origin: ORIGIN.replace('_', '.') }]
    expect(cache.originsWithoutHit(items)).toEqual([ORIGIN])
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual([ORIGIN])
      return new Response(
        JSON.stringify([
          {
            outpoint: ORIGIN,
            origin: {
              outpoint: ORIGIN,
              data: {
                map: { app: 'Ageless Republic', name: 'Axe', subType: 'collectionItem' },
                insc: { file: { type: 'image/webp' } },
                sigma: [{ algorithm: 'BSM', address: SIGNER, valid: true }],
              },
            },
          },
        ]),
      )
    })

    expect(
      await backfillOriginSigners({ chain: 'main', outpoints: [tip], origins: cache.originsWithoutHit(items), fetchImpl }),
    ).toBe(1)
    expect(cache.getResolvedInscriptionByOrigin(ORIGIN)).toMatchObject({
      origin: ORIGIN,
      name: 'Axe',
      app: 'Ageless Republic',
      mimeType: 'image/webp',
      signer: SIGNER,
    })
    expect(cache.originsWithoutHit(items)).toEqual([])
  })

  it('never replaces a held origin hit, only fills the signer it was never asked for', async () => {
    const cache = await import('./inscriptionCache')
    cache.rememberResolvedInscription(ORIGIN, resolved(ORIGIN, { name: 'Held', traits: [{ name: 'Class', value: 'ALL' }] }))
    cache.rememberResolvedInscription(OTHER, resolved(OTHER, { signer: null }))
    const changed = cache.rememberIndexedOrigins(
      new Map([
        [ORIGIN, resolved(ORIGIN, { name: 'Index', signer: SIGNER })],
        [OTHER, resolved(OTHER, { name: 'Index', signer: SIGNER })],
      ]),
    )
    expect(changed).toBe(1)
    expect(cache.getResolvedInscription(ORIGIN)).toMatchObject({ name: 'Held', signer: SIGNER, traits: [{ name: 'Class', value: 'ALL' }] })
    expect(cache.getResolvedInscription(OTHER)).toMatchObject({ name: 'Dragon', signer: null })
  })

  it('leaves hits unasked-for when the index fails, and does not ask again this session', async () => {
    const cache = await import('./inscriptionCache')
    const { backfillOriginSigners } = await import('./originSigners')
    cache.rememberResolvedInscription('t1.0', resolved(ORIGIN))
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }))
    expect(await backfillOriginSigners({ chain: 'main', outpoints: ['t1.0'], fetchImpl })).toBe(0)
    expect(cache.getResolvedInscription('t1.0')?.signer).toBeUndefined()
    await backfillOriginSigners({ chain: 'main', outpoints: ['t1.0'], fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
