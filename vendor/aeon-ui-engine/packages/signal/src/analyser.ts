export type AttachAnalyserOptions = {
  fftSize?: number
  smoothingTimeConstant?: number
  /** Set on the element before `src` when using remote audio (CORS). */
  crossOrigin?: '' | 'anonymous' | 'use-credentials'
}

let sharedContext: AudioContext | null = null
const graphs = new WeakMap<HTMLAudioElement, AnalyserNode>()
const failed = new WeakSet<HTMLAudioElement>()

function getContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext()
  }
  return sharedContext
}

/** Tap an `<audio>` element for visualization without muting playback. */
export function attachMediaAnalyser(
  audio: HTMLAudioElement,
  options?: AttachAnalyserOptions,
): AnalyserNode | null {
  if (failed.has(audio)) return null

  const existing = graphs.get(audio)
  if (existing) {
    void sharedContext?.resume()
    return existing
  }

  if (options?.crossOrigin !== undefined) {
    audio.crossOrigin = options.crossOrigin
  }

  try {
    const ctx = getContext()
    const source = ctx.createMediaElementSource(audio)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = options?.fftSize ?? 256
    analyser.smoothingTimeConstant = options?.smoothingTimeConstant ?? 0.65

    source.connect(analyser)
    source.connect(ctx.destination)

    graphs.set(audio, analyser)
    void ctx.resume()
    return analyser
  } catch {
    failed.add(audio)
    return null
  }
}

export function getMediaAnalyser(audio: HTMLAudioElement | null | undefined): AnalyserNode | null {
  if (!audio) return null
  return graphs.get(audio) ?? null
}

export async function resumeAudioContext(): Promise<void> {
  if (sharedContext?.state === 'suspended') {
    await sharedContext.resume()
  }
}

export type DemoSignal = {
  context: AudioContext
  analyser: AnalyserNode
  start: () => void
  stop: () => void
}

/** Low-volume oscillator for demos and playgrounds (no media file). */
export function createDemoSignal(options?: { frequency?: number; gain?: number }): DemoSignal {
  const context = new AudioContext()
  const oscillator = context.createOscillator()
  oscillator.type = 'sawtooth'
  oscillator.frequency.value = options?.frequency ?? 110

  const gain = context.createGain()
  gain.gain.value = options?.gain ?? 0.04

  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.65

  oscillator.connect(gain)
  gain.connect(analyser)
  analyser.connect(context.destination)

  let running = false

  return {
    context,
    analyser,
    start() {
      if (running) return
      oscillator.start()
      running = true
      void context.resume()
    },
    stop() {
      if (!running) return
      try {
        oscillator.stop()
      } catch {
        /* already stopped */
      }
      running = false
      void context.close()
    },
  }
}
