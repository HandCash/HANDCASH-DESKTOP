import { useEffect, useMemo, useRef, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import {
  formatFungibleAmount,
  getFungible,
  listFungibles,
  subscribeFungibles,
  type FungibleToken,
} from '../wallet/fungibles'
import {
  addressFromIdentityKey,
  identityKeyFromRecipient,
  listFriends,
  resolvePaymentAddress,
  searchFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import {
  clearNavChild,
  openFungibleDetails,
} from '../wallet/navStore'
import { parseHandleInput, resolveHandle } from '../wallet/handleResolve'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { fetchBalanceSats, getActiveWallet } from '../wallet/session'
import {
  parseFungibleSendAmount,
  sendFungible,
} from '../wallet/sendFungible'
import type { Chain } from '../wallet/vault'
import { FungibleTokenFace } from './FungibleTokenFace'

type Props = {
  tokenId: string
  chain: Chain
  onSent?: (balanceSats: number) => void
  onFail?: (error: string) => void
}

/** The panel only composes and confirms; the send outlives it. */
type Stage = 'edit' | 'confirm'

function shortenAddress(value: string): string {
  const v = value.trim()
  if (v.length <= 20) return v
  return `${v.slice(0, 10)}…${v.slice(-8)}`
}

export function SendFungiblePanel({ tokenId, chain, onSent }: Props) {
  const [token, setToken] = useState<FungibleToken | null>(
    () => getFungible(tokenId),
  )
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [friendLabel, setFriendLabel] = useState<string | null>(null)
  const [recipientIdentityKey, setRecipientIdentityKey] = useState<string | null>(null)
  const [showMatches, setShowMatches] = useState(false)
  const [stage, setStage] = useState<Stage>('edit')
  const sendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeFriends(setFriends), [])

  useEffect(() => {
    return subscribeFungibles((list) => {
      setToken(
        list.find(
          (t) => t.tokenId === tokenId || t.tokenIds?.includes(tokenId),
        ) ?? null,
      )
    })
  }, [tokenId])

  useEffect(() => {
    let cancelled = false
    void listFungibles().then((list) => {
      if (cancelled) return
      setToken(
        list.find(
          (t) => t.tokenId === tokenId || t.tokenIds?.includes(tokenId),
        ) ?? null,
      )
    })
    return () => {
      cancelled = true
    }
  }, [tokenId])

  const matches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const balanceLabel = token
    ? formatFungibleAmount(token.amt, token.dec)
    : ''
  const recipientLabel = friendLabel || (to ? shortenAddress(to) : '')
  const sendBlocked =
    !token ||
    !token.colourSupply ||
    token.spendKind === 'cosigned' ||
    token.spendKind === 'mixed'
  const canReview =
    !sendBlocked && to.trim().length > 0 && amount.trim().length > 0

  /** Same recipient grammar as collectable / BSV send. */
  const applyRecipientInput = (value: string) => {
    setRecipientQuery(value)
    setShowMatches(true)
    setFriendLabel(null)
    setError(null)
    const wallet = getActiveWallet()
    const trimmed = value.trim()

    const peer = tryParsePeerPayUri(trimmed)
    if (peer) {
      try {
        setTo(addressFromIdentityKey(peer.identityKey, chain))
        setRecipientIdentityKey(peer.identityKey)
      } catch (err) {
        setTo('')
        setRecipientIdentityKey(null)
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }

    if (parseHandleInput(trimmed)) {
      setTo('')
      setRecipientIdentityKey(null)
      void (async () => {
        try {
          const resolved = await resolveHandle(trimmed)
          setTo(addressFromIdentityKey(resolved.identityKey, chain))
          setRecipientIdentityKey(resolved.identityKey)
          setFriendLabel(resolved.display)
          setError(null)
        } catch (err) {
          setTo('')
          setRecipientIdentityKey(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      })()
      return
    }

    setTo(trimmed)
    let key = identityKeyFromRecipient(trimmed)
    if (!key && wallet?.address && wallet.identityKey) {
      try {
        if (resolvePaymentAddress(trimmed, chain) === wallet.address) {
          key = wallet.identityKey
        }
      } catch {
        // Not a resolvable address; leave key null.
      }
    }
    setRecipientIdentityKey(key)
  }

  const selectFriend = (friend: Friend) => {
    try {
      const address = addressFromIdentityKey(friend.identityKey, chain)
      setRecipientQuery(friend.label)
      setShowMatches(false)
      setTo(address)
      setRecipientIdentityKey(friend.identityKey)
      setFriendLabel(friend.label)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      playWalletSound('deny')
    }
  }

  const fillMax = () => {
    if (!token) return
    setAmount(formatFungibleAmount(token.amt, token.dec))
    setError(null)
  }

  /**
   * Hand the transfer to the wallet and return to the inventory — same
   * fire-and-forget pattern as collectables.
   */
  const confirmSend = () => {
    if (!token || sendingRef.current || sendBlocked) return
    sendingRef.current = true
    setError(null)
    const send = {
      tokenId: token.tokenId,
      amount: amount.trim(),
      toAddress: to,
      recipientIdentityKey,
      friendLabel,
    }
    const label = recipientLabel
    const sym = token.sym
    clearNavChild()

    void (async () => {
      try {
        await sendFungible(send)
        playPaymentSuccessSound()
        toastSuccess('Sent', `${sym} on the way to ${label}.`)
        void listFungibles().catch(() => {})
        try {
          onSent?.(await fetchBalanceSats(getActiveWallet()?.wallet))
        } catch (err) {
          console.warn('[send-token] balance refresh failed', err)
        }
      } catch (err) {
        playWalletSound('error')
        toastError('Send failed', err instanceof Error ? err.message : String(err))
      } finally {
        sendingRef.current = false
      }
    })()
  }

  if (!token) {
    return <p className="connected-empty-line">Token not found</p>
  }

  return (
    <div
      className="nav-child-panel send-panel send-collectable-panel send-fungible-panel"
      data-aeon-scope="send-fungible"
      data-aeon-state={stateToAttr(stage)}
    >
      {stage === 'edit' && (
        <div className="send-stage send-stage-edit">
          <div className="send-layout">
            <div className="send-amount-hero send-collectable-hero">
              <div className="send-collectable-preview">
                <FungibleTokenFace
                  tokenId={token.tokenId}
                  sym={token.sym}
                  iconUrl={token.iconUrl}
                  size={48}
                />
                <div>
                  <p className="send-eyebrow">Send token</p>
                  <strong className="collectable-details-name">{token.sym}</strong>
                  <p className="collectable-details-app">Balance {balanceLabel}</p>
                </div>
              </div>
            </div>

            <div className="send-side">
              {sendBlocked ? (
                <p className="error" role="status">
                  {!token.colourSupply
                    ? 'Legacy BSV-21 tips are read-only. 1Sat tokens split face-value tips under a shared origin.'
                    : token.spendKind === 'cosigned'
                      ? 'This token requires a cosigner to send.'
                      : 'This balance mixes plain and cosigned tips — send them separately.'}
                </p>
              ) : null}

              <div className="field send-amount-field">
                <label htmlFor="fungible-amount">Amount</label>
                <div className="send-amount-row">
                  <input
                    id="fungible-amount"
                    inputMode="decimal"
                    value={amount}
                    disabled={sendBlocked}
                    onChange={(e) => {
                      setAmount(e.target.value)
                      setError(null)
                    }}
                    placeholder={token.dec > 0 ? `0.${'0'.repeat(Math.min(token.dec, 4))}` : '0'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={sendBlocked}
                    onClick={fillMax}
                  >
                    Max
                  </button>
                </div>
              </div>

              <div className="field friend-recipient-field send-to-field">
                <label htmlFor="fungible-to">To</label>
                <input
                  id="fungible-to"
                  value={recipientQuery}
                  disabled={sendBlocked}
                  onChange={(e) => applyRecipientInput(e.target.value)}
                  onFocus={() => setShowMatches(true)}
                  onBlur={() => {
                    window.setTimeout(() => setShowMatches(false), 120)
                  }}
                  placeholder="Friend, $handle, address, or identity key"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="friend-recipient-hint send-recipient-hint">
                  Handles and identity keys resolve to a payment address on this network.
                </p>
                <div className="send-resolved-slot" aria-live="polite">
                  {friendLabel ? (
                    <p className="friend-recipient-hint">
                      Sending to <strong>{friendLabel}</strong>
                    </p>
                  ) : null}
                </div>
                {error && stage === 'edit' ? (
                  <p className="error" role="status">
                    {error}
                  </p>
                ) : null}
                {showMatches && matches.length > 0 && (
                  <ul className="friend-suggest-list send-friend-suggest" role="listbox">
                    {matches.map((friend) => (
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
                  type="button"
                  className="btn btn-primary"
                  disabled={!canReview}
                  onClick={() => {
                    try {
                      parseFungibleSendAmount(amount, token)
                      const address = resolvePaymentAddress(to, chain)
                      setTo(address)
                      setError(null)
                      setStage('confirm')
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err)
                      setError(message)
                      playWalletSound('deny')
                    }
                  }}
                >
                  Review
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => openFungibleDetails(token.tokenId)}
                >
                  Back
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {stage === 'confirm' && (
        <div className="send-stage send-stage-confirm">
          <div className="send-layout send-layout-confirm">
            <div className="send-amount-hero send-collectable-hero">
              <div className="send-collectable-preview">
                <FungibleTokenFace
                  tokenId={token.tokenId}
                  sym={token.sym}
                  iconUrl={token.iconUrl}
                  size={48}
                />
                <div>
                  <p className="send-eyebrow">You’re sending</p>
                  <strong className="collectable-details-name">
                    {amount.trim()} {token.sym}
                  </strong>
                </div>
              </div>
            </div>
            <div className="send-side">
              <p className="send-confirm-to">
                to <strong>{recipientLabel}</strong>
              </p>
              {friendLabel ? <p className="mono send-confirm-address">{to}</p> : null}
              <div className="actions send-actions">
                <button type="button" className="btn btn-primary" onClick={confirmSend}>
                  Confirm
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setStage('edit')}>
                  Back
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
