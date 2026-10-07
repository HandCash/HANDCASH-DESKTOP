import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'

const registerSignedSend = vi.fn()
const propagateSignedSend = vi.fn()
const pinBroadcastLocalTx = vi.fn()
const txHadArcadeSubmitContact = vi.fn()

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: (...a: unknown[]) => registerSignedSend(...a),
  propagateSignedSend: (...a: unknown[]) => propagateSignedSend(...a),
}))
vi.mock('./staleOutputRelease', () => ({
  pinBroadcastLocalTx: (...a: unknown[]) => pinBroadcastLocalTx(...a),
}))
vi.mock('./arcadeSubmitGuard', () => ({
  txHadArcadeSubmitContact: (...a: unknown[]) => txHadArcadeSubmitContact(...a),
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

async function post() {
  const { postForeignInputAction } = await import('./foreignInputAction')
  return postForeignInputAction({
    active,
    spendKey: KEY,
    inputBeef: beefOf(source),
    inputs: [{ outpoint: `${sourceTxid}.0`, txid: sourceTxid, vout: 0, satoshis: 1, sourceLock: lock, description: 'tip' }],
    outputs: [{ lockingScript: lock.toHex(), satoshis: 1, outputDescription: 'tip' }],
    labels: ['legacy-import'],
    description: 'Import',
  })
}

describe('postForeignInputAction', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const fn of [registerSignedSend, propagateSignedSend, pinBroadcastLocalTx, txHadArcadeSubmitContact, createAction, abortAction]) {
      fn.mockReset()
    }
    createAction.mockResolvedValue({ txid: signedTxid, tx: beefOf(signed) })
    registerSignedSend.mockImplementation(async (args: unknown) => ({ handle: args }))
  })

  it('keeps the Toolbox from broadcasting and hands the cheque to the lifecycle', async () => {
    propagateSignedSend.mockResolvedValue({ kind: 'accepted' })
    txHadArcadeSubmitContact.mockReturnValue(true)
    pinBroadcastLocalTx.mockResolvedValue(true)

    await expect(post()).resolves.toEqual({ txid: signedTxid, propagation: 'accepted' })
    expect(createAction.mock.calls[0]![0]).toMatchObject({ options: { noSend: true, signAndProcess: false } })
    expect(registerSignedSend).toHaveBeenCalledWith({
      txid: signedTxid,
      atomicBeef: [1, 2, 3],
      durableBody: [4, 5],
      flow: 'legacy_import',
    })
    expect(pinBroadcastLocalTx).toHaveBeenCalledWith(signedTxid, [1, 2, 3])
  })

  it.each([
    ['queued for retry', { kind: 'queued' }, true],
    ['untracked by every miner', { kind: 'untracked' }, true],
    ['accepted without Arcade contact', { kind: 'accepted' }, false],
  ])('answers propagating when %s and never pins its change', async (_label, submitted, contact) => {
    propagateSignedSend.mockResolvedValue(submitted)
    txHadArcadeSubmitContact.mockReturnValue(contact)

    await expect(post()).resolves.toEqual({ txid: signedTxid, propagation: 'propagating' })
    expect(pinBroadcastLocalTx).not.toHaveBeenCalled()
  })

  it('never aborts a signed cheque, even when a miner proves it rejected', async () => {
    propagateSignedSend.mockRejectedValue(new Error('ARC rejected'))

    await expect(post()).rejects.toThrow('ARC rejected')
    expect(abortAction).not.toHaveBeenCalled()
  })
})
