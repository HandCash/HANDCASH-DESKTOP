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
})
