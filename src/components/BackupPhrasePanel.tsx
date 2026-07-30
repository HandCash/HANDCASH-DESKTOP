import { useState, type FormEvent } from 'react'
import { revealMnemonic, revealRootKeyHex, readVaultMeta } from '../wallet/vault'

export function BackupPhrasePanel() {
  const meta = readVaultMeta()
  const [password, setPassword] = useState('')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [rootKey, setRootKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  return (
    <div className="nav-section-body" data-aeon-scope="backup-phrase">
      <div className="connected-panel-head">
        <h2>Backup</h2>
      </div>
      <p className="lede" style={{ marginTop: 0 }}>
        {meta?.hasMnemonic
          ? 'Reveal your 12-word recovery phrase. Anyone with these words can spend your money.'
          : 'This wallet was created before recovery phrases. You can export an emergency root key instead.'}
      </p>

      <form className="panel" onSubmit={(e) => void reveal(e)}>
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
            {busy ? 'Unlocking…' : meta?.hasMnemonic ? 'Show recovery phrase' : 'Show emergency key'}
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
              Copy phrase
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setMnemonic(null)
                setPassword('')
              }}
            >
              Hide
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
              Copy key
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setRootKey(null)
                setPassword('')
              }}
            >
              Hide
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
