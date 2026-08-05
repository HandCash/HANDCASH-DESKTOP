import { isWalletSfxEnabled } from './soundPrefs'

export type WalletSound =
  | 'success'
  | 'error'
  | 'copy'
  | 'connect'
  | 'deny'
  | 'unlock'
  | 'receive'
  | 'soft'

type Tone = { freq: number; start: number; duration: number; gain?: number; type?: OscillatorType }

let sharedCtx: AudioContext | null = null
let unlockBound = false

function getSharedAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx
  const AudioCtx =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return null
  sharedCtx = new AudioCtx()
  return sharedCtx
}

/** Android / iOS WebViews start suspended until a user gesture resumes the context. */
async function ensureAudioRunning(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === 'closed') {
    sharedCtx = null
    const next = getSharedAudioContext()
    if (!next) return false
    return ensureAudioRunning(next)
  }
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return false
    }
  }
  return ctx.state === 'running'
}

function bindAudioUnlock(): void {
  if (unlockBound || typeof window === 'undefined') return
  unlockBound = true
  const unlock = () => {
    const ctx = getSharedAudioContext()
    if (!ctx) return
    void ensureAudioRunning(ctx)
  }
  // Capture phase so we unlock before UI handlers that play SFX on the same tap.
  for (const type of ['pointerdown', 'touchstart', 'keydown', 'click'] as const) {
    window.addEventListener(type, unlock, { capture: true, passive: true })
  }
}

bindAudioUnlock()

function playTones(tones: Tone[]): void {
  const ctx = getSharedAudioContext()
  if (!ctx) return
  void (async () => {
    try {
      if (!(await ensureAudioRunning(ctx))) return
      const t0 = ctx.currentTime + 0.015
      for (const tone of tones) {
        const start = t0 + tone.start
        const duration = tone.duration
        const gain = tone.gain ?? 0.07
        const osc = ctx.createOscillator()
        const amp = ctx.createGain()
        osc.type = tone.type ?? 'sine'
        osc.frequency.setValueAtTime(tone.freq, start)
        amp.gain.setValueAtTime(0.0001, start)
        amp.gain.exponentialRampToValueAtTime(gain, start + 0.015)
        amp.gain.exponentialRampToValueAtTime(0.0001, start + duration)
        osc.connect(amp)
        amp.connect(ctx.destination)
        // Every tone leaves a gain node wired to the destination, and the graph
        // reprocesses all of them each quantum. The nav bar plays a tone per tap,
        // so without this the UI degrades click by click until it locks up.
        osc.onended = () => {
          try {
            osc.disconnect()
            amp.disconnect()
          } catch {
            // already torn down
          }
        }
        osc.start(start)
        osc.stop(start + duration + 0.02)
      }
    } catch {
      // Audio unavailable — ignore
    }
  })()
}

const PATTERNS: Record<WalletSound, Tone[]> = {
  // Two-note cha-ching (payments / success)
  success: [
    { freq: 880, start: 0, duration: 0.12, gain: 0.09 },
    { freq: 1318.5, start: 0.1, duration: 0.28, gain: 0.07 },
  ],
  // Soft descending pair
  error: [
    { freq: 420, start: 0, duration: 0.14, gain: 0.06, type: 'triangle' },
    { freq: 280, start: 0.12, duration: 0.22, gain: 0.05, type: 'triangle' },
  ],
  // Short tick
  copy: [{ freq: 1200, start: 0, duration: 0.06, gain: 0.045 }],
  // Ascending allow
  connect: [
    { freq: 660, start: 0, duration: 0.08, gain: 0.06 },
    { freq: 990, start: 0.08, duration: 0.14, gain: 0.055 },
  ],
  // Soft reject
  deny: [{ freq: 360, start: 0, duration: 0.16, gain: 0.05, type: 'triangle' }],
  // Warm unlock
  unlock: [
    { freq: 523.25, start: 0, duration: 0.1, gain: 0.055 },
    { freq: 659.25, start: 0.09, duration: 0.12, gain: 0.05 },
    { freq: 783.99, start: 0.18, duration: 0.18, gain: 0.045 },
  ],
  // Receive / internalize
  receive: [
    { freq: 740, start: 0, duration: 0.1, gain: 0.06 },
    { freq: 988, start: 0.09, duration: 0.2, gain: 0.055 },
  ],
  // Subtle UI confirm
  soft: [{ freq: 880, start: 0, duration: 0.08, gain: 0.04 }],
}

/**
 * Play a wallet sound effect. No-op unless Settings → Sound effects is on.
 * Pass `{ force: true }` to preview from Settings while enabling.
 */
export function playWalletSound(kind: WalletSound, opts?: { force?: boolean }): void {
  if (!opts?.force && !isWalletSfxEnabled()) return
  const tones = PATTERNS[kind]
  if (tones) playTones(tones)
}
