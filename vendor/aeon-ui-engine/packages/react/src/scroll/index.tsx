import { scrollAnatomy, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useScrollState } from './use-scroll-state.js'

interface ScrollContextValue {
  stateAttr: string
}

const ScrollCtx = createContext<ScrollContextValue | null>(null)

export function useScrollContext(): ScrollContextValue {
  const ctx = useContext(ScrollCtx)
  if (!ctx) throw new Error('Scroll parts must be used within <Scroll.Root>')
  return ctx
}

export interface ScrollRootProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

const Root = forwardRef<HTMLDivElement, ScrollRootProps>(function ScrollRoot(
  { children, className, ...rest },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stateAttr = useScrollState(viewportRef)
  const value = useMemo(() => ({ stateAttr }), [stateAttr])

  return (
    <ScrollCtx.Provider value={value}>
      <div
        ref={ref}
        className={className}
        {...partAttrs(scrollAnatomy.scope, scrollAnatomy.root)}
        {...rest}
      >
        <ScrollViewportRefContext.Provider value={viewportRef}>
          {children}
        </ScrollViewportRefContext.Provider>
      </div>
    </ScrollCtx.Provider>
  )
})

const ScrollViewportRefContext = createContext<React.RefObject<HTMLDivElement | null> | null>(
  null,
)

export interface ScrollViewportProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

const Viewport = forwardRef<HTMLDivElement, ScrollViewportProps>(function ScrollViewport(
  { children, className, ...rest },
  forwardedRef,
) {
  const ctxRef = useContext(ScrollViewportRefContext)
  const { stateAttr } = useScrollContext()

  return (
    <div
      ref={(node) => {
        if (ctxRef) ctxRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      className={className}
      data-aeon-scroll=""
      {...partAttrs(scrollAnatomy.scope, scrollAnatomy.viewport, { state: stateAttr })}
      {...rest}
    >
      {children}
    </div>
  )
})

const Content = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollContent(
  props,
  ref,
) {
  return <div ref={ref} {...partOnlyAttrs(scrollAnatomy.content)} {...props} />
})

export const Scroll = {
  Root,
  Viewport,
  Content,
}

export { useScrollState } from './use-scroll-state.js'
