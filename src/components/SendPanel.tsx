import { useEffect, useMemo, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { P2PKH } from '@bsv/sdk'
import { sendMachine } from '../machines/sendMachine'
import {
  fetchBalanceSats,
  getActiveWallet,
} from '../wallet/session'
import { syncLegacyFunds } from '../wallet/syncFunds'
import {
  amountToSats,
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  formatTypedAmount,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  setDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from '../wallet/appActivity'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from '../wallet/pendingSend'
import {
  addressFromIdentityKey,
  listFriends,
  searchFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import { takeSendPrefill } from '../wallet/sendPrefill'
import type { Chain } from '../wallet/vault'
import { CheckCircleIcon } from './icons'

type Props = {
  chain: Chain
  balanceSats: number
  onSent: (balanceSats: number) => void
  onFail: (error: string) => void
  onClose: () => void
}

function shortenAddress(value: string): string {
  const v = value.trim()
  if (v.length <= 20) return v
  return `${v.slice(0, 10)}…${v.slice(-8)}`
}

export function SendPanel({ chain, balanceSats, onSent, onFail, onClose }: Props) {
  const [sendSnap, send] = useMachine(sendMachine)
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [showFriendMatches, setShowFriendMatches] = useState(false)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const sendState = stateToAttr(sendSnap.value)

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])

  useEffect(() => {
    const prefill = takeSendPrefill()
    if (!prefill) return
    if (prefill.amountUnit === 'usd') {
      setDisplayCurrency('usd')
      setCurrency('usd')
    } else if (prefill.amountUnit === 'sats' || prefill.amountUnit === 'bsv') {
      setDisplayCurrency('bsv')
      setCurrency('bsv')
    }
    let amount = prefill.amount ?? ''
    if (prefill.amountUnit === 'sats' && prefill.amount) {
      amount = (Number(prefill.amount) / 1e8).toFixed(8).replace(/\.?0+$/, '')
    }
    if (prefill.to) {
      setRecipientQuery(prefill.friendLabel || prefill.to)
      send({
        type: 'EDIT',
        to: prefill.to,
        friendLabel: prefill.friendLabel ?? null,
        amount: amount || undefined,
      })
    } else if (amount) {
      send({ type: 'EDIT', amount })
    }
  }, [send])

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
    sendSnap.context.to.trim().length > 0 &&
    amountSats > 0 &&
    (currency === 'bsv' || usdPerBsv != null)

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

  const confirmSend = async () => {
    send({ type: 'CONFIRM' })
    const active = getActiveWallet()
    if (!active) {
      send({ type: 'FAIL', error: 'Wallet locked' })
      onFail('Wallet locked')
      return
    }
    let pendingId: string | null = null
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
      const pending = beginPendingSend({
        to,
        sats: satoshis,
        friendLabel: sendSnap.context.friendLabel,
      })
      pendingId = pending.id

      const lockingScript = new P2PKH().lock(to).toHex()
      const result = await active.wallet.createAction({
        description: `HandCash send to ${to}`,
        labels: ['handcash-send'],
        outputs: [
          {
            lockingScript,
            satoshis,
            outputDescription: 'Payment',
          },
        ],
      })

      const txid =
        (result as { txid?: string })?.txid ?? `local-${Date.now().toString(16)}`
      completePendingSend(pending.id, txid)

      const recipientNote = sendSnap.context.friendLabel
        ? `${sendSnap.context.friendLabel} (${to})`
        : to
      if (!hasActivityTxid(txid)) {
        recordAppActivity({
          origin: WALLET_ACTIVITY_ORIGIN,
          kind: 'spent',
          sats: satoshis,
          method: 'send',
          note: `Sent to ${recipientNote}`,
          txid,
        })
      }
      clearPendingSend(pending.id)
      pendingId = null

      send({ type: 'SUCCESS', txid })
      onSent(Math.max(0, balanceSats - satoshis))
      void syncLegacyFunds()
        .then((balance) => {
          if (balance != null) onSent(balance)
          else {
            return fetchBalanceSats(active.wallet).then((b) => onSent(b))
          }
        })
        .catch((err) => {
          console.warn('[send] balance refresh failed', err)
        })
    } catch (err) {
      if (pendingId) clearPendingSend(pendingId)
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
      onFail(message)
    }
  }

  return (
    <div className="nav-child-panel send-panel" data-aeon-scope="send" data-aeon-state={sendState}>
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
                  onChange={(e) => {
                    const value = e.target.value
                    setRecipientQuery(value)
                    setShowFriendMatches(true)
                    send({ type: 'EDIT', to: value.trim(), friendLabel: null })
                  }}
                  onFocus={() => setShowFriendMatches(true)}
                  onBlur={() => {
                    window.setTimeout(() => setShowFriendMatches(false), 120)
                  }}
                  placeholder="Search friends or paste address"
                  autoComplete="off"
                  spellCheck={false}
                />
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
                  onClick={() => send({ type: 'REVIEW' })}
                >
                  Review
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
            <p className="send-status-title">Sending…</p>
            <p className="send-status-sub">Broadcasting your payment…</p>
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
