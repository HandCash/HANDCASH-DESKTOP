import { useEffect, useState } from 'react'
import {
  downloadUpdateNow,
  installUpdateNow,
  useUpdateStatus,
  type UpdateStatus,
} from '../wallet/updateStatus'

function dismissKey(version: string | null): string {
  return `handcash.update.dismissed:${version ?? 'unknown'}`
}

function wasDismissed(version: string | null): boolean {
  try {
    return sessionStorage.getItem(dismissKey(version)) === '1'
  } catch {
    return false
  }
}

function dismiss(version: string | null) {
  try {
    sessionStorage.setItem(dismissKey(version), '1')
  } catch {
    /* ignore */
  }
}

function bannerCopy(status: UpdateStatus): {
  title: string
  body: string
  action: 'download' | 'restart' | null
} | null {
  if (status.phase === 'ready' && status.canInstall) {
    return {
      title: 'Update ready',
      body: `HandCash Desktop ${status.availableVersion ?? ''} is ready to install.`,
      action: 'restart',
    }
  }
  if (status.phase === 'downloading') {
    return {
      title: 'Downloading update…',
      body: `${status.availableVersion ?? ''} — ${status.percent ?? 0}%`,
      action: null,
    }
  }
  if (status.phase === 'available') {
    return {
      title: 'Update available',
      body: `HandCash Desktop ${status.availableVersion ?? ''} is available.`,
      action: status.percent == null ? 'download' : null,
    }
  }
  return null
}

/** Cursor-style: top banner + restart prompt. No first-run prefs wizard. */
export function UpdatePrompt() {
  const status = useUpdateStatus()
  const copy = bannerCopy(status)
  const [restartOpen, setRestartOpen] = useState(false)

  useEffect(() => {
    if (status.phase === 'ready' && status.canInstall && !wasDismissed(status.availableVersion)) {
      setRestartOpen(true)
    }
  }, [status.phase, status.canInstall, status.availableVersion])

  if (!copy) return null

  return (
    <>
      <div className="update-banner" role="status">
        <div className="update-banner-copy">
          <strong>{copy.title}</strong>
          <span>{copy.body}</span>
        </div>
        <div className="update-banner-actions">
          {copy.action === 'download' ? (
            <button type="button" className="primary" onClick={() => void downloadUpdateNow()}>
              Update
            </button>
          ) : null}
          {copy.action === 'restart' ? (
            <button type="button" className="primary" onClick={() => void installUpdateNow()}>
              Restart to Update
            </button>
          ) : null}
        </div>
      </div>

      {restartOpen && status.canInstall ? (
        <div
          className="modal-backdrop update-prompt-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-prompt-title"
        >
          <div className="modal update-prompt-modal">
            <h2 id="update-prompt-title">Restart to Update</h2>
            <p>
              HandCash Desktop <strong>{status.availableVersion}</strong> has been downloaded and is
              ready to install.
            </p>
            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  dismiss(status.availableVersion)
                  setRestartOpen(false)
                }}
              >
                Later
              </button>
              <button type="button" className="primary" onClick={() => void installUpdateNow()}>
                Restart to Update
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
