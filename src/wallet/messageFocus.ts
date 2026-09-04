/** One-shot peer focus when opening Messages from Friends. */

type Listener = (peerId: string | null) => void

let focusPeerId: string | null = null
const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l(focusPeerId)
}

export function focusMessagePeer(peerId: string | null): void {
  focusPeerId = peerId
  notify()
}

export function takeMessageFocus(): string | null {
  const next = focusPeerId
  focusPeerId = null
  notify()
  return next
}

export function subscribeMessageFocus(listener: Listener): () => void {
  listeners.add(listener)
  listener(focusPeerId)
  return () => listeners.delete(listener)
}
