import { useEffect, useMemo, useRef, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import {
  getCollectable,
  listCollectables,
  sendCollectable,
  warmHardenedSend,
  type Collectable,
} from '../wallet/collectables'
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
  openCollectableDetails,
} from '../wallet/navStore'
import {
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from '../wallet/appActivity'
import { parseHandleInput, resolveHandle } from '../wallet/handleResolve'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import { toastError } from '../wallet/toast'
import { fetchBalanceSats, getActiveWallet } from '../wallet/session'
import {
  getPaymentProgress,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import type { Chain } from '../wallet/vault'
import { CheckCircleIcon } from './icons'
import { DeferredImage } from './DeferredImage'

type Props = {
  outpoint: string
  chain: Chain
  onSent?: (balanceSats: number) => void
  onFail?: (error: string) => void
}

type Stage = 'edit' | 'confirm' | 'sending' | 'success' | 'failure'

function shortenAddress(value: string): string {
  const v = value.trim()
  if (v.length <= 20) return v
  return `${v.slice(0, 10)}…${v.slice(-8)}`
}

export function SendCollectablePanel({ outpoint, chain, onSent }: Props) {
  const [item, setItem] = useState<Collectable | null>(null)
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [to, setTo] = useState('')
  const [friendLabel, setFriendLabel] = useState<string | null>(null)
  const [recipientIdentityKey, setRecipientIdentityKey] = useState<string | null>(null)
  const [showMatches, setShowMatches] = useState(false)
  const [stage, setStage] = useState<Stage>('edit')
  const sendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [paymentProgress, setPaymentProgressState] = useState(() => getPaymentProgress())

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribePaymentProgress(setPaymentProgressState), [])

  useEffect(() => {
    let cancelled = false
    void getCollectable(outpoint).then((next) => {
      if (!cancelled) setItem(next)
    })
    return () => {
      cancelled = true
    }
  }, [outpoint])

  useEffect(() => {
    if (stage === 'success') playPaymentSuccessSound()
    if (stage === 'failure') playWalletSound('error')
    if (stage === 'confirm') warmHardenedSend(recipientIdentityKey)
  }, [stage, recipientIdentityKey])

  const matches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const recipientLabel = friendLabel || (to ? shortenAddress(to) : '')
  const canReview = to.trim().length > 0

  /** Same recipient grammar as BSV send: friend, address, identity key, peerpay URI, $handle. */
  const applyRecipientInput = (value: string) => {
    setRecipientQuery(value)
    setShowMatches(true)
    setTo(value.trim())
    setFriendLabel(null)
    const wallet = getActiveWallet()
    let key = identityKeyFromRecipient(value)
    // Own P2PKH address still hardens — we know our identity key.
    if (!key && wallet?.address && wallet.identityKey) {
      try {
        if (resolvePaymentAddress(value, chain) === wallet.address) {
          key = wallet.identityKey
        }
      } catch {
        // Not a resolvable address; leave key null.
      }
    }
    setRecipientIdentityKey(key)

    const peer = tryParsePeerPayUri(value)
    if (peer) {
      try {
        setTo(addressFromIdentityKey(peer.identityKey, chain))
        setRecipientIdentityKey(peer.identityKey)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }

    if (parseHandleInput(value)) {
      void (async () => {
        try {
          const resolved = await resolveHandle(value)
          setTo(addressFromIdentityKey(resolved.identityKey, chain))
          setRecipientIdentityKey(resolved.identityKey)
          setFriendLabel(resolved.display)
          setError(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })()
    }
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

  const confirmSend = async () => {
    if (!item || sendingRef.current) return
    sendingRef.current = true
    setStage('sending')
    setError(null)
    try {
      const result = await sendCollectable({
        outpoint: item.outpoint,
        toAddress: to,
        recipientIdentityKey,
        name: item.name,
        origin: item.origin,
        app: item.app,
      })
      setTxid(result.txid)
      const noteTo = friendLabel ? `${friendLabel} (${to})` : to
      if (!hasActivityTxid(result.txid)) {
        recordAppActivity({
          origin: WALLET_ACTIVITY_ORIGIN,
          kind: 'spent',
          sats: 1,
          method: 'send-collectable',
          note: `Sent ${item.name} to ${noteTo}`,
          txid: result.txid,
          item: {
            name: item.name,
            origin: item.origin,
            outpoint: item.outpoint,
            imageUrl: item.imageUrl,
            ...(item.app ? { app: item.app } : {}),
          },
        })
      }

      setStage('success')
      void listCollectables().catch(() => {})
      // Pre-send heal already ran; Dashboard poll + settle grace reconcile the rest.
      void fetchBalanceSats(getActiveWallet()?.wallet)
        .then((balance) => {
          onSent?.(balance)
        })
        .catch((err) => {
          console.warn('[send-collectable] balance refresh failed', err)
        })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStage('failure')
      toastError('Send failed', message)
      sendingRef.current = false
    }
  }

  if (!item) {
    return <p className="connected-empty-line">Collectable not found</p>
  }

  return (
    <div
      className="nav-child-panel send-panel send-collectable-panel"
      data-aeon-scope="send-collectable"
      data-aeon-state={stateToAttr(stage)}
    >
      {stage === 'edit' && (
        <div className="send-stage send-stage-edit">
          <div className="send-layout">
            <div className="send-amount-hero send-collectable-hero">
              <div className="send-collectable-preview">
                <div className="collectable-media collectable-media-sm">
                  <DeferredImage
                    src={item.imageUrl}
                    alt={item.name}
                    width={48}
                    height={48}
                    skeletonWidth={48}
                    skeletonHeight={48}
                    skeletonRadius={6}
                    skeletonClassName="skeleton-qr"
                  />
                </div>
                <div>
                  <p className="send-eyebrow">Send collectable</p>
                  <strong className="collectable-details-name">{item.name}</strong>
                  {item.app ? <p className="collectable-details-app">{item.app}</p> : null}
                </div>
              </div>
            </div>

            <div className="send-side">
              <div className="field friend-recipient-field send-to-field">
                <label htmlFor="collectable-to">To</label>
                <input
                  id="collectable-to"
                  value={recipientQuery}
                  onChange={(e) => applyRecipientInput(e.target.value)}
                  onFocus={() => setShowMatches(true)}
                  onBlur={() => {
                    window.setTimeout(() => setShowMatches(false), 120)
                  }}
                  placeholder="Friend, $handle, address, or identity key"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
                <p className="friend-recipient-hint send-recipient-hint">
                  Handles and identity keys resolve to a payment address on this network.
                </p>
                {friendLabel && (
                  <p className="friend-recipient-hint">
                    Sending to <strong>{friendLabel}</strong>
                  </p>
                )}
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
                  onClick={() => openCollectableDetails(item.outpoint)}
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
                <div className="collectable-media collectable-media-sm">
                  <DeferredImage
                    src={item.imageUrl}
                    alt={item.name}
                    width={48}
                    height={48}
                    skeletonWidth={48}
                    skeletonHeight={48}
                    skeletonRadius={6}
                    skeletonClassName="skeleton-qr"
                  />
                </div>
                <div>
                  <p className="send-eyebrow">You’re sending</p>
                  <strong className="collectable-details-name">{item.name}</strong>
                </div>
              </div>
            </div>
            <div className="send-side">
              <p className="send-confirm-to">
                to <strong>{recipientLabel}</strong>
              </p>
              {friendLabel ? <p className="mono send-confirm-address">{to}</p> : null}
              <div className="actions send-actions">
                <button type="button" className="btn btn-primary" onClick={() => void confirmSend()}>
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

      {stage === 'sending' && (
        <div className="send-stage send-stage-status">
          <div className="send-stage-body send-stage-body-center">
            <div className="send-spinner" aria-hidden />
            <p className="send-status-title">
              {paymentProgress.label ?? 'Sending…'}
            </p>
            <p className="send-status-sub">
              {paymentProgress.detail ?? 'Preparing the collectable…'}
            </p>
          </div>
        </div>
      )}

      {stage === 'success' && (
        <div className="send-stage send-stage-success">
          <div className="send-stage-body send-stage-body-center">
            <div className="send-success-mark" aria-hidden>
              <CheckCircleIcon size={80} />
            </div>
            <p className="send-status-title">Sent</p>
            <strong className="collectable-details-name">{item.name}</strong>
            <p className="send-confirm-to">
              to <strong>{recipientLabel}</strong>
            </p>
            {txid ? (
              <p className="mono send-txid" title={txid}>
                {shortenAddress(txid)}
              </p>
            ) : null}
          </div>
          <div className="actions send-actions">
            <button type="button" className="btn btn-primary" onClick={() => clearNavChild()}>
              Done
            </button>
          </div>
        </div>
      )}

      {stage === 'failure' && (
        <div className="send-stage send-stage-failure">
          <div className="send-stage-body send-stage-body-center">
            <p className="send-status-title">Couldn’t send</p>
            <p className="error send-failure-error">{error}</p>
          </div>
          <div className="actions send-actions">
            <button type="button" className="btn btn-primary" onClick={() => setStage('edit')}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => openCollectableDetails(item.outpoint)}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
