import { barLayout, barScaleTransform, sceneAttrs } from '@aeon-ui/geometry'
import { useSignalVisualizer, type UseSignalVisualizerOptions } from './use-signal-visualizer.js'

export type SignalBarsProps = UseSignalVisualizerOptions & {
  className?: string
  viewWidth?: number
  viewHeight?: number
  fills?: readonly string[]
  label?: string
}

/** SVG bar visualizer driven by `@aeon-ui/signal` band motion. */
export function SignalBars({
  className,
  viewWidth = 80,
  viewHeight = 52,
  fills,
  label = 'Audio visualizer',
  barCount = 7,
  ...vizOptions
}: SignalBarsProps) {
  const { scales, brightness, active } = useSignalVisualizer({ barCount, ...vizOptions })
  const bars = barLayout({ count: barCount, viewWidth, viewHeight, fills })

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      role="img"
      aria-label={label}
      className={className}
      {...sceneAttrs('visualizer', active ? 'active' : 'idle')}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {bars.map((bar, i) => {
        const scale = scales[i] ?? 1
        const bright = brightness[i] ?? 1
        return (
          <g
            key={i}
            transform={barScaleTransform(bar, scale)}
            style={active ? { filter: `brightness(${bright})` } : undefined}
          >
            <rect
              x={bar.x}
              y={bar.y}
              width={bar.w}
              height={bar.h}
              rx={bar.w / 2}
              fill={bar.fill}
            />
          </g>
        )
      })}
    </svg>
  )
}
