import type { ConnectedApp } from './permissions'
import { getMissingBackupStep, isBackupConfirmed } from './backupStatus'
import { playWalletSound } from './soundService'
import { focusMessagePeer } from './messageFocus'

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
  | { type: 'add-friend' }
  | { type: 'messages'; friendId: string }
  | { type: 'collectable'; outpoint: string }
  | { type: 'send-collectable'; outpoint: string }
  | { type: 'setting'; settingId: SettingId }

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

function openRequiredBackup() {
  const missing = getMissingBackupStep()
  openSetting(missing === 'history' ? 'history-backup' : 'backup')
}

export function openSendFlow(prefill?: string, opts?: { requireBackup?: boolean }) {
  if (opts?.requireBackup !== false && !isBackupConfirmed()) {
    playWalletSound('deny')
    openRequiredBackup()
    return
  }
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

export function openAddFriend() {
  openNavChild('friends', { type: 'add-friend' })
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
  if (!isBackupConfirmed()) {
    playWalletSound('deny')
    openRequiredBackup()
    return
  }
  openNavChild('collectables', { type: 'send-collectable', outpoint })
}

function resolveSettingId(settingId: SettingId): SettingId {
  if (settingId === 'backup-phrase' || settingId === 'split-backup') return 'backup'
  return settingId
}

export function openSetting(settingId: SettingId) {
  openNavChild('settings', { type: 'setting', settingId: resolveSettingId(settingId) })
}
