import { contentAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { contentRegionMachine, type ContentRegionState } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface ContentContextValue {
  state: ContentRegionState
  error: string | null
  send: ReturnType<typeof useAeonMachine<typeof contentRegionMachine>>[1]
}

const ContentCtx = createContext<ContentContextValue | null>(null)

export function useContentContext() {
  const ctx = useContext(ContentCtx)
  if (!ctx) throw new Error('Content parts must be used within Content.Root')
  return ctx
}

export interface ContentRootProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Controlled face — projects parent/app machine onto Content slots
   * (same pattern as Button `status`). When set, slot visibility uses this
   * value instead of the internal contentRegionMachine leaf.
   */
  state?: ContentRegionState
  children?: ReactNode
}

const Root = forwardRef<HTMLDivElement, ContentRootProps>(function ContentRoot(
  { state: stateProp, children, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(contentRegionMachine)
  const machineState = snapshot.value as ContentRegionState
  const state = stateProp ?? machineState
  const value = useMemo(
    () => ({ state, error: snapshot.context.error, send }),
    [state, snapshot.context.error, send],
  )

  return (
    <ContentCtx.Provider value={value}>
      <div
        ref={ref}
        {...mergeProps(scopeAttrs(contentAnatomy.scope, contentAnatomy.root, { state }), rest)}
      >
        {children}
      </div>
    </ContentCtx.Provider>
  )
})

const Toolbar = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ContentToolbar(
  props,
  ref,
) {
  const { state } = useContentContext()
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(contentAnatomy.scope, contentAnatomy.toolbar, { state }), props)}
    />
  )
})

/** Primary body — shown when state is ready | loadingMore | success (and optionally idle). */
const Body = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ContentBody(
  { hidden, ...rest },
  ref,
) {
  const { state } = useContentContext()
  const show = state === 'ready' || state === 'loadingMore' || state === 'success' || state === 'idle'
  if (!show) return null
  return (
    <div
      ref={ref}
      hidden={hidden}
      {...mergeProps(partAttrs(contentAnatomy.scope, contentAnatomy.body, { state }), rest)}
    />
  )
})

function StatusSlot(
  part: string,
  match: ContentRegionState | ContentRegionState[],
  displayName: string,
) {
  const matches = Array.isArray(match) ? match : [match]
  const Comp = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ContentStatusSlot(
    props,
    ref,
  ) {
    const { state } = useContentContext()
    if (!matches.includes(state)) return null
    return (
      <div
        ref={ref}
        role="status"
        {...mergeProps(partAttrs(contentAnatomy.scope, part, { state }), props)}
      />
    )
  })
  Comp.displayName = displayName
  return Comp
}

const Pending = StatusSlot(contentAnatomy.pending, 'pending', 'Content.Pending')
const Empty = StatusSlot(contentAnatomy.empty, 'empty', 'Content.Empty')
const ErrorSlot = StatusSlot(contentAnatomy.error, 'error', 'Content.Error')
const Success = StatusSlot(contentAnatomy.success, 'success', 'Content.Success')

const Sentinel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ContentSentinel(
  props,
  ref,
) {
  const { state } = useContentContext()
  if (state !== 'ready' && state !== 'loadingMore') return null
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(contentAnatomy.scope, contentAnatomy.sentinel, { state }), props)}
    />
  )
})

/**
 * Content — status-slotted region. Machine totality maps 1:1 onto parts.
 * States: idle | pending | empty | error | ready | loadingMore | success
 * Drive via contentRegionMachine events, or project with Root `state` prop.
 */
export const Content = {
  Root,
  Toolbar,
  Body,
  Pending,
  Empty,
  Error: ErrorSlot,
  Success,
  Sentinel,
}
