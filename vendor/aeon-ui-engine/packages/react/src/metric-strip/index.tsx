import { metricStripAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { createContext, forwardRef, useContext, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

interface MetricStripContextValue {
  density: 'cluster' | 'loose'
}

const MetricCtx = createContext<MetricStripContextValue | null>(null)

function useMetricCtx() {
  const ctx = useContext(MetricCtx)
  if (!ctx) throw new Error('MetricStrip parts must be used within MetricStrip.Root')
  return ctx
}

export interface MetricStripRootProps extends HTMLAttributes<HTMLElement> {
  /** cluster = ultra-dense chips; loose = columnar stats */
  density?: 'cluster' | 'loose'
  children?: ReactNode
}

/**
 * MetricStrip — dense value/label chips (generic stats, not product wallets).
 */
const Root = forwardRef<HTMLElement, MetricStripRootProps>(function MetricStripRoot(
  { density = 'cluster', children, ...rest },
  ref,
) {
  return (
    <MetricCtx.Provider value={{ density }}>
      <div
        ref={ref as never}
        data-aeon-density={density}
        role="group"
        {...mergeProps(scopeAttrs(metricStripAnatomy.scope, metricStripAnatomy.root), rest)}
      >
        {children}
      </div>
    </MetricCtx.Provider>
  )
})

const Chip = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function MetricChip(
  props,
  ref,
) {
  useMetricCtx()
  return (
    <span
      ref={ref}
      {...mergeProps(partAttrs(metricStripAnatomy.scope, metricStripAnatomy.chip), props)}
    />
  )
})

const Value = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function MetricValue(
  props,
  ref,
) {
  useMetricCtx()
  return (
    <span
      ref={ref}
      {...mergeProps(partAttrs(metricStripAnatomy.scope, metricStripAnatomy.value), props)}
    />
  )
})

const Label = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function MetricLabel(
  props,
  ref,
) {
  useMetricCtx()
  return (
    <span
      ref={ref}
      {...mergeProps(partAttrs(metricStripAnatomy.scope, metricStripAnatomy.label), props)}
    />
  )
})

export const MetricStrip = {
  Root,
  Chip,
  Value,
  Label,
}
