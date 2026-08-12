import { describe, expect, it, vi, beforeEach } from 'vitest'

type CreateActionArgs = {
  options?: {
    acceptDelayedBroadcast?: boolean
    randomizeOutputs?: boolean
    signAndProcess?: boolean
    noSend?: boolean
    trustSelf?: 'known'
  }
  labels?: string[]
  outputs?: Array<{ customInstructions?: string; lockingScript?: string }>
}

const abortAction = vi.fn(async () => ({ aborted: true }))
const actionBatchAbort = vi.fn(async () => true)
const listNoSendActions = vi.fn(async () => ({ totalActions: 0, actions: [] }))
const createAction = vi.fn(async (_args: CreateActionArgs) => ({
  txid: 'b'.repeat(64),
  tx: [1, 2, 3],
  sendWithResults: [{ txid: 'b'.repeat(64), status: 'unproven' }],
}))
const internalizeAction = vi.fn(async () => ({ accepted: true }))
const getPublicKey = vi.fn(async (..._args: unknown[]) => ({
  publicKey:
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
}))
const createHmac = vi.fn(async (..._args: unknown[]) => ({
  hmac: Array.from({ length: 32 }, (_, i) => i),
}))
const prepareSpendHeal = vi.fn(async (_sats?: number) => 100_000)
const postBeef = vi.fn(async () => [
  { status: 'success', txidResults: [{ status: 'success' }] },
])
const notifyPeerBrc29Payment = vi.fn(
  async (): Promise<{ delivered: 'local' | 'cloud'; beefInBox: boolean }> => ({
    delivered: 'cloud',
    beefInBox: true,
  }),
)

const walletState = {
  identityKey: '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    identityKey: walletState.identityKey,
    rootKeyHex: 'ab'.repeat(32),
    services: { postBeef },
    wallet: {
      createAction: (args: CreateActionArgs) => createAction(args),
      abortAction,
      listNoSendActions,
      actionBatch: { abort: () => actionBatchAbort() },
      internalizeAction,
      getPublicKey: (...args: unknown[]) => getPublicKey(...args),
      createHmac: (...args: unknown[]) => createHmac(...args),
    },
  }),
  fetchBalanceSats: async () => 90_000,
}))

vi.mock('./messageTransport', () => ({
  notifyPeerBrc29Payment,
}))

vi.mock('./pendingBrc29Outbox', () => ({
  enqueuePendingBrc29Remit: vi.fn(),
  flushPendingBrc29Outbox: async () => 0,
}))

vi.mock('./spendGuard', () => ({
  runExclusiveSpend: <T>(fn: () => Promise<T>) => fn(),
  prepareSpendHeal: (sats?: number) => prepareSpendHeal(sats),
  assertSendableBalance: async () => 100_000,
  refreshSpendableBalance: async () => 100_000,
}))

vi.mock('./paymentPolicy', () => ({ assertOnlineForPayment: () => {} }))
vi.mock('./deviceSync', () => ({ scheduleHistoryBackupPush: () => {} }))
vi.mock('./appActivity', () => ({
  hasActivityTxid: () => false,
  hasSettledActivityTxid: () => false,
  recordAppActivity: () => {},
  upsertAppActivity: () => {},
  noteInboundReceivePending: () => {},
  noteInboundReceiveComplete: () => {},
  WALLET_ACTIVITY_ORIGIN: 'wallet',
  extractSatsFromArgs: () => 0,
}))
vi.mock('./pendingSend', () => ({
  beginPendingSend: () => ({ id: 'p1' }),
  completePendingSend: () => {},
  clearPendingSend: () => {},
}))
vi.mock('./staleOutputRelease', () => ({
  isAlreadySpentInputError: () => false,
  releaseStaleSpendableOutputs: async () => {},
}))
vi.mock('./messageStore', () => ({
  listThreads: () => [],
  listMessages: () => [],
  updateMessage: () => null,
}))
vi.mock('./walletHealth', () => ({ setSyncHealth: () => {} }))
vi.mock('./toast', () => ({ toastSuccess: () => {} }))

const PAYEE =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

describe('sendBrc29ToIdentityKey', () => {
  beforeEach(() => {
    createAction.mockClear()
    abortAction.mockClear()
    actionBatchAbort.mockClear()
    listNoSendActions.mockClear()
    internalizeAction.mockClear()
    getPublicKey.mockClear()
    createHmac.mockClear()
    postBeef.mockClear()
    notifyPeerBrc29Payment.mockClear()
    walletState.identityKey =
      '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  })

  it('broadcasts BRC-29 then delivers remittance to the payee', async () => {
    const { sendBrc29ToIdentityKey, BRC29_PROTOCOL_ID } = await import(
      './sendBrc29Payment'
    )
    const result = await sendBrc29ToIdentityKey({
      payeeIdentityKey: PAYEE,
      satoshis: 1_000,
      friendLabel: 'Alice',
    })

    expect(result.txid).toBe('b'.repeat(64))
    expect(result.remittance.derivationPrefix).toBeTruthy()
    expect(result.remittance.derivationSuffix).toBeTruthy()
    expect(result.remittance.outputIndex).toBe(0)

    expect(getPublicKey).toHaveBeenCalled()
    const pkArgs = getPublicKey.mock.calls[0]?.[0] as unknown as {
      protocolID: unknown
      keyID: string
      counterparty: string
    }
    expect(pkArgs.protocolID).toEqual(BRC29_PROTOCOL_ID)
    expect(pkArgs.counterparty).toBe(PAYEE)
    expect(pkArgs.keyID).toContain(' ')

    expect(createAction).toHaveBeenCalledTimes(1)
    const args = createAction.mock.calls[0]?.[0] as CreateActionArgs | undefined
    expect(args?.options?.noSend).toBeUndefined()
    expect(args?.options?.signAndProcess).toBe(true)
    expect(args?.options?.acceptDelayedBroadcast).toBe(true)
    expect(args?.options?.randomizeOutputs).toBe(false)
    expect(args?.labels).toEqual(expect.arrayContaining(['brc29', 'handcash-send']))
    const instructions = JSON.parse(args?.outputs?.[0]?.customInstructions || '{}')
    expect(instructions.derivationPrefix).toBe(result.remittance.derivationPrefix)
    expect(instructions.derivationSuffix).toBe(result.remittance.derivationSuffix)
    expect(instructions.payee).toBe(PAYEE)
    expect(internalizeAction).not.toHaveBeenCalled()
    expect(notifyPeerBrc29Payment).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientIdentityKey: PAYEE,
        atomicBeef: [1, 2, 3],
        txid: 'b'.repeat(64),
      }),
    )
    expect(result.selfReceived).toBe(false)
    expect(result.peerDelivered).toBe(true)
  })

  it('still succeeds when remittance is in the box without inline BEEF', async () => {
    notifyPeerBrc29Payment.mockResolvedValueOnce({
      delivered: 'cloud',
      beefInBox: false,
    })
    const { sendBrc29ToIdentityKey } = await import('./sendBrc29Payment')
    const result = await sendBrc29ToIdentityKey({
      payeeIdentityKey: PAYEE,
      satoshis: 1_000,
    })
    expect(result.peerDelivered).toBe(true)
    expect(notifyPeerBrc29Payment).toHaveBeenCalled()
  })

  it('keeps the broadcast tx when the inbox is unreachable (no second payment)', async () => {
    notifyPeerBrc29Payment.mockResolvedValueOnce({
      delivered: 'local' as const,
      beefInBox: false,
    })
    const { sendBrc29ToIdentityKey } = await import('./sendBrc29Payment')
    const result = await sendBrc29ToIdentityKey({
      payeeIdentityKey: PAYEE,
      satoshis: 1_000,
    })
    expect(result.peerDelivered).toBe(false)
    expect(result.txid).toBe('b'.repeat(64))
    expect(createAction).toHaveBeenCalledTimes(1)
    expect(abortAction).not.toHaveBeenCalled()
  })

  it('internalizes immediately when paying this wallet', async () => {
    walletState.identityKey = PAYEE
    const { sendBrc29ToIdentityKey } = await import('./sendBrc29Payment')
    const result = await sendBrc29ToIdentityKey({
      payeeIdentityKey: PAYEE,
      satoshis: 1_000,
    })

    expect(result.selfReceived).toBe(true)
    expect(notifyPeerBrc29Payment).toHaveBeenCalled()
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: [1, 2, 3],
        labels: ['brc29'],
        outputs: [
          expect.objectContaining({
            protocol: 'wallet payment',
            paymentRemittance: expect.objectContaining({
              senderIdentityKey: PAYEE,
            }),
          }),
        ],
      }),
    )
  })
})

describe('internalizeBrc29Payment', () => {
  it('calls internalizeAction wallet payment with remittance', async () => {
    const internalizeAction = vi.fn(async () => ({ accepted: true }))
    const toBinaryAtomic = vi.fn(() => [1, 2, 3])
    vi.resetModules()
    vi.doMock('./session', () => ({
      getActiveWallet: () => ({
        chain: 'main',
        services: {
          postBeef: async () => [
            { status: 'success', txidResults: [{ status: 'success' }] },
          ],
        },
        wallet: { internalizeAction },
      }),
      fetchBalanceSats: async () => 91_000,
    }))
    vi.doMock('./beefCache', () => ({
      getBeefForTxidCached: async () => ({ toBinaryAtomic }),
    }))

    const { internalizeBrc29Payment } = await import('./sendBrc29Payment')
    const result = await internalizeBrc29Payment({
      txid: 'c'.repeat(64),
      remittance: {
        derivationPrefix: 'pre',
        derivationSuffix: 'suf',
        outputIndex: 0,
      },
      senderIdentityKey: PAYEE,
      satoshis: 500,
    })

    expect(result.accepted).toBe(true)
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['brc29'],
        outputs: [
          expect.objectContaining({
            protocol: 'wallet payment',
            outputIndex: 0,
            paymentRemittance: {
              derivationPrefix: 'pre',
              derivationSuffix: 'suf',
              senderIdentityKey: PAYEE,
            },
          }),
        ],
      }),
    )
  })
})
