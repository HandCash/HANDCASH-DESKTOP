import { beforeEach, describe, expect, it, vi } from 'vitest'

const runExclusiveBurn = vi.hoisted(() => vi.fn())
vi.mock('./spendGuard', () => ({ runExclusiveBurn }))

vi.mock('./transactionTelemetry', () => ({
  recordPaymentProgressStage: vi.fn(),
  recordTransactionStage: vi.fn(),
}))

vi.mock('./appActivity', () => ({
  upsertAppActivity: vi.fn(),
  WALLET_ACTIVITY_ORIGIN: 'wallet',
  findPendingOutpointFlight: () => null,
  pendingOutpointFlightVerb: () => null,
}))

const TOKEN_ID = `${'ab'.repeat(32)}_0`

function burnArgs() {
  return {
    tokenId: TOKEN_ID,
    amount: '25',
    sym: 'BLACK',
    pendingId: 'burn-1',
    item: {
      name: 'BLACK',
      origin: TOKEN_ID,
      tokenId: TOKEN_ID,
      amt: '25',
      dec: 0,
      outpoint: `${'cd'.repeat(32)}_0`,
    },
  }
}

describe('BSV-21 burn progress', () => {
  beforeEach(() => {
    vi.resetModules()
    runExclusiveBurn.mockReset()
  })

  /**
   * runExclusiveBurn holds spend priority for the whole destroy, and the pill
   * reports any priority hold as "Waiting to send" unless the flow labels
   * itself. A burn is neither a send nor waiting.
   */
  it('announces Burning before it takes the spend region', async () => {
    const { getPaymentProgress } = await import('./paymentProgress')
    let atEntry: { phase: string; label: string | null } | null = null
    runExclusiveBurn.mockImplementation(async () => {
      const live = getPaymentProgress()
      atEntry = { phase: live.phase, label: live.label }
      throw new Error('stop after the priority hold')
    })

    const { burnBsv21Tokens } = await import('./token/burn')
    await expect(burnBsv21Tokens(burnArgs())).rejects.toThrow(
      'stop after the priority hold',
    )

    expect(atEntry).toEqual({ phase: 'preparing', label: 'Burning…' })
  })

  it('clears the burn pill when the destroy fails', async () => {
    const { getPaymentProgress } = await import('./paymentProgress')
    runExclusiveBurn.mockRejectedValue(new Error('createAction refused'))

    const { burnBsv21Tokens } = await import('./token/burn')
    await expect(burnBsv21Tokens(burnArgs())).rejects.toThrow(
      'createAction refused',
    )

    expect(getPaymentProgress().phase).toBe('idle')
  })

  it('clears the burn pill after a successful destroy', async () => {
    const { getPaymentProgress } = await import('./paymentProgress')
    runExclusiveBurn.mockResolvedValue({
      txid: 'ef'.repeat(32),
      recoveredSatoshis: 2,
    })

    const { burnBsv21Tokens } = await import('./token/burn')
    await expect(burnBsv21Tokens(burnArgs())).resolves.toMatchObject({
      recoveredSatoshis: 2,
    })

    expect(getPaymentProgress().phase).toBe('idle')
  })
})
