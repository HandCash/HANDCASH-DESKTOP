import { useEffect, useState } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { Progress } from '@aeon-ui/react'
import { clearBackupBackoff } from '../wallet/backupWatchdog'
import { fetchRemoteBrc39Meta, replaceLocalHistoryFromCloud } from '../wallet/historyBackup'
import { ensureSuggestedHistoryBackupUrl } from '../wallet/historyBackupPrefs'
import { recomposeWallet } from '../wallet/recompose'
import { fetchBalanceSats } from '../wallet/session'
import { getWalletRuntime } from '../wallet/walletRuntime'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { playWalletSound } from '../wallet/soundService'
import {
  HISTORY_RESTORE_STAGES,
  HISTORY_RESTORE_STAGE_LABELS,
  historyRecoveryMachine,
  historyRestoreProgress,
  historyRestoreStageFace,
} from '../machines/historyRecoveryMachine'
import { PasswordField } from './PasswordField'

type Props = {
  onDone: (balanceSats: number) => void
  onSkip: () => void
}

const LEGACY_PASSWORD_HINT = /decrypt|password|passphrase|auth|mac|argon|gcm|cipher|invalid/i

/**
 * Post-restore gate: keys are sealed; replace local toolbox state from BRC-39
 * using the root key. When a remote backup exists we pull automatically —
 * local IndexedDB is wiped first, then merged from cloud (never an empty PUT
 * over remote; push stays deferred on the restore path).
 *
 * Every face here is `historyRecoveryMachine`: the probe outcome, the six
 * restore stages the bar walks, the one-time legacy password ask, and the
 * failure. The stage list is driven by the domain path's `onStage`, so the
 * bar advances when the wallet does.
 */
export function HistoryRecoveryPanel({ onDone, onSkip }: Props) {
  const actor = useActorRef(historyRecoveryMachine)
  const snapshot = useSelector(actor, (s) => s)
  const [legacyPassword, setLegacyPassword] = useState('')

  const restoring = snapshot.matches('restoring')
  const progress = historyRestoreProgress(snapshot)
  const stateAttr = stateToAttr(snapshot.value)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        ensureSuggestedHistoryBackupUrl()
        const remote = await fetchRemoteBrc39Meta()
        if (cancelled) return
        if (remote?.exists) actor.send({ type: 'FOUND', bytes: remote.bytes ?? null })
        else actor.send({ type: 'MISSING' })
      } catch (err) {
        if (cancelled) return
        actor.send({
          type: 'UNREACHABLE',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [actor])

  const restore = async () => {
    actor.send({ type: 'RESTORE' })
    try {
      ensureSuggestedHistoryBackupUrl()
      clearBackupBackoff()
      const legacy = legacyPassword.trim() || getSessionBackupPassword() || null
      // Wipe empty local toolbox, then pull remote — pull-only; guarded push
      // is deferred until after the wallet UI is free (historyEmptyGuard).
      await replaceLocalHistoryFromCloud(legacy, {
        onStage: (stage) => actor.send({ type: 'STAGE', stage }),
      })
      actor.send({ type: 'STAGE', stage: 'recompose' })
      const recomposed = await recomposeWallet({
        password: getSessionBackupPassword(),
        history: 'skip',
        reason: 'restore-url',
      })
      let balanceSats = recomposed.spendableSats ?? -1
      if (balanceSats < 0) {
        actor.send({ type: 'STAGE', stage: 'balance' })
        const runtime = getWalletRuntime()
        balanceSats = runtime ? await fetchBalanceSats(runtime.instance.wallet) : 0
      }
      actor.send({ type: 'SUCCEED', balanceSats })
      playWalletSound('success')
      onDone(balanceSats)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      playWalletSound('error')
      if (LEGACY_PASSWORD_HINT.test(message)) {
        actor.send({
          type: 'LEGACY_NEEDED',
          message:
            'This cloud backup was made with an older unlock password. Enter that password once below — we’ll re-seal history to your wallet key.',
        })
        return
      }
      actor.send({ type: 'FAIL', message })
    }
  }

  // A found backup restores on its own; the user is never asked to press Restore
  // for the happy path. Re-read the actor so a double-invoked effect cannot
  // start a second restore — RESTORE has already moved the chart on.
  const found = snapshot.matches('found')
  useEffect(() => {
    if (found && actor.getSnapshot().matches('found')) void restore()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore reads the latest password
  }, [found])

  const note = snapshot.matches('probing')
    ? 'Looking for your history backup…'
    : snapshot.matches('found')
    ? 'History backup found — restoring automatically.'
    : restoring
    ? 'History backup found — restoring balance, activity, friends, and apps…'
    : snapshot.matches('missing')
    ? 'No history backup on HandCash yet. You can enter with a chain scan only, or check Settings → History later.'
    : snapshot.matches('unreachable')
    ? `Could not reach history host: ${snapshot.context.error ?? 'unknown error'}`
    : snapshot.matches('done')
    ? 'History restored.'
    : null

  const canSkip = snapshot.matches('missing') || snapshot.matches('unreachable')
  const canRestore =
    snapshot.matches('unreachable') || snapshot.matches('legacy') || snapshot.matches('failure')
  const showError =
    (snapshot.matches('legacy') || snapshot.matches('failure')) && snapshot.context.error

  return (
    <div
      className="wallet-setup-config"
      data-aeon-scope="history-recovery"
      data-aeon-state={stateAttr}
    >
      <h2>Restore your history</h2>
      <p className="auth-lede">
        Keys are on this device. Activity, UTXOs, friends, and connected apps live in your encrypted
        history backup — sealed to this wallet’s key, not your unlock password.
      </p>
      {note ? (
        <p className="auth-lede" role="status">
          {note}
        </p>
      ) : null}

      {showError ? (
        <p className="wallet-sync-note is-error" role="alert">
          {snapshot.context.error}
        </p>
      ) : null}

      {progress ? (
        <div
          className="history-recovery-progress"
          data-aeon-part="restore-progress"
          data-aeon-state={stateAttr}
        >
          <Progress.Root
            value={progress.value}
            max={progress.max}
            className="history-progress"
            aria-label="Restore progress"
          >
            <Progress.Track className="history-progress-track">
              <Progress.Range className="history-progress-range" />
            </Progress.Track>
          </Progress.Root>
          <ol className="history-recovery-stages" data-aeon-part="restore-stages">
            {HISTORY_RESTORE_STAGES.map((stage) => (
              <li
                key={stage}
                className="history-recovery-stage"
                data-aeon-part="stage"
                data-aeon-state={historyRestoreStageFace(snapshot, stage)}
                aria-current={
                  historyRestoreStageFace(snapshot, stage) === 'active' ? 'step' : undefined
                }
              >
                <span className="history-recovery-stage-mark" aria-hidden="true" />
                <span className="history-recovery-stage-label">
                  {HISTORY_RESTORE_STAGE_LABELS[stage]}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {snapshot.matches('legacy') ? (
        <>
          <PasswordField
            id="history-legacy-password"
            label="Previous unlock password (one-time)"
            placeholder="Password that encrypted the old backup"
            value={legacyPassword}
            onChange={(e) => setLegacyPassword(e.target.value)}
            autoComplete="current-password"
          />
          <p className="password-hint">
            Only needed for backups made before root-key history. After this restore we re-upload
            sealed to your key.
          </p>
        </>
      ) : null}

      <div
        className="auth-actions"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        data-aeon-part="history-recovery-actions"
        data-aeon-state={stateAttr}
      >
        {canRestore ? (
          <button type="button" className="btn btn-primary primary" onClick={() => void restore()}>
            {snapshot.matches('legacy') ? 'Restore with this password' : 'Restore history'}
          </button>
        ) : null}
        {canSkip ? (
          <button type="button" className="btn btn-ghost" onClick={onSkip}>
            {snapshot.matches('missing') ? 'Continue without history' : 'Skip for now'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
