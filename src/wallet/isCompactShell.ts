import { useSyncExternalStore } from 'react'
import { isMobileWalletPlatform } from './isMobilePlatform'
import {
  isCompactLayout,
  subscribeCompactLayout,
} from './layoutViewport'

/**
 * True for Capacitor phone shells, or Desktop when the window is in compact
 * layout (taller than wide / narrow tile). Use for UI chrome that should match
 * the phone shell — not for native APIs, timeouts, or keyboard inset.
 */
export function isCompactShell(): boolean {
  return isMobileWalletPlatform() || isCompactLayout()
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeCompactLayout(() => onStoreChange())
}

function getSnapshot(): boolean {
  return isCompactShell()
}

/** React: re-render when Desktop toggles portrait/narrow compact layout. */
export function useCompactShell(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
