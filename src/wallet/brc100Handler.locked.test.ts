import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBrc100Request } from './brc100Handler'
import { resetAccountLocalKeyScopeForTests } from './accountLocalKeys'

vi.stubGlobal('window', {})

beforeEach(() => {
  // A locked wallet has no account bound, so account storage is unreadable.
  resetAccountLocalKeyScopeForTests()
})

const call = (method: string) =>
  handleBrc100Request(
    {
      method: 'POST',
      path: `/${method}`,
      headers: { originator: 'deposit.example.com', origin: 'https://deposit.example.com' },
      body: '{}',
      request_id: 1,
    },
    null,
  )

describe('BRC-100 bridge while locked', () => {
  it.each(['listLtcDeposits', 'getLtcDepositAddress', 'listOutputs', 'createAction'])(
    '%s answers WALLET_LOCKED instead of reading account storage',
    async (method) => {
      const res = await call(method)
      expect(res.status).toBe(503)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'WALLET_LOCKED' })
    },
  )
})
