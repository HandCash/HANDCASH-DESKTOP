import { useState, type FormEvent } from 'react'
import { revealRootKeyHex } from '../wallet/vault'
import { markBackupConfirmed } from '../wallet/backupStatus'
import {
  BRC140_DEFAULT_THRESHOLD,
  BRC140_DEFAULT_TOTAL,
  createBrc140Shares,
  shareDownloadFilename,
  type Brc140ShareSet,
} from '../wallet/brc140Backup'
import { playWalletSound } from '../wallet/soundService'
import { copyText } from '../wallet/clipboard'

const PLACE_HINTS = [
  'Phone notes / password manager',
  'Email to yourself / cloud docs',
  'USB, paper, or another device',
] as const

function downloadShare(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function SplitBackupPanel() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shareSet, setShareSet] = useState<Brc140ShareSet | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setShareSet(null)
    setConfirmed(false)
    setBusy(true)
    try {
      const rootKeyHex = await revealRootKeyHex(password)
      const next = createBrc140Shares(
        rootKeyHex,
        BRC140_DEFAULT_THRESHOLD,
        BRC140_DEFAULT_TOTAL,
      )
      setShareSet(next)
      playWalletSound('unlock')
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const downloadOne = (index: number) => {
    if (!shareSet?.shares[index]) return
    downloadShare(
      shareDownloadFilename(index, shareSet.totalShares, shareSet.integrity),
      `${shareSet.shares[index]}\n`,
    )
    playWalletSound('soft')
  }

  const downloadAll = () => {
    if (!shareSet) return
    shareSet.shares.forEach((_, i) => downloadOne(i))
  }

  const copyOne = async (index: number) => {
    if (!shareSet?.shares[index]) return
    if (await copyText(shareSet.shares[index]!)) playWalletSound('copy')
    else {
      playWalletSound('error')
      setError('Could not copy.')
    }
  }

  const finish = () => {
    if (!confirmed) return
    markBackupConfirmed()
    setShareSet(null)
    setPassword('')
    setConfirmed(false)
    playWalletSound('success')
  }

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="split-backup">
      <p className="settings-hint">
        BRC-140 splits your key into {BRC140_DEFAULT_TOTAL} slices. Any{' '}
        {BRC140_DEFAULT_THRESHOLD} of those {BRC140_DEFAULT_TOTAL} recover the wallet. Put each
        slice in a <strong>different</strong> place — notes, email, USB, paper. Places don’t need
        to be vaults; they just shouldn’t all be the same spot.
      </p>

      {!shareSet ? (
        <form className="settings-form settings-form-compact" onSubmit={(e) => void create(e)}>
          <div className="field">
            <label htmlFor="split-backup-password">Password</label>
            <input
              id="split-backup-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || password.length < 8}>
              {busy ? 'Creating…' : 'Create slices'}
            </button>
          </div>
        </form>
      ) : (
        <div className="split-backup-shares">
          <p className="settings-hint">
            Integrity <span className="mono">{shareSet.integrity}</span> — copy or download each
            slice, then store them apart.
          </p>
          <ul className="split-backup-list">
            {shareSet.shares.map((share, index) => (
              <li key={share} className="split-backup-item">
                <div className="split-backup-item-head">
                  <strong>
                    Slice {index + 1} of {shareSet.totalShares}
                  </strong>
                  <span className="settings-row-desc">
                    e.g. {PLACE_HINTS[index] ?? 'Somewhere else'}
                  </span>
                </div>
                <code className="mono split-backup-share">{share}</code>
                <div className="actions split-backup-item-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => downloadOne(index)}>
                    Download
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void copyOne(index)}
                  >
                    Copy
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={downloadAll}>
              Download all
            </button>
          </div>
          <label className="split-backup-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I saved each slice in a different place and can get to at least{' '}
              {shareSet.threshold} of them later.
            </span>
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!confirmed}
              onClick={finish}
            >
              Done — backup confirmed
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setShareSet(null)
                setPassword('')
                setConfirmed(false)
                playWalletSound('deny')
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
