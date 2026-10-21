import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../features/messages'
import type { PeerIdentityView } from '../../hooks/usePeerIdentity'
import { ChatThreadList } from './ChatThread'
import { MessageBubble } from './MessageBubble'

vi.mock('../../hooks/usePeerIdentity', () => ({
  usePeerIdentity: () => {
    throw new Error('bubbles take the thread peer as a prop')
  },
}))

function message(partial: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', peerId: 'p1', direction: 'in', kind: 'text', text: 'hi', createdAt: 1, ...partial }
}

const withPicture: PeerIdentityView = {
  kind: 'presented',
  profile: {
    id: 'profile-1',
    identityKey: '02ab',
    source: 'identity-key',
    name: 'Alice',
    description: '',
    image: { contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) },
  },
  mark: { id: 'profile-1', state: 'unconfirmed' },
}

const withoutPicture: PeerIdentityView = {
  ...withPicture,
  profile: { ...withPicture.profile, image: undefined },
} as PeerIdentityView

function avatars(html: string): string[] {
  return html.match(/<span[^>]*class="chat-msg-avatar"[^>]*>/g) ?? []
}

describe('MessageBubble avatar', () => {
  it("shows the peer's profile picture in the bubble avatar slot", () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { msg: message(), peerLabel: 'alice', peer: withPicture }))
    expect(avatars(html)).toHaveLength(1)
    expect(avatars(html)[0]).toContain('data-aeon-state="image"')
    expect(html).toContain('peer-avatar-image')
  })

  it('falls back to the initial without a picture or profile', () => {
    for (const peer of [withoutPicture, null]) {
      const html = renderToStaticMarkup(createElement(MessageBubble, { msg: message(), peerLabel: 'alice', peer }))
      expect(avatars(html)[0]).toContain('data-aeon-state="initial"')
      expect(html).toMatch(/class="chat-msg-avatar"[^>]*>A<\/span>/)
    }
  })

  it('has no avatar on my own messages', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { msg: message({ direction: 'out' }), peerLabel: 'alice', peer: withPicture }),
    )
    expect(avatars(html)).toEqual([])
  })
})

describe('ChatThreadList avatars', () => {
  it('gives every incoming bubble the one peer profile the thread passed in', () => {
    const html = renderToStaticMarkup(
      createElement(ChatThreadList, {
        section: 'messages',
        visibleMessages: [message({ id: 'a' }), message({ id: 'b', direction: 'out' }), message({ id: 'c' })],
        timeline: null,
        peerLabel: 'alice',
        peer: withPicture,
        actions: {},
        listRef: createRef<HTMLDivElement>(),
        endRef: createRef<HTMLDivElement>(),
      }),
    )
    const slots = avatars(html)
    expect(slots).toHaveLength(2)
    for (const slot of slots) expect(slot).toContain('data-aeon-state="image"')
  })
})
