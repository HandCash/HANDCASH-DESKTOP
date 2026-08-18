import type { ConnectedApp } from './permissions'
import { focusMessagePeer } from './messageFocus'
import { TRUSTHOLDERS_ENABLED } from './walletConfig'

export type NavSection =
  | 'activity'
  | 'apps'
  | 'collectables'
  | 'friends'
  | 'identity'
  | 'settings'

export type SettingId =
  | 'change-password'
  | 'backup'
  | 'backup-phrase'
  | 'split-backup'
  | 'trustholder-backup'
  | 'device-handoff'
  | 'history-backup'
  | 'wipe-wallet'
  | 'about-handcash'
  | 'statecharts'
  | 'logs'

export type NavChild =
  | { type: 'app'; origin: string }
  | { type: 'permission'; origin: string; scopeId: string }
  | { type: 'send'; prefill?: string }
  | { type: 'scan' }
  | { type: 'receive' }
  | { type: 'payment'; entryId: string }
  | { type: 'friend'; friendId: string }
  | { type: 'add-friend'; identityKey?: string; label?: string }
  | { type: 'messages'; friendId: string }
  | { type: 'collectable'; outpoint: string }
  | { type: 'send-collectable'; outpoint: string }
  | { type: 'fungible'; tokenId: string }
  | { type: 'send-fungible'; tokenId: string }
  | { type: 'setting'; settingId: SettingId }

export type NavState = {
  section: NavSection
  child: NavChild | null
}

type Listener = (state: NavState) => void

const listeners = new Set<Listener>()

let state: NavState = { section: 'activity', child: null }

let navLogTimer: ReturnType<typeof setTimeout> | null = null
let pendingNavLog: string | null = null

function emit() {
  // Breadcrumb: a freeze raises no error, so the last settled screen is what
  // tells us where to look. Debounced — rapid tab tapping must not itself
  // flood the log path (append + durable flush) on every intermediate flip.
  pendingNavLog = `[nav] ${state.section}${state.child ? `/${state.child.type}` : ''}`
  if (!navLogTimer) {
    navLogTimer = setTimeout(() => {
      navLogTimer = null
      if (pendingNavLog) console.info(pendingNavLog)
      pendingNavLog = null
    }, 120)
  }
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
  settingBackStack = []
  state = { section, child: null }
  emit()
}

export function openNavChild(section: NavSection, child: NavChild) {
  if (section !== 'settings' || child.type !== 'setting') {
    settingBackStack = []
  }
  state = { section, child }
  emit()
}

export function clearNavChild() {
  if (!state.child) return
  settingBackStack = []
  state = { ...state, child: null }
  emit()
}

export function openAppDetails(app: ConnectedApp) {
  openNavChild('apps', { type: 'app', origin: app.origin })
}

export function openPermissionDetails(origin: string, scopeId: string) {
  openNavChild('apps', { type: 'permission', origin, scopeId })
}

export function openSendFlow(prefill?: string) {
  openNavChild('activity', {
    type: 'send',
    ...(prefill?.trim() ? { prefill: prefill.trim() } : {}),
  })
}

export function openScanFlow() {
  openNavChild('activity', { type: 'scan' })
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

export function openAddFriend(opts?: { identityKey?: string; label?: string }) {
  openNavChild('friends', {
    type: 'add-friend',
    ...(opts?.identityKey ? { identityKey: opts.identityKey.trim() } : {}),
    ...(opts?.label ? { label: opts.label.trim() } : {}),
  })
}

export function openMessagesWithFriend(friendId: string) {
  focusMessagePeer(friendId)
  openNavChild('friends', { type: 'messages', friendId })
}

/** @deprecated */
export const openChatWithFriend = openMessagesWithFriend

export function openCollectableDetails(outpoint: string) {
  openNavChild('collectables', { type: 'collectable', outpoint })
}

export function openSendCollectable(outpoint: string) {
  openNavChild('collectables', { type: 'send-collectable', outpoint })
}

export function openFungibleDetails(tokenId: string) {
  openNavChild('collectables', { type: 'fungible', tokenId })
}

export function openSendFungible(tokenId: string) {
  openNavChild('collectables', { type: 'send-fungible', tokenId })
}

function resolveSettingId(settingId: SettingId): SettingId {
  if (settingId === 'backup-phrase' || settingId === 'split-backup') return 'backup'
  if (settingId === 'trustholder-backup' && !TRUSTHOLDERS_ENABLED) return 'backup'
  return settingId
}

/** Nested Settings screens (Keys → Cloud backup, About → Statecharts). */
let settingBackStack: SettingId[] = []

export function getSettingBackStack(): readonly SettingId[] {
  return settingBackStack
}

export function openSetting(
  settingId: SettingId,
  opts?: { replace?: boolean },
) {
  const resolved = resolveSettingId(settingId)
  const current =
    state.section === 'settings' && state.child?.type === 'setting'
      ? state.child.settingId
      : null
  if (!opts?.replace && current && current !== resolved) {
    settingBackStack = [...settingBackStack, current]
  } else if (opts?.replace) {
    // Keep stack as-is (e.g. Keys → History after confirm).
  } else {
    settingBackStack = []
  }
  openNavChild('settings', { type: 'setting', settingId: resolved })
}

/** Pop nested setting, or leave Settings child entirely. */
export function backFromSetting() {
  const prev = settingBackStack[settingBackStack.length - 1]
  if (prev) {
    settingBackStack = settingBackStack.slice(0, -1)
    openNavChild('settings', { type: 'setting', settingId: prev })
    return
  }
  clearNavChild()
}

export function popSettingTo(settingId: SettingId) {
  const resolved = resolveSettingId(settingId)
  const idx = settingBackStack.lastIndexOf(resolved)
  if (idx >= 0) {
    settingBackStack = settingBackStack.slice(0, idx)
  } else {
    settingBackStack = []
  }
  openNavChild('settings', { type: 'setting', settingId: resolved })
}
