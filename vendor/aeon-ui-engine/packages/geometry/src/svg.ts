export type BarRect = {
  x: number
  y: number
  w: number
  h: number
  fill: string
}

export type BarLayoutOptions = {
  count: number
  viewWidth: number
  viewHeight: number
  barWidth?: number
  gap?: number
  fills?: readonly string[]
}

const DEFAULT_FILLS = [
  '#8B5CF6',
  '#6366F1',
  '#4F8FF7',
  '#38BDF8',
  '#2DD4BF',
  '#FBBF24',
  '#F472B6',
] as const

/** Evenly spaced vertical bars for spectrum-style SVG (Soundbase-style layout). */
export function barLayout(options: BarLayoutOptions): BarRect[] {
  const count = options.count
  const viewW = options.viewWidth
  const viewH = options.viewHeight
  const barW = options.barWidth ?? Math.min(10, (viewW - (count - 1) * (options.gap ?? 4)) / count)
  const gap = options.gap ?? 4
  const fills = options.fills ?? DEFAULT_FILLS
  const totalW = count * barW + (count - 1) * gap
  const startX = (viewW - totalW) / 2
  const bars: BarRect[] = []

  for (let i = 0; i < count; i++) {
    const h = viewH * (0.42 + (i / Math.max(1, count - 1)) * 0.58)
    const y = (viewH - h) / 2
    const x = startX + i * (barW + gap)
    bars.push({
      x,
      y,
      w: barW,
      h,
      fill: fills[i % fills.length]!,
    })
  }
  return bars
}

/** Centered Y scale transform for one bar (scale applied around bar center). */
export function barScaleTransform(bar: BarRect, scaleY: number): string {
  const cx = bar.x + bar.w / 2
  const cy = bar.y + bar.h / 2
  return `translate(${cx} ${cy}) scale(1 ${scaleY}) translate(${-cx} ${-cy})`
}
