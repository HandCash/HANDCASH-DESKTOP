/**
 * HandCash handle presentation.
 *
 * BRC-169's formal grammar is `@handle@domain`. HandCash's short product form
 * is `$handle` (dollar sigil, no `@`). Fully-qualified / email-shaped forms use
 * the BRC-169 `@handle@domain` grammar (at, no `$`). Input still accepts
 * `$handle`, `@handle`, `@$handle`, and bare / paymail-shaped forms.
 */

export function normalizeHandleName(raw: string): string {
  return raw
    .trim()
    .replace(/^@\$/, '')
    .replace(/^\$/, '')
    .replace(/^@/, '')
    .toLowerCase()
}

/** Short HandCash form: `$alice` (never email-shaped). */
export function formatDollarHandle(raw: string): string {
  const h = normalizeHandleName(raw)
  return h ? `$${h}` : ''
}

/**
 * Prefer the short `$alice` inside HandCash. Fully-qualified / foreign-domain
 * forms use BRC-169 email grammar: `@alice@domain` (at, no `$`).
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
    return `@${h}@${d || home}`
  }
  return `$${h}`
}
