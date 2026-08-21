import { authenticityFromProvenCache, getProvenVerdict } from './provenCache'

function normalizeOutpoint(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase()
  const match = /^([0-9a-f]{64})[._](0|[1-9]\d*)$/.exec(raw)
  return match ? `${match[1]}.${match[2]}` : null
}

/**
 * Market-only extension to BRC-100 listOutputs rows.
 *
 * The market must not infer authenticity from an `origin` tag or from unverified
 * remittance. Only the wallet's durable BRC-150 verdict may make an item
 * eligible for sale, and only the origin that verdict established may be bound
 * into a sale — `provenOrigin` is the origin the wallet walked to itself, so the
 * market never has to trust the `origin` an app or a sender wrote into metadata.
 *
 * Remittance is deliberately not part of this verdict. `customInstructions`
 * carries a proof blob only for tips that arrived through a BRC-150 send; a
 * minted or imported tip is just as genuine and rebuilds a publishable proof at
 * listing time. Requiring the blob here would hide almost every real item.
 */
export function addMarketOriginVerdicts(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[] }
  if (!Array.isArray(body.outputs)) return result
  return {
    ...body,
    outputs: body.outputs.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const outpoint = normalizeOutpoint((raw as { outpoint?: unknown }).outpoint)
      const verdict = outpoint
        ? authenticityFromProvenCache(outpoint)
        : { authenticity: 'unproven' as const, proven: false }
      const proven = verdict.proven && verdict.authenticity === 'brc150'
      const provenOrigin = proven && outpoint ? getProvenVerdict(outpoint)?.origin : undefined
      return {
        ...raw,
        authenticity: verdict.authenticity,
        originVerified: proven,
        provenOrigin: provenOrigin ?? null,
      }
    }),
  }
}
