import {
  COIN_NAMES,
  type BoxMessage,
  type ChartApp,
  type ChartCoinId,
  type ChartEffect,
  type ChartEffectKind,
  type ChartNetwork,
  type ChartValues,
  type ItemRef,
  type Recipient,
  type ResolvedEffect,
  type SenderRef,
} from './chartTypes'

/** Effects that move money, share identity, or clear or block mail wait for the user's approval. */
const APPROVED: ReadonlySet<ChartEffectKind> = new Set([
  'requestPayment',
  'sendPayment',
  'sendItem',
  'signMessage',
  'deleteMessages',
  'blockSender',
])

export function effectNeedsApproval(kind: ChartEffectKind): boolean {
  return APPROVED.has(kind)
}

/** Both coins in this version count in satoshis. */
export function formatChartAmount(_coin: ChartCoinId, units: number): string {
  return `${units.toLocaleString('en-US')} ${units === 1 ? 'sat' : 'sats'}`
}

function coinLine(coin: ChartCoinId, network: ChartNetwork): string {
  return network === 'testnet' ? `${COIN_NAMES[coin]} testnet` : COIN_NAMES[coin]
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function names(list: readonly { label: string }[]): string {
  const labels = list.map((r) => r.label)
  if (labels.length <= 2) return labels.join(' and ')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** One plain line per declared effect, shown before an app runs. */
export function describeEffect(effect: ChartEffect): string {
  switch (effect.kind) {
    case 'requestPayment':
      return `Ask friends you pick for ${COIN_NAMES[effect.coin]}`
    case 'sendPayment':
      return `Send ${COIN_NAMES[effect.coin]} to a friend you pick`
    case 'sendItem':
      return 'Send an item you pick to a friend you pick'
    case 'signMessage':
      return 'Sign text with your identity key'
    case 'fetch':
      return `Read ${effect.url}`
    case 'listMessages':
      return `Read what's waiting in your message ${effect.boxes.length === 1 ? 'box' : 'boxes'} (${effect.boxes.join(', ')})`
    case 'acknowledgeMessages':
      return 'Mark messages handled'
    case 'deleteMessages':
      return 'Clear messages you pick'
    case 'blockSender':
      return 'Block a sender you pick'
    case 'unblockSender':
      return 'Unblock a sender you pick'
  }
}

function need<T>(value: unknown, what: string, ok: (v: unknown) => boolean): T {
  if (!ok(value)) throw new Error(`Pick ${what} first`)
  return value as T
}

const isRecipient = (v: unknown) =>
  typeof v === 'object' && v !== null && typeof (v as Recipient).identityKey === 'string'
const isAmount = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0

function recipients(value: unknown): Recipient[] {
  if (Array.isArray(value)) return value.filter(isRecipient) as Recipient[]
  return isRecipient(value) ? [value as Recipient] : []
}

function messagesOf(value: unknown, values: ChartValues, listFields: string[]): BoxMessage[] {
  if (Array.isArray(value)) {
    // A selection holds message ids; resolve them against the listed messages.
    const listed = listFields.flatMap((f) => (Array.isArray(values[f]) ? (values[f] as BoxMessage[]) : []))
    return (value as unknown[])
      .map((id) => listed.find((m) => m.id === id))
      .filter((m): m is BoxMessage => !!m)
  }
  if (typeof value === 'object' && value !== null && typeof (value as BoxMessage).id === 'string') {
    return [value as BoxMessage]
  }
  return []
}

function senderOf(value: unknown): SenderRef | null {
  if (typeof value !== 'object' || value === null) return null
  const m = value as Partial<BoxMessage & SenderRef>
  if (typeof m.identityKey === 'string') return { identityKey: m.identityKey, name: m.name ?? m.identityKey }
  if (typeof m.sender === 'string' && m.sender) return { identityKey: m.sender, name: m.senderName ?? m.sender }
  return null
}

/**
 * Turn a declared effect and the current field values into the concrete
 * action. The approval shows exactly this, and exactly this runs.
 */
export function resolveEffect(
  chart: ChartApp,
  effectId: string,
  values: ChartValues,
  network: ChartNetwork,
): ResolvedEffect {
  const effect = chart.effects[effectId]
  if (!effect) throw new Error(`Undeclared effect ${effectId}`)
  const read = (field: string) => values[field]
  const text = (field?: string) => {
    const v = field ? read(field) : undefined
    return typeof v === 'string' ? v.trim() : ''
  }
  const listFields = Object.entries(chart.fields)
    .filter(([, f]) => f.type === 'messages')
    .map(([name]) => name)

  switch (effect.kind) {
    case 'requestPayment':
    case 'sendPayment': {
      if (!effect.networks.includes(network)) throw new Error(`This app doesn't run on ${network}`)
      const total = need<number>(read(effect.amount.field), 'an amount', isAmount)
      if (effect.kind === 'sendPayment') {
        const to = need<Recipient>(read(effect.to.field), 'a friend', isRecipient)
        return { kind: 'sendPayment', coin: effect.coin, network, to, amount: total, memo: text(effect.memo?.field) }
      }
      const from = recipients(read(effect.from.field))
      if (from.length === 0) throw new Error('Pick a friend first')
      const split = effect.amount.divideBy
      const parts = split ? recipients(read(split.countOf)).length + (split.plus ?? 0) : 1
      const amountEach = Math.floor(total / Math.max(1, parts))
      if (amountEach <= 0) throw new Error('The amount is too small to split')
      return { kind: 'requestPayment', coin: effect.coin, network, from, amountEach, memo: text(effect.memo?.field) }
    }
    case 'sendItem': {
      if (!effect.networks.includes(network)) throw new Error(`This app doesn't run on ${network}`)
      const to = need<Recipient>(read(effect.to.field), 'a friend', isRecipient)
      const item = need<ItemRef>(
        read(effect.item.field),
        'an item',
        (v) => typeof v === 'object' && v !== null && typeof (v as ItemRef).outpoint === 'string',
      )
      return { kind: 'sendItem', coin: effect.coin, network, to, item }
    }
    case 'signMessage': {
      const message = text(effect.message.field)
      if (!message) throw new Error('Write the text to sign first')
      return { kind: 'signMessage', appId: chart.id, message }
    }
    case 'fetch':
      return { kind: 'fetch', url: effect.url }
    case 'listMessages':
      return { kind: 'listMessages', boxes: [...effect.boxes] }
    case 'acknowledgeMessages':
    case 'deleteMessages': {
      const messages = messagesOf(read(effect.messages.field), values, listFields)
      if (messages.length === 0) throw new Error('Pick a message first')
      return { kind: effect.kind, messages }
    }
    case 'blockSender':
    case 'unblockSender': {
      const sender = senderOf(read(effect.sender.field))
      if (!sender) throw new Error('Pick a sender first')
      return { kind: effect.kind, sender }
    }
  }
}

export type ApprovalCopy = {
  eyebrow: string
  title: string
  amount?: string
  lines: Array<{ label: string; value: string }>
  note?: string
  confirm: string
}

/** What the approval step says: the amount, who it goes to or comes from, and what is shared or lost. */
export function approvalFor(effect: ResolvedEffect, app: { name: string }): ApprovalCopy {
  switch (effect.kind) {
    case 'sendPayment':
      return {
        eyebrow: `${app.name} wants to send`,
        title: `Send to ${effect.to.label}`,
        amount: formatChartAmount(effect.coin, effect.amount),
        lines: [
          { label: 'To', value: effect.to.label },
          { label: 'Coin', value: coinLine(effect.coin, effect.network) },
          ...(effect.memo ? [{ label: 'Note', value: effect.memo }] : []),
        ],
        confirm: 'Send',
      }
    case 'requestPayment': {
      const each = formatChartAmount(effect.coin, effect.amountEach)
      return {
        eyebrow: `${app.name} wants to ask for a payment`,
        title: `Ask ${names(effect.from)}`,
        amount: effect.from.length > 1 ? `${each} each` : each,
        lines: [
          { label: 'From', value: names(effect.from) },
          { label: 'Coin', value: coinLine(effect.coin, effect.network) },
          ...(effect.memo ? [{ label: 'Note', value: effect.memo }] : []),
        ],
        note: `The request carries your identity to ${effect.from.length > 1 ? 'each of them' : effect.from[0].label}.`,
        confirm: effect.from.length > 1 ? `Send ${effect.from.length} requests` : 'Send request',
      }
    }
    case 'sendItem':
      return {
        eyebrow: `${app.name} wants to send an item`,
        title: `Send ${effect.item.name}`,
        lines: [
          { label: 'Item', value: effect.item.name },
          { label: 'To', value: effect.to.label },
          { label: 'Coin', value: coinLine(effect.coin, effect.network) },
        ],
        confirm: 'Send',
      }
    case 'signMessage':
      return {
        eyebrow: `${app.name} wants your signature`,
        title: 'Sign with your identity key',
        lines: [{ label: 'Text', value: effect.message }],
        note: `Anyone can check that this wallet signed this text for ${app.name}. Nothing else is signed.`,
        confirm: 'Sign',
      }
    case 'deleteMessages': {
      const notices = effect.messages.filter((m) => m.kind === 'payment-notice' || m.kind === 'tip').length
      return {
        eyebrow: `${app.name} wants to clear messages`,
        title: `Clear ${plural(effect.messages.length, 'message')}`,
        lines: [
          { label: 'From', value: names(uniqueSenders(effect.messages)) },
          { label: 'Box', value: [...new Set(effect.messages.map((m) => m.box))].join(', ') },
        ],
        note: notices
          ? `${plural(notices, 'payment notice')} among them. Clearing a notice before this wallet takes its payment can lose that payment.`
          : 'Cleared messages are deleted from the box host and cannot be read again.',
        confirm: `Clear ${plural(effect.messages.length, 'message')}`,
      }
    }
    case 'blockSender':
      return {
        eyebrow: `${app.name} wants to block a sender`,
        title: `Block ${effect.sender.name}`,
        lines: [{ label: 'Identity key', value: effect.sender.identityKey }],
        note: `Messages from ${effect.sender.name}, payment notices included, are cleared as they arrive until you unblock them.`,
        confirm: 'Block',
      }
    default:
      return { eyebrow: app.name, title: effect.kind, lines: [], confirm: 'Continue' }
  }
}

function uniqueSenders(messages: readonly BoxMessage[]): Array<{ label: string }> {
  const seen = new Map<string, string>()
  for (const m of messages) if (!seen.has(m.sender)) seen.set(m.sender, m.senderName)
  return [...seen.values()].map((label) => ({ label }))
}
