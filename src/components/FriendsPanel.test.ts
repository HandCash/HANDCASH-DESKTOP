import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listFriends, type Friend } from '../wallet/friends'
import { FriendsPanel, FriendsResults } from './FriendsPanel'

const NOW = Date.UTC(2026, 9, 22, 16, 0)
const DAY = 24 * 60 * 60_000

vi.mock('./PeerIdentity', () => ({
  FriendIdentityBlock: ({ name, fallback }: { name: ReactNode; fallback: ReactNode }) =>
    createElement('span', null, createElement('span', { className: 'friend-avatar' }), name, fallback),
}))
vi.mock('./PanelFilter', () => ({
  PanelFilter: ({ id }: { id: string }) => createElement('input', { id, className: 'panel-filter-mock' }),
}))
vi.mock('./CollectionViewToggle', () => ({ CollectionViewToggle: () => null }))
vi.mock('../wallet/friends', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wallet/friends')>()),
  listFriends: vi.fn(() => []),
  subscribeFriends: () => () => undefined,
}))
vi.mock('../wallet/collectionView', () => ({
  getCollectionView: () => 'list',
  subscribeCollectionView: () => () => undefined,
}))
vi.mock('../wallet/navStore', () => ({
  openAddFriend: vi.fn(),
  openFriendDetails: vi.fn(),
  openMessagesInbox: vi.fn(),
}))
vi.mock('../wallet/soundedAction', () => ({ withSoftSound: (fn: () => void) => fn }))

const FRIENDS: Friend[] = [
  { id: 'a', label: 'Alice', identityKey: '02' + 'a'.repeat(64), createdAt: NOW - 3 * DAY },
  { id: 'b', label: 'Bob', identityKey: '03' + 'b'.repeat(64), createdAt: NOW - DAY - 1 },
]

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const results = (friends: Friend[], query = '') =>
  renderToStaticMarkup(
    createElement(FriendsResults, { friends, query, view: 'list', chain: 'main', now: NOW }),
  )

beforeEach(() => {
  vi.mocked(listFriends).mockReturnValue([])
})

describe('FriendsResults', () => {
  it('offers to add a friend when there are none', () => {
    const out = text(results([]))
    expect(out).toContain('No friends yet')
    expect(out).toContain('Add friend')
  })

  it('lists each friend with an avatar and when they were added', () => {
    const html = results(FRIENDS)
    const out = text(html)
    expect(out).toContain('Alice')
    expect(out).toContain('Added 3 days ago')
    expect(out).toContain('Bob')
    expect(out).toContain('Added yesterday')
    expect(html.match(/friend-avatar/g)).toHaveLength(2)
  })

  it('shows only matching friends for a search', () => {
    const out = text(results(FRIENDS, 'ali'))
    expect(out).toContain('Alice')
    expect(out).not.toContain('Bob')
  })

  it('says plainly when a search matches nothing', () => {
    const out = text(results(FRIENDS, 'zzz'))
    expect(out).toContain('No friends found')
    expect(out).toContain('Nothing matches “zzz”.')
  })
})

describe('FriendsPanel', () => {
  const panel = () => renderToStaticMarkup(createElement(FriendsPanel, { chain: 'main' }))

  it('puts the search directly under the title, above the list', () => {
    vi.mocked(listFriends).mockReturnValue(FRIENDS)
    const html = panel()
    const search = html.indexOf('panel-filter-mock')
    expect(search).toBeGreaterThan(html.indexOf('Friends'))
    expect(search).toBeLessThan(html.indexOf('Alice'))
    expect(html).toContain('aria-label="2 friends"')
  })

  it('has no search with no friends, only the empty state', () => {
    const html = panel()
    expect(html).not.toContain('panel-filter-mock')
    expect(text(html)).toContain('No friends yet')
  })
})
