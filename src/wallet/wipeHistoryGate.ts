/**
 * Wipe is gated on the history replica.
 *
 * While a history backup URL is configured, this device may only be wiped
 * after the cloud copy provably holds what localState holds: a fresh guarded
 * upload, confirmed by a remote HEAD. P2P outputs (BRC-29 change, received
 * payments) exist only in localState — Refresh cannot rebuild them — so a wipe
 * ahead of the upload destroys them.
 */
import { hasDeviceLinkBackupUrl } from './deviceSync'
import { fetchRemoteBrc39Meta, HistoryThinOverwriteError, uploadBrc39Backup } from './historyBackup'
import { inspectLocalToolboxState } from './layers'
import { sessionBackupCredential } from './sessionBackupAuth'
import { appendAppLog } from './appLog'

export type WipeHistoryGate = Readonly<{
  kind: 'backup-off' | 'nothing-to-lose' | 'synced'
  checkedAt: number
}>

export type WipeHistoryRefusal =
  | { kind: 'locked' }
  | { kind: 'cloud-richer'; detail: string }
  | { kind: 'upload-failed'; detail: string }
  | { kind: 'unconfirmed' }

export type WipeHistoryCheck =
  | { ok: true; gate: WipeHistoryGate }
  | { ok: false; refusal: WipeHistoryRefusal }

/** A gate older than this must be re-proved; a send could land in between. */
export const WIPE_GATE_TTL_MS = 2 * 60 * 1000

function pass(kind: WipeHistoryGate['kind']): WipeHistoryCheck {
  appendAppLog('info', `[wipe] history gate ${kind}`)
  return { ok: true, gate: Object.freeze({ kind, checkedAt: Date.now() }) }
}

function refuse(refusal: WipeHistoryRefusal): WipeHistoryCheck {
  appendAppLog('warn', `[wipe] history gate refused ${refusal.kind}`)
  return { ok: false, refusal }
}

export async function syncHistoryBeforeWipe(): Promise<WipeHistoryCheck> {
  if (!hasDeviceLinkBackupUrl()) return pass('backup-off')
  const local = await inspectLocalToolboxState()
  if (local.looksEmpty) return pass('nothing-to-lose')

  const credential = sessionBackupCredential()
  if (credential === null) return refuse({ kind: 'locked' })

  let uploadedAt: number
  try {
    uploadedAt = (await uploadBrc39Backup(credential, { passwordAlreadyVerified: true })).exportedAt
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return refuse(
      err instanceof HistoryThinOverwriteError
        ? { kind: 'cloud-richer', detail }
        : { kind: 'upload-failed', detail },
    )
  }

  const remote = await fetchRemoteBrc39Meta()
  if (!remote?.exists) return refuse({ kind: 'unconfirmed' })
  if (remote.exportedAt != null && remote.exportedAt < uploadedAt) return refuse({ kind: 'unconfirmed' })
  return pass('synced')
}

export function assertWipeGateFresh(gate: WipeHistoryGate | null, now = Date.now()): void {
  if (!gate || now - gate.checkedAt > WIPE_GATE_TTL_MS) {
    throw new Error('History backup must sync before this device is wiped')
  }
}

export function wipeRefusalMessage(refusal: WipeHistoryRefusal): string {
  switch (refusal.kind) {
    case 'locked':
      return 'Unlock the wallet to sync history first.'
    case 'cloud-richer':
      return 'The cloud copy has history this device lacks. Replace from cloud in History backup, then wipe.'
    case 'upload-failed':
      return `History didn’t sync: ${refusal.detail}`
    case 'unconfirmed':
      return 'The upload couldn’t be confirmed. Check the connection and try again.'
  }
}
