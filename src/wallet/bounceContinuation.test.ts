import { describe, expect, it, vi } from 'vitest'
import {
  bounceDepositFromCreateAction,
  bounceRefundUrl,
  continueTxBounceRefund,
} from './bounceContinuation'

const HOST = 'brc-cloud.bcryderman.workers.dev'
const PAYEE = `02${'ab'.repeat(32)}`
const SENDER = `03${'cd'.repeat(32)}`
const TXID = 'aa'.repeat(32)

function depositRequest() {
  return {
    outputs: [
      {
        customInstructions: JSON.stringify({
          derivationPrefix: 'abc',
          derivationSuffix: 'def',
          payee: PAYEE,
        }),
      },
    ],
  }
}

describe('bounce continuation', () => {
  it('recognises only a bounce deposit from an allowed host', () => {
    expect(bounceDepositFromCreateAction(depositRequest())).toEqual({
      derivationPrefix: 'abc',
      derivationSuffix: 'def',
    })
    expect(bounceDepositFromCreateAction({ outputs: [{ satoshis: 1 }] })).toBeNull()
    expect(bounceDepositFromCreateAction({ outputs: [{ customInstructions: '{"payee":"02"}' }] })).toBeNull()
    expect(bounceRefundUrl(HOST)).toBe(`https://${HOST}/v1/tx-bounce/refund`)
    expect(bounceRefundUrl('evil.example')).toBeNull()
    expect(bounceRefundUrl('localhost:8787')).toBe('http://localhost:8787/v1/tx-bounce/refund')
  })

  it('posts the refund and credits it without a second page round trip', async () => {
    const internalize = vi.fn(async () => ({}))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        atomicBeef: [1, 2, 3],
        outputIndex: 0,
        refundTxid: 'bb'.repeat(32),
        remittance: { derivationPrefix: 'r1', derivationSuffix: 'r2' },
        senderIdentityKey: PAYEE,
      }),
    }))
    await continueTxBounceRefund({
      originator: HOST,
      request: depositRequest(),
      result: { txid: TXID, tx: [9, 9] },
      identityKey: SENDER,
      internalize,
      fetchImpl: fetchImpl as never,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://${HOST}/v1/tx-bounce/refund`)
    expect(JSON.parse(String(init.body))).toMatchObject({
      txid: TXID,
      atomicBeef: [9, 9],
      outputIndex: 0,
      senderIdentityKey: SENDER,
      derivationPrefix: 'abc',
      derivationSuffix: 'def',
    })
    expect(internalize).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: [1, 2, 3],
        outputs: [
          expect.objectContaining({
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: 'r1',
              derivationSuffix: 'r2',
              senderIdentityKey: PAYEE,
            },
          }),
        ],
      }),
    )
  })

  it('leaves an ordinary payment alone', async () => {
    const fetchImpl = vi.fn()
    await continueTxBounceRefund({
      originator: HOST,
      request: { outputs: [{ satoshis: 1000, lockingScript: '00' }] },
      result: { txid: TXID, tx: [1] },
      identityKey: SENDER,
      internalize: vi.fn(),
      fetchImpl: fetchImpl as never,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats an already-credited refund as done', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ atomicBeef: [1], outputIndex: 0, refundTxid: TXID, remittance: {}, senderIdentityKey: PAYEE }),
    }))
    await expect(
      continueTxBounceRefund({
        originator: HOST,
        request: depositRequest(),
        result: { txid: TXID, tx: [1] },
        identityKey: SENDER,
        internalize: async () => {
          throw new Error('transaction already internalized')
        },
        fetchImpl: fetchImpl as never,
      }),
    ).resolves.toBeUndefined()
  })
})
