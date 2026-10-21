/**
 * Short UI sounds synthesized with Web Audio: no files to ship or license.
 * Silent until an app calls `configureSounds({ enabled: true })`.
 */

export type SoundName = 'tap' | 'copy' | 'send' | 'success' | 'attention' | 'error' | 'ready'

export interface Tone {
  /** Start frequency in Hz. */
  freq: number
  /** End frequency in Hz; glides from `freq` over the tone. */
  to?: number
  /** Offset from the sound's start, in seconds. */
  at: number
  /** Time to fade out, in seconds. */
  duration: number
  type?: OscillatorType
  /** Peak gain before the master volume, 0 to 1. */
  gain: number
}

/** A soft mallet note with a faint metal-bar shimmer: quiet inharmonic partials (2.76x, 5.4x) over the fundamental. */
const pluck = (freq: number, at: number, duration: number, gain: number): Tone[] => [
  { freq, at, duration, type: 'sine', gain },
  { freq: freq * 2.76, at, duration: duration * 0.4, type: 'sine', gain: gain * 0.05 },
  { freq: freq * 5.4, at, duration: Math.min(0.03, duration * 0.2), type: 'sine', gain: gain * 0.02 },
]

export const soundPresets: Record<SoundName, readonly Tone[]> = {
  tap: pluck(880, 0, 0.07, 0.28),
  copy: [...pluck(784, 0, 0.09, 0.3), ...pluck(1175, 0.06, 0.16, 0.26)],
  send: [...pluck(587, 0, 0.1, 0.3), ...pluck(880, 0.05, 0.18, 0.26)],
  success: [...pluck(523, 0, 0.22, 0.28), ...pluck(659, 0.08, 0.24, 0.25), ...pluck(784, 0.16, 0.42, 0.24)],
  attention: [...pluck(988, 0, 0.16, 0.24), ...pluck(988, 0.15, 0.3, 0.18)],
  error: [
    { freq: 392, at: 0, duration: 0.14, type: 'triangle', gain: 0.3 },
    { freq: 311, at: 0.12, duration: 0.24, type: 'triangle', gain: 0.28 },
  ],
  ready: [...pluck(659, 0, 0.16, 0.22), ...pluck(784, 0.07, 0.18, 0.22), ...pluck(988, 0.14, 0.2, 0.22), ...pluck(1319, 0.21, 0.5, 0.2)],
}

export interface SoundSettings {
  enabled: boolean
  /** Master volume, 0 to 1. */
  volume: number
}

/** The slice of `AudioContext` the player uses; tests pass a fake. */
export type SoundContext = Pick<AudioContext, 'currentTime' | 'state' | 'resume' | 'createOscillator' | 'createGain' | 'createBiquadFilter' | 'destination'>

export interface SoundPlayer {
  play(name: SoundName): void
  configure(settings: Partial<SoundSettings>): void
  settings(): SoundSettings
}

const ATTACK = 0.004
/** Rounds off the top end so no preset sounds harsh on laptop speakers. */
const LOWPASS_HZ = 4600
const FLOOR = 0.0001
/** The same sound fired again within this many seconds is dropped. */
const REPEAT_GAP = 0.06

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

function browserContext(): SoundContext | null {
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  return Ctor ? new Ctor() : null
}

function resumeOnGesture(ctx: SoundContext) {
  if (typeof window === 'undefined') return
  const resume = () => {
    void ctx.resume().catch(() => {})
    window.removeEventListener('pointerdown', resume, true)
    window.removeEventListener('keydown', resume, true)
  }
  window.addEventListener('pointerdown', resume, true)
  window.addEventListener('keydown', resume, true)
}

export function createSoundPlayer(
  createContext: () => SoundContext | null = browserContext,
  initial: Partial<SoundSettings> = {},
): SoundPlayer {
  let current: SoundSettings = { enabled: false, volume: 0.5, ...initial }
  current.volume = clamp01(current.volume)
  let ctx: SoundContext | null | undefined
  let output: AudioNode | null = null
  const lastPlayed = new Map<SoundName, number>()

  const context = () => {
    if (ctx === undefined) {
      try {
        ctx = createContext()
      } catch {
        ctx = null
      }
      if (ctx) {
        const filter = ctx.createBiquadFilter()
        filter.type = 'lowpass'
        filter.frequency.value = LOWPASS_HZ
        filter.connect(ctx.destination)
        output = filter
        if (ctx.state === 'suspended') resumeOnGesture(ctx)
      }
    }
    return ctx
  }

  return {
    play(name) {
      if (!current.enabled || current.volume === 0) return
      const audio = context()
      if (!audio || !output || audio.state === 'closed') return
      const now = audio.currentTime
      const last = lastPlayed.get(name)
      if (last !== undefined && now - last < REPEAT_GAP) return
      lastPlayed.set(name, now)
      for (const tone of soundPresets[name]) {
        const start = now + tone.at
        const end = start + tone.duration
        const osc = audio.createOscillator()
        const gain = audio.createGain()
        osc.type = tone.type ?? 'sine'
        osc.frequency.setValueAtTime(tone.freq, start)
        if (tone.to !== undefined) osc.frequency.exponentialRampToValueAtTime(tone.to, end)
        gain.gain.setValueAtTime(FLOOR, start)
        gain.gain.linearRampToValueAtTime(Math.max(FLOOR, tone.gain * current.volume), start + ATTACK)
        gain.gain.exponentialRampToValueAtTime(FLOOR, end)
        osc.connect(gain)
        gain.connect(output)
        osc.start(start)
        osc.stop(end + 0.02)
      }
    },
    configure(settings) {
      current = { ...current, ...settings }
      current.volume = clamp01(current.volume)
    },
    settings: () => ({ ...current }),
  }
}

const shared = createSoundPlayer()

/** Play a preset through the shared player; a no-op while sounds are off. */
export const playSound = (name: SoundName) => shared.play(name)
/** Turn the shared player on or off and set its volume. */
export const configureSounds = (settings: Partial<SoundSettings>) => shared.configure(settings)
export const soundSettings = () => shared.settings()
