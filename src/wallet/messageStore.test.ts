import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./friends', () => ({
  listFriends: () => [],
}))

import { bindAccountLocalKeyScope } from './accountLocalKeys'
import {
  appendMessage,
  listAllMessages,
  MESSAGES_DURABLE_MAX_BYTES,
} from './messageStore'

describe('message store retention', () => {
  beforeEach(() => {
    store.clear()
    bindAccountLocalKeyScope({
      accountIndex: 0,
      identityKey: 'vitest-primary-identity',
      chain: 'main',
    })
  })

  it('keeps newest messages while bounding rich protocol cards', () => {
    for (let i = 0; i < 4; i += 1) {
      appendMessage('peer', {
        direction: 'in',
        kind: 'text',
        text: `${i}:${'x'.repeat(300 * 1024)}`,
        createdAt: i + 1,
      })
    }

    const raw = store.get('handcash.messages.v1')
    expect(raw).toBeDefined()
    expect(raw!.length).toBeLessThanOrEqual(MESSAGES_DURABLE_MAX_BYTES)
    const messages = listAllMessages()
    expect(messages.at(-1)?.text.startsWith('3:')).toBe(true)
    expect(messages.some((message) => message.text.startsWith('0:'))).toBe(false)
  })

  /**
   * Chain ingest marks inbound payments by walking history for every txid it
   * imports. Re-reading and re-parsing the blob per call blocked the main
   * thread for seconds on a phone with real history.
   */
  it('parses stored history once, however many callers ask for it', () => {
    // Cold: history that this renderer has not parsed yet.
    appendMessage('peer', { direction: 'in', kind: 'text', text: 'hi' })
    const raw = store.get('handcash.messages.v1')!
    store.set('handcash.messages.v1', raw.replace('"hi"', '"yo"'))

    const parse = vi.spyOn(JSON, 'parse')
    for (let i = 0; i < 25; i += 1) {
      expect(listAllMessages()).toHaveLength(1)
    }
    expect(parse).toHaveBeenCalledTimes(1)

    // A write leaves its own blob behind, so readers after it parse nothing.
    parse.mockClear()
    appendMessage('peer', { direction: 'in', kind: 'text', text: 'again' })
    expect(listAllMessages()).toHaveLength(2)
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('notices history replaced underneath it', () => {
    appendMessage('peer', { direction: 'in', kind: 'text', text: 'hi' })
    expect(listAllMessages()).toHaveLength(1)

    store.clear()
    expect(listAllMessages()).toHaveLength(0)
  })

  /**
   * Finding how many entries to drop re-encodes on every probe. History that
   * already fits must never pay for that search.
   */
  it('does not run the trim search on in-budget history', () => {
    for (let i = 0; i < 5; i += 1) {
      appendMessage('peer', { direction: 'in', kind: 'text', text: `m${i}` })
    }
    const spy = vi.spyOn(JSON, 'stringify')
    appendMessage('peer', { direction: 'in', kind: 'text', text: 'last' })
    const encodes = spy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        'data' in (call[0] as Record<string, unknown>),
    )
    spy.mockRestore()
    expect(encodes).toHaveLength(1)
  })
})

describe('inbound payment cards', () => {
  const TXID = 'c'.repeat(64)
  const card = (meta: Record<string, unknown> = {}, kind: 'pay-sent' | 'tip' = 'pay-sent') => ({
    direction: 'in' as const,
    kind,
    text: 'Pay 500 sats',
    meta: { txid: TXID, brc29: { derivationPrefix: 'p', derivationSuffix: 's', outputIndex: 0 }, ...meta },
  })

  beforeEach(() => {
    store.clear()
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'vitest-primary-identity', chain: 'main' })
  })

  it('is one card however many times its notice arrives', () => {
    const first = appendMessage('peer', card({ status: 'Receiving (SPV)' }))
    const again = appendMessage('peer', card({ status: 'Receiving (SPV)' }))
    expect(again.id).toBe(first.id)
    expect(listAllMessages()).toHaveLength(1)
  })

  it('keeps distinct outputs, kinds and senders of one transaction apart', () => {
    appendMessage('peer', card({ itemOutputIndex: 0 }))
    appendMessage('peer', card({ itemOutputIndex: 1 }))
    appendMessage('peer', card({}, 'tip'))
    appendMessage('other', card())
    expect(listAllMessages()).toHaveLength(4)
  })

  it('never folds outgoing cards or plain chat', () => {
    appendMessage('peer', { ...card(), direction: 'out' })
    appendMessage('peer', { ...card(), direction: 'out' })
    appendMessage('peer', { direction: 'in', kind: 'text', text: 'same' })
    appendMessage('peer', { direction: 'in', kind: 'text', text: 'same' })
    expect(listAllMessages()).toHaveLength(4)
  })
})
