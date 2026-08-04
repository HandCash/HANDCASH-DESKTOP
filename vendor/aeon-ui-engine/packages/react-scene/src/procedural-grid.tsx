import type { CSSProperties, HTMLAttributes } from 'react'
import { gridPatternStyle, vignetteStyle, sceneAttrs } from '@aeon-ui/geometry'

export type ProceduralGridProps = HTMLAttributes<HTMLDivElement> & {
  cell?: number
  lineColor?: string
  vignette?: boolean
}

/** Layered grid lines + optional vignette for page/scene backgrounds. */
export function ProceduralGrid({
  cell,
  lineColor,
  vignette = true,
  className,
  style,
  ...rest
}: ProceduralGridProps) {
  const grid = gridPatternStyle({ cell, lineColor })
  const merged: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    ...grid,
    ...style,
  }

  return (
    <div {...rest} {...sceneAttrs('grid')} className={className} style={merged} aria-hidden>
      {vignette ? (
        <div style={{ position: 'absolute', inset: 0, ...vignetteStyle() }} aria-hidden />
      ) : null}
    </div>
  )
}
