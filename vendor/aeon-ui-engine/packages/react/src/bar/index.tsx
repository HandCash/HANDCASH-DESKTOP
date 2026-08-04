import { barAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { createContext, forwardRef, type HTMLAttributes } from 'react'
import { mergeProps } from '../utils/merge-props.js'

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface BarContextValue {
  gap?: string
}

const BarContext = createContext<BarContextValue>({})

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

export interface BarRootProps extends HTMLAttributes<HTMLDivElement> {
  /** HTML element to render — defaults to `'header'`. */
  as?: 'header' | 'nav' | 'footer' | 'div'
  /** Flex gap between zones. */
  gap?: string
}

const Root = forwardRef<HTMLDivElement, BarRootProps>(function BarRoot(
  { as: Tag = 'header', gap, children, ...rest },
  ref,
) {
  return (
    <BarContext.Provider value={{ gap }}>
      <Tag
        ref={ref as never}
        {...mergeProps(scopeAttrs(barAnatomy.scope, barAnatomy.root), rest)}
      >
        {children}
      </Tag>
    </BarContext.Provider>
  )
})

/* ------------------------------------------------------------------ */
/*  Zone (Leading / Center / Trailing)                                 */
/* ------------------------------------------------------------------ */

type Zone = 'leading' | 'center' | 'trailing'

interface ZoneProps extends HTMLAttributes<HTMLDivElement> {
  /** Which zone — controls flex behavior. */
  zone: Zone
}

const Zone = forwardRef<HTMLDivElement, ZoneProps>(function BarZone(
  { zone, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(barAnatomy.scope, zone), rest)}
    >
      {children}
    </div>
  )
})

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Bar — horizontal layout primitive for toolbars, headers, footers.
 *
 * Guarantees no overlap by enforcing a three-zone flex contract:
 * - **Leading** — `flex: 0 1 auto`, shrinks before overflowing.
 * - **Center** — `flex: 1 1 0`, absorbs available space, truncates.
 * - **Trailing** — `flex: 0 1 auto`, shrinks before overflowing.
 *
 * The root is always `display: flex; flex-wrap: nowrap` with
 * `overflow: hidden` so children can never escape the bar boundary.
 * Responsive collapse is handled by the Panda recipe (min-widths, wrap
 * at breakpoints) — never by ad-hoc CSS.
 */
export const Bar = {
  Root,
  Leading: forwardRef<HTMLDivElement, Omit<ZoneProps, 'zone'>>(
    function BarLeading(props, ref) {
      return <Zone ref={ref} zone="leading" {...props} />
    },
  ),
  Center: forwardRef<HTMLDivElement, Omit<ZoneProps, 'zone'>>(
    function BarCenter(props, ref) {
      return <Zone ref={ref} zone="center" {...props} />
    },
  ),
  Trailing: forwardRef<HTMLDivElement, Omit<ZoneProps, 'zone'>>(
    function BarTrailing(props, ref) {
      return <Zone ref={ref} zone="trailing" {...props} />
    },
  ),
}
