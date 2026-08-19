import { useEffect, useRef, useState } from 'react'
import { formatBsv, formatSats } from '../wallet/session'
import {
  clearPhraseItemMigrateCursor,
  migratePhraseItemsBatch,
  peekPhraseItemMigrateCursor,
  previewPhraseSweep,
  sweepPhraseFunding,
  validatePhraseInput,
  type PhraseSweepPreview,
} from '../wallet/phraseSweep'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { unlockVault } from '../wallet/vault'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

type Phase = 'enter' | 'preview' | 'working' | 'done'

/**
 * Settings → Import phrase — sweep another BIP39 wallet into this install.
 */
export function ImportPhrasePanel() {
  const [phase, setPhase] = useState<Phase>('enter')
  const [phrase, setPhrase] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<PhraseSweepPreview | null>(null)
  const [status, setStatus] = useState('')
  const [fundingResult, setFundingResult] = useState<string | null>(null)
  const [itemProgress, setItemProgress] = useState<string | null>(null)
  const [migrateItems, setMigrateItems] = useState(true)
  const abortRef = useRef(false)

  useEffect(() => {
    const cur = peekPhraseItemMigrateCursor()
    if (cur) {
      setItemProgress(
        `Resume available · ${cur.moved} moved · offset ${cur.offset}`,
      )
    }
  }, [])

  const runPreview = async () => {
    const invalid = validatePhraseInput(phrase)
    if (invalid) {
      toastError('Phrase', invalid)
      return
    }
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      toastError('Password', 'Confirm your unlock password first.')
      return
    }
    setBusy(true)
    setStatus('Checking phrase…')
    playWalletSound('soft')
    try {
      await unlockVault(password)
      const next = await previewPhraseSweep(phrase, passphrase)
      setPreview(next)
      setPhase('preview')
      setStatus('')
      playWalletSound('success')
    } catch (err) {
      playWalletSound('error')
      toastError('Preview failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runSweep = async () => {
    if (!preview) return
    if (preview.sameAsActive) {
      toastError('Same wallet', 'That phrase is already this identity — use Refresh.')
      return
    }
    abortRef.current = false
    setBusy(true)
    setPhase('working')
    playWalletSound('soft')
    try {
      await unlockVault(password)
      setStatus('Sweeping BSV into this wallet…')
      const funding = await sweepPhraseFunding({
        mnemonic: phrase,
        passphrase,
        candidate: preview.candidate,
        utxos: preview.scan.utxos,
      })
      const fundMsg =
        funding.imported > 0
          ? `Moved ${formatSats(funding.fundingSatsMoved)} sats (${funding.imported} output${funding.imported === 1 ? '' : 's'})`
          : funding.failed > 0
            ? `No funding moved · ${funding.failed} failed`
            : 'No sweepable BSV on that phrase'
      setFundingResult(fundMsg)
      toastSuccess('BSV sweep', fundMsg)

      if (migrateItems && preview.itemCountAtLeast > 0 && !abortRef.current) {
        setStatus(
          preview.itemCountCapped
            ? `Moving collectables (large collection — this takes a while)…`
            : `Moving ${preview.itemCountAtLeast} collectables…`,
        )
        let guard = 0
        while (!abortRef.current && guard < 200_000) {
          guard += 1
          const batch = await migratePhraseItemsBatch({
            candidate: preview.candidate,
            batchSize: 5,
          })
          setItemProgress(
            `${batch.moved} moved · ${batch.failed} failed · scanned ${batch.scanned}${batch.done ? ' · done' : ''}`,
          )
          if (batch.done) break
          setStatus(`Moving collectables… ${batch.moved} so far`)
        }
      }

      setPhase('done')
      setStatus('')
      playWalletSound('success')
      toastSuccess('Import finished', 'Refresh Collect if items are still catching up.')
    } catch (err) {
      playWalletSound('error')
      toastError('Import failed', err instanceof Error ? err.message : String(err))
      setPhase('preview')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="import-phrase"
      data-aeon-state={phase}
    >
      <p className="settings-hint">
        Paste a <strong>12- or 24-word</strong> recovery phrase from another wallet (e.g. Yours).
        BSV is swept into <em>this</em> HandCash identity. Collectables move in small batches —
        huge collections (hundreds of thousands) will take a long time and need fee sats on this
        wallet.
      </p>

      {phase === 'enter' || phase === 'preview' ? (
        <>
          <div className="field" data-aeon-part="field" style={{ marginTop: 12 }}>
            <label htmlFor="import-phrase">Recovery phrase</label>
            <textarea
              id="import-phrase"
              rows={3}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="twelve words separated by spaces"
              autoComplete="off"
              spellCheck={false}
              disabled={busy || phase === 'preview'}
            />
          </div>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-passphrase">BIP39 passphrase (optional)</label>
            <input
              id="import-passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
              disabled={busy || phase === 'preview'}
            />
          </div>
          <div className="field" data-aeon-part="field">
            <label htmlFor="import-unlock">Your unlock password</label>
            <input
              id="import-unlock"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </div>
        </>
      ) : null}

      {phase === 'enter' ? (
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !phrase.trim()}
            onClick={() => void runPreview()}
          >
            {busy ? 'Scanning…' : 'Preview'}
          </button>
        </div>
      ) : null}

      {preview && (phase === 'preview' || phase === 'working' || phase === 'done') ? (
        <div style={{ marginTop: 16 }}>
          <h3 className="settings-row-label">Source wallet</h3>
          <p className="settings-row-desc" style={{ marginTop: 6 }}>
            Scheme: <strong>{preview.candidate.scheme}</strong>
            <br />
            Address: {preview.candidate.address}
            <br />
            Identity: {preview.candidate.identityKey.slice(0, 14)}…
            {preview.sameAsActive ? (
              <>
                <br />
                <strong>Same as this wallet</strong> — nothing to sweep.
              </>
            ) : null}
          </p>
          <p className="settings-row-desc" style={{ marginTop: 8 }}>
            Sweepable BSV: <strong>{formatBsv(preview.fundingSats)}</strong> (
            {preview.fundingCount} output{preview.fundingCount === 1 ? '' : 's'})
            <br />
            Collectables:{' '}
            <strong>
              {preview.itemCountCapped
                ? `${preview.itemCountAtLeast.toLocaleString()}+`
                : preview.itemCountAtLeast.toLocaleString()}
            </strong>
          </p>

          {phase === 'preview' && !preview.sameAsActive ? (
            <>
              <label className="wallet-setup-option" style={{ marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={migrateItems}
                  onChange={(e) => setMigrateItems(e.target.checked)}
                />
                <span className="wallet-setup-option-body">
                  <strong>Also move collectables</strong>
                  <span>
                    After BSV. Large sets run in batches — leave the app open. This wallet pays
                    fees.
                  </span>
                </span>
              </label>
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void runSweep()}
                >
                  Sweep into this wallet
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null)
                    setPhase('enter')
                    setPhrase('')
                    setPassphrase('')
                  }}
                >
                  Start over
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {phase === 'working' ? (
        <div style={{ marginTop: 16 }}>
          <p className="settings-hint">{status || 'Working…'}</p>
          {itemProgress ? <p className="settings-row-desc">{itemProgress}</p> : null}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                abortRef.current = true
                toastSuccess('Stopping', 'Finishes the current batch, then pauses.')
              }}
            >
              Pause after this batch
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'done' ? (
        <div style={{ marginTop: 16 }}>
          {fundingResult ? <p className="settings-row-desc">{fundingResult}</p> : null}
          {itemProgress ? <p className="settings-row-desc">{itemProgress}</p> : null}
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setPhase('enter')
                setPreview(null)
                setPhrase('')
                setPassphrase('')
                setFundingResult(null)
                setItemProgress(null)
              }}
            >
              Done
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                clearPhraseItemMigrateCursor()
                setItemProgress(null)
                toastSuccess('Cleared', 'Item migrate cursor reset')
              }}
            >
              Clear item resume
            </button>
          </div>
        </div>
      ) : null}

      {status && phase === 'enter' ? (
        <p className="settings-row-desc" style={{ marginTop: 8 }}>
          {status}
        </p>
      ) : null}

      <SettingsFeatureAbout tags={['BRC-75', 'BIP39']}>
        Tries BRC-75 (Yours / HandCash) then legacy HD. Funding uses the foreign key to sign;
        change lands on this identity. Items are separate on-chain moves.
      </SettingsFeatureAbout>
    </div>
  )
}
