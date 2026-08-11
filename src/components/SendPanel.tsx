import { useEffect, useMemo, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { sendMachine } from '../machines/sendMachine'
import {
  amountToSats,
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  formatTypedAmount,
  getCachedUsdPerBsv,
  satsToUsd,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  addressFromIdentityKey,
  listFriends,
  searchFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import {
  assertSendableBalance,
  refreshSpendableBalance,
  sendSatsToAddress,
} from '../wallet/sendPayment'
import {
  requestSpendPriority,
  releaseSpendPriority,
} from '../wallet/walletCoordinator'
import {
  getPaymentProgress,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { parseHandleInput, resolveHandle } from '../wallet/handleResolve'
import { offlinePaymentBlockedMessage } from '../wallet/paymentPolicy'
import type { Chain } from '../wallet/vault'
import { CheckCircleIcon } from './icons'

type Props = {
  chain: Chain
  balanceSats: number
  /** Prefill from QR scan (PeerPay / identity / address). */
  initialRecipient?: string
  onSent: (balanceSats: number) => void
  onFail: (error: string) => void
  onClose: () => void
}

function shortenAddress(value: string): string {
  const v = value.trim()
  if (v.length <= 20) return v
  return `${v.slice(0, 10)}…${v.slice(-8)}`
}

export function SendPanel({
  chain,
  balanceSats,
  initialRecipient,
  onSent,
  onFail,
  onClose,
}: Props) {
  const [sendSnap, send] = useMachine(sendMachine)
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [showFriendMatches, setShowFriendMatches] = useState(false)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [offlineBlock, setOfflineBlock] = useState(() => offlinePaymentBlockedMessage())
  const [reviewBusy, setReviewBusy] = useState(false)
  const [paymentProgress, setPaymentProgressState] = useState(() => getPaymentProgress())
  const sendState = stateToAttr(sendSnap.value)
  const appliedPrefill = useRef(false)

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => subscribePaymentProgress(setPaymentProgressState), [])
  useEffect(() => {
    const sync = () => setOfflineBlock(offlinePaymentBlockedMessage())
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const isSuccess = sendSnap.matches('success')
  const isFailure = sendSnap.matches('failure')
  useEffect(() => {
    if (!isSuccess) return
    playPaymentSuccessSound()
  }, [isSuccess])
  useEffect(() => {
    if (!isFailure) return
    playWalletSound('error')
  }, [isFailure])

  const friendMatches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const amountSats = amountToSats(sendSnap.context.amount, currency, usdPerBsv)
  const amountLabel = formatTypedAmount(sendSnap.context.amount, currency)
  const amountSecondary =
    amountSats > 0 ? formatSecondaryFromSats(amountSats, currency, usdPerBsv) : null

  const canReview =
    !offlineBlock &&
    !reviewBusy &&
    sendSnap.context.to.trim().length > 0 &&
    amountSats > 0 &&
    (currency === 'bsv' || usdPerBsv != null)

  const goReview = async () => {
    if (reviewBusy || offlineBlock) return
    setReviewBusy(true)
    playWalletSound('soft')
    try {
      const satoshis = amountToSats(sendSnap.context.amount, currency, usdPerBsv)
      if (!Number.isFinite(satoshis) || satoshis <= 0) {
        throw new Error(
          currency === 'usd' && usdPerBsv == null
            ? 'USD rate unavailable'
            : 'Invalid amount',
        )
      }
      // Trust the painted balance when it already covers the amount — avoid a
      // toolbox listOutputs stall while sync holds IndexedDB. Confirm re-checks.
      if (satoshis <= balanceSats) {
        send({ type: 'REVIEW' })
        return
      }
      requestSpendPriority()
      try {
        const available = await assertSendableBalance(satoshis)
        onSent(available)
        send({ type: 'REVIEW' })
      } finally {
        releaseSpendPriority()
      }
    } catch (err) {
      playWalletSound('error')
      onFail(err instanceof Error ? err.message : String(err))
      try {
        requestSpendPriority()
        const available = await refreshSpendableBalance()
        onSent(available)
      } catch {
        // ignore secondary refresh failure
      } finally {
        releaseSpendPriority()
      }
    } finally {
      setReviewBusy(false)
    }
  }

  const recipientLabel =
    sendSnap.context.friendLabel || shortenAddress(sendSnap.context.to)

  const selectFriend = (friend: Friend) => {
    try {
      const address = addressFromIdentityKey(friend.identityKey, chain)
      setRecipientQuery(friend.label)
      setShowFriendMatches(false)
      send({ type: 'EDIT', to: address, friendLabel: friend.label })
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err))
    }
  }

  const applyRecipientInput = (value: string) => {
    setRecipientQuery(value)
    setShowFriendMatches(true)
    const peer = tryParsePeerPayUri(value)
    if (peer) {
      try {
        const address = addressFromIdentityKey(peer.identityKey, chain)
        const patch: { to: string; friendLabel: null; amount?: string } = {
          to: address,
          friendLabel: null,
        }
        if (peer.sats != null) {
          if (currency === 'usd' && usdPerBsv != null && usdPerBsv > 0) {
            const usd = satsToUsd(peer.sats, usdPerBsv)
            patch.amount = String(Number(usd.toFixed(4)))
          } else {
            patch.amount = String(peer.sats / 1e8)
          }
        }
        send({ type: 'EDIT', ...patch })
        return
      } catch (err) {
        onFail(err instanceof Error ? err.message : String(err))
      }
    }
    if (parseHandleInput(value)) {
      void (async () => {
        try {
          const resolved = await resolveHandle(value)
          const address = addressFromIdentityKey(resolved.identityKey, chain)
          send({ type: 'EDIT', to: address, friendLabel: resolved.display })
        } catch (err) {
          onFail(err instanceof Error ? err.message : String(err))
        }
      })()
      return
    }
    send({ type: 'EDIT', to: value.trim(), friendLabel: null })
  }

  useEffect(() => {
    if (appliedPrefill.current || !initialRecipient?.trim()) return
    appliedPrefill.current = true
    applyRecipientInput(initialRecipient.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecipient])

  const confirmSend = async () => {
    send({ type: 'CONFIRM' })
    try {
      const satoshis = amountToSats(sendSnap.context.amount, currency, usdPerBsv)
      if (!Number.isFinite(satoshis) || satoshis <= 0) {
        throw new Error(
          currency === 'usd' && usdPerBsv == null
            ? 'USD rate unavailable'
            : 'Invalid amount',
        )
      }

      const to = sendSnap.context.to.trim()
      const { txid, balanceSats: nextBalance } = await sendSatsToAddress({
        to,
        satoshis,
        friendLabel: sendSnap.context.friendLabel,
      })

      send({ type: 'SUCCESS', txid })
      onSent(nextBalance)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
      try {
        const available = await refreshSpendableBalance()
        onSent(available)
      } catch {
        // ignore — still show send failure
      }
    }
  }

  return (
    <div className="nav-child-panel send-panel" data-aeon-scope="send" data-aeon-state={sendState}>
      {offlineBlock ? (
        <p className="wallet-sync-note is-error" role="alert">
          {offlineBlock}
        </p>
      ) : null}
      {sendSnap.matches('editing') && (
        <div className="send-stage send-stage-edit">
          <div className="send-layout">
            <div className="send-amount-hero" data-currency={currency}>
              <label htmlFor="amount" className="send-amount-label">
                Amount
              </label>
              <div className="send-amount-row">
                <input
                  id="amount"
                  className="send-amount-input"
                  inputMode="decimal"
                  value={sendSnap.context.amount}
                  onChange={(e) => send({ type: 'EDIT', amount: e.target.value })}
                  placeholder="0"
                  autoFocus
                  aria-label={currency === 'usd' ? 'Amount in USD' : 'Amount in BSV'}
                />
              </div>
              <p className="send-amount-unit" aria-hidden>
                {currency === 'usd' ? 'USD' : 'BSV'}
              </p>
              {amountSecondary ? (
                <p className="send-amount-secondary">≈ {amountSecondary}</p>
              ) : null}
              <p className="send-available">
                Available {formatPrimaryFromSats(balanceSats, currency, usdPerBsv)} ·{' '}
                {formatSecondaryFromSats(balanceSats, currency, usdPerBsv)}
                {reviewBusy ? ' · refreshing…' : ''}
              </p>
              {currency === 'usd' && usdPerBsv == null ? (
                <p className="send-amount-warning">USD rate unavailable — switch to BSV or refresh</p>
              ) : null}
            </div>

            <div className="send-side">
              <div className="field friend-recipient-field send-to-field">
                <label htmlFor="to">To</label>
                <input
                  id="to"
                  value={recipientQuery}
                  onChange={(e) => applyRecipientInput(e.target.value)}
                  onFocus={() => setShowFriendMatches(true)}
                  onBlur={() => {
                    window.setTimeout(() => setShowFriendMatches(false), 120)
                  }}
                  placeholder="Friend, $handle, peerpay:, address, or identity key"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="friend-recipient-hint send-recipient-hint">
                  PeerPay links, $handles, and identity keys resolve to a payment address on this network.
                </p>
                {sendSnap.context.friendLabel && (
                  <p className="friend-recipient-hint">
                    Sending to <strong>{sendSnap.context.friendLabel}</strong>
                  </p>
                )}
                {showFriendMatches && friendMatches.length > 0 && (
                  <ul className="friend-suggest-list send-friend-suggest" role="listbox">
                    {friendMatches.map((friend) => (
                      <li key={friend.id}>
                        <button
                          type="button"
                          className="friend-suggest-item"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => selectFriend(friend)}
                        >
                          <strong>{friend.label}</strong>
                          <span className="mono">{friend.identityKey.slice(0, 16)}…</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="actions send-actions">
                <button
                  className="btn btn-primary"
                  disabled={!canReview}
                  onClick={() => void goReview()}
                >
                  {reviewBusy ? 'Checking balance…' : 'Review'}
                </button>
                <button className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sendSnap.matches('confirming') && (
        <div className="send-stage send-stage-confirm">
          <div className="send-layout send-layout-confirm">
            <div className="send-amount-hero">
              <p className="send-eyebrow">You’re sending</p>
              <p className="send-confirm-amount">{amountLabel}</p>
              {amountSecondary ? (
                <p className="send-amount-secondary">≈ {amountSecondary}</p>
              ) : null}
            </div>
            <div className="send-side">
              <p className="send-confirm-to">
                to <strong>{recipientLabel}</strong>
              </p>
              {sendSnap.context.friendLabel ? (
                <p className="mono send-confirm-address">{sendSnap.context.to}</p>
              ) : null}
              <div className="actions send-actions">
                <button className="btn btn-primary" onClick={() => void confirmSend()}>
                  Confirm
                </button>
                <button className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                  Back
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sendSnap.matches('broadcasting') && (
        <div className="send-stage send-stage-status">
          <div className="send-stage-body send-stage-body-center">
            <div className="send-spinner" aria-hidden />
            <p className="send-status-title">
              {paymentProgress.label ?? 'Sending…'}
            </p>
            <p className="send-status-sub">
              {paymentProgress.detail ?? 'Preparing your payment…'}
            </p>
          </div>
        </div>
      )}

      {sendSnap.matches('success') && (
        <div className="send-stage send-stage-success">
          <div className="send-stage-body send-stage-body-center">
            <div className="send-success-mark" aria-hidden>
              <CheckCircleIcon size={80} />
            </div>
            <p className="send-status-title">Sent</p>
            <p className="send-confirm-amount send-success-amount">{amountLabel}</p>
            {amountSecondary ? (
              <p className="send-amount-secondary">≈ {amountSecondary}</p>
            ) : null}
            <p className="send-confirm-to">
              to <strong>{recipientLabel}</strong>
            </p>
            {sendSnap.context.txid ? (
              <p className="mono send-txid" title={sendSnap.context.txid}>
                {shortenAddress(sendSnap.context.txid)}
              </p>
            ) : null}
          </div>
          <div className="actions send-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                send({ type: 'RESET' })
                onClose()
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {sendSnap.matches('failure') && (
        <div className="send-stage send-stage-failure">
          <div className="send-stage-body send-stage-body-center">
            <p className="send-status-title">Couldn’t send</p>
            <p className="error send-failure-error">{sendSnap.context.error}</p>
          </div>
          <div className="actions send-actions">
            <button className="btn btn-primary" onClick={() => send({ type: 'BACK' })}>
              Edit
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
