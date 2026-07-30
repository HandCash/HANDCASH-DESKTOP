import { useState, type FormEvent } from 'react'
import { revealMnemonic, revealRootKeyHex, readVaultMeta } from '../wallet/vault'
import { isBackupConfirmed, markBackupConfirmed } from '../wallet/backupStatus'

export function BackupPhrasePanel() {
  const meta = readVaultMeta()
  const [password, setPassword] = useState('')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [rootKey, setRootKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(() => isBackupConfirmed())

  const reveal = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setMnemonic(null)
    setRootKey(null)
    setBusy(true)
    try {
      if (meta?.hasMnemonic) {
        setMnemonic(await revealMnemonic(password))
      } else {
        setRootKey(await revealRootKeyHex(password))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string) => {
    try {
      if (window.handcash?.clipboardWrite) await window.handcash.clipboardWrite(text)
      else await navigator.clipboard.writeText(text)
    } catch {
      setError('Could not copy to clipboard.')
    }
  }

  const confirmSaved = () => {
    markBackupConfirmed()
    setConfirmed(true)
    setMnemonic(null)
    setRootKey(null)
    setPassword('')
  }

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="backup-phrase">
      <p className="settings-hint">
        {meta?.hasMnemonic
          ? 'Anyone with these words can spend your money.'
          : 'Legacy wallet — export an emergency key and store it offline.'}
      </p>

      <form className="settings-form settings-form-compact" onSubmit={(e) => void reveal(e)}>
        <div className="field">
          <label htmlFor="backup-password">Password</label>
          <input
            id="backup-password"
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
          <button className="btn btn-primary" type="submit" disabled={busy || password.length < 8}>
            {busy ? 'Unlocking…' : meta?.hasMnemonic ? 'Show phrase' : 'Show key'}
          </button>
        </div>
      </form>

      {mnemonic ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <ol className="recovery-phrase-grid">
            {mnemonic.split(/\s+/).map((word, i) => (
              <li key={`${i}-${word}`}>
                <span className="recovery-phrase-index">{i + 1}.</span> {word}
              </li>
            ))}
          </ol>
          <div className="actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-ghost" onClick={() => void copy(mnemonic)}>
              Copy
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmSaved}>
              I saved it
            </button>
          </div>
        </div>
      ) : null}

      {rootKey ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <p className="mono" style={{ wordBreak: 'break-all' }}>
            {rootKey}
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-ghost" onClick={() => void copy(rootKey)}>
              Copy
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmSaved}>
              I saved it
            </button>
          </div>
        </div>
      ) : null}

      {confirmed && !mnemonic && !rootKey ? (
        <p className="settings-success" role="status">
          Backup marked as saved on this device.
        </p>
      ) : null}
    </div>
  )
}
