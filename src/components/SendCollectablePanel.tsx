import { useEffect, useMemo, useRef, useState } from 'react'
import { ListRow } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import {
  getCachedCollectable,
  getCollectable,
  listCollectables,
  sendCollectable,
  sendCollectables,
  subscribeCollectables,
  type Collectable,
} from '../wallet/collectables'
import { isItemSent } from '../wallet/sentItemGuard'
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
import { parseHandleInput, createHandleResolveDebouncer } from '../wallet/handleResolve'
import {
  getVerificationProgress,
  isOutpointVerifying,
  subscribeVerificationProgress,
} from '../wallet/verificationProgress'
import {
  collectableSendReadyMessage,
  inspectCollectableSendReady,
} from '../wallet/collectableSendReady'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { fetchBalanceSats, getActiveWallet } from '../wallet/session'
import type { Chain } from '../wallet/vault'
import { DeferredImage } from './DeferredImage'
import { releaseWarmedQrCamera } from '../wallet/qrCameraWarm'
import {
  CheckIcon,
  CloseIcon,
  CollectablesIcon,
  FriendsIcon,
  ScanQrIcon,
} from './icons'
import { EmptyState } from './EmptyState'
import { RecipientQrScan } from './QrScanner'
import { useWalletActionDock } from './WalletActionDock'

type Props = {
  outpoint?: string
  outpoints?: string[]
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

export function SendCollectablePanel({
  outpoint,
  outpoints,
  chain,
  onSent,
}: Props) {
  const requestedOutpoints = useMemo(
    () => [...new Set((outpoints ?? (outpoint ? [outpoint] : [])).filter(Boolean))],
    [outpoint, outpoints],
  )
  const outpointKey = requestedOutpoints.join('|')
  const [items, setItems] = useState<Collectable[]>(() =>
    requestedOutpoints
      .map((value) => getCachedCollectable(value))
      .filter((value): value is Collectable => value != null),
  )
  const [loading, setLoading] = useState(
    () => items.length !== requestedOutpoints.length,
  )
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [to, setTo] = useState('')
  const [friendLabel, setFriendLabel] = useState<string | null>(null)
  const [recipientIdentityKey, setRecipientIdentityKey] = useState<string | null>(null)
  const [showMatches, setShowMatches] = useState(false)
  const [stage, setStage] = useState<Stage>('edit')
  const sendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [scanningTo, setScanningTo] = useState(false)
  const [verification, setVerification] = useState(() => getVerificationProgress())
  const handleResolveRef = useRef(createHandleResolveDebouncer())

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribeVerificationProgress(setVerification), [])
  useEffect(() => () => handleResolveRef.current.cancel(), [])

  useEffect(() => {
    let cancelled = false
    const cached = requestedOutpoints
      .map((value) => getCachedCollectable(value))
      .filter((value): value is Collectable => value != null)
    setItems(cached)
    setLoading(cached.length !== requestedOutpoints.length)
    setStage('edit')
    setError(null)
    void Promise.all(
      requestedOutpoints.map((value) => getCollectable(value)),
    ).then((loaded) => {
      if (!cancelled) {
        setItems(loaded.filter((value): value is Collectable => value != null))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    const unsubscribe = subscribeCollectables((list) => {
      const selected = list.filter((item) =>
        requestedOutpoints.includes(item.outpoint),
      )
      if (selected.length > 0) setItems(selected)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [outpointKey])

  const item = items[0] ?? null
  const batch = requestedOutpoints.length > 1

  const matches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const recipientLabel = friendLabel || (to ? shortenAddress(to) : '')
  const resolvedName = resolvedRecipientName(friendLabel, to, recipientIdentityKey)
  const sendReady = items.length === requestedOutpoints.length && items.length > 0
    ? items
        .map((selected) =>
          inspectCollectableSendReady({
            outpoint: selected.outpoint,
            proven: selected.proven,
            verifying: isOutpointVerifying(selected.outpoint, verification),
          }),
        )
        .find((ready) => !ready.ready) ?? { ready: true as const }
    : { ready: false as const, reason: 'unproven' as const }
  const sendBlocked = !sendReady.ready
  const sendBlockMessage = sendBlocked
    ? collectableSendReadyMessage(sendReady.reason)
    : null
  const canReview = to.trim().length > 0 && !sendBlocked

  /** Same recipient grammar as BSV send: friend, address, identity key, peerpay URI, $handle. */
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
      handleResolveRef.current.schedule(trimmed, {
        onResolved: (resolved) => {
          setTo(addressFromIdentityKey(resolved.identityKey, chain))
          setRecipientIdentityKey(resolved.identityKey)
          setFriendLabel(resolved.display)
          setError(null)
        },
        onError: (err) => {
          setTo('')
          setRecipientIdentityKey(null)
          setError(err.message)
        },
      })
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

  /**
   * Hand the transfer to the wallet and return to the inventory.
   *
   * The grid marks the tile as sending, the sidebar mirrors live progress and
   * Activity carries the result, so a status screen here would only cover the
   * surfaces that outlive this panel.
   */
  const confirmSend = () => {
    if (!item || items.length !== requestedOutpoints.length || sendingRef.current || sendBlocked) return
    sendingRef.current = true
    setError(null)
    const common = {
      toAddress: to,
      recipientIdentityKey,
      friendLabel,
    }
    const send = {
      ...common,
      outpoint: item.outpoint,
      name: item.name,
      origin: item.origin,
      app: item.app,
    }
    const label = recipientLabel
    clearNavChild()

    // Deliberately not awaited: the panel is gone by the time this settles.
    void (async () => {
      try {
        // Activity is recorded inside finishSend as soon as the txid exists.
        if (batch) {
          await sendCollectables({
            ...common,
            outpoints: requestedOutpoints,
          })
        } else {
          await sendCollectable(send)
        }
        playPaymentSuccessSound()
        toastSuccess(
          'Sent',
          batch
            ? `${items.length} collectables on the way to ${label}.`
            : `${send.name} on the way to ${label}.`,
        )
        void listCollectables().catch(() => {})
        // Local state is authoritative for the spend; Dashboard poll reconciles after.
        try {
          onSent?.(await fetchBalanceSats(getActiveWallet()?.wallet))
        } catch (err) {
          console.warn('[send-collectable] balance refresh failed', err)
        }
      } catch (err) {
        playWalletSound('error')
        toastError('Send failed', err instanceof Error ? err.message : String(err))
      } finally {
        sendingRef.current = false
      }
    })()
  }

  const goReview = () => {
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
  }

  useWalletActionDock(
    item
      ? stage === 'edit'
        ? {
            ariaLabel: 'Collectable send actions',
            secondary: {
              label: 'Cancel',
              onClick: () =>
                batch ? clearNavChild() : openCollectableDetails(item.outpoint),
              icon: <CloseIcon size={18} />,
              tone: 'danger',
            },
            primary: {
              label: 'Review',
              onClick: goReview,
              disabled: !canReview,
              icon: <CheckIcon size={18} />,
              tone: 'primary',
            },
          }
        : {
            ariaLabel: 'Confirm collectable transfer',
            secondary: {
              label: 'Cancel',
              onClick: () =>
                batch ? clearNavChild() : openCollectableDetails(item.outpoint),
              icon: <CloseIcon size={18} />,
              tone: 'danger',
            },
            primary: {
              label: 'Confirm',
              onClick: confirmSend,
              disabled: sendBlocked,
              icon: <CheckIcon size={18} />,
              tone: 'primary',
            },
          }
      : null,
  )

  if (!item) {
    const spent = requestedOutpoints.some((value) => isItemSent(value))
    return loading ? (
      <div
        className="nav-child-panel send-panel send-collectable-panel"
        data-aeon-scope="send-collectable"
        data-aeon-state="loading"
        aria-busy="true"
        aria-label="Loading collectable"
      />
    ) : (
      <EmptyState
        icon={<CollectablesIcon size={22} />}
        title={spent ? 'Already sent' : 'Item unavailable'}
        body={
          spent
            ? 'This collectable is no longer in your wallet — it was sent recently or is already spent on chain.'
            : 'This collectable is no longer in the wallet or could not be loaded.'
        }
      />
    )
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
                {items.slice(0, 3).map((selected) => (
                  <div
                    className="collectable-media collectable-media-sm"
                    key={selected.outpoint}
                  >
                    <DeferredImage
                      src={selected.imageUrl}
                      alt={selected.name}
                      width={48}
                      height={48}
                      skeletonWidth={48}
                      skeletonHeight={48}
                      skeletonRadius={6}
                      skeletonClassName="skeleton-qr"
                      retainDecoded
                    />
                  </div>
                ))}
                <div>
                  <p className="send-eyebrow">
                    {batch ? `Send ${items.length} collectables` : 'Send collectable'}
                  </p>
                  <strong className="collectable-details-name">
                    {batch ? `${items.length} selected` : item.name}
                  </strong>
                  {!batch && item.app ? (
                    <p className="collectable-details-app">{item.app}</p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="send-side">
              <div className="field friend-recipient-field send-to-field">
                <label htmlFor="collectable-to">To</label>
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
                    />
                    <button
                      type="button"
                      className="send-to-scan"
                      aria-label="Scan address QR"
                      title="Scan address QR"
                      onClick={() => {
                        playWalletSound('soft')
                        setShowMatches(false)
                        setScanningTo(true)
                      }}
                    >
                      <ScanQrIcon size={18} />
                    </button>
                  </div>
                )}
                <p className="friend-recipient-hint send-recipient-hint">
                  Handles and identity keys resolve to a payment address on this network.
                </p>
                {resolvedName ? (
                  <p className="send-resolved" aria-live="polite">
                    Sending to <strong>{resolvedName}</strong>
                  </p>
                ) : null}
                {error && stage === 'edit' ? (
                  <p className="error" role="status">
                    {error}
                  </p>
                ) : null}
                {sendBlockMessage ? (
                  <p className="error" role="status">
                    {sendBlockMessage}
                  </p>
                ) : null}
                {showMatches && matches.length > 0 ? (
                  <ul className="friend-suggest-list send-friend-suggest" role="listbox">
                    {matches.map((friend) => (
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

            </div>
          </div>
        </div>
      )}

      {stage === 'confirm' && (
        <div className="send-stage send-stage-confirm">
          <div className="send-layout send-layout-confirm">
            <div className="send-amount-hero send-collectable-hero">
              <div className="send-collectable-preview">
                {items.slice(0, 3).map((selected) => (
                  <div
                    className="collectable-media collectable-media-sm"
                    key={selected.outpoint}
                  >
                    <DeferredImage
                      src={selected.imageUrl}
                      alt={selected.name}
                      width={48}
                      height={48}
                      skeletonWidth={48}
                      skeletonHeight={48}
                      skeletonRadius={6}
                      skeletonClassName="skeleton-qr"
                      retainDecoded
                    />
                  </div>
                ))}
                <div>
                  <p className="send-eyebrow">You’re sending</p>
                  <strong className="collectable-details-name">
                    {batch ? `${items.length} collectables` : item.name}
                  </strong>
                </div>
              </div>
            </div>
            <div className="send-side">
              <p className="send-confirm-to">
                to <strong>{recipientLabel}</strong>
              </p>
              {friendLabel ? <p className="mono send-confirm-address">{to}</p> : null}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
