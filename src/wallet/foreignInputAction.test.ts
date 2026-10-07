import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'

const registerSignedSend = vi.fn()
const propagateSignedSend = vi.fn()
const awaitChainedLegFunding = vi.fn()
const noteForeignInputs = vi.fn()

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: (...a: unknown[]) => registerSignedSend(...a),
  propagateSignedSend: (...a: unknown[]) => propagateSignedSend(...a),
  awaitChainedLegFunding: (...a: unknown[]) => awaitChainedLegFunding(...a),
}))
vi.mock('./staleOutputRelease', () => ({
  noteForeignInputs: (...a: unknown[]) => noteForeignInputs(...a),
}))
vi.mock('./itemMigrateBundle', () => ({
  migratePackage: () => [1, 2, 3],
  migrateRetryBody: () => [4, 5],
  migrateTipPostBytes: () => 0,
}))

const KEY = PrivateKey.fromHex('22'.repeat(32))
const lock = new P2PKH().lock(KEY.toAddress())

function beefOf(tx: Transaction): number[] {
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef.toBinary()
}

const source = new Transaction()
source.addOutput({ satoshis: 1, lockingScript: lock })
const sourceTxid = source.id('hex')
const signed = new Transaction()
signed.addInput({ sourceTXID: sourceTxid, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
signed.addOutput({ satoshis: 1, lockingScript: lock })
const signedTxid = signed.id('hex')

const createAction = vi.fn()
const abortAction = vi.fn()
const active = { wallet: { createAction, abortAction } } as never

const actionArgs = () => ({
  active,
  spendKey: KEY,
  inputBeef: beefOf(source),
  inputs: [{ outpoint: `${sourceTxid}.0`, txid: sourceTxid, vout: 0, satoshis: 1, sourceLock: lock, description: 'tip' }],
  outputs: [{ lockingScript: lock.toHex(), satoshis: 1, outputDescription: 'tip' }],
  labels: ['legacy-import'],
  description: 'Import',
})

async function sign() {
  const { signForeignInputAction } = await import('./foreignInputAction')
  return signForeignInputAction(actionArgs())
}

async function post() {
  const { settleForeignInputAction } = await import('./foreignInputAction')
  return settleForeignInputAction(await sign())
}

describe('foreign-input action', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const fn of [registerSignedSend, propagateSignedSend, awaitChainedLegFunding, noteForeignInputs, createAction, abortAction]) {
      fn.mockReset()
    }
    createAction.mockResolvedValue({ txid: signedTxid, tx: beefOf(signed) })
    registerSignedSend.mockImplementation(async (args: unknown) => ({ handle: args }))
  })

  it('keeps the Toolbox from broadcasting and hands the cheque to the common flow', async () => {
    propagateSignedSend.mockResolvedValue({ kind: 'accepted' })
    awaitChainedLegFunding.mockResolvedValue(true)

    await expect(post()).resolves.toEqual({ txid: signedTxid, propagation: 'accepted' })
    expect(createAction.mock.calls[0]![0]).toMatchObject({ options: { noSend: true, signAndProcess: false } })
    expect(registerSignedSend).toHaveBeenCalledWith({
      txid: signedTxid,
      atomicBeef: [1, 2, 3],
      durableBody: [4, 5],
      flow: 'legacy_import',
    })
    expect(awaitChainedLegFunding).toHaveBeenCalledWith(signedTxid, [1, 2, 3])
    expect(noteForeignInputs).toHaveBeenCalledWith([`${sourceTxid}.0`])
    expect(noteForeignInputs.mock.invocationCallOrder[0]).toBeLessThan(registerSignedSend.mock.invocationCallOrder[0]!)
  })

  it('returns from signing once propagation has started, without waiting on miners', async () => {
    propagateSignedSend.mockReturnValue(new Promise(() => {}))

    const signedAction = await sign()

    expect(signedAction.txid).toBe(signedTxid)
    expect(propagateSignedSend).toHaveBeenCalledOnce()
    expect(awaitChainedLegFunding).not.toHaveBeenCalled()
  })

  it.each([
    ['queued for retry', { kind: 'queued' }],
    ['untracked by every miner', { kind: 'untracked' }],
    ['accepted without Arcade', { kind: 'accepted' }],
  ])('answers propagating when %s and the common flow never frees its change', async (_label, submitted) => {
    propagateSignedSend.mockResolvedValue(submitted)
    awaitChainedLegFunding.mockResolvedValue(false)

    await expect(post()).resolves.toEqual({ txid: signedTxid, propagation: 'propagating' })
  })

  it('never aborts a signed cheque, even when a miner proves it rejected', async () => {
    propagateSignedSend.mockRejectedValue(new Error('ARC rejected'))

    await expect(post()).rejects.toThrow('ARC rejected')
    expect(abortAction).not.toHaveBeenCalled()
    expect(awaitChainedLegFunding).not.toHaveBeenCalled()
  })
})
