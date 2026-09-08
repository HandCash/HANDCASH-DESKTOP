import {
  PrivateKey,
  Transaction,
  UnlockingScript,
  type WalletInterface,
} from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { broadcastAtomicBeef, calls } = vi.hoisted(() => ({
  broadcastAtomicBeef: vi.fn(),
  calls: [] as string[],
}))

vi.mock('./sendBrc29Payment', () => ({
  broadcastAtomicBeef: (...args: unknown[]) =>
    broadcastAtomicBeef(...args),
}))

vi.mock('./legacyBeef', () => ({
  withVisibleOnChainBeef: async <T>(work: () => Promise<T>) => {
    calls.push('validate')
    return work()
  },
}))

function atomicFixture(): { txid: string; atomic: number[] } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: 'f'.repeat(64),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  transaction.addP2PKHOutput(
    PrivateKey.fromHex('1'.padStart(64, '0')).toAddress(),
    1_000,
  )
  return {
    txid: transaction.id('hex'),
    atomic: Array.from(transaction.toAtomicBEEF()),
  }
}

describe('internalizeActionWithBroadcast', () => {
  beforeEach(() => {
    calls.length = 0
    broadcastAtomicBeef.mockReset()
    broadcastAtomicBeef.mockImplementation(async () => {
      calls.push('broadcast')
      return true
    })
  })

  it('accepts locally before broadcasting without an explorer gate', async () => {
    const { internalizeActionWithBroadcast } = await import(
      './internalizeBroadcast'
    )
    const fixture = atomicFixture()
    const internalizeAction = vi.fn(async () => {
      calls.push('internalize')
      return { accepted: true }
    })
    const wallet = { internalizeAction } as unknown as WalletInterface
    const args = { tx: fixture.atomic, outputs: [] }

    await expect(
      internalizeActionWithBroadcast(wallet, args, 'example.com'),
    ).resolves.toEqual({ accepted: true })

    expect(calls).toEqual(['validate', 'internalize', 'broadcast'])
    expect(broadcastAtomicBeef).toHaveBeenCalledWith(
      fixture.txid,
      fixture.atomic,
    )
  })

  it('refuses malformed Atomic BEEF before wallet mutation or broadcast', async () => {
    const { internalizeActionWithBroadcast } = await import(
      './internalizeBroadcast'
    )
    const internalizeAction = vi.fn()
    const wallet = { internalizeAction } as unknown as WalletInterface

    await expect(
      internalizeActionWithBroadcast(wallet, { tx: { 0: 1 } }),
    ).rejects.toThrow(/valid AtomicBEEF/)
    expect(internalizeAction).not.toHaveBeenCalled()
    expect(broadcastAtomicBeef).not.toHaveBeenCalled()
  })
})
