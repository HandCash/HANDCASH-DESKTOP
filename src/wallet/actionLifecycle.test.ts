import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptWalletActionId,
  beginAction,
  beginWalletAction,
  bridgeActionId,
  dismissAction,
  endWalletAction,
  hasBusyAction,
  listLiveActions,
  liveAction,
  liveActionForOutpoint,
  liveActionForTxid,
  resetLiveActionsForTests,
  subscribeLiveActions,
  walletAction,
} from './actionLifecycle'
import { clearPaymentProgress, setPaymentProgress } from './paymentProgress'
import { upsertAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'

afterEach(() => {
  clearPaymentProgress()
  resetLiveActionsForTests()
  vi.useRealTimers()
})

describe('actionLifecycle registry', () => {
  it('publishes one view per live action, newest first', () => {
    const seen: number[] = []
    const unsubscribe = subscribeLiveActions(() => seen.push(listLiveActions().length))
    beginAction({ id: 'action:1', origin: 'a.app', method: 'createAction', startedAt: 1 })
    beginAction({ id: 'action:2', origin: 'b.app', method: 'signAction', startedAt: 2 })
    expect(listLiveActions().map((view) => view.id)).toEqual(['action:2', 'action:1'])
    expect(seen).toEqual([1, 2])
    unsubscribe()
  })

  it('joins a bridge request to its row by id, txid and outpoint', () => {
    const handle = beginAction({
      id: bridgeActionId(7),
      origin: 'mint.example',
      method: 'createAction',
      description: 'Mint Fox #1',
    })
    handle.stage('signing')
    handle.txid('CD'.repeat(32))
    handle.touch([`${'cd'.repeat(32)}_0`])
    expect(liveActionForTxid('cd'.repeat(32))?.id).toBe('action:7')
    expect(liveActionForOutpoint(`${'cd'.repeat(32)}.0`)?.face).toBe('signing')
    expect(hasBusyAction()).toBe(true)
  })

  it('retires a settled action after a beat and a failed one after it can be read', () => {
    vi.useFakeTimers()
    const settled = beginAction({ id: 'action:1', origin: 'a.app', method: 'createAction' })
    const failed = beginAction({ id: 'action:2', origin: 'a.app', method: 'createAction' })
    settled.settle()
    failed.fail('Denied by policy')
    expect(listLiveActions().map((view) => view.face).sort()).toEqual(['failed', 'settled'])
    vi.advanceTimersByTime(1_600)
    expect(listLiveActions().map((view) => view.id)).toEqual(['action:2'])
    expect(listLiveActions()[0]?.error).toBe('Denied by policy')
    vi.advanceTimersByTime(8_000)
    expect(listLiveActions()).toEqual([])
  })

  it('never times out while the user is still approving, but does once the wallet is working', () => {
    vi.useFakeTimers()
    const approving = beginAction({ id: 'action:1', origin: 'a.app', method: 'createAction' })
    const working = beginAction({ id: 'action:2', origin: 'a.app', method: 'createAction' })
    working.stage('signing')
    vi.advanceTimersByTime(91_000)
    expect(approving.view().face).toBe('approving')
    expect(liveAction('action:2')?.view().face).toBe('failed')
  })

  it('dismisses a denial without a verdict', () => {
    beginAction({ id: 'action:1', origin: 'a.app', method: 'createAction' })
    dismissAction('action:1')
    expect(listLiveActions()).toEqual([])
  })

  it('lets a wallet send adopt the id of the row it writes', () => {
    beginWalletAction({ origin: WALLET_ACTIVITY_ORIGIN, method: 'payment', stage: 'preparing' })
    expect(walletAction()?.id.startsWith('wallet:')).toBe(true)
    const adopted = adoptWalletActionId('send-42')
    expect(adopted?.id).toBe('send-42')
    expect(adopted?.view().face).toBe('preparing')
    expect(walletAction()?.id).toBe('send-42')
    endWalletAction('settled')
    expect(walletAction()).toBeNull()
  })
})

describe('paymentProgress walks the shared lifecycle', () => {
  it('maps pill phases onto stages and settles when the pill clears', () => {
    setPaymentProgress('preparing', 'Waiting', 'aa.0')
    expect(walletAction()?.view().face).toBe('preparing')
    expect(walletAction()?.view().outpoints).toEqual(['aa.0'])
    setPaymentProgress('building')
    expect(walletAction()?.view().face).toBe('preparing')
    setPaymentProgress('signing')
    expect(walletAction()?.view().face).toBe('signing')
    setPaymentProgress('broadcasting')
    expect(walletAction()?.view().face).toBe('broadcasting')
    setPaymentProgress('finishing')
    expect(walletAction()?.view().face).toBe('settling')
    clearPaymentProgress()
    expect(walletAction()).toBeNull()
    expect(listLiveActions()[0]?.face).toBe('settled')
  })

  it('binds the pill to the first pending row the send writes', () => {
    setPaymentProgress('preparing', 'Waiting to send')
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1200,
      method: 'send',
      note: 'Sending to alice',
      status: 'pending',
      pendingId: 'send-live-1',
    })
    expect(walletAction()?.id).toBe('send-live-1')
    setPaymentProgress('signing')
    expect(liveAction('send-live-1')?.view().face).toBe('signing')
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1200,
      method: 'send',
      note: 'Sent to alice',
      status: 'complete',
      pendingId: 'send-live-1',
      txid: 'ee'.repeat(32),
    })
    // The row learning its txid is the action learning it.
    expect(liveAction('send-live-1')?.view().txid).toBe('ee'.repeat(32))
    clearPaymentProgress()
  })
})

describe('a signed action is a fact', () => {
  it('settles, never fails, when the wallet is slow after the txid exists', () => {
    vi.useFakeTimers()
    const signed = beginAction({ id: 'action:9', origin: 'a.app', method: 'createAction' })
    signed.stage('broadcasting')
    signed.txid('ab'.repeat(32))
    vi.advanceTimersByTime(91_000)
    expect(liveAction('action:9')?.view().face).toBe('settled')
    vi.advanceTimersByTime(1_600)
    expect(liveAction('action:9')).toBeNull()
  })
})
