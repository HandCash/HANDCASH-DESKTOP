import { useEffect, useRef, useState } from 'react'
import { formatBsv, formatSats, getActiveWallet } from '../wallet/session'
import {
  clearPhraseItemMigrateCursor,
  estimateItemMigrateCost,
  migratePhraseItemsBatch,
  peekPhraseItemMigrateCursor,
  previewPhraseSweep,
  refreshAfterPhraseItemMigrate,
  subscribePhraseItemMigrateCursor,
  sweepPhraseFunding,
  validatePhraseInput,
  type PhraseItemMigrateCursor,
  type PhraseSweepPreview,
} from '../wallet/phraseSweep'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { unlockVault } from '../wallet/vault'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

type Phase = 'enter' | 'preview' | 'working' | 'done'

/** Tips per transaction the run below uses — the estimate must match it. */
const ITEMS_PER_TX = 25

/**
 * State the fee budget and transaction count before the run, not after it
 * stops. A large collection costs real money and takes hours, and the previous
 * copy said "hours of fees" without a number to weigh.
 */
function describeItemMigrateBudget(itemCount: number, capped: boolean): string {
  const { transactions, feeSats } = estimateItemMigrateCost({
    itemCount,
    itemsPerTx: ITEMS_PER_TX,
  })
  const cost = `~${transactions.toLocaleString()} transaction${
    transactions === 1 ? '' : 's'
  }, ~${formatBsv(feeSats)} BSV in fees`
  if (!capped) return `${cost} — finishes in one run.`
  return `At least ${cost}, and the real count is higher. Runs for hours, stops if this wallet runs low on BSV, and resumes where it left off.`
}

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
  const [pendingImport, setPendingImport] = useState<PhraseItemMigrateCursor | null>(
    () => peekPhraseItemMigrateCursor(),
  )
  /** Addresses whose collectables this run will move. */
  const [itemBranches, setItemBranches] = useState<string[]>([])
  const abortRef = useRef(false)

  useEffect(() => {
    const cur = peekPhraseItemMigrateCursor()
    if (cur) {
      setItemProgress(
        `Resume available · ${cur.moved} imported · ${cur.offset} scanned`,
      )
    }
    return subscribePhraseItemMigrateCursor(setPendingImport)
  }, [])

  const activeIdentityKey = getActiveWallet()?.identityKey.trim().toLowerCase() ?? ''
  const pendingBelongsToActiveWallet =
    pendingImport != null &&
    pendingImport.destIdentityKey.trim().toLowerCase() === activeIdentityKey

  const forgetPendingImport = () => {
    if (!pendingImport) return
    const confirmed = window.confirm(
      'Forget this pending import? Items already imported stay in this wallet. Only the saved resume position is removed.',
    )
    if (!confirmed) return
    clearPhraseItemMigrateCursor()
    setItemProgress(null)
    toastSuccess('Pending import removed', 'Already imported collectables were not changed.')
  }

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
      if (
        pendingImport &&
        !next.hits.some((hit) => hit.candidate.address === pendingImport.sourceAddress)
      ) {
        throw new Error(
          'This phrase does not contain the source address for the pending import. Enter the same phrase used to start it, or forget the pending import first.',
        )
      }
      setPreview(next)
      // Start a very large branch switched off. Destination change pays a fee
      // per collectable, so a capped count can outrun the balance and take
      // hours — that is a decision to make deliberately, not a default.
      setItemBranches(
        next.hits
          .filter(
            (h) =>
              h.itemCountAtLeast > 0 &&
              (pendingImport
                ? h.candidate.address === pendingImport.sourceAddress
                : !h.itemCountCapped),
          )
          .map((h) => h.candidate.address),
      )
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
    if (preview.hits.length === 0) {
      toastError(
        preview.sameAsActive ? 'Same wallet' : 'Nothing found',
        preview.sameAsActive
          ? 'That phrase is already this identity — use Refresh.'
          : 'No BSV or collectables to sweep from that phrase.',
      )
      return
    }
    abortRef.current = false
    setBusy(true)
    setPhase('working')
    playWalletSound('soft')
    try {
      await unlockVault(password)
      if (pendingImport) {
        // This is an explicit continuation action, not a second general phrase
        // sweep. Do not move unrelated funding outputs while resuming items.
        setStatus('Resuming collectable import…')
        setFundingResult(null)
      } else {
        setStatus('Sweeping BSV into this wallet…')
        let importedTotal = 0
        let failedTotal = 0
        let satsTotal = 0
        let alreadySweptTotal = 0
        for (const hit of preview.hits) {
          if (abortRef.current) break
          if (hit.fundingCount === 0) continue
          const funding = await sweepPhraseFunding({
            mnemonic: phrase,
            passphrase,
            candidate: hit.candidate,
            utxos: hit.scan.utxos,
          })
          importedTotal += funding.imported
          failedTotal += funding.failed
          satsTotal += funding.fundingSatsMoved
          alreadySweptTotal += funding.alreadySwept
        }
        const fundMsg =
          importedTotal > 0
            ? `Moved ${formatSats(satsTotal)} sats (${importedTotal} output${importedTotal === 1 ? '' : 's'})`
            : failedTotal > 0
              ? `No funding moved · ${failedTotal} failed`
              : alreadySweptTotal > 0
                ? `Already swept earlier · ${alreadySweptTotal} output${alreadySweptTotal === 1 ? '' : 's'} claimed by this wallet`
                : 'No sweepable BSV on that phrase'
        setFundingResult(fundMsg)
        toastSuccess('BSV sweep', fundMsg)
      }

      const itemHits = preview.hits.filter(
        (h) =>
          h.itemCountAtLeast > 0 &&
          itemBranches.includes(h.candidate.address) &&
          (!pendingImport || h.candidate.address === pendingImport.sourceAddress),
      )
      if (migrateItems && itemHits.length > 0 && !abortRef.current) {
        setStatus(
          preview.itemCountCapped
            ? `Moving collectables (large collection — this takes a while)…`
            : `Moving ${preview.itemCountAtLeast} collectables…`,
        )
        let movedRunning = 0
        let movedTotal = 0
        let outOfFunds = false
        const startedAt = Date.now()
        const rate = (moved: number) => {
          const minutes = (Date.now() - startedAt) / 60_000
          if (minutes < 0.25 || moved === 0) return ''
          return ` · ${Math.round(moved / minutes).toLocaleString()}/min`
        }
        for (const hit of itemHits) {
          if (abortRef.current || outOfFunds) break
          let guard = 0
          // A collection-wide fault (unreadable tips, rejected broadcasts) fails
          // every item identically. Grinding through thousands of them just to
          // report the same error at the end is worse than stopping early.
          let barrenBatches = 0
          let lastMoved = 0
          let lastFailed = 0
          while (!abortRef.current && guard < 200_000) {
            guard += 1
            const batch = await migratePhraseItemsBatch({
              candidate: hit.candidate,
              batchSize: 50,
              itemsPerTx: ITEMS_PER_TX,
              expectedItemCount: hit.itemCountCapped
                ? undefined
                : hit.itemCountAtLeast,
            })
            movedTotal = movedRunning + batch.moved
            const skippedNote = batch.skipped > 0 ? ` · ${batch.skipped} skipped` : ''
            setItemProgress(
              `${movedRunning + batch.moved} moved · ${batch.failed} failed${skippedNote} · scanned ${batch.scanned}${rate(movedRunning + batch.moved)}${batch.done ? ' · done' : ''}`,
            )
            if (batch.done) {
              movedRunning += batch.moved
              break
            }
            if (batch.stopped === 'funds') {
              movedRunning += batch.moved
              toastError(
                'Out of spendable BSV',
                `Moved ${movedRunning.toLocaleString()} collectable${movedRunning === 1 ? '' : 's'} before the wallet ran low. Each ${ITEMS_PER_TX}-item transaction costs about ${formatSats(
                  estimateItemMigrateCost({
                    itemCount: ITEMS_PER_TX,
                    itemsPerTx: ITEMS_PER_TX,
                  }).feeSats,
                )} sats. Add funds and run Import phrase again — it resumes where this stopped.`,
              )
              outOfFunds = true
              break
            }
            // Paging past outputs that are not collectables is progress, not a
            // fault — only repeated failures with nothing moved end the run.
            const stalled = batch.moved === lastMoved && batch.failed > lastFailed
            barrenBatches = stalled ? barrenBatches + 1 : 0
            lastMoved = batch.moved
            lastFailed = batch.failed
            if (barrenBatches >= 3) {
              toastError(
                'Collectable migration stopped',
                batch.lastError ?? 'No collectables could be moved from that phrase.',
              )
              break
            }
            setStatus(
              `Moving collectables… ${(movedRunning + batch.moved).toLocaleString()} so far${rate(movedRunning + batch.moved)}`,
            )
          }
        }
        // Chain ingest once per run: per batch it slowed every later batch down.
        if (movedTotal > 0) {
          setStatus('Checking the chain…')
          await refreshAfterPhraseItemMigrate()
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
        Move BSV and collectables from another wallet’s 12- or 24-word phrase into this one.
      </p>

      {pendingImport ? (
        <section
          className="settings-row"
          data-aeon-scope="phrase-import-resume"
          data-aeon-state={
            pendingBelongsToActiveWallet ? 'eligible' : 'different-destination'
          }
          style={{ marginTop: 12 }}
        >
          <div data-aeon-part="header">
            <h3 className="settings-row-label">Pending collectable import</h3>
            <p className="settings-row-desc" style={{ marginTop: 4 }}>
              {pendingImport.stopped === 'funds'
                ? 'Paused because this wallet ran out of spendable BSV for transaction fees.'
                : 'Paused before every source output was checked.'}
            </p>
          </div>
          <dl className="payment-details-meta" style={{ marginTop: 10 }}>
            <dt>Imported</dt>
            <dd>{Math.max(0, Math.trunc(pendingImport.moved)).toLocaleString()}</dd>
            <dt>Scanned</dt>
            <dd>{Math.max(0, Math.trunc(pendingImport.offset)).toLocaleString()}</dd>
            <dt>Failed</dt>
            <dd>{Math.max(0, Math.trunc(pendingImport.failed)).toLocaleString()}</dd>
            <dt>Ignored</dt>
            <dd>
              {Math.max(0, Math.trunc(pendingImport.skipped ?? 0)).toLocaleString()}{' '}
              non-collectables
            </dd>
          </dl>
          <p className="settings-row-desc" style={{ marginTop: 8 }}>
            Source address
            <br />
            <code>{pendingImport.sourceAddress}</code>
          </p>
          <p className="settings-row-desc" style={{ marginTop: 8 }}>
            Destination:{' '}
            <strong>
              {pendingBelongsToActiveWallet ? 'this wallet' : 'a different wallet identity'}
            </strong>
          </p>
          {pendingImport.lastError ? (
            <p className="settings-row-desc" style={{ marginTop: 8 }}>
              Last error: {pendingImport.lastError}
            </p>
          ) : null}
          <p className="settings-row-desc" style={{ marginTop: 8 }}>
            {pendingBelongsToActiveWallet
              ? 'To continue, enter the same source phrase and your unlock password below. Preview verifies the source before any transaction is made.'
              : 'Switch back to the destination wallet to continue. This wallet may only forget the saved resume position.'}
          </p>
          <div className="actions" data-aeon-part="actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={forgetPendingImport}>
              Forget pending import
            </button>
          </div>
        </section>
      ) : null}

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
            disabled={
              busy ||
              !phrase.trim() ||
              (pendingImport != null && !pendingBelongsToActiveWallet)
            }
            onClick={() => void runPreview()}
          >
            {busy ? 'Scanning…' : pendingImport ? 'Preview and resume' : 'Preview'}
          </button>
        </div>
      ) : null}

      {preview && (phase === 'preview' || phase === 'working' || phase === 'done') ? (
        <div style={{ marginTop: 16 }}>
          <h3 className="settings-row-label">Source wallet</h3>
          {preview.hits.length === 0 ? (
            <p className="settings-row-desc" style={{ marginTop: 6 }}>
              {preview.sameAsActive ? (
                <>
                  <strong>Same as this wallet</strong> — nothing to sweep.
                </>
              ) : (
                'Nothing found on the paths we check.'
              )}
            </p>
          ) : (
            <ul className="settings-row-desc" style={{ marginTop: 6, paddingLeft: 18 }}>
              {preview.hits.map((hit) => (
                <li key={hit.candidate.address} style={{ marginBottom: 4 }}>
                  <strong>{hit.candidate.label}</strong> · {formatBsv(hit.fundingSats)}{' '}
                  BSV ·{' '}
                  {hit.itemCountCapped
                    ? `${hit.itemCountAtLeast.toLocaleString()}+`
                    : hit.itemCountAtLeast.toLocaleString()}{' '}
                  item{hit.itemCountAtLeast === 1 ? '' : 's'}
                  <br />
                  <span style={{ opacity: 0.7 }}>{hit.candidate.address}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="settings-row-desc" style={{ marginTop: 8 }}>
            Total sweepable BSV: <strong>{formatBsv(preview.fundingSats)}</strong> (
            {preview.fundingCount} output{preview.fundingCount === 1 ? '' : 's'})
            <br />
            Total collectables:{' '}
            <strong>
              {preview.itemCountCapped
                ? `${preview.itemCountAtLeast.toLocaleString()}+`
                : preview.itemCountAtLeast.toLocaleString()}
            </strong>
          </p>

          {phase === 'preview' && preview.hits.length > 0 ? (
            <>
              <label className="wallet-setup-option" style={{ marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={migrateItems}
                  onChange={(e) => setMigrateItems(e.target.checked)}
                />
                <span className="wallet-setup-option-body">
                  <strong>Also move collectables</strong>
                  <span>Runs after BSV, in batches. This wallet pays the fees.</span>
                </span>
              </label>
              {migrateItems && preview.hits.some((h) => h.itemCountAtLeast > 0) ? (
                <div style={{ marginTop: 8, paddingLeft: 4 }}>
                  <p className="settings-row-desc" style={{ marginBottom: 6 }}>
                    Move collectables from:
                  </p>
                  {preview.hits
                    .filter((hit) => hit.itemCountAtLeast > 0)
                    .map((hit) => (
                      <label
                        key={hit.candidate.address}
                        className="wallet-setup-option"
                        style={{ marginTop: 4 }}
                      >
                        <input
                          type="checkbox"
                          checked={itemBranches.includes(hit.candidate.address)}
                          disabled={
                            pendingImport != null &&
                            hit.candidate.address !== pendingImport.sourceAddress
                          }
                          onChange={(e) =>
                            setItemBranches((prev) =>
                              e.target.checked
                                ? [...prev, hit.candidate.address]
                                : prev.filter((a) => a !== hit.candidate.address),
                            )
                          }
                        />
                        <span className="wallet-setup-option-body">
                          <strong>
                            {hit.candidate.label} ·{' '}
                            {hit.itemCountCapped
                              ? `${hit.itemCountAtLeast.toLocaleString()}+`
                              : hit.itemCountAtLeast.toLocaleString()}{' '}
                            item{hit.itemCountAtLeast === 1 ? '' : 's'}
                          </strong>
                          <span>
                            {describeItemMigrateBudget(
                              hit.itemCountAtLeast,
                              hit.itemCountCapped,
                            )}
                          </span>
                        </span>
                      </label>
                    ))}
                </div>
              ) : null}
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void runSweep()}
                >
                  {pendingImport ? 'Resume collectable import' : 'Sweep into this wallet'}
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
          </div>
        </div>
      ) : null}

      {status && phase === 'enter' ? (
        <p className="settings-row-desc" style={{ marginTop: 8 }}>
          {status}
        </p>
      ) : null}

      <SettingsFeatureAbout tags={['BRC-75', 'BIP39', 'BIP44']}>
        Scans BRC-75, HD master, and the Yours / RelayX / Twetch BIP44 branches — Yours keeps
        cash and ordinals on separate paths, so both are checked. Funding uses the foreign key
        to sign; change lands on this identity. Items are separate on-chain moves.
      </SettingsFeatureAbout>
    </div>
  )
}
