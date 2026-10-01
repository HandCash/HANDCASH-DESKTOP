import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { addFriendFromRecipient } from '../wallet/friends'
import { clearNavChild, getNavState } from '../wallet/navStore'
import {
  createHandleResolveDebouncer,
  parseHandleInput,
  type ResolvedHandle,
} from '../wallet/handleResolve'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { ExclusiveActionRegion } from './ExclusiveActionRegion'
import { CheckCircleIcon, PersonAddIcon } from './icons'

function initialFromNav(): { label: string; recipient: string } {
  const child = getNavState().child
  if (child?.type !== 'add-friend') return { label: '', recipient: '' }
  return {
    label: child.label?.trim() ?? '',
    recipient: child.identityKey?.trim() ?? '',
  }
}

export function AddFriendPanel() {
  const seeded = initialFromNav()
  const [label, setLabel] = useState(seeded.label)
  const [recipient, setRecipient] = useState(seeded.recipient)
  const add = useAsyncAction<'add'>()
  const [resolvedHandle, setResolvedHandle] = useState<ResolvedHandle | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const handleResolveRef = useRef(createHandleResolveDebouncer())

  const trimmedRecipient = recipient.trim()
  const isHandleInput = Boolean(parseHandleInput(trimmedRecipient))
  const isPeerPayInput = Boolean(tryParsePeerPayUri(trimmedRecipient))
  /** Handles are fixed identity — no custom label. Peerpay / identity key can set one. */
  const canSetCustomLabel = Boolean(trimmedRecipient && !isHandleInput)
  /** Peerpay has no useful default display — require a label. Identity key falls back. */
  const needsLabel = Boolean(trimmedRecipient && isPeerPayInput)
  const canSubmit = useMemo(() => {
    if (!trimmedRecipient || add.busy) return false
    if (needsLabel && !label.trim()) return false
    if (isHandleInput && resolveError) return false
    return true
  }, [trimmedRecipient, add.busy, needsLabel, label, isHandleInput, resolveError])

  useEffect(() => () => handleResolveRef.current.cancel(), [])

  useEffect(() => {
    setResolveError(null)
    setResolvedHandle(null)
    if (!isHandleInput) return
    handleResolveRef.current.schedule(trimmedRecipient, {
      onResolved: (resolved) => {
        setResolvedHandle(resolved)
        setResolveError(null)
      },
      onError: (err) => {
        setResolvedHandle(null)
        setResolveError(err.message)
      },
    })
  }, [trimmedRecipient, isHandleInput])

  const onAdd = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    const outcome = await add.run('add', async () => {
      await addFriendFromRecipient({
        label: canSetCustomLabel ? label.trim() || undefined : undefined,
        recipient: trimmedRecipient,
      })
    })
    if (outcome.ok) {
      playWalletSound('soft')
      toastSuccess('Friend added')
      clearNavChild()
    } else if (outcome.error) {
      playWalletSound('error')
      toastError('Couldn’t add friend', outcome.error)
    }
  }

  return (
    <div className="nav-child-panel add-friend-panel" data-aeon-scope="add-friend">
      <ExclusiveActionRegion
        action={add}
        scope="add-friend"
        part="add-friend-form"
        className="friends-add-form"
        actionsClassName="actions add-friend-actions"
        error={add.error}
        idleLabel="Add friend"
        pendingLabel="Adding…"
        primaryDisabled={!canSubmit}
        onSubmit={(e) => void onAdd(e)}
        secondary={{ label: 'Cancel', onClick: () => clearNavChild() }}
      >
        <div className="add-friend-content">
          <header className="add-friend-intro">
            <span className="add-friend-intro-icon" aria-hidden>
              <PersonAddIcon size={20} />
            </span>
            <div>
              <h3>Add someone you trust</h3>
              <p>Use their $handle, peer payment link, or public identity key.</p>
            </div>
          </header>

          <div className="field">
            <label htmlFor="friend-key">Handle or identity key</label>
            <input
              id="friend-key"
              className="mono"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="$alice, peerpay:…, or 02… / 03…"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              disabled={add.busy}
            />
            {isHandleInput && !resolvedHandle && !resolveError ? (
              <p className="add-friend-resolving" aria-live="polite">
                Looking up handle…
              </p>
            ) : null}
            {resolvedHandle ? (
              <div className="add-friend-preview" aria-live="polite">
                <span className="add-friend-preview-icon" aria-hidden>
                  <CheckCircleIcon size={20} />
                </span>
                <div>
                  <span className="add-friend-preview-label">
                    Verified handle
                  </span>
                  <strong>{resolvedHandle.display}</strong>
                </div>
              </div>
            ) : null}
            {resolveError ? (
              <p className="error" role="status">
                {resolveError}
              </p>
            ) : null}
          </div>
          {canSetCustomLabel ? (
            <div className="field">
              <label htmlFor="friend-label">Label{needsLabel ? '' : ' (optional)'}</label>
              <input
                id="friend-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="How you’ll recognize this peer"
                autoComplete="off"
                disabled={add.busy}
              />
            </div>
          ) : null}
        </div>
      </ExclusiveActionRegion>
    </div>
  )
}
