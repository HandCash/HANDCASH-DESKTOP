/**
 * Ringtone for an incoming call and ringback while the far side rings. They
 * play whether or not Settings → Sound effects is on: a call nobody hears is
 * a missed call. No audio API (tests, a locked-down shell) means silence.
 */

export type RingKind = 'ring' | 'ringback'

type Note = { freq: number; at: number; dur: number }

const PATTERNS: Record<RingKind, { notes: Note[]; every: number; gain: number }> = {
  ring: {
    notes: [
      { freq: 784, at: 0, dur: 0.14 },
      { freq: 988, at: 0.16, dur: 0.14 },
      { freq: 1175, at: 0.32, dur: 0.22 },
      { freq: 784, at: 0.8, dur: 0.14 },
      { freq: 988, at: 0.96, dur: 0.14 },
      { freq: 1175, at: 1.12, dur: 0.22 },
    ],
    every: 3000,
    gain: 0.09,
  },
  ringback: {
    notes: [
      { freq: 440, at: 0, dur: 1.2 },
      { freq: 480, at: 0, dur: 1.2 },
    ],
    every: 4000,
    gain: 0.025,
  },
}

let ctx: AudioContext | null = null
let playing: { kind: RingKind; timer: ReturnType<typeof setInterval> } | null = null

function audio(): AudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  return ctx
}

function burst(kind: RingKind): void {
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume().catch(() => undefined)
  const { notes, gain } = PATTERNS[kind]
  const t0 = ac.currentTime + 0.02
  for (const n of notes) {
    const osc = ac.createOscillator()
    const g = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.freq
    g.gain.setValueAtTime(0, t0 + n.at)
    g.gain.linearRampToValueAtTime(gain, t0 + n.at + 0.02)
    g.gain.setValueAtTime(gain, t0 + n.at + n.dur - 0.03)
    g.gain.linearRampToValueAtTime(0, t0 + n.at + n.dur)
    osc.connect(g).connect(ac.destination)
    osc.start(t0 + n.at)
    osc.stop(t0 + n.at + n.dur + 0.01)
  }
}

/** Play `kind` on a loop until `stopRinging`, or switch from the other one. */
export function startRinging(kind: RingKind): void {
  if (playing?.kind === kind) return
  stopRinging()
  if (!audio()) return
  burst(kind)
  playing = { kind, timer: setInterval(() => burst(kind), PATTERNS[kind].every) }
}

export function stopRinging(): void {
  if (!playing) return
  clearInterval(playing.timer)
  playing = null
}

export function ringingNow(): RingKind | null {
  return playing?.kind ?? null
}
