import type { WalletInterface } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { handleBrc100Request } from './brc100Handler'
import type { WalletRuntime } from './walletRuntime'

vi.stubGlobal('window', {})
vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()),
  gateOriginAccess: vi.fn(async () => 'allow' as const),
  connectedAppChannel: () => null,
}))
const migration = vi.hoisted(() => ({
  refreshLegacyAddressPayload: vi.fn(async () => ({ importedCount: 1 })),
  getLegacyAddressPayload: vi.fn(async () => ({ address: '1Legacy' })),
}))
vi.mock('./migration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./migration')>()),
  ...migration,
}))

vi.mock('./walletRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./walletRuntime')>()),
  runtimeIsCurrent: () => true,
}))

function runtime(): WalletRuntime {
  return {
    runtimeId: 'migration-write-test',
    signal: new AbortController().signal,
    instance: { wallet: {} as WalletInterface, identityKey: '02'.padEnd(66, '1') },
  } as unknown as WalletRuntime
}

const call = (method: string, host = 'market.handcash.io') =>
  handleBrc100Request(
    {
      method: 'POST',
      path: `/${method}`,
      headers: { originator: host, origin: `https://${host}` },
      body: JSON.stringify({ txids: ['ab'.repeat(32)] }),
      request_id: 7,
    },
    runtime(),
  )

describe('BRC-100 migration writes (Packet F)', () => {
  it('refreshLegacyAddress fails closed with a pending-review-unavailable code and ingests nothing', async () => {
    const res = await call('refreshLegacyAddress')
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'MIGRATION_PENDING_REVIEW_UNAVAILABLE' })
    expect(migration.refreshLegacyAddressPayload).not.toHaveBeenCalled()
  })

  it('a non-HandCash host is still refused by origin first', async () => {
    const res = await call('refreshLegacyAddress', 'app.example.com')
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'MIGRATION_ORIGIN_DENIED' })
  })

  it('the read-only legacy address stays available', async () => {
    const res = await call('getLegacyAddress')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ address: '1Legacy' })
  })
})
