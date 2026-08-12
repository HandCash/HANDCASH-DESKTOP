/**
 * Interpret toolbox `postBeef` / `postRaws` results.
 *
 * Top-level `status: 'error'` is not enough — Bitails marks missing-inputs as
 * error+doubleSpend, while already-in-mempool stays success on the txid row.
 */
export type PostBeefServiceResult = {
  name?: string
  status?: string
  txidResults?: Array<{
    txid?: string
    status?: string
    alreadyKnown?: boolean
    doubleSpend?: boolean
    competingTxs?: string[]
    serviceError?: boolean
    notes?: Array<{ what?: string; message?: string; code?: unknown }>
    data?: unknown
  }>
  error?: { message?: string }
}

export type PostBeefSummary = {
  accepted: boolean
  doubleSpend: boolean
  missingInputs: boolean
  serviceOnlyErrors: boolean
  detail: string
  competingTxs: string[]
}

function noteWhat(notes: Array<{ what?: string }> | undefined): string[] {
  return (notes ?? []).map((n) => String(n.what ?? '')).filter(Boolean)
}

export function summarizePostBeef(
  results: PostBeefServiceResult[] | null | undefined,
): PostBeefSummary {
  if (!Array.isArray(results)) {
    return {
      accepted: false,
      doubleSpend: false,
      missingInputs: false,
      serviceOnlyErrors: true,
      detail: 'no services',
      competingTxs: [],
    }
  }
  let accepted = false
  let doubleSpend = false
  let missingInputs = false
  let anyTxRow = false
  let anyServiceError = false
  const competing = new Set<string>()
  const parts: string[] = []

  for (const r of results) {
    const name = r.name || 'service'
    parts.push(`${name}:${r.status || 'unknown'}`)
    for (const t of r.txidResults ?? []) {
      anyTxRow = true
      const notes = noteWhat(t.notes)
      if (t.status === 'success' || t.alreadyKnown) accepted = true
      if (notes.some((w) => /AlreadyInMempool/i.test(w))) accepted = true
      if (t.doubleSpend) doubleSpend = true
      if (notes.some((w) => /MissingInputs/i.test(w))) {
        missingInputs = true
        doubleSpend = true
      }
      if (t.serviceError) anyServiceError = true
      for (const c of t.competingTxs ?? []) {
        const id = c.trim().toLowerCase()
        if (/^[0-9a-f]{64}$/.test(id)) competing.add(id)
      }
      if (t.status === 'error' && t.data && typeof t.data === 'object') {
        const msg = String((t.data as { message?: string }).message ?? '')
        if (/missing.?input/i.test(msg)) {
          missingInputs = true
          doubleSpend = true
        }
      }
    }
    if (r.status === 'error' && !r.txidResults?.length) anyServiceError = true
  }

  if (!accepted && results.some((r) => r.status === 'success')) accepted = true

  return {
    accepted,
    doubleSpend,
    missingInputs,
    serviceOnlyErrors: !accepted && !doubleSpend && (anyServiceError || !anyTxRow),
    detail: parts.join(', ') || 'no services',
    competingTxs: [...competing],
  }
}

export function formatPostBeefFailure(summary: PostBeefSummary): string {
  if (summary.missingInputs || summary.doubleSpend) {
    return 'This item looks already spent on-chain. Refreshing inventory — pick it again if it still appears.'
  }
  if (summary.serviceOnlyErrors) {
    return `Broadcast services were unreachable (${summary.detail}). Check connection and try again.`
  }
  return `Broadcast failed — not accepted by the network (${summary.detail})`
}
