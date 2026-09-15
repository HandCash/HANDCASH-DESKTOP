export type OutpointSpentStatus = 'spent' | 'unspent' | 'unknown'

/**
 * Arcade `/tx` is source-tx presence. Always `null` so spent probes skip it.
 */
export function spentStatusFromArcadeTxLookup(
  _txStatus: unknown,
): OutpointSpentStatus | null {
  return null
}

/**
 * Bitails `/tx/{txid}/output/{n}/status`. `unknown` means spent *or* never
 * seen — that is not proof the coins moved, so the caller must fail closed.
 */
export function classifyBitailsUtxoStatus(body: {
  status?: unknown
  spent?: unknown
}): OutpointSpentStatus {
  const status = String(body.status ?? '').toLowerCase()
  if (status === 'unknown' || status === 'not found') return 'unknown'
  if (body.spent === true) return 'spent'
  if (body.spent === false) return 'unspent'
  return 'unknown'
}
