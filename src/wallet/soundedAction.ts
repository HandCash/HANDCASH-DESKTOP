import { playWalletSound } from './soundService'

/** A click handler that plays the soft tap, then runs `action`. */
export function withSoftSound(action: () => void): () => void {
  return () => {
    playWalletSound('soft')
    action()
  }
}
