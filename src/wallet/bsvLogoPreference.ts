type Listener = (classic: boolean) => void

const listeners = new Set<Listener>()

let classic = false
let tapCount = 0
let tapTimer = 0

/** Dragon / old-school BSV mark (triple-tap easter egg). */
export function getBsvLogoClassic(): boolean {
  return classic
}

export function subscribeBsvLogoClassic(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setClassic(next: boolean) {
  if (classic === next) return
  classic = next
  for (const listener of listeners) listener(classic)
}

/** Triple-tap within ~700ms toggles between default and classic BSV logos. */
export function registerBsvLogoTap(): void {
  window.clearTimeout(tapTimer)
  tapCount += 1
  if (tapCount >= 3) {
    tapCount = 0
    setClassic(!classic)
    return
  }
  tapTimer = window.setTimeout(() => {
    tapCount = 0
  }, 700)
}
