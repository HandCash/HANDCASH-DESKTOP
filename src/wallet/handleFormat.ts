/**
 * HandCash handle presentation.
 *
 * BRC-169's formal grammar uses `@handle@domain`. HandCash's product form is
 * `$handle` (and `$handle@domain` when the ecosystem must be shown). Both are
 * accepted on input; HandCash surfaces prefer `$`.
 */

export function normalizeHandleName(raw: string): string {
  return raw
    .trim()
    .replace(/^\$/, '')
    .replace(/^@/, '')
    .toLowerCase()
}

/** Local HandCash form: `$alice`. */
export function formatDollarHandle(raw: string): string {
  const h = normalizeHandleName(raw)
  return h ? `$${h}` : ''
}

/**
 * Prefer `$alice` inside HandCash; `$alice@domain` when the ecosystem is foreign
 * or the caller asks for the fully-qualified form.
 */
export function formatHandCashHandle(
  handle: string,
  domain: string | null | undefined,
  opts: { fullyQualified?: boolean; homeDomain?: string } = {},
): string {
  const h = normalizeHandleName(handle)
  if (!h) return ''
  const home = (opts.homeDomain || 'handcash.io').toLowerCase()
  const d = domain?.trim().toLowerCase() || null
  if (opts.fullyQualified || (d && d !== home)) {
    return `$${h}@${d || home}`
  }
  return `$${h}`
}
