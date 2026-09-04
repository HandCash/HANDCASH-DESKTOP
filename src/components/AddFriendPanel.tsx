import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { addFriendFromRecipient } from '../wallet/friends'
import { clearNavChild, getNavState } from '../wallet/navStore'
import {
  createHandleResolveDebouncer,
  isVerifiedHandleCertificate,
  parseHandleInput,
  type ResolvedHandle,
} from '../wallet/handleResolve'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  const verifiedHandle =
    resolvedHandle && isVerifiedHandleCertificate(resolvedHandle.certificate)

  const canSubmit = useMemo(() => {
    if (!trimmedRecipient || busy) return false
    if (needsLabel && !label.trim()) return false
    if (isHandleInput && resolveError) return false
    return true
  }, [trimmedRecipient, busy, needsLabel, label, isHandleInput, resolveError])

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
    setError(null)
    setBusy(true)
    try {
      await addFriendFromRecipient({
        label: canSetCustomLabel ? label.trim() || undefined : undefined,
        recipient: trimmedRecipient,
      })
      playWalletSound('soft')
      toastSuccess('Friend added')
      clearNavChild()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      playWalletSound('error')
      toastError('Couldn’t add friend', message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nav-child-panel add-friend-panel" data-aeon-scope="add-friend">
      <form className="friends-add-form" onSubmit={(e) => void onAdd(e)}>
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
            disabled={busy}
          />
          {resolvedHandle ? (
            <p className="add-friend-resolved" aria-live="polite">
              {verifiedHandle ? (
                <span className="handle-verified-badge" title="Verified handle certificate">
                  Verified
                </span>
              ) : null}
              <strong>{resolvedHandle.display}</strong>
            </p>
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
              disabled={busy}
            />
          </div>
        ) : null}
        {error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {busy ? 'Adding…' : 'Add friend'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => clearNavChild()}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
