/** Short HandCash-style success chime (Web Audio — no asset file). */
export function playPaymentSuccessSound(): void {
  try {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()

    const playTone = (freq: number, start: number, duration: number, gain = 0.08) => {
      const osc = ctx.createOscillator()
      const amp = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, start)
      amp.gain.setValueAtTime(0.0001, start)
      amp.gain.exponentialRampToValueAtTime(gain, start + 0.02)
      amp.gain.exponentialRampToValueAtTime(0.0001, start + duration)
      osc.connect(amp)
      amp.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + duration + 0.02)
    }

    const t0 = ctx.currentTime + 0.02
    // Two-note “cha-ching”
    playTone(880, t0, 0.12, 0.09)
    playTone(1318.5, t0 + 0.1, 0.28, 0.07)

    window.setTimeout(() => {
      void ctx.close().catch(() => {})
    }, 600)
  } catch {
    // Audio unavailable — ignore
  }
}
