export type BandRange = { start: number; end: number }

/** Split FFT bins into `barCount` bands (low → high, skewed toward mids). */
export function bandRanges(bufferLength: number, barCount: number): BandRange[] {
  const ranges: BandRange[] = []
  const minBin = 1
  const maxBin = bufferLength - 1
  const span = maxBin - minBin

  for (let i = 0; i < barCount; i++) {
    const t0 = i / barCount
    const t1 = (i + 1) / barCount
    const start = Math.floor(minBin + span * t0 ** 1.45)
    const end = Math.max(start + 1, Math.floor(minBin + span * t1 ** 1.45))
    ranges.push({ start, end })
  }
  return ranges
}

/** Average + peak blend for one frequency band (0–1). */
export function bandLevel(data: Uint8Array, start: number, end: number): number {
  let sum = 0
  let peak = 0
  for (let j = start; j < end; j++) {
    const v = data[j]!
    sum += v
    if (v > peak) peak = v
  }
  const avg = sum / Math.max(1, end - start) / 255
  const pk = peak / 255
  const blended = avg * 0.55 + pk * 0.45
  return Math.min(1, blended ** 0.72 * 1.35)
}
