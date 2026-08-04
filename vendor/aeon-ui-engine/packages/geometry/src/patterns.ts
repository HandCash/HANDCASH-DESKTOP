export type GridPatternOptions = {
  cell?: number
  lineColor?: string
  lineWidth?: number
}

/** CSS `background-image` for an orthogonal grid (no external assets). */
export function gridPatternStyle(options?: GridPatternOptions): {
  backgroundImage: string
  backgroundSize: string
} {
  const cell = options?.cell ?? 32
  const color = options?.lineColor ?? 'rgba(255, 255, 255, 0.06)'
  const w = options?.lineWidth ?? 1
  const line = `${w}px ${color}`
  return {
    backgroundImage: [
      `linear-gradient(${line} 0 0)`,
      `linear-gradient(90deg, ${line} 0 0)`,
    ].join(', '),
    backgroundSize: `${cell}px ${cell}px`,
  }
}

export type WavePatternOptions = {
  wavelength?: number
  amplitude?: number
  stroke?: string
  strokeWidth?: number
}

/** SVG path `d` for a horizontal sine wave across `width`. */
export function wavePath(width: number, height: number, options?: WavePatternOptions): string {
  const wavelength = options?.wavelength ?? 48
  const amplitude = options?.amplitude ?? height * 0.2
  const mid = height / 2
  const steps = Math.max(8, Math.ceil(width / (wavelength / 4)))
  const points: string[] = []

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = t * width
    const y = mid + Math.sin(t * (width / wavelength) * Math.PI * 2) * amplitude
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return points.join(' ')
}

/** Radial vignette as CSS gradient for scene overlays. */
export function vignetteStyle(options?: { strength?: number }): { background: string } {
  const s = options?.strength ?? 0.55
  return {
    background: `radial-gradient(ellipse 80% 70% at 50% 45%, transparent 0%, rgba(0,0,0,${s}) 100%)`,
  }
}
