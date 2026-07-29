import { useEffect, useMemo, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { P2PKH } from '@bsv/sdk'
import { sendMachine } from '../machines/sendMachine'
import {
  fetchBalanceSats,
  getActiveWallet,
} from '../wallet/session'
import {
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from '../wallet/appActivity'
import {
  addressFromIdentityKey,
  listFriends,
  searchFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
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

  const isSuccess = sendSnap.matches('success')
  useEffect(() => {
    if (!isSuccess) return
    playPaymentSuccessSound()
  }, [isSuccess])

  const friendMatches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const canReview =
    sendSnap.context.to.trim().length > 0 && Number(sendSnap.context.amount) > 0

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
    try {
      const satoshis = Math.round(Number(sendSnap.context.amount) * 1e8)
      if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')

      const lockingScript = new P2PKH().lock(sendSnap.context.to.trim()).toHex()
      const result = await active.wallet.createAction({
        description: `HandCash send to ${sendSnap.context.to}`,
        outputs: [
          {
            lockingScript,
            satoshis,
            outputDescription: 'Payment',
          },
        ],
      })

      const balance = await fetchBalanceSats(active.wallet)
      const txid =
        (result as { txid?: string })?.txid ?? `local-${Date.now().toString(16)}`
      const recipientNote = sendSnap.context.friendLabel
        ? `${sendSnap.context.friendLabel} (${sendSnap.context.to.trim()})`
        : sendSnap.context.to.trim()
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: satoshis,
        method: 'send',
        note: `Sent to ${recipientNote}`,
        txid,
      })
      send({ type: 'SUCCESS', txid })
      onSent(balance)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
      onFail(message)
    }
  }

  return (
    <div className="nav-child-panel send-panel" data-aeon-scope="send" data-aeon-state={sendState}>
      {sendSnap.matches('editing') && (
        <div className="send-stage send-stage-edit">
          <div className="send-stage-body">
            <div className="send-amount-hero">
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
                />
                <span className="send-amount-unit">BSV</span>
              </div>
              <p className="send-available">
                Available {formatPrimaryFromSats(balanceSats, currency, usdPerBsv)} ·{' '}
                {formatSecondaryFromSats(balanceSats, currency, usdPerBsv)}
              </p>
            </div>

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
                <ul className="friend-suggest-list" role="listbox">
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
      )}

      {sendSnap.matches('confirming') && (
        <div className="send-stage send-stage-confirm">
          <div className="send-stage-body send-stage-body-center">
            <p className="send-eyebrow">You’re sending</p>
            <p className="send-confirm-amount">
              {sendSnap.context.amount} <span>BSV</span>
            </p>
            <p className="send-confirm-to">
              to <strong>{recipientLabel}</strong>
            </p>
            {sendSnap.context.friendLabel ? (
              <p className="mono send-confirm-address">{sendSnap.context.to}</p>
            ) : null}
          </div>
          <div className="actions send-actions">
            <button className="btn btn-primary" onClick={() => void confirmSend()}>
              Confirm
            </button>
            <button className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
              Back
            </button>
          </div>
        </div>
      )}

      {sendSnap.matches('broadcasting') && (
        <div className="send-stage send-stage-status">
          <div className="send-stage-body send-stage-body-center">
            <div className="send-spinner" aria-hidden />
            <p className="send-status-title">Sending…</p>
            <p className="send-status-sub">Broadcasting your payment</p>
          </div>
        </div>
      )}

      {sendSnap.matches('success') && (
        <div className="send-stage send-stage-success">
          <div className="send-stage-body send-stage-body-center">
            <div className="send-success-mark" aria-hidden>
              <CheckCircleIcon size={72} />
            </div>
            <p className="send-status-title">Sent</p>
            <p className="send-confirm-amount send-success-amount">
              {sendSnap.context.amount} <span>BSV</span>
            </p>
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
