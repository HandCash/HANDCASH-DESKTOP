import { bandLevel } from './bands.js'

export type BarMotionState = {
  scales: number[]
  brightness: number[]
}

export type BarMotionOptions = {
  barCount?: number
  idleScale?: number
  minScale?: number
  maxScale?: number
  idleBrightness?: number
  minBrightness?: number
  maxBrightness?: number
  attack?: number
  decay?: number
}

const DEFAULTS = {
  idleScale: 1,
  minScale: 0.75,
  maxScale: 1.25,
  idleBrightness: 1,
  minBrightness: 0.5,
  maxBrightness: 1.5,
  attack: 0.42,
  decay: 0.14,
} as const

export function createBarMotionState(barCount: number, options?: BarMotionOptions): BarMotionState {
  const idleScale = options?.idleScale ?? DEFAULTS.idleScale
  const idleBrightness = options?.idleBrightness ?? DEFAULTS.idleBrightness
  return {
    scales: Array.from({ length: barCount }, () => idleScale),
    brightness: Array.from({ length: barCount }, () => idleBrightness),
  }
}

function mapLevel(avg: number, min: number, max: number) {
  return min + avg * (max - min)
}

function smoothToward(current: number, target: number, attack: number, decay: number) {
  const rate = target > current ? attack : decay
  return current + (target - current) * rate
}

/** Advance one animation frame from frequency data (or decay toward idle). */
export function stepBarMotion(
  state: BarMotionState,
  analyser: AnalyserNode | null,
  data: Uint8Array | null,
  ranges: { start: number; end: number }[],
  options?: BarMotionOptions,
): void {
  const idleScale = options?.idleScale ?? DEFAULTS.idleScale
  const minScale = options?.minScale ?? DEFAULTS.minScale
  const maxScale = options?.maxScale ?? DEFAULTS.maxScale
  const idleBrightness = options?.idleBrightness ?? DEFAULTS.idleBrightness
  const minBrightness = options?.minBrightness ?? DEFAULTS.minBrightness
  const maxBrightness = options?.maxBrightness ?? DEFAULTS.maxBrightness
  const attack = options?.attack ?? DEFAULTS.attack
  const decay = options?.decay ?? DEFAULTS.decay
  const barCount = state.scales.length

  for (let i = 0; i < barCount; i++) {
    if (analyser && data) {
      const { start, end } = ranges[i] ?? { start: 0, end: 1 }
      const level = bandLevel(data, start, end)
      const scaleTarget = mapLevel(level, minScale, maxScale)
      const brightTarget = mapLevel(level, minBrightness, maxBrightness)
      state.scales[i] = smoothToward(state.scales[i]!, scaleTarget, attack, decay)
      state.brightness[i] = smoothToward(state.brightness[i]!, brightTarget, attack, decay)
    } else {
      state.scales[i] = smoothToward(state.scales[i]!, idleScale, 0.12, 0.12)
      state.brightness[i] = smoothToward(state.brightness[i]!, idleBrightness, 0.12, 0.12)
    }
  }
}
