import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const mocks = vi.hoisted(() => ({
  cheque: vi.fn(() => null as number[] | null),
  conflict: vi.fn(async () => false),
  rejected: vi.fn(() => false),
  broadcast: vi.fn(async () => true),
}))

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./spendAnnounce', () => ({
  announceSpendCompleted: vi.fn(),
}))

vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => ({
    instance: { chain: 'main', address: '1SelfSendAddress' },
  }),
}))

vi.mock('./signedChequeArchive', () => ({
  signedChequeAtomic: (txid: string) => mocks.cheque(txid),
}))

vi.mock('./arcadeSubmitGuard', () => ({
  txIsArcadeRejected: (txid: string) => mocks.rejected(txid),
  signedTxSpendConflictIsProven: (args: { txid: string }) => mocks.conflict(args),
}))

vi.mock('./sendBrc29Payment', () => ({
  broadcastAtomicBeef: (...args: unknown[]) => mocks.broadcast(...args),
}))

import { clearAppActivity, listRecentActivity, noteInboundReceivePending } from './appActivity'
import { __resetGhostTxSuppressForTests, isGhostTxSuppressed } from './ghostTxSuppress'
import {
  reconcileSelfSendReceive,
  reconcileStuckSelfSendReceives,
  resetSelfSendReceiveForTests,
  SELF_SEND_RECEIVE_GRACE_MS,
} from './selfSendReceive'

const TX = 'ab'.repeat(32)

function agePastGrace(): number {
  return Date.now() + SELF_SEND_RECEIVE_GRACE_MS + 50
}

function pinTokenReceive(): void {
  noteInboundReceivePending({
    txid: TX,
    item: true,
    token: { tokenId: 'tid_0', amount: '5', sym: 'KING', dec: 0 },
  })
}

describe('reconcileSelfSendReceive', () => {
  beforeEach(() => {
    store.clear()
    clearAppActivity()
    __resetGhostTxSuppressForTests()
    resetSelfSendReceiveForTests()
    mocks.cheque.mockReset()
    mocks.cheque.mockReturnValue(null)
    mocks.conflict.mockReset()
    mocks.conflict.mockResolvedValue(false)
    mocks.rejected.mockReset()
    mocks.rejected.mockReturnValue(false)
    mocks.broadcast.mockReset()
    mocks.broadcast.mockResolvedValue(true)
  })

  it('leaves a peer receive alone when this wallet did not sign it', async () => {
    pinTokenReceive()
    expect(await reconcileSelfSendReceive({ txid: TX, now: agePastGrace() })).toBe('wait')
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(listRecentActivity(10)).toHaveLength(1)
  })

  it('waits out the original send before touching a fresh self-send echo', async () => {
    mocks.cheque.mockReturnValue([1, 2, 3])
    pinTokenReceive()
    expect(await reconcileSelfSendReceive({ txid: TX })).toBe('wait')
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('hides an aged self-send receive whose inputs are already spent', async () => {
    mocks.cheque.mockReturnValue([9])
    mocks.conflict.mockResolvedValue(true)
    pinTokenReceive()
    expect(await reconcileStuckSelfSendReceives(agePastGrace())).toBe(1)
    expect(isGhostTxSuppressed(TX)).toBe(true)
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(listRecentActivity(10)).toHaveLength(0)
  })

  it('hides an Arcade-rejected self-send without posting it again', async () => {
    mocks.cheque.mockReturnValue([9])
    mocks.rejected.mockReturnValue(true)
    pinTokenReceive()
    expect(await reconcileSelfSendReceive({ txid: TX, now: agePastGrace() })).toBe('hidden')
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(listRecentActivity(10)).toHaveLength(0)
  })

  it('broadcasts a live self-send and restores the missing send row', async () => {
    mocks.cheque.mockReturnValue([4, 5])
    pinTokenReceive()
    expect(await reconcileSelfSendReceive({ txid: TX, now: agePastGrace() })).toBe('broadcast')
    expect(mocks.broadcast).toHaveBeenCalledWith(TX, [4, 5], { skipIfOnChain: true })
    const rows = listRecentActivity(10)
    const sent = rows.find((row) => row.kind === 'spent')
    expect(sent?.method).toBe('send-token')
    expect(sent?.note).toMatch(/KING/)
    expect(sent?.note).toMatch(/myself/)
    const receiving = rows.find((row) => row.kind === 'earned')
    expect(receiving?.status).toBe('pending')
    expect(await reconcileSelfSendReceive({ txid: TX, now: agePastGrace() })).toBe('broadcast')
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
  })

  it('hides the receive when the broadcast itself is rejected', async () => {
    mocks.cheque.mockReturnValue([4])
    mocks.broadcast.mockImplementation(async () => {
      const { rememberGhostTx } = await import('./ghostTxSuppress')
      rememberGhostTx(TX)
      return false
    })
    pinTokenReceive()
    expect(await reconcileSelfSendReceive({ txid: TX, now: agePastGrace() })).toBe('hidden')
    expect(listRecentActivity(10).some((row) => row.kind === 'earned')).toBe(false)
  })
})
