import type { WalletInterface } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleBrc100Request } from './brc100Handler'
import { listLiveActions, resetLiveActionsForTests } from './actionLifecycle'
import type { WalletRuntime } from './walletRuntime'

vi.stubGlobal('window', {})
vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()),
  gateOriginAccess: vi.fn(async () => 'allow' as const),
  connectedAppChannel: () => null,
}))

const BNT_OUTPOINT = `${'ab'.repeat(32)}.0`

function staleRuntime(): WalletRuntime {
  const wallet = {
    listOutputs: vi.fn(async () => ({ totalOutputs: 1, outputs: [{ outpoint: BNT_OUTPOINT }] })),
  } as unknown as WalletInterface
  const signal = AbortSignal.abort()
  return { runtimeId: 'switched-away', signal, instance: { wallet, identityKey: '02'.padEnd(66, '1') } } as unknown as WalletRuntime
}

afterEach(() => resetLiveActionsForTests())

describe('BRC-100 bridge when the account changes mid-request', () => {
  it('answers 409 and leaves no action waiting in the activity list', async () => {
    const res = await handleBrc100Request(
      {
        method: 'POST',
        path: '/createAction',
        headers: { originator: 'app.example.com', origin: 'https://app.example.com' },
        body: JSON.stringify({ description: 'Pay', inputs: [{ outpoint: BNT_OUTPOINT }] }),
        request_id: 41,
      },
      staleRuntime(),
    )
    expect(res.status).toBe(409)
    expect(listLiveActions().filter((a) => a.face !== 'failed' && a.face !== 'settled')).toEqual([])
  })
})
