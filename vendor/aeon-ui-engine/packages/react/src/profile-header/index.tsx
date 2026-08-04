import { profileHeaderAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export interface ProfileHeaderRootProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

/**
 * ProfileHeader — dense account surface (identity + metrics + actions).
 * Compose Identity / MetricStrip / Bar actions — not a dating hero.
 */
const Root = forwardRef<HTMLElement, ProfileHeaderRootProps>(function ProfileHeaderRoot(
  { children, ...rest },
  ref,
) {
  return (
    <header
      ref={ref as never}
      {...mergeProps(scopeAttrs(profileHeaderAnatomy.scope, profileHeaderAnatomy.root), rest)}
    >
      {children}
    </header>
  )
})

const Media = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ProfileHeaderMedia(
  props,
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(profileHeaderAnatomy.scope, profileHeaderAnatomy.media), props)}
    />
  )
})

const IdentitySlot = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ProfileHeaderIdentity(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(profileHeaderAnatomy.scope, profileHeaderAnatomy.identity), props)}
      />
    )
  },
)

const Metrics = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ProfileHeaderMetrics(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(profileHeaderAnatomy.scope, profileHeaderAnatomy.metrics), props)}
      />
    )
  },
)

const Actions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ProfileHeaderActions(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(profileHeaderAnatomy.scope, profileHeaderAnatomy.actions), props)}
      />
    )
  },
)

const Body = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ProfileHeaderBody(
  props,
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(profileHeaderAnatomy.scope, profileHeaderAnatomy.body), props)}
    />
  )
})

export const ProfileHeader = {
  Root,
  Media,
  Identity: IdentitySlot,
  Metrics,
  Actions,
  Body,
}
