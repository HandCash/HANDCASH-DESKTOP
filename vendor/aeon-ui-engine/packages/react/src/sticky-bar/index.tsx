import { barAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { stickyBarMachine, type StickyBarState } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface StickyBarContextValue {
  state: StickyBarState
  offsetPx: number
  send: ReturnType<typeof useAeonMachine<typeof stickyBarMachine>>[1]
}

const StickyBarCtx = createContext<StickyBarContextValue | null>(null)

export function useStickyBarContext() {
  const ctx = useContext(StickyBarCtx)
  if (!ctx) throw new Error('StickyBar parts must be used within StickyBar.Root')
  return ctx
}

export interface StickyBarRootProps extends HTMLAttributes<HTMLElement> {
  as?: 'header' | 'nav' | 'footer' | 'div'
  /** Placement — top | bottom | inline (CSS contract). */
  placement?: 'top' | 'bottom' | 'inline'
  /** Initial machine state. */
  defaultState?: StickyBarState
  children?: ReactNode
}

const Root = forwardRef<HTMLElement, StickyBarRootProps>(function StickyBarRoot(
  {
    /* Default div — AppShell.Header is already the landmark; nested <header> is invalid
       HTML and browsers auto-close the outer header (0-height), so the bar covers content. */
    as: Tag = 'div',
    placement = 'top',
    defaultState = 'floating',
    children,
    style,
    ...rest
  },
  ref,
) {
  const [snapshot, send] = useAeonMachine(stickyBarMachine, {
    input: { initial: defaultState },
  })
  const state = snapshot.value as StickyBarState
  const offsetPx = snapshot.context.offsetPx
  const value = useMemo(() => ({ state, offsetPx, send }), [state, offsetPx, send])

  if (state === 'hidden') return null

  const stickyStyle: CSSProperties = {
    ...(typeof style === 'object' && style ? style : {}),
    ...(offsetPx > 0 ? ({ ['--aeon-bar-offset' as string]: `${offsetPx}px` } as CSSProperties) : {}),
  }

  return (
    <StickyBarCtx.Provider value={value}>
      <Tag
        ref={ref as never}
        data-aeon-placement={placement}
        style={stickyStyle}
        {...mergeProps(scopeAttrs(barAnatomy.scope, barAnatomy.root, { state }), rest)}
      >
        {children}
      </Tag>
    </StickyBarCtx.Provider>
  )
})

type Zone = 'leading' | 'center' | 'trailing'

const Zone = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { zone: Zone }
>(function StickyBarZone({ zone, ...rest }, ref) {
  const { state } = useStickyBarContext()
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(barAnatomy.scope, zone, { state }), rest)}
    />
  )
})

const Leading = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function StickyBarLeading(props, ref) {
    return <Zone ref={ref} zone="leading" {...props} />
  },
)
const Center = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function StickyBarCenter(props, ref) {
    return <Zone ref={ref} zone="center" {...props} />
  },
)
const Trailing = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function StickyBarTrailing(props, ref) {
    return <Zone ref={ref} zone="trailing" {...props} />
  },
)

const Seam = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function StickyBarSeam(
  props,
  ref,
) {
  const { state } = useStickyBarContext()
  return (
    <div
      ref={ref}
      aria-hidden
      {...mergeProps(partAttrs(barAnatomy.scope, barAnatomy.seam, { state }), props)}
    />
  )
})

/**
 * StickyBar — sticky/fixed chrome band with machine totality.
 * States: floating | docked | collapsed | hidden
 * Zones reuse bar anatomy (leading / center / trailing / seam).
 */
export const StickyBar = {
  Root,
  Leading,
  Center,
  Trailing,
  Seam,
}
