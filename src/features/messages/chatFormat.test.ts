import { describe, expect, it } from 'vitest'
import type { ActivityEntry } from '../../wallet/appActivity'
import type { ChatMessage } from '../../wallet/messageStore'
import type { PaymentProgress } from '../../wallet/paymentProgress'
import {
  applyPaymentVerb,
  chatPaymentDescription,
  chatShellClass,
  chatShellState,
  composerStateFor,
  filterPeers,
  formatFileSize,
  isCardMessage,
  isSystemMessage,
  isUnwiredCommand,
  localNote,
  messageAmounts,
  messageItemState,
  payConfirmRequest,
  paymentBadge,
  paymentTimeline,
  payStatusLabel,
  peerActivityOutsideChat,
  resolveAmountSats,
  shortenTxid,
  threadEmptyCopy,
  unreadBadgeLabel,
  unwiredCommandNote,
  type ChatPeer,
} from './chatFormat'
import { parseLocalCommand } from '../../wallet/brc218'

const TXID = 'a'.repeat(64)
const IDLE: PaymentProgress = { phase: 'idle', startedAt: null, label: null, detail: null } as PaymentProgress

function message(partial: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', peerId: 'p1', direction: 'out', kind: 'text', text: 'hi', createdAt: 1, ...partial }
}

function activity(partial: Partial<ActivityEntry> & { retry?: unknown }): ActivityEntry {
  return { id: 'a1', origin: 'handcash', kind: 'spent', sats: 100, at: 2, method: 'p2pkh', ...partial } as ActivityEntry
}

function peer(peerId: string, label: string | null, preview = '', unread = 0): ChatPeer {
  return {
    peerId,
    friend: label === null ? null : { id: peerId, label, identityKey: `key-${peerId}`, createdAt: 0 },
    thread: { peerId, updatedAt: 1, lastPreview: preview, unread },
  } as ChatPeer
}

describe('chat formatting', () => {
  it('shortens long txids and leaves short ones', () => {
    expect(shortenTxid('abc')).toBe('abc')
    expect(shortenTxid('0123456789abcdefXYZ')).toBe('01234567…defXYZ')
  })

  it('formats file sizes in B, KB and MB', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('caps the unread badge at 9+', () => {
    expect(unreadBadgeLabel(3)).toBe('3')
    expect(unreadBadgeLabel(10)).toBe('9+')
  })

  it('heads local notes with the not-sent line', () => {
    expect(localNote('a', 'b')).toBe('Only you — not sent\na\nb')
  })
})

describe('amounts', () => {
  it('keeps sats amounts and drops sub-sat ones', () => {
    expect(resolveAmountSats({ kind: 'sats', sats: 5, label: '5 sats' }, null)).toEqual({
      amountLabel: '5 sats',
      sats: 5,
    })
    expect(resolveAmountSats({ kind: 'sats', sats: 0, label: '0 sats' }, null)).toEqual({
      amountLabel: '0 sats',
    })
    expect(resolveAmountSats(undefined, null)).toEqual({})
  })

  it('converts fiat at the rate, rounding a positive dust amount up to 1 sat', () => {
    expect(resolveAmountSats({ kind: 'fiat', currency: 'USD', value: 1, label: '$1' }, 50).sats).toBe(2_000_000)
    expect(resolveAmountSats({ kind: 'fiat', currency: 'USD', value: 1e-9, label: '$0' }, 50).sats).toBe(1)
    expect(resolveAmountSats({ kind: 'fiat', currency: 'USD', value: 1, label: '$1' }, null).sats).toBeUndefined()
  })

  it('leads with the card label when there are no sats', () => {
    const amounts = messageAmounts(message({ kind: 'pay-request', meta: { amountLabel: '$1' } }), 'usd', 50)
    expect(amounts).toEqual({ amountLabel: '$1', primaryAmount: '$1', satsLine: null })
  })

  it('adds a sats line under a fiat primary amount', () => {
    const amounts = messageAmounts(message({ kind: 'tip', meta: { sats: 2_000_000 } }), 'usd', 50)
    expect(amounts.satsLine).toBe((2_000_000).toLocaleString() + ' sats')
    expect(amounts.primaryAmount).not.toMatch(/sats?/)
  })
})

describe('composer', () => {
  it('fills /pay with the currency lead', () => {
    expect(applyPaymentVerb('', 'pay', 'usd')).toEqual({ draft: '/pay $', cursor: 6 })
    expect(applyPaymentVerb('', 'request', 'bsv')).toEqual({ draft: '/request  bsv', cursor: 9 })
  })

  it('switches verb but keeps a typed amount', () => {
    expect(applyPaymentVerb('/pay 5 sats lunch', 'request', 'usd')).toEqual({
      draft: '/request 5 sats lunch',
      cursor: 21,
    })
    expect(applyPaymentVerb('/request $', 'pay', 'usd')).toEqual({ draft: '/pay $', cursor: 6 })
  })

  it('names the composer state from the draft', () => {
    expect(composerStateFor('')).toBe('idle')
    expect(composerStateFor('hello')).toBe('chat')
    expect(composerStateFor('//not a command')).toBe('chat')
    expect(composerStateFor('/pay 1 sat')).toBe('command')
    expect(composerStateFor('/help')).toBe('lookup')
  })

  it('writes notes for recognised but unwired commands', () => {
    const cmd = parseLocalCommand('/scope read')
    expect(isUnwiredCommand(cmd)).toBe(true)
    if (!isUnwiredCommand(cmd)) return
    expect(unwiredCommandNote(cmd)).toBe(
      'Only you — not sent\n/scope is recognized (BRC-218) but not fully wired yet.\nRequested scope: read',
    )
    expect(isUnwiredCommand(parseLocalCommand('/help'))).toBe(false)
  })
})

describe('peer list', () => {
  const peers = [peer('a', 'Alice', 'lunch', 2), peer('b', 'Bob', 'hello'), peer('c', null)]

  it('filters by name or preview, case-insensitively', () => {
    expect(filterPeers(peers, ' ALI ', false).map((p) => p.peerId)).toEqual(['a'])
    expect(filterPeers(peers, 'hello', false).map((p) => p.peerId)).toEqual(['b'])
    expect(filterPeers(peers, '', false)).toHaveLength(3)
  })

  it('keeps only unread threads when asked', () => {
    expect(filterPeers(peers, '', true).map((p) => p.peerId)).toEqual(['a'])
  })
})

describe('payments timeline', () => {
  const friend = { identityKey: 'KEY', label: 'Alice' }

  it('keeps wallet activity with the friend that has no chat card', () => {
    const entries = [
      activity({ id: 'dup', txid: ` ${TXID.toUpperCase()} `, retry: { recipientIdentityKey: 'key' } }),
      activity({ id: 'new', txid: 'b'.repeat(64), retry: { recipientIdentityKey: 'key' } }),
      activity({ id: 'other', retry: { recipientIdentityKey: 'someone' } }),
    ]
    const chat = [message({ kind: 'pay-sent', meta: { txid: TXID } })]
    expect(peerActivityOutsideChat(entries, friend, chat).map((e) => e.id)).toEqual(['new'])
  })

  it('orders chat cards and activity by time, chat first on ties', () => {
    const rows = paymentTimeline(
      [message({ id: 'm-late', createdAt: 5 }), message({ id: 'm-tie', createdAt: 2 })],
      [activity({ id: 'a-tie', at: 2 }), activity({ id: 'a-early', at: 1 })],
    )
    expect(rows.map((r) => (r.kind === 'message' ? r.message.id : r.entry.id))).toEqual([
      'a-early',
      'm-tie',
      'a-tie',
      'm-late',
    ])
  })
})

describe('message cards', () => {
  it('builds the confirm request from the card', () => {
    expect(payConfirmRequest(message({ id: 'x', kind: 'tip', text: 'Tip', meta: { sats: 1 } }))).toEqual({
      id: 'x',
      verb: 'tip',
      amountLabel: 'Tip',
      satsLabel: '1 sat',
    })
    expect(payConfirmRequest(message({ kind: 'escrow', meta: { amountLabel: '$1' } }))).toMatchObject({
      verb: 'escrow',
      amountLabel: '$1',
      satsLabel: null,
    })
  })

  it('labels pay status, falling back to SPV receiving for incoming payments', () => {
    expect(payStatusLabel(message({ meta: { payStatus: 'sent', txid: TXID } }), IDLE)).toBe(
      `Sent · ${shortenTxid(TXID)}`,
    )
    expect(payStatusLabel(message({ meta: { payStatus: 'sending' } }), IDLE)).toBe('Sending…')
    expect(
      payStatusLabel(message({ meta: { payStatus: 'sending' } }), { ...IDLE, phase: 'signing', label: 'Signing' } as PaymentProgress),
    ).toBe('Signing')
    expect(payStatusLabel(message({ direction: 'in', kind: 'tip' }), IDLE)).toBe('Receiving (SPV)')
    expect(payStatusLabel(message({ meta: { payStatus: 'failed', error: 'no funds' } }), IDLE)).toBe(
      'Failed · no funds',
    )
  })

  it('names the item state, card kind and badge', () => {
    expect(messageItemState(message({ kind: 'pay-request' }))).toBe('mine request-card')
    expect(messageItemState(message({ direction: 'in', kind: 'tip', meta: { payStatus: 'failed' } }))).toBe(
      'theirs payment-card failed',
    )
    expect(messageItemState(message({}))).toBe('mine')
    expect(isCardMessage(message({ kind: 'escrow' }))).toBe(true)
    expect(isCardMessage(message({ kind: 'file' }))).toBe(false)
    expect(isSystemMessage(message({ kind: 'whois' }))).toBe(true)
    expect(paymentBadge('tip', false)).toBe('Tip claimed')
    expect(paymentBadge('pay-sent', true)).toBe('Payment')
  })
})

describe('shell', () => {
  it('projects list, thread and thread-only', () => {
    expect(chatShellState({ navRouted: false, threadOnly: true, activePeerId: 'a' })).toBe('thread-only')
    expect(chatShellState({ navRouted: true, threadOnly: false, activePeerId: 'a' })).toBe('thread')
    expect(chatShellState({ navRouted: false, threadOnly: false, activePeerId: null })).toBe('list')
  })

  it('adds nested or fullscreen classes', () => {
    expect(chatShellClass(false, false)).toBe('chat-shell')
    expect(chatShellClass(true, true)).toBe('chat-shell chat-shell--nested chat-with-scroll')
    expect(chatShellClass(false, true)).toBe('chat-shell chat-shell--fullscreen')
  })

  it('has empty copy per section', () => {
    expect(threadEmptyCopy('files').title).toBe('No shared files')
    expect(threadEmptyCopy('payments').title).toBe('No payments yet')
    expect(threadEmptyCopy('messages').title).toBe('No messages yet')
  })

  it('describes chat payments for the wallet', () => {
    expect(chatPaymentDescription('lunch', null, 'addr')).toBe('HandCash messages: lunch')
    expect(chatPaymentDescription(undefined, 'key')).toBe('HandCash messages BRC-29 pay')
    expect(chatPaymentDescription(undefined, null, 'addr')).toBe('HandCash messages pay to addr')
  })
})
