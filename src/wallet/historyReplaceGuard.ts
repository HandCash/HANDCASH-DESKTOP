import type { LocalToolboxState } from './layers'

/** What the history host reports about the cloud copy (`fetchRemoteBrc39Meta`). */
export type CloudHistoryMeta = {
  exists: boolean
  exportedAt: number | null
  spendableSats: number | null
  actionCount: number | null
}

export type HistorySides = {
  /** Null when the host could not be reached. */
  remote: CloudHistoryMeta | null
  /** Null when this device's ledger could not be read. */
  local: LocalToolboxState | null
}

export type ReplaceVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * Replace from cloud selects a fresh ledger built from the cloud copy; the
 * current ledger is set aside, not merged. Anything only this device holds
 * stops showing. So it is allowed only when the cloud copy is known to hold at
 * least as many actions and as many spendable sats as this device. Merge is the
 * everyday restore; replace is recovery for a ledger merge cannot fix.
 */
export function replaceFromCloudVerdict({ remote, local }: HistorySides): ReplaceVerdict {
  if (!remote) return { allowed: false, reason: 'History host unreachable' }
  if (!remote.exists) return { allowed: false, reason: 'No cloud copy yet' }
  if (!local) return { allowed: false, reason: 'This device’s history could not be read' }
  if (remote.actionCount == null || remote.spendableSats == null) {
    return { allowed: false, reason: 'The cloud copy does not report its size; restore merges instead' }
  }
  if (local.actionCount > remote.actionCount) {
    const extra = local.actionCount - remote.actionCount
    return {
      allowed: false,
      reason: `This device has ${extra.toLocaleString()} action${extra === 1 ? '' : 's'} the cloud copy lacks. Back up first.`,
    }
  }
  if (local.spendableSats > remote.spendableSats) {
    return {
      allowed: false,
      reason: `This device holds ${(local.spendableSats - remote.spendableSats).toLocaleString()} more spendable sats than the cloud copy. Back up first.`,
    }
  }
  return { allowed: true }
}

/** One line per side, e.g. "12 actions · 4,000 sats". */
export function describeHistorySide(
  side: { actionCount: number | null; spendableSats: number | null } | null,
): string {
  if (!side) return 'Unknown'
  const actions = side.actionCount == null ? '? actions' : `${side.actionCount.toLocaleString()} actions`
  const sats = side.spendableSats == null ? 'unknown balance' : `${side.spendableSats.toLocaleString()} sats`
  return `${actions} · ${sats}`
}
