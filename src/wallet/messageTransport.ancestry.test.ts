import { PrivateKey } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

const beefCache = vi.hoisted(() => ({
  mergeLocalUnconfirmedAncestry: vi.fn(async (_wallet: unknown, atomic: number[]) => [...atomic, 9]),
  rememberBeefTree: vi.fn(),
}))

vi.mock('./session', () => ({ getActiveWallet: () => ({ chain: 'main' }) }))
vi.mock('./beefCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./beefCache')>()),
  ...beefCache,
}))

const { notifyPeerItemIncoming } = await import('./messageTransport')

describe('item notify ancestry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    beefCache.mergeLocalUnconfirmedAncestry.mockClear()
  })

  async function notify(ancestryComplete?: boolean) {
    const root = PrivateKey.fromRandom()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success' }), { status: 200 })))
    return notifyPeerItemIncoming({
      recipientIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
      rootKeyHex: root.toHex(),
      senderIdentityKey: root.toPublicKey().toString(),
      txid: 'b'.repeat(64),
      itemName: 'Card',
      atomicBeef: [1, 2, 3],
      ...(ancestryComplete ? { ancestryComplete } : {}),
    })
  }

  it('completes local ancestry for a lone card', async () => {
    await notify()
    expect(beefCache.mergeLocalUnconfirmedAncestry).toHaveBeenCalledTimes(1)
  })

  it('leaves a batch package the caller already completed alone', async () => {
    const result = await notify(true)
    expect(beefCache.mergeLocalUnconfirmedAncestry).not.toHaveBeenCalled()
    expect(result.beefInBox).toBe(true)
  })
})
