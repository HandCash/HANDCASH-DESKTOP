/**
 * BRC-218 chat-native command grammar (compose-side only).
 * Received counterparty text MUST NEVER be parsed as commands.
 * @see https://github.com/bsv-blockchain/BRCs/blob/master/apps/0218.md
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
  | { verb: 'unsupported'; name: string; raw: string }
  | { verb: 'help' }

const IMPLEMENTED = new Set(['pay', 'message', 'request', 'tip', 'whois', 'help'])

function parseAmountToken(tokens: string[], from: number): { amount: ParsedAmount; next: number } | null {
  const a = tokens[from]
  const b = tokens[from + 1]
  if (!a) return null

  // 21545 sats
  if (/^\d+$/.test(a) && b && /^(sat|sats)$/i.test(b)) {
    const sats = Number(a)
    return {
      amount: { kind: 'sats', sats, label: `${sats.toLocaleString()} sats` },
      next: from + 2,
    }
  }

  // $2.18 or USD $2.18
  const fiatPrefixed = /^(USD|EUR|GBP|CHF|CAD|AUD)$/i.test(a) && b?.startsWith('$')
  if (fiatPrefixed) {
    const value = Number(b.slice(1))
    if (!Number.isFinite(value)) return null
    return {
      amount: {
        kind: 'fiat',
        currency: a.toUpperCase(),
        value,
        label: `${a.toUpperCase()} $${value.toFixed(2)}`,
      },
      next: from + 2,
    }
  }

  if (a.startsWith('$')) {
    const value = Number(a.slice(1))
    if (!Number.isFinite(value)) return null
    return {
      amount: { kind: 'fiat', currency: 'USD', value, label: `$${value.toFixed(2)}` },
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
  if (trimmed.startsWith('//')) return null // plain chat with leading /

  const body = trimmed.slice(1)
  const tokens = body.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
  if (tokens.length === 0) return null

  const verb = tokens[0].toLowerCase()
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

  if (verb === 'pay' || verb === 'request') {
    let i = 0
    let recipient: string | undefined
    // recipient if not amount-like
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
    '/pay [recipient] <amount> [memo] — open payment confirm',
    '/request [recipient] <amount> [memo] — payment request card',
    '/tip [amount] — tip in this thread',
    '/whois [recipient] — show identity',
    '/message [recipient] <text> — send text',
    '/help — this list',
    'Amounts: $2.18 or 21545 sats',
    'Use // to send a literal /… message',
  ].join('\n')
}
