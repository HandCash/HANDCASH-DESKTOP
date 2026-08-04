/**
 * BRC-218 chat-native command grammar (compose-side only).
 * Received counterparty text MUST NEVER be parsed as commands.
 * @see BRCs/apps/0218.md
 */

export type ParsedAmount =
  | { kind: 'sats'; sats: number; label: string }
  | { kind: 'fiat'; currency: string; value: number; label: string }

export type Brc218Command =
  | { verb: 'pay'; recipient?: string; amount?: ParsedAmount; memo?: string }
  | { verb: 'message'; recipient?: string; text: string }
  | { verb: 'request'; recipient?: string; amount?: ParsedAmount; memo?: string }
  | { verb: 'tip'; amount?: ParsedAmount }
  | { verb: 'whois'; recipient?: string }
  | { verb: 'escrow'; amount?: ParsedAmount; asset?: string; agent?: string; memo?: string }
  | { verb: 'sign'; text?: string }
  | { verb: 'receipt'; text?: string }
  | { verb: 'attest'; recipient?: string }
  | { verb: 'scope'; value?: string }
  | { verb: 'trolltoll'; amount?: ParsedAmount }
  | { verb: 'unsupported'; name: string; raw: string }
  | { verb: 'help' }

/** Verbs we parse and surface in-UI (cards / local system replies). */
const IMPLEMENTED = new Set([
  'pay',
  'message',
  'request',
  'tip',
  'whois',
  'help',
  'escrow',
  'sign',
  'receipt',
  'attest',
  'scope',
  'trolltoll',
])

export const COMMAND_PALETTE: Array<{ verb: string; hint: string }> = [
  { verb: 'pay', hint: '<amount> [memo] — pay in this thread' },
  { verb: 'request', hint: '<amount> [memo] — request payment' },
  { verb: 'tip', hint: '<amount> — tip (bound when replying)' },
  { verb: 'whois', hint: '[@handle] — resolve identity' },
  { verb: 'message', hint: '<text> — send as message' },
  { verb: 'escrow', hint: '<amount> — escrow card (agent hold)' },
  { verb: 'sign', hint: '[text] — request a signature' },
  { verb: 'receipt', hint: '[text] — request a signed ack' },
  { verb: 'attest', hint: '[@handle] — peer attestation' },
  { verb: 'scope', hint: '<everyone|contacts|toll|…> — reachability' },
  { verb: 'trolltoll', hint: '<amount> — per-message toll' },
  { verb: 'help', hint: '— list commands' },
]

/** Adaptive fiat label — keeps sub-cent amounts readable ($0.001, $0.0001). */
export function formatFiatLabel(value: number, currency = 'USD'): string {
  if (!Number.isFinite(value)) return currency === 'USD' ? '$0' : `${currency} 0`
  const abs = Math.abs(value)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 2 : abs >= 0.0001 ? 4 : 6
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  })
  if (currency === 'USD') return `$${body}`
  return `${currency} $${body}`
}

export function formatSatsLabel(sats: number): string {
  const n = Math.max(0, Math.floor(sats))
  return `${n.toLocaleString()} sat${n === 1 ? '' : 's'}`
}

function parseAmountToken(tokens: string[], from: number): { amount: ParsedAmount; next: number } | null {
  const a = tokens[from]
  const b = tokens[from + 1]
  if (!a) return null

  if (/^\d+$/.test(a) && b && /^(sat|sats)$/i.test(b)) {
    const sats = Number(a)
    if (!Number.isFinite(sats) || sats < 1) return null
    return {
      amount: { kind: 'sats', sats, label: formatSatsLabel(sats) },
      next: from + 2,
    }
  }

  if (/^\d+(\.\d+)?$/.test(a) && b && /^bsv$/i.test(b)) {
    const value = Number(a)
    if (!Number.isFinite(value) || value <= 0) return null
    const sats = Math.round(value * 1e8)
    if (sats < 1) return null
    return {
      amount: { kind: 'sats', sats, label: `${a} BSV` },
      next: from + 2,
    }
  }

  const fiatPrefixed = /^(USD|EUR|GBP|CHF|CAD|AUD)$/i.test(a) && b?.startsWith('$')
  if (fiatPrefixed) {
    const raw = b.slice(1)
    const value = Number(raw.startsWith('.') ? `0${raw}` : raw)
    if (!Number.isFinite(value) || value <= 0) return null
    return {
      amount: {
        kind: 'fiat',
        currency: a.toUpperCase(),
        value,
        label: formatFiatLabel(value, a.toUpperCase()),
      },
      next: from + 2,
    }
  }

  if (a.startsWith('$')) {
    const raw = a.slice(1)
    const value = Number(raw.startsWith('.') ? `0${raw}` : raw)
    if (!Number.isFinite(value) || value <= 0) return null
    return {
      amount: { kind: 'fiat', currency: 'USD', value, label: formatFiatLabel(value) },
      next: from + 1,
    }
  }

  return null
}

/**
 * Parse a locally composed line. Returns null if the line is plain chat
 * (including `//` → literal `/` chat per BRC-218 §2.1).
 */
export function parseLocalCommand(line: string): Brc218Command | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.startsWith('//')) return null

  const body = trimmed.slice(1)
  const tokens = body.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
  if (tokens.length === 0) return null

  const verb = tokens[0]!.toLowerCase()
  const args = tokens.slice(1)

  if (verb === 'help') return { verb: 'help' }

  if (!IMPLEMENTED.has(verb)) {
    return { verb: 'unsupported', name: verb, raw: trimmed }
  }

  if (verb === 'whois') {
    return { verb: 'whois', recipient: args[0] }
  }

  if (verb === 'tip') {
    const parsed = args.length ? parseAmountToken(args, 0) : null
    return { verb: 'tip', amount: parsed?.amount }
  }

  if (verb === 'message') {
    const recipient = args[0]
    const text = args.slice(1).join(' ')
    return { verb: 'message', recipient, text }
  }

  if (verb === 'sign' || verb === 'receipt') {
    return { verb, text: args.join(' ') || undefined }
  }

  if (verb === 'attest') {
    return { verb: 'attest', recipient: args[0] }
  }

  if (verb === 'scope') {
    return { verb: 'scope', value: args[0] }
  }

  if (verb === 'trolltoll') {
    const parsed = args.length ? parseAmountToken(args, 0) : null
    return { verb: 'trolltoll', amount: parsed?.amount }
  }

  if (verb === 'escrow') {
    let i = 0
    let agent: string | undefined
    let asset: string | undefined
    if (args[0]?.startsWith('@') || args[0]?.startsWith('#')) {
      if (args[0].startsWith('#')) asset = args[0]
      else agent = args[0]
      i = 1
    }
    const parsed = parseAmountToken(args, i)
    const memo = parsed ? args.slice(parsed.next).join(' ') : args.slice(i).join(' ')
    return {
      verb: 'escrow',
      amount: parsed?.amount,
      asset,
      agent,
      memo: memo || undefined,
    }
  }

  if (verb === 'pay' || verb === 'request') {
    let i = 0
    let recipient: string | undefined
    if (args[0] && !args[0].startsWith('$') && !/^\d+$/.test(args[0])) {
      recipient = args[0]
      i = 1
    }
    const parsed = parseAmountToken(args, i)
    const memo = parsed ? args.slice(parsed.next).join(' ') : args.slice(i).join(' ')
    if (verb === 'pay') {
      return {
        verb: 'pay',
        recipient,
        amount: parsed?.amount,
        memo: memo || undefined,
      }
    }
    return {
      verb: 'request',
      recipient,
      amount: parsed?.amount,
      memo: memo || undefined,
    }
  }

  return { verb: 'unsupported', name: verb, raw: trimmed }
}

/** Display form when user typed `//hello` → show `/hello` as chat. */
export function normalizeChatText(line: string): string {
  if (line.startsWith('//')) return line.slice(1)
  return line
}

export function helpText(): string {
  return [
    'BRC-218 commands (compose only — received text is never executed):',
    ...COMMAND_PALETTE.map((c) => `/${c.verb} ${c.hint}`),
    'Amounts: $0.01, 1 sat, 0.00000001 bsv, or 21545 sats',
    'Use // to send a literal /… message',
    'Only you see /help — it is not sent.',
  ].join('\n')
}

/** Filter palette for composer autocomplete when draft starts with `/`. */
export function matchingCommands(draft: string): Array<{ verb: string; hint: string }> {
  const t = draft.trim()
  if (!t.startsWith('/') || t.startsWith('//')) return []
  const frag = t.slice(1).split(/\s/)[0]?.toLowerCase() ?? ''
  if (!frag) return COMMAND_PALETTE
  return COMMAND_PALETTE.filter((c) => c.verb.startsWith(frag))
}
