import type { WalletInterface } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBrc100Request } from './brc100Handler'
import { requestActionApproval } from './permissions'
import { claimCloudHandlePayload } from './handleClaim'
import type { WalletRuntime } from './walletRuntime'

const KEY = `02${'a'.repeat(64)}`
const TICKET = 'eyJ2IjoxfQ.c2lnbmF0dXJl'

vi.stubGlobal('window', {})
vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()),
  gateOriginAccess: vi.fn(async () => 'allow' as const),
  connectedAppChannel: () => null,
  requestActionApproval: vi.fn(async () => 'allow' as const),
}))
vi.mock('./walletRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./walletRuntime')>()),
  runtimeIsCurrent: () => true,
}))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  getActiveWallet: () => ({ identityKey: KEY }),
}))
vi.mock('./handleClaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./handleClaim')>()),
  claimCloudHandlePayload: vi.fn(async ({ handle }: { handle: string }) => ({
    handle,
    display: `@${handle}@brc-cloud.bcryderman.workers.dev`,
    identityKey: KEY,
    claimedAt: 1,
    certificate: { type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=', subject: KEY, signature: '3044' },
  })),
}))

function runtime(): WalletRuntime {
  return {
    runtimeId: 'live',
    signal: new AbortController().signal,
    instance: { wallet: {} as WalletInterface, identityKey: KEY },
  } as unknown as WalletRuntime
}

function issue(body: unknown) {
  return handleBrc100Request(
    {
      method: 'POST',
      path: '/issueHandle',
      headers: { originator: 'apps.alignity.test', origin: 'https://apps.alignity.test' },
      body: JSON.stringify(body),
      request_id: 7,
    },
    runtime(),
  )
}

beforeEach(() => {
  vi.mocked(requestActionApproval).mockClear()
  vi.mocked(claimCloudHandlePayload).mockClear()
})

describe('issueHandle over the BRC-100 bridge', () => {
  it('prompts with the scope, claims with the ticket and answers the certificate', async () => {
    const res = await issue({ handle: 'alignity', identityKey: KEY, claimTicket: TICKET })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ handle: 'alignity', identityKey: KEY, certificate: { signature: '3044' } })
    expect(vi.mocked(requestActionApproval).mock.calls[0]?.slice(0, 3)).toEqual([
      'apps.alignity.test',
      'issueHandle',
      { handle: 'alignity', identityKey: KEY },
    ])
    expect(claimCloudHandlePayload).toHaveBeenCalledWith({ handle: 'alignity', claimTicket: TICKET })
  })

  it('answers a refusal as a coded error, without claiming', async () => {
    vi.mocked(requestActionApproval).mockResolvedValueOnce('deny')
    const res = await issue({ handle: 'alignity', identityKey: KEY, claimTicket: TICKET })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'error', code: 'HANDLE_ISSUE_REFUSED' })
    expect(claimCloudHandlePayload).not.toHaveBeenCalled()
  })

  it('answers a key the wallet does not sign with before prompting', async () => {
    const res = await issue({ handle: 'alignity', identityKey: `03${'b'.repeat(64)}`, claimTicket: TICKET })
    expect(JSON.parse(res.body).code).toBe('HANDLE_ISSUE_WRONG_KEY')
    expect(requestActionApproval).not.toHaveBeenCalled()
  })
})
