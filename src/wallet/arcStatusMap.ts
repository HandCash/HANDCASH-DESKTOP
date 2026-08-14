/**
 * Map ARC / postBeef / toolbox broadcast signals → ArcStatus.
 *
 * HTTP 200 alone is never finality. Prefer explicit ARC codes; fall back to
 * postBeef summary notes for multi-provider stacks.
 */
import type { ArcStatus } from './txLifecycle'
import type { PostBeefSummary } from './postBeefResult'

const ARC_CODE_MAP: Record<string, ArcStatus> = {
  QUEUED: 'STORED',
  RECEIVED: 'STORED',
  STORED: 'STORED',
  ANNOUNCED_TO_NETWORK: 'ANNOUNCED_TO_NETWORK',
  ANNOUNCED: 'ANNOUNCED_TO_NETWORK',
  REQUESTED_BY_NETWORK: 'ANNOUNCED_TO_NETWORK',
  SENT_TO_NETWORK: 'ANNOUNCED_TO_NETWORK',
  ACCEPTED_BY_NETWORK: 'ANNOUNCED_TO_NETWORK',
  SEEN_ON_NETWORK: 'SEEN_ON_NETWORK',
  SEEN_MULTIPLE_NODES: 'SEEN_ON_NETWORK',
  SEEN_IN_ORPHAN_MEMPOOL: 'SEEN_ON_NETWORK',
  MINED: 'MINED',
  CONFIRMED: 'MINED',
  IMMUTABLE: 'MINED',
  REJECTED: 'REJECTED',
  DOUBLE_SPEND_ATTEMPTED: 'DOUBLE_SPEND_ATTEMPTED',
  DOUBLESPENDATTEMPTED: 'DOUBLE_SPEND_ATTEMPTED',
}

/** Parse a raw ARC txStatus / callback string. */
export function parseArcStatus(raw: string | null | undefined): ArcStatus | null {
  if (!raw) return null
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return ARC_CODE_MAP[key] ?? null
}

/**
 * Derive ArcStatus from a postBeef summary after dispatch.
 * Accepted → SEEN_ON_NETWORK (optimistic mempool); never MINED from postBeef alone.
 */
export function arcStatusFromPostBeef(summary: PostBeefSummary): ArcStatus {
  if (summary.doubleSpend || summary.missingInputs) return 'DOUBLE_SPEND_ATTEMPTED'
  if (summary.accepted) return 'SEEN_ON_NETWORK'
  return 'REJECTED'
}

export type ArcRejectionHandler = {
  status: ArcStatus
  shouldRollbackLocks: boolean
  shouldReleaseStaleOutputs: boolean
}

/** Explicit recovery policy per ARC rejection / double-spend. */
export function handleArcRejection(status: ArcStatus): ArcRejectionHandler {
  switch (status) {
    case 'REJECTED':
      return {
        status,
        shouldRollbackLocks: true,
        shouldReleaseStaleOutputs: false,
      }
    case 'DOUBLE_SPEND_ATTEMPTED':
      return {
        status,
        shouldRollbackLocks: true,
        shouldReleaseStaleOutputs: true,
      }
    default:
      return {
        status,
        shouldRollbackLocks: false,
        shouldReleaseStaleOutputs: false,
      }
  }
}
