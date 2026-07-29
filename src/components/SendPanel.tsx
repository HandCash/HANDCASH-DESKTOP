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
import type { Chain } from '../wallet/vault'

type Props = {
  chain: Chain
  balanceSats: number
  onSent: (balanceSats: number) => void
  onFail: (error: string) => void
  onClose: () => void
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

  const friendMatches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

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
        <>
          <div className="field friend-recipient-field">
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
          <div className="field">
            <label htmlFor="amount">Amount (BSV)</label>
            <input
              id="amount"
              value={sendSnap.context.amount}
              onChange={(e) => send({ type: 'EDIT', amount: e.target.value })}
              placeholder="0.01"
            />
          </div>
          <p className="brand-sub">
            Available {formatPrimaryFromSats(balanceSats, currency, usdPerBsv)} ·{' '}
            {formatSecondaryFromSats(balanceSats, currency, usdPerBsv)}
          </p>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => send({ type: 'REVIEW' })}>
              Review
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {sendSnap.matches('confirming') && (
        <>
          <p className="lede">
            Send <strong>{sendSnap.context.amount} BSV</strong> to
            {sendSnap.context.friendLabel ? (
              <>
                {' '}
                <strong>{sendSnap.context.friendLabel}</strong>
              </>
            ) : null}
          </p>
          <p className="mono">{sendSnap.context.to}</p>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => void confirmSend()}>
              Confirm
            </button>
            <button className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
              Back
            </button>
          </div>
        </>
      )}

      {sendSnap.matches('broadcasting') && <p className="lede">Broadcasting…</p>}

      {sendSnap.matches('success') && (
        <>
          <p className="lede">Payment submitted.</p>
          <p className="mono">{sendSnap.context.txid}</p>
          <div className="actions">
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
        </>
      )}

      {sendSnap.matches('failure') && (
        <>
          <p className="error">{sendSnap.context.error}</p>
          <div className="actions">
            <button className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
              Edit
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  )
}
