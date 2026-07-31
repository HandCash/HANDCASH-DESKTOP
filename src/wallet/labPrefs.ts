import { durableGetItem, durableSetItem } from './durableStorage'

/** Survives wallet wipe. Experimental features — all off by default. */
export const LAB_CHAT_PREF_KEY = 'handcash.lab.chat.enabled'

type ChatListener = (enabled: boolean) => void

const chatListeners = new Set<ChatListener>()

/** Chat lab flag — off until opted in under Settings → Lab. */
export function isLabChatEnabled(): boolean {
  return durableGetItem(LAB_CHAT_PREF_KEY) === '1'
}

export function setLabChatEnabled(enabled: boolean): void {
  durableSetItem(LAB_CHAT_PREF_KEY, enabled ? '1' : '0')
  for (const listener of chatListeners) listener(enabled)
}

export function subscribeLabChat(listener: ChatListener): () => void {
  chatListeners.add(listener)
  listener(isLabChatEnabled())
  return () => chatListeners.delete(listener)
}
