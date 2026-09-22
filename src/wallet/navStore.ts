import type { ConnectedApp } from './permissions'
import { focusMessagePeer } from './messageFocus'
import { isCompactShell } from './isCompactShell'

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
  | 'device-handoff'
  | 'history-backup'
  | 'import-phrase'
  | 'wipe-wallet'
  | 'about-handcash'
  | 'statecharts'
  | 'logs'
  | 'wallet-health'

export type NavChild =
  | { type: 'app'; origin: string }
  | { type: 'app-launch'; origin: string; url: string }
  | { type: 'app-browser'; origin: string; url: string }
  | { type: 'permission'; origin: string; scopeId: string }
  | { type: 'send'; prefill?: string }
  | { type: 'scan' }
  | { type: 'receive' }
  | { type: 'payment'; entryId: string }
  | { type: 'friend'; friendId: string }
  | { type: 'add-friend'; identityKey?: string; label?: string }
  | { type: 'messages'; friendId?: string }
  | { type: 'collectable'; outpoint: string }
  | { type: 'send-collectable'; outpoint: string }
  | { type: 'send-collectables'; outpoints: string[] }
  | { type: 'burn-collectable'; outpoint: string }
  | { type: 'burn-collectables'; outpoints: string[] }
  | { type: 'fungible'; tokenId: string }
  | { type: 'send-fungible'; tokenId: string }
  | { type: 'burn-fungible'; tokenId: string }
  | { type: 'setting'; settingId: SettingId }

export type NavState = {
  section: NavSection
  child: NavChild | null
}

/** Live in-app browser session — survives section changes and request overlays. */
export type EmbeddedAppBrowser = {
  origin: string
  url: string
}

type Listener = (state: NavState) => void
type EmbeddedBrowserListener = (session: EmbeddedAppBrowser | null) => void
type EmbeddedBrowserTabsListener = (
  tabs: readonly EmbeddedAppBrowser[],
  activeOrigin: string | null,
) => void

const listeners = new Set<Listener>()
const embeddedBrowserListeners = new Set<EmbeddedBrowserListener>()
const embeddedBrowserTabsListeners = new Set<EmbeddedBrowserTabsListener>()

let state: NavState = { section: 'activity', child: null }
let embeddedAppBrowsers: EmbeddedAppBrowser[] = []
let activeEmbeddedBrowserOrigin: string | null = null

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

function emitEmbeddedBrowser() {
  const active = getEmbeddedAppBrowser()
  for (const cb of embeddedBrowserListeners) cb(active)
  const tabs = getEmbeddedAppBrowserTabs()
  for (const cb of embeddedBrowserTabsListeners) cb(tabs, activeEmbeddedBrowserOrigin)
}

export function getEmbeddedAppBrowser(): EmbeddedAppBrowser | null {
  return (
    embeddedAppBrowsers.find((tab) => tab.origin === activeEmbeddedBrowserOrigin) ??
    embeddedAppBrowsers[0] ??
    null
  )
}

export function getEmbeddedAppBrowserTabs(): readonly EmbeddedAppBrowser[] {
  return embeddedAppBrowsers.slice()
}

export function subscribeEmbeddedAppBrowser(cb: EmbeddedBrowserListener): () => void {
  embeddedBrowserListeners.add(cb)
  cb(getEmbeddedAppBrowser())
  return () => {
    embeddedBrowserListeners.delete(cb)
  }
}

export function subscribeEmbeddedAppBrowserTabs(cb: EmbeddedBrowserTabsListener): () => void {
  embeddedBrowserTabsListeners.add(cb)
  cb(getEmbeddedAppBrowserTabs(), activeEmbeddedBrowserOrigin)
  return () => {
    embeddedBrowserTabsListeners.delete(cb)
  }
}

/**
 * Close one in-app browser tab. Section changes and request overlays only park
 * tabs so every webview remains mounted and keeps its app state.
 */
export function closeEmbeddedAppBrowser(origin = activeEmbeddedBrowserOrigin ?? undefined) {
  if (!origin) return
  const closingIndex = embeddedAppBrowsers.findIndex((tab) => tab.origin === origin)
  if (closingIndex < 0) return
  const closingForeground =
    state.child?.type === 'app-browser' && state.child.origin === origin
  embeddedAppBrowsers = embeddedAppBrowsers.filter((tab) => tab.origin !== origin)
  if (activeEmbeddedBrowserOrigin === origin) {
    const fallback =
      embeddedAppBrowsers[Math.min(closingIndex, embeddedAppBrowsers.length - 1)] ?? null
    activeEmbeddedBrowserOrigin = fallback?.origin ?? null
  }
  emitEmbeddedBrowser()
  if (closingForeground) {
    settingBackStack = []
    const next = getEmbeddedAppBrowser()
    state = next
      ? {
          section: 'apps',
          child: { type: 'app-browser', origin: next.origin, url: next.url },
        }
      : { ...state, child: null }
    emit()
  }
}

export function closeAllEmbeddedAppBrowsers() {
  if (embeddedAppBrowsers.length === 0) return
  embeddedAppBrowsers = []
  activeEmbeddedBrowserOrigin = null
  emitEmbeddedBrowser()
  if (state.child?.type === 'app-browser') {
    settingBackStack = []
    state = { ...state, child: null }
    emit()
  }
}

/** Bring a parked browser tab back to the Apps foreground. */
export function focusEmbeddedAppBrowser(origin = activeEmbeddedBrowserOrigin ?? undefined) {
  const tab = embeddedAppBrowsers.find((candidate) => candidate.origin === origin)
  if (!tab) return
  activeEmbeddedBrowserOrigin = tab.origin
  emitEmbeddedBrowser()
  openNavChild('apps', {
    type: 'app-browser',
    origin: tab.origin,
    url: tab.url,
  })
}

export function setNavSection(section: NavSection) {
  settingBackStack = []
  // Park the embedded browser (keep session) — do not destroy the webview.
  state = { section, child: null }
  emit()
}

export function openNavChild(section: NavSection, child: NavChild) {
  if (section !== 'settings' || child.type !== 'setting') {
    settingBackStack = []
  }
  if (child.type === 'app-browser') {
    const existing = embeddedAppBrowsers.find((tab) => tab.origin === child.origin)
    if (!existing) {
      embeddedAppBrowsers = [...embeddedAppBrowsers, { origin: child.origin, url: child.url }]
    }
    activeEmbeddedBrowserOrigin = child.origin
    emitEmbeddedBrowser()
  }
  state = { section, child }
  emit()
}

export function clearNavChild() {
  if (!state.child) return
  settingBackStack = []
  if (state.child.type === 'app-browser') {
    closeEmbeddedAppBrowser(state.child.origin)
    return
  }
  state = { ...state, child: null }
  emit()
}

export function openAppDetails(app: ConnectedApp) {
  openNavChild('apps', { type: 'app', origin: app.origin })
}

export function openAppLaunch(origin: string, url: string) {
  openNavChild('apps', { type: 'app-launch', origin, url })
}

export function openEmbeddedAppBrowser(origin: string, url: string) {
  openNavChild('apps', { type: 'app-browser', origin, url })
}

/**
 * Record where a tab has browsed to.
 *
 * A tab only ever held its entry URL, so closing one and opening the app again
 * dropped the user back at the landing page. The panel keys its `<webview>` on
 * the URL it mounted with, not on this, so recording here must never rebuild
 * the guest — that would reload the page on every navigation.
 */
export function noteEmbeddedAppBrowserUrl(origin: string, url: string) {
  const tab = embeddedAppBrowsers.find((entry) => entry.origin === origin)
  if (!tab || tab.url === url) return
  embeddedAppBrowsers = embeddedAppBrowsers.map((entry) =>
    entry.origin === origin ? { ...entry, url } : entry,
  )
  emitEmbeddedBrowser()
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

/** Desktop Scan lives in the side column and must not change the main tab. */
let sideScanOpen = false
const sideScanListeners = new Set<(open: boolean) => void>()

function emitSideScan() {
  for (const cb of sideScanListeners) cb(sideScanOpen)
}

export function getSideScanOpen(): boolean {
  return sideScanOpen
}

export function subscribeSideScan(cb: (open: boolean) => void): () => void {
  sideScanListeners.add(cb)
  cb(sideScanOpen)
  return () => {
    sideScanListeners.delete(cb)
  }
}

export function closeSideScan() {
  if (!sideScanOpen) return
  sideScanOpen = false
  emitSideScan()
}

export function openScanFlow() {
  // Compact (phone or portrait/narrow desktop): Scan is a full nav child.
  // Wide desktop: overlay the side column only — keep Collect / Settings / etc.
  if (!isCompactShell()) {
    sideScanOpen = true
    emitSideScan()
    return
  }
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

export function openMessagesInbox() {
  openNavChild('friends', { type: 'messages' })
}

export function openMessagesWithFriend(friendId: string) {
  focusMessagePeer(friendId)
  openNavChild('friends', { type: 'messages', friendId })
}

/** @deprecated */
export const openChatWithFriend = openMessagesWithFriend

export function isMessagesNavChild(
  child: NavChild | null,
): child is { type: 'messages'; friendId?: string } {
  return child?.type === 'messages'
}

export function openCollectableDetails(outpoint: string) {
  openNavChild('collectables', { type: 'collectable', outpoint })
}

export function openSendCollectable(outpoint: string) {
  openNavChild('collectables', { type: 'send-collectable', outpoint })
}

export function openSendCollectables(outpoints: readonly string[]) {
  const stable = [...new Set(outpoints.map((value) => value.trim()).filter(Boolean))]
  if (stable.length === 1) return openSendCollectable(stable[0])
  if (stable.length > 1) {
    openNavChild('collectables', { type: 'send-collectables', outpoints: stable })
  }
}

export function openBurnCollectable(outpoint: string) {
  openNavChild('collectables', { type: 'burn-collectable', outpoint })
}

export function openBurnCollectables(outpoints: readonly string[]) {
  const stable = [...new Set(outpoints.map((value) => value.trim()).filter(Boolean))]
  if (stable.length === 1) return openBurnCollectable(stable[0])
  if (stable.length > 1) {
    openNavChild('collectables', { type: 'burn-collectables', outpoints: stable })
  }
}

export function openFungibleDetails(tokenId: string) {
  openNavChild('collectables', { type: 'fungible', tokenId })
}

export function openSendFungible(tokenId: string) {
  openNavChild('collectables', { type: 'send-fungible', tokenId })
}

export function openBurnFungible(tokenId: string) {
  openNavChild('collectables', { type: 'burn-fungible', tokenId })
}

function resolveSettingId(settingId: SettingId): SettingId {
  if (settingId === 'backup-phrase' || settingId === 'split-backup') return 'backup'
  return settingId
}

/** Nested Settings screens (for example About → Statecharts). */
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
