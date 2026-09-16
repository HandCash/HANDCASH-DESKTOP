import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
    return true
  },
}))

const { ordEnvelopeHex } = await import('./ordScriptPush')
const { p2pkhScriptHex } = await import('./ordinalOwnership')

const ADDRESS = PrivateKey.fromRandom().toAddress()
const ORIGIN = `${'ab'.repeat(32)}_0`

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])

/** What a Mint Studio item mint locks: ord envelope plus the holder's P2PKH. */
function mintScript(contentType: string, body: Uint8Array): string {
  return ordEnvelopeHex(contentType, body) + p2pkhScriptHex(ADDRESS)
}

describe('local item art', () => {
  beforeEach(async () => {
    store.clear()
    vi.resetModules()
  })

  it('keeps the art a fresh mint carries, so the card needs no indexer', async () => {
    const art = await import('./localItemArt')

    const url = art.rememberItemArtFromScript(ORIGIN, mintScript('image/png', PNG))

    expect(url).toBe(`data:image/png;base64,${art.getItemArtRecord(ORIGIN)?.b64}`)
    expect(art.getItemArtDataUrl(ORIGIN)).toMatch(/^data:image\/png;base64,/)
  })

  it('survives a restart — the mint transaction is not re-parsed to paint', async () => {
    const first = await import('./localItemArt')
    first.rememberItemArtFromScript(ORIGIN, mintScript('image/png', PNG))

    vi.resetModules()
    const reloaded = await import('./localItemArt')

    expect(reloaded.getItemArtDataUrl(ORIGIN)).toMatch(/^data:image\/png;base64,/)
    expect(reloaded.hasItemArt(ORIGIN)).toBe(true)
  })

  it('reads a dotted tip origin and an underscored one as the same art', async () => {
    const art = await import('./localItemArt')
    art.rememberItemArtFromScript(ORIGIN, mintScript('image/png', PNG))

    expect(art.getItemArtDataUrl(ORIGIN.replace('_0', '.0'))).toBeDefined()
  })

  it('trusts the bytes over the declared type — octet-stream PNG still paints', async () => {
    const art = await import('./localItemArt')

    const url = art.rememberItemArtFromScript(
      ORIGIN,
      mintScript('application/octet-stream', PNG),
    )

    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('keeps no art for a text inscription — there is no picture to paint', async () => {
    const art = await import('./localItemArt')

    const url = art.rememberItemArtFromScript(
      ORIGIN,
      mintScript('text/plain', new TextEncoder().encode('hello')),
    )

    expect(url).toBeUndefined()
    expect(art.hasItemArt(ORIGIN)).toBe(false)
  })

  it('keeps no art from a transferred tip — a P2PKH carries no envelope', async () => {
    const art = await import('./localItemArt')

    expect(art.rememberItemArtFromScript(ORIGIN, p2pkhScriptHex(ADDRESS))).toBeUndefined()
  })

  it('looks at one script per origin per session — list rebuilds stay cheap', async () => {
    const art = await import('./localItemArt')
    const script = mintScript('text/plain', new TextEncoder().encode('hello'))

    expect(art.itemArtUnexamined(ORIGIN)).toBe(true)
    art.rememberItemArtFromScript(ORIGIN, script)
    expect(art.itemArtUnexamined(ORIGIN)).toBe(false)
  })

  it('refuses an inscription too large to carry in the art store', async () => {
    const art = await import('./localItemArt')
    const huge = new Uint8Array(300 * 1024)
    huge.set(PNG, 0)

    art.rememberItemArt(ORIGIN, huge, 'image/png')

    expect(art.hasItemArt(ORIGIN)).toBe(false)
  })

  it('paints a received item from the remittance BEEF the sender delivered', async () => {
    const { Beef, Script, Transaction } = await import('@bsv/sdk')
    const art = await import('./localItemArt')
    const { bytesToBase64 } = await import('./base64Binary')

    const originTx = new Transaction()
    originTx.addInput({
      sourceTXID: 'cd'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(''),
      sequence: 0xffffffff,
    })
    originTx.addOutput({
      lockingScript: Script.fromHex(mintScript('image/png', PNG)),
      satoshis: 1,
    })
    const beef = new Beef()
    beef.mergeRawTx(originTx.toBinary())
    const origin = `${originTx.id('hex')}_0`

    const url = art.rememberItemArtFromProvenance({
      v: 2,
      origin,
      tip: origin,
      path: [origin],
      beefB64: bytesToBase64(new Uint8Array(beef.toBinary())),
    })

    expect(url).toMatch(/^data:image\/png;base64,/)
    expect(art.getItemArtDataUrl(origin)).toBeDefined()
  })
})
