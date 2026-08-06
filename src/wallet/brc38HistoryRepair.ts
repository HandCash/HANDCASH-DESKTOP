/**
 * BRC-38 export refuses any document containing a JSON `null`, and the monitor
 * writes them: a service that answers without a txid leaves `{"txid":null}` in
 * `provenTxReqs[].history.notes`. One such note poisons every future backup,
 * and because the backup watchdog counts failures, the wallet ends up locked
 * out of cloud backup for hours over a diagnostic breadcrumb.
 *
 * These notes carry no wallet state, so the repair is to drop the null members
 * from the stored history and let the export run again.
 */
import { appendAppLog } from './appLog'

/** Storage surface this repair needs — narrower than the toolbox provider. */
export type ProvenTxReqHistoryStore = {
  findUserByIdentityKey: (identityKey: string) => Promise<{ userId: number } | undefined>
  getProvenTxReqsForUser: (args: {
    userId: number
  }) => Promise<Array<{ provenTxReqId: number; history?: unknown }>>
  updateProvenTxReq: (id: number, update: { history: string }) => Promise<unknown>
}

/** True when a thrown error is BRC-38 validation refusing a null member. */
export function isNullMemberRejection(err: unknown): boolean {
  return err instanceof Error && /^BRC-38 .* must omit null values$/.test(err.message)
}

/** Recursively drop null members; returns undefined when the value is itself null. */
function withoutNulls(value: unknown): unknown {
  if (value === null) return undefined
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      const kept = withoutNulls(item)
      if (kept !== undefined) out.push(kept)
    }
    return out
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const kept = withoutNulls(child)
      if (kept !== undefined) out[key] = kept
    }
    return out
  }
  return value
}

/**
 * Rewrite every `provenTxReq.history` that contains a null member.
 * Returns how many rows were rewritten.
 */
export async function repairProvenTxReqHistoryNulls(
  storage: ProvenTxReqHistoryStore,
  identityKey: string,
): Promise<number> {
  const user = await storage.findUserByIdentityKey(identityKey)
  if (!user) return 0

  let repaired = 0
  for (const req of await storage.getProvenTxReqsForUser({ userId: user.userId })) {
    const raw = req.history
    // The column is a JSON string on disk, but a provider may hand back the object.
    let parsed: unknown
    if (typeof raw === 'string') {
      if (!raw.includes('null')) continue
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
    } else if (raw != null && typeof raw === 'object') {
      parsed = raw
    } else {
      continue
    }

    const cleaned = withoutNulls(parsed) ?? {}
    const next = JSON.stringify(cleaned)
    if (typeof raw === 'string' && next === raw) continue
    if (typeof raw !== 'string' && next === JSON.stringify(raw)) continue

    await storage.updateProvenTxReq(req.provenTxReqId, { history: next })
    repaired += 1
  }

  if (repaired > 0) {
    appendAppLog(
      'warn',
      `[cloud-backup] dropped null note field(s) from ${repaired} monitor history row(s)`,
    )
  }
  return repaired
}
