import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_CERTIFIER, TEST_CERTIFIER_PUB, useTestHandleCertifier } from './handleCertificate.fixture'
import {
  listedVerifiedIssuers,
  refreshVerifiedIssuers,
  resetVerifiedIssuersForTests,
  verifiedIssuerFor,
  verifiedIssuersMessage,
  verifyVerifiedIssuerList,
  type VerifiedIssuer,
} from './verifiedIssuers'

useTestHandleCertifier()

const bapId = (seed: number) => Utils.toBase58(Array.from({ length: 20 }, (_, i) => (seed * 31 + i) & 0xff))

async function signedList(
  entries: VerifiedIssuer[],
  updatedAt = '2026-10-01T00:00:00.000Z',
  certifier: ProtoWallet = TEST_CERTIFIER,
  certifierPub = TEST_CERTIFIER_PUB,
) {
  const body = { v: 1 as const, updatedAt, entries }
  const { signature } = await certifier.createSignature({
    data: verifiedIssuersMessage(body),
    protocolID: [2, 'handcash verified issuers'],
    keyID: '1',
    counterparty: 'anyone',
  })
  return { ...body, certifier: certifierPub, signature: Utils.toHex(signature) }
}

function serving(...bodies: unknown[]): typeof fetch {
  let i = 0
  return vi.fn(async () => new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]))) as never
}

beforeEach(() => {
  resetVerifiedIssuersForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyVerifiedIssuerList', () => {
  it('accepts a list signed by the pinned certifier', async () => {
    const list = await signedList([{ bapId: bapId(1), name: 'HandCash' }])
    expect(await verifyVerifiedIssuerList(list)).toMatchObject({ entries: list.entries })
  })

  it('refuses a tampered entry', async () => {
    const list = await signedList([{ bapId: bapId(1), name: 'HandCash' }])
    expect(await verifyVerifiedIssuerList({ ...list, entries: [{ bapId: bapId(2), name: 'HandCash' }] })).toBeNull()
  })

  it('refuses a list signed by another key, even when it names that key', async () => {
    const other = PrivateKey.fromHex('11'.repeat(32))
    const list = await signedList(
      [{ bapId: bapId(1), name: 'HandCash' }],
      undefined,
      new ProtoWallet(other),
      other.toPublicKey().toString(),
    )
    expect(await verifyVerifiedIssuerList(list)).toBeNull()
  })

  it('refuses a malformed BAP ID', async () => {
    const list = await signedList([{ bapId: 'not base58 0OIl', name: 'HandCash' }])
    expect(await verifyVerifiedIssuerList(list)).toBeNull()
  })
})

describe('refreshVerifiedIssuers', () => {
  it('adopts a valid list', async () => {
    const entry = { bapId: bapId(3), name: 'Studio' }
    await refreshVerifiedIssuers(serving(await signedList([entry])), 'https://cloud.test')
    expect(verifiedIssuerFor(entry.bapId)).toEqual(entry)
    expect(listedVerifiedIssuers()).toEqual([entry])
  })

  it('refuses a list older than one already seen', async () => {
    const entry = { bapId: bapId(4), name: 'Removed later' }
    const newer = await signedList([], '2026-10-02T00:00:00.000Z')
    const replayed = await signedList([entry], '2026-10-01T00:00:00.000Z')
    const fetchImpl = serving(newer, replayed)
    await refreshVerifiedIssuers(fetchImpl, 'https://cloud.test')
    await refreshVerifiedIssuers(fetchImpl, 'https://cloud.test')
    expect(verifiedIssuerFor(entry.bapId)).toBeNull()
    expect(listedVerifiedIssuers()).toEqual([])
  })

  it('keeps the previous list when the server answers with a forged one', async () => {
    const entry = { bapId: bapId(5), name: 'Studio' }
    const good = await signedList([entry])
    const forged = { ...(await signedList([entry], '2026-10-03T00:00:00.000Z')), entries: [] }
    const fetchImpl = serving(good, forged)
    await refreshVerifiedIssuers(fetchImpl, 'https://cloud.test')
    await refreshVerifiedIssuers(fetchImpl, 'https://cloud.test')
    expect(verifiedIssuerFor(entry.bapId)).toEqual(entry)
  })
})
