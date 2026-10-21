import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePeerIdentity, type PeerIdentityView } from '../hooks/usePeerIdentity'
import type { Friend } from '../wallet/friends'
import { FriendIdentityBlock, PeerAvatarForKey, PeerIdentityBlock } from './PeerIdentity'

vi.mock('../hooks/usePeerIdentity', () => ({ usePeerIdentity: vi.fn(() => null) }))

const presented: PeerIdentityView = {
  kind: 'presented',
  profile: { id: 'profile-1', identityKey: '02ab', source: 'identity-key', name: 'Alice', description: '' },
  mark: { id: 'profile-1', state: 'unconfirmed' },
}

const friend: Friend = { id: 'f1', label: 'alice', identityKey: '02ab', createdAt: 1 }

const block = {
  name: createElement('strong', null, 'alice'),
  fallback: createElement('span', { className: 'fallback' }, '02ab'),
}

function render(type: Parameters<typeof createElement>[0], props: object): string {
  return renderToStaticMarkup(createElement(type, props))
}

beforeEach(() => vi.mocked(usePeerIdentity).mockClear())

describe('PeerIdentityBlock', () => {
  it('shows the presented profile under the name instead of the fallback', () => {
    const html = render(PeerIdentityBlock, { label: 'alice', peer: presented, ...block })
    expect(html).toContain('data-aeon-part="peer-identity"')
    expect(html).not.toContain('fallback')
  })

  it('shows the fallback when no profile was presented', () => {
    const html = render(PeerIdentityBlock, { label: 'alice', peer: null, ...block })
    expect(html).toBe(
      '<span class="friend-avatar" data-aeon-part="peer-avatar" data-aeon-state="initial" aria-hidden="true">A</span>' +
        '<strong>alice</strong><span class="fallback">02ab</span>',
    )
  })

  it('wraps name and line in a div only when asked, with or without a class', () => {
    const body = (bodyClassName?: string) =>
      render(PeerIdentityBlock, { label: 'alice', peer: null, ...block, bodyClassName }).replace(/^<span.*?<\/span>/, '')
    expect(body()).toBe('<strong>alice</strong><span class="fallback">02ab</span>')
    expect(body('')).toBe('<div><strong>alice</strong><span class="fallback">02ab</span></div>')
    expect(body('titles')).toBe('<div class="titles"><strong>alice</strong><span class="fallback">02ab</span></div>')
  })

  it('passes the avatar class through', () => {
    const html = render(PeerIdentityBlock, { label: 'alice', peer: null, ...block, avatarClassName: 'friend-avatar big' })
    expect(html.startsWith('<span class="friend-avatar big"')).toBe(true)
  })
})

describe('FriendIdentityBlock', () => {
  it("looks up the friend's profile, asking the friend again if it was evicted", () => {
    vi.mocked(usePeerIdentity).mockReturnValueOnce(presented)
    const html = render(FriendIdentityBlock, { chain: 'main', friend, ...block })
    expect(usePeerIdentity).toHaveBeenCalledWith('main', '02ab', friend)
    expect(html).toContain('data-aeon-part="peer-identity"')
  })
})

describe('PeerAvatarForKey', () => {
  it('looks up by wallet key alone and shows the initial without a picture', () => {
    const html = render(PeerAvatarForKey, { chain: 'main', identityKey: '02ab', label: 'bob' })
    expect(usePeerIdentity).toHaveBeenCalledWith('main', '02ab')
    expect(html).toBe(
      '<span class="friend-avatar" data-aeon-part="peer-avatar" data-aeon-state="initial" aria-hidden="true">B</span>',
    )
  })
})
