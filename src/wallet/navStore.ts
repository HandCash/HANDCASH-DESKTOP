import type { ConnectedApp } from './permissions'

export type NavSection = 'activity' | 'apps' | 'collectables' | 'friends' | 'identity'

export type NavChild =
  | { type: 'app'; origin: string }
  | { type: 'permission'; origin: string; scopeId: string }
  | { type: 'send' }
  | { type: 'receive' }
  | { type: 'payment'; entryId: string }
  | { type: 'friend'; friendId: string }
  | { type: 'add-friend' }

export type NavState = {
  section: NavSection
  child: NavChild | null
}

type Listener = (state: NavState) => void

const listeners = new Set<Listener>()

let state: NavState = { section: 'activity', child: null }

function emit() {
  for (const cb of listeners) cb(state)
}

export function getNavState(): NavState {
  return state
}

export function subscribeNav(cb: Listener): () => void {
  listeners.add(cb)
  cb(state)
  return () => {
    listeners.delete(cb)
  }
}

export function setNavSection(section: NavSection) {
  state = { section, child: null }
  emit()
}

export function openNavChild(section: NavSection, child: NavChild) {
  state = { section, child }
  emit()
}

export function clearNavChild() {
  if (!state.child) return
  state = { ...state, child: null }
  emit()
}

export function openAppDetails(app: ConnectedApp) {
  openNavChild('apps', { type: 'app', origin: app.origin })
}

export function openPermissionDetails(origin: string, scopeId: string) {
  openNavChild('apps', { type: 'permission', origin, scopeId })
}

export function openSendFlow() {
  openNavChild('activity', { type: 'send' })
}

export function openReceiveFlow() {
  openNavChild('activity', { type: 'receive' })
}

export function openPaymentDetails(entryId: string) {
  openNavChild('activity', { type: 'payment', entryId })
}

export function openFriendDetails(friendId: string) {
  openNavChild('friends', { type: 'friend', friendId })
}

export function openAddFriend() {
  openNavChild('friends', { type: 'add-friend' })
}
