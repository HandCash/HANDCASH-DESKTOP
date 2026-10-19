import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const durable = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => (durable.set(key, value), true),
}))
vi.mock('./accountLocalKeys', () => ({ accountLocalKeyFor: (key: string, o: { identityKey: string }) => `${o.identityKey.slice(0, 8)}:${key}` }))

const {
  WALLET_PROTOCOLS,
  coinRecipientSupport,
  parseWalletProtocolsRecord,
  publishWalletProtocols,
  resetPeerProtocolsCacheForTest,
  signWalletProtocols,
  walletProtocolsUrl,
} = await import('./walletProtocols')

const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString().toLowerCase()
const wallet = { rootKeyHex: root.toHex(), identityKey, accountIndex: 0, chain: 'main' } as Parameters<typeof publishWalletProtocols>[0]

let served: { status: number; body?: unknown } = { status: 404 }
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return new Response('{}', { status: served.status })
  return new Response(served.body === undefined ? '' : JSON.stringify(served.body), { status: served.status })
})

beforeEach(() => {
  durable.clear()
  resetPeerProtocolsCacheForTest()
  fetchMock.mockClear()
  served = { status: 404 }
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wallet protocols record (BRC-213 §7.2)', () => {
  it('names BSV-21 and a coin protocol for every chain the wallet holds', () => {
    expect(WALLET_PROTOCOLS).toEqual(['bsv21', 'coin:ltc', 'coin:bch', 'coin:btc', 'coin:doge'])
  })

  it('verifies only a record its identity signed', () => {
    const record = signWalletProtocols(root.toHex(), ['coin:btc', 'bsv21'], 1_000)
    expect(record.protocols).toEqual(['bsv21', 'coin:btc'])
    expect(parseWalletProtocolsRecord(record, identityKey)).toEqual(record)
    expect(parseWalletProtocolsRecord({ ...record, protocols: ['bsv21', 'coin:btc', 'coin:doge'] }, identityKey)).toBeNull()
    expect(parseWalletProtocolsRecord({ ...record, at: 2_000 }, identityKey)).toBeNull()
    expect(parseWalletProtocolsRecord(record, PrivateKey.fromRandom().toPublicKey().toString())).toBeNull()
    const forged = signWalletProtocols(PrivateKey.fromRandom().toHex(), ['coin:btc'], 1_000)
    expect(parseWalletProtocolsRecord({ ...forged, identityKey }, identityKey)).toBeNull()
  })

  it('publishes once per change and retries a failed publish', async () => {
    served = { status: 503 }
    expect(await publishWalletProtocols(wallet)).toBe('failed')
    served = { status: 200 }
    expect(await publishWalletProtocols(wallet)).toBe('published')
    expect(await publishWalletProtocols(wallet)).toBe('current')
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts).toHaveLength(2)
    const [url, init] = puts[1]!
    expect(url).toBe(walletProtocolsUrl(identityKey))
    expect(new Headers(init!.headers).get('X-HandCash-Identity')).toBe(identityKey)
    expect(parseWalletProtocolsRecord(JSON.parse(String(init!.body)), identityKey)?.protocols).toEqual([...WALLET_PROTOCOLS].sort())
  })

  it('a coin goes to an identity only when its signed record names the coin', async () => {
    const peer = PrivateKey.fromRandom()
    const peerKey = peer.toPublicKey().toString()
    served = { status: 200, body: signWalletProtocols(peer.toHex(), ['bsv21', 'coin:btc']) }
    expect(await coinRecipientSupport(peerKey, 'btc')).toEqual({ kind: 'supported' })
    expect(await coinRecipientSupport(peerKey, 'doge')).toEqual({ kind: 'unsupported' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('no record is unknown, a forged one or no answer is unchecked, and neither is cached as support', async () => {
    const peerKey = PrivateKey.fromRandom().toPublicKey().toString()
    expect(await coinRecipientSupport(peerKey, 'btc')).toEqual({ kind: 'unknown' })
    resetPeerProtocolsCacheForTest()
    served = { status: 200, body: signWalletProtocols(PrivateKey.fromRandom().toHex(), ['coin:btc']) }
    expect(await coinRecipientSupport(peerKey, 'btc')).toMatchObject({ kind: 'unreachable' })
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await coinRecipientSupport(peerKey, 'btc')).toEqual({ kind: 'unreachable', reason: 'offline' })
  })
})
