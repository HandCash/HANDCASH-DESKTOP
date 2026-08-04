import { partAttrs, scopeAttrs, statusBannerAnatomy } from '@aeon-ui/core'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export type StatusBannerTone = 'info' | 'success' | 'warning' | 'danger'

export interface StatusBannerRootProps extends HTMLAttributes<HTMLDivElement> {
  tone?: StatusBannerTone
  /** Machine-ish status string projected to data-aeon-state (e.g. ready, downloading). */
  status?: string
  children?: ReactNode
}

const Root = forwardRef<HTMLDivElement, StatusBannerRootProps>(function StatusBannerRoot(
  { tone = 'info', status, children, ...rest },
  ref,
) {
  const state = [tone, status].filter(Boolean).join(' ')
  return (
    <div
      ref={ref}
      role="status"
      {...mergeProps(scopeAttrs(statusBannerAnatomy.scope, statusBannerAnatomy.root, { state }), rest)}
    >
      {children}
    </div>
  )
})

const Copy = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function StatusBannerCopy(
  props,
  ref,
) {
  return <div ref={ref} {...mergeProps(partAttrs(statusBannerAnatomy.scope, statusBannerAnatomy.copy), props)} />
})

const Title = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function StatusBannerTitle(
  props,
  ref,
) {
  return (
    <strong
      ref={ref as never}
      {...mergeProps(partAttrs(statusBannerAnatomy.scope, statusBannerAnatomy.title), props)}
    />
  )
})

const Body = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function StatusBannerBody(
  props,
  ref,
) {
  return (
    <span ref={ref} {...mergeProps(partAttrs(statusBannerAnatomy.scope, statusBannerAnatomy.body), props)} />
  )
})

const Actions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function StatusBannerActions(
  props,
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(statusBannerAnatomy.scope, statusBannerAnatomy.actions), props)}
    />
  )
})

const Action = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function StatusBannerAction(props, ref) {
    return <button ref={ref} type="button" {...props} />
  },
)

/** Non-blocking top-of-app notice (updates, sync, offline). */
export const StatusBanner = {
  Root,
  Copy,
  Title,
  Body,
  Actions,
  Action,
}
