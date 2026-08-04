import { partAttrs, scopeAttrs, threadAnatomy } from '@aeon-ui/core'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'

/** Base alignment / delivery states. */
export type ThreadMessageState = 'mine' | 'theirs' | 'pending' | 'failed'

/** Structured in-thread faces (space-combinable with mine/theirs). */
export type ThreadItemFace = 'command-result' | 'payment-card' | 'request-card'

export interface ThreadRootProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

/**
 * Thread — message stream.
 * Item `state` projects mine | theirs | pending | failed, optionally plus
 * command-result | payment-card | request-card (e.g. `mine payment-card`).
 */
const Root = forwardRef<HTMLElement, ThreadRootProps>(function ThreadRoot(
  { children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref as never}
      {...mergeProps(scopeAttrs(threadAnatomy.scope, threadAnatomy.root), rest)}
    >
      {children}
    </div>
  )
})

const List = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ThreadList(
  props,
  ref,
) {
  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.list), props)}
    />
  )
})

export interface ThreadItemProps extends HTMLAttributes<HTMLDivElement> {
  state?: ThreadMessageState | ThreadItemFace | `${ThreadMessageState} ${ThreadItemFace}` | string
}

const Item = forwardRef<HTMLDivElement, ThreadItemProps>(function ThreadItem(
  { state = 'theirs', ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.item, { state }), rest)}
    />
  )
})

const Bubble = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ThreadBubble(
  props,
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.bubble), props)}
    />
  )
})

const Meta = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function ThreadMeta(
  props,
  ref,
) {
  return (
    <span ref={ref} {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.meta), props)} />
  )
})

const Day = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ThreadDay(
  props,
  ref,
) {
  return (
    <div ref={ref} {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.day), props)} />
  )
})

/** Reply / message-binding control — must be touch-reachable (BRC-218 §4.10). */
const Bind = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ThreadBind(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.bind), props)}
      />
    )
  },
)

const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ThreadCard(
  props,
  ref,
) {
  return (
    <div ref={ref} {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.card), props)} />
  )
})

const CardTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ThreadCardTitle(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.cardTitle), props)}
      />
    )
  },
)

const CardBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ThreadCardBody(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.cardBody), props)}
      />
    )
  },
)

const CardActions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ThreadCardActions(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(threadAnatomy.scope, threadAnatomy.cardActions), props)}
      />
    )
  },
)

export const Thread = {
  Root,
  List,
  Item,
  Bubble,
  Meta,
  Day,
  Bind,
  Card,
  CardTitle,
  CardBody,
  CardActions,
}
