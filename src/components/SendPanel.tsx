import { useEffect, useMemo, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { ListRow } from '@aeon-ui/react'
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
  toggleDisplayCurrency,
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
  assertSendableBalanceForReview,
  refreshSpendableBalance,
  sendSatsToAddress,
} from '../wallet/sendPayment'
import {
  claimBrc29SettlementUri,
  sendBrc29ToIdentityKey,
} from '../wallet/sendBrc29Payment'
import { tryParseBrc29SettlementUri } from '../wallet/brc29Uri'
import { toastSuccess } from '../wallet/toast'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { parseHandleInput, createHandleResolveDebouncer } from '../wallet/handleResolve'
import { offlinePaymentBlockedMessage } from '../wallet/paymentPolicy'
import type { Chain } from '../wallet/vault'
import { useDisplayBalanceSats } from '../hooks/useDisplayBalanceSats'
import { releaseWarmedQrCamera } from '../wallet/qrCameraWarm'
import { FriendsIcon, ScanQrIcon } from './icons'
import { RecipientQrScan } from './QrScanner'

type Props = {
  chain: Chain
  identityKey: string
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

function trimAmountInput(raw: number): string {
  const formatted = raw.toFixed(8)
  if (!formatted.includes('.')) return formatted
  let end = formatted.length
  while (end > 0 && formatted[end - 1] === '0') end -= 1
  if (end > 0 && formatted[end - 1] === '.') end -= 1
  return formatted.slice(0, end)
}

const REVIEW_BALANCE_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(id)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(id)
        reject(err)
      },
    )
  })
}

/** Keep the satoshi value when the send form swaps USD <-> BSV. */
function amountInputFromSats(
  sats: number,
  currency: DisplayCurrency,
  usdPerBsv: number | null,
): string {
  if (!(sats > 0)) return ''
  const raw =
    currency === 'usd'
      ? usdPerBsv != null && usdPerBsv > 0
        ? satsToUsd(sats, usdPerBsv)
        : null
      : sats / 1e8
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return ''
  return trimAmountInput(raw)
}

function resolvedRecipientName(
  friendLabel: string | null,
  to: string,
  payeeIdentityKey: string | null,
): string | null {
  if (friendLabel) return friendLabel
  if (payeeIdentityKey) return shortenAddress(to)
  const trimmed = to.trim()
  if (trimmed.length >= 26) return shortenAddress(trimmed)
  return null
}

export function SendPanel({
  chain,
  identityKey,
  initialRecipient,
  onSent,
  onFail,
  onClose,
}: Props) {
  const balanceSats = useDisplayBalanceSats({ identityKey, chain })
  const [sendSnap, send] = useMachine(sendMachine)
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [showFriendMatches, setShowFriendMatches] = useState(false)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [offlineBlock, setOfflineBlock] = useState(() => offlinePaymentBlockedMessage())
  const [reviewBusy, setReviewBusy] = useState(false)
  const [scanningTo, setScanningTo] = useState(false)
  const sendState = stateToAttr(sendSnap.value)
  const appliedPrefill = useRef(false)
  const handleResolveRef = useRef(createHandleResolveDebouncer())

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => () => handleResolveRef.current.cancel(), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
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

  const isFailure = sendSnap.matches('failure')
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
      // Fast local read only — promotion/heal runs on Confirm inside runExclusiveSpend.
      const available = await withTimeout(
        assertSendableBalanceForReview(satoshis),
        REVIEW_BALANCE_TIMEOUT_MS,
        'Balance check timed out. Wallet storage may be busy — wait a moment and try again.',
      )
      onSent(available)
      send({ type: 'REVIEW' })
    } catch (err) {
      playWalletSound('error')
      onFail(err instanceof Error ? err.message : String(err))
      try {
        const available = await refreshSpendableBalance()
        onSent(available)
      } catch {
        // ignore secondary refresh failure
      }
    } finally {
      setReviewBusy(false)
    }
  }

  const recipientLabel =
    sendSnap.context.friendLabel || shortenAddress(sendSnap.context.to)
  const resolvedName = resolvedRecipientName(
    sendSnap.context.friendLabel,
    sendSnap.context.to,
    sendSnap.context.payeeIdentityKey,
  )

  const toggleSendCurrency = () => {
    const next: DisplayCurrency = currency === 'usd' ? 'bsv' : 'usd'
    const sats = amountToSats(sendSnap.context.amount, currency, usdPerBsv)
    playWalletSound('soft')
    if (sats > 0) {
      const converted = amountInputFromSats(sats, next, usdPerBsv)
      if (converted) send({ type: 'EDIT', amount: converted })
    }
    toggleDisplayCurrency()
  }

  const selectFriend = (friend: Friend) => {
    try {
      const address = addressFromIdentityKey(friend.identityKey, chain)
      setRecipientQuery(friend.label)
      setShowFriendMatches(false)
      send({
        type: 'EDIT',
        to: address,
        friendLabel: friend.label,
        payeeIdentityKey: friend.identityKey,
      })
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err))
    }
  }

  const applyRecipientInput = (value: string) => {
    setRecipientQuery(value)
    setShowFriendMatches(true)
    if (tryParseBrc29SettlementUri(value)) {
      void (async () => {
        try {
          const result = await claimBrc29SettlementUri(value)
          if (result.accepted) {
            if (result.balanceSats != null) onSent(result.balanceSats)
            playPaymentSuccessSound()
            toastSuccess('Payment claimed', 'The BRC-29 payment is in your wallet.')
            setRecipientQuery('')
            return
          }
          onFail(result.reason || 'Could not claim BRC-29 payment')
        } catch (err) {
          onFail(err instanceof Error ? err.message : String(err))
        }
      })()
      return
    }
    const peer = tryParsePeerPayUri(value)
    if (peer) {
      try {
        const address = addressFromIdentityKey(peer.identityKey, chain)
        const patch: {
          to: string
          friendLabel: null
          payeeIdentityKey: string
          amount?: string
        } = {
          to: address,
          friendLabel: null,
          payeeIdentityKey: peer.identityKey,
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
      handleResolveRef.current.schedule(value, {
        onResolved: (resolved) => {
          const address = addressFromIdentityKey(resolved.identityKey, chain)
          send({
            type: 'EDIT',
            to: address,
            friendLabel: resolved.display,
            payeeIdentityKey: resolved.identityKey,
          })
        },
        onError: (err) => onFail(err.message),
      })
      return
    }
    send({
      type: 'EDIT',
      to: value.trim(),
      friendLabel: null,
      payeeIdentityKey: null,
    })
  }

  useEffect(() => {
    if (appliedPrefill.current || !initialRecipient?.trim()) return
    appliedPrefill.current = true
    applyRecipientInput(initialRecipient.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecipient])

  /**
   * Hand the payment to the wallet and get out of the way.
   *
   * Everything after this point is already visible outside the panel — the
   * sidebar mirrors live progress and Activity carries the settled or failed
   * row — so keeping the user on a status screen only hides the surfaces that
   * outlive it. Only a pre-flight refusal stays here, where the amount can
   * still be edited.
   */
  const confirmSend = () => {
    const satoshis = amountToSats(sendSnap.context.amount, currency, usdPerBsv)
    if (!Number.isFinite(satoshis) || satoshis <= 0) {
      send({
        type: 'FAIL',
        error:
          currency === 'usd' && usdPerBsv == null
            ? 'USD rate unavailable'
            : 'Invalid amount',
      })
      return
    }

    const to = sendSnap.context.to.trim()
    const payeeKey = sendSnap.context.payeeIdentityKey?.trim() || null
    const friendLabel = sendSnap.context.friendLabel
    const label = recipientLabel

    send({ type: 'CONFIRM' })
    onClose()

    // Deliberately not awaited: the panel is gone by the time this settles.
    void (async () => {
      try {
        let balanceSats: number
        let selfReceived = false
        if (payeeKey != null) {
          const next = await sendBrc29ToIdentityKey({
            payeeIdentityKey: payeeKey,
            satoshis,
            friendLabel,
          })
          balanceSats = next.balanceSats
          selfReceived = Boolean(next.selfReceived)
        } else {
          const next = await sendSatsToAddress({ to, satoshis, friendLabel })
          balanceSats = next.balanceSats
        }
        playPaymentSuccessSound()
        toastSuccess(
          'Sent',
          selfReceived
            ? `${amountLabel} credited back to this wallet.`
            : `${amountLabel} on the way to ${label}.`,
        )
        onSent(balanceSats)
      } catch (err) {
        onFail(err instanceof Error ? err.message : String(err))
        try {
          onSent(await refreshSpendableBalance())
        } catch {
          // ignore — the failure is already reported
        }
      }
    })()
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
              <button
                type="button"
                className="send-amount-unit"
                onClick={toggleSendCurrency}
                aria-label={
                  currency === 'usd'
                    ? 'Amount in USD. Click to enter BSV.'
                    : 'Amount in BSV. Click to enter USD.'
                }
                title="Click to swap currency"
              >
                {currency === 'usd' ? 'USD' : 'BSV'}
              </button>
              {/*
                One reserved line for whichever note applies. Mounting these as
                they became true moved the amount under the caret while it was
                being typed.
              */}
              <div className="send-amount-note" aria-live="polite">
                {currency === 'usd' && usdPerBsv == null ? (
                  <span className="send-amount-warning">
                    USD rate unavailable — switch to BSV or refresh
                  </span>
                ) : amountSecondary ? (
                  <span className="send-amount-secondary">≈ {amountSecondary}</span>
                ) : null}
              </div>
              <p className="send-available">
                Available {formatPrimaryFromSats(balanceSats, currency, usdPerBsv)} ·{' '}
                {formatSecondaryFromSats(balanceSats, currency, usdPerBsv)}
                {reviewBusy ? ' · refreshing…' : ''}
              </p>
            </div>

            <div className="send-side">
              <div className="field friend-recipient-field send-to-field">
                <label htmlFor="to">To</label>
                {scanningTo ? (
                  <RecipientQrScan
                    onCancel={() => {
                      playWalletSound('soft')
                      releaseWarmedQrCamera()
                      setScanningTo(false)
                    }}
                    onValue={(value) => {
                      applyRecipientInput(value)
                      releaseWarmedQrCamera()
                      setScanningTo(false)
                    }}
                  />
                ) : (
                  <div className="send-to-input">
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
                    <button
                      type="button"
                      className="send-to-scan"
                      aria-label="Scan address QR"
                      title="Scan address QR"
                      onClick={() => {
                        playWalletSound('soft')
                        setShowFriendMatches(false)
                        setScanningTo(true)
                      }}
                    >
                      <ScanQrIcon size={18} />
                    </button>
                  </div>
                )}
                <p className="friend-recipient-hint send-recipient-hint">
                  PeerPay links, $handles, and identity keys resolve to a payment address on this network.
                </p>
                {resolvedName ? (
                  <p className="send-resolved" aria-live="polite">
                    Sending to <strong>{resolvedName}</strong>
                  </p>
                ) : null}
                {showFriendMatches && friendMatches.length > 0 ? (
                  <ul className="friend-suggest-list send-friend-suggest" role="listbox">
                    {friendMatches.map((friend) => (
                      <li key={friend.id}>
                        <ListRow.Root
                          as="button"
                          type="button"
                          className="friend-suggest-item"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => selectFriend(friend)}
                        >
                          <ListRow.Leading className="friend-suggest-leading" aria-hidden>
                            <FriendsIcon size={16} />
                          </ListRow.Leading>
                          <span className="friend-suggest-copy">
                            <ListRow.Label>{friend.label}</ListRow.Label>
                            <ListRow.Description className="mono">
                              {friend.identityKey.slice(0, 16)}…
                            </ListRow.Description>
                          </span>
                        </ListRow.Root>
                      </li>
                    ))}
                  </ul>
                ) : null}
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
              <div className="send-amount-note">
                {amountSecondary ? (
                  <span className="send-amount-secondary">≈ {amountSecondary}</span>
                ) : null}
              </div>
            </div>
            <div className="send-side">
              <p className="send-confirm-to">
                to <strong>{recipientLabel}</strong>
              </p>
              {sendSnap.context.friendLabel ? (
                <p className="mono send-confirm-address">{sendSnap.context.to}</p>
              ) : null}
              <div className="actions send-actions">
                <button className="btn btn-primary" onClick={confirmSend}>
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
