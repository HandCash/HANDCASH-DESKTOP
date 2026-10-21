import { formatChartAmount } from './chartEffects'
import type {
  BoxMessage,
  BoxMessageKind,
  ChartApp,
  ChartValues,
  FetchedResult,
  ItemRef,
  Recipient,
  SenderRef,
  SignatureResult,
} from './chartTypes'

export const CHART_APPS_DESCRIPTION = 'Small single-purpose apps your wallet runs itself. Not a replacement for websites.'

export const BOX_MESSAGE_KIND_LABELS: Record<BoxMessageKind, string> = {
  message: 'Message',
  'payment-request': 'Payment request',
  'payment-notice': 'Payment notice',
  tip: 'Tip',
  file: 'File',
  'identity-card': 'Identity card',
  market: 'Market settlement',
  unreadable: 'Unreadable message',
}

export function shortIdentityKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key
}

export function formatMessageTime(at: number, now = Date.now()): string {
  if (!at) return 'at an unknown time'
  const d = new Date(at)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Render one field for display; empty string when it holds nothing. */
export function formatField(chart: ChartApp, values: ChartValues, name: string, sub?: string): string {
  const def = chart.fields[name]
  const v = values[name]
  if (!def || v === undefined) return def?.type === 'messages' || def?.type === 'senders' || def?.type === 'selection' ? '0' : ''
  switch (def.type) {
    case 'amount':
      return typeof v === 'number' ? formatChartAmount(def.coin ?? 'BSV', v) : ''
    case 'text':
      return String(v)
    case 'friend':
      return (v as Recipient).label
    case 'friends': {
      const list = v as Recipient[]
      return sub === 'count' ? String(list.length) : list.map((r) => r.label).join(', ')
    }
    case 'item':
      return (v as ItemRef).name
    case 'messages':
    case 'senders':
    case 'selection':
      return String((v as unknown[]).length)
    case 'message': {
      const m = v as BoxMessage
      if (sub === 'sender' || sub === undefined) return m.senderName
      if (sub === 'box') return m.box
      if (sub === 'kind') return BOX_MESSAGE_KIND_LABELS[m.kind]
      if (sub === 'time') return formatMessageTime(m.at)
      return m.text || (m.kind === 'unreadable' ? 'This message could not be opened with your key.' : 'No text.')
    }
    case 'sender':
      return (v as SenderRef).name
    case 'signature': {
      const s = v as SignatureResult
      return sub === 'identityKey' ? s.identityKey : s.signature
    }
    case 'fetched': {
      const f = v as FetchedResult
      return sub === 'status' ? String(f.status) : f.text
    }
  }
}

/** Fill `{field}` and `{field.key}` placeholders. The validator has already checked each one. */
export function interpolate(chart: ChartApp, values: ChartValues, text: string): string {
  return text.replace(/\{([^{}]*)\}/g, (_, path: string) => {
    const [name, sub] = path.split('.')
    return formatField(chart, values, name, sub)
  })
}
