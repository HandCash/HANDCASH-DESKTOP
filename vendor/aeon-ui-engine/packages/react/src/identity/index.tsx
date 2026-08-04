import { identityAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { createContext, forwardRef, useContext, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

interface IdentityContextValue {
  size: 'sm' | 'md' | 'lg'
}

const IdentityCtx = createContext<IdentityContextValue | null>(null)

function useIdentityCtx() {
  const ctx = useContext(IdentityCtx)
  if (!ctx) throw new Error('Identity parts must be used within Identity.Root')
  return ctx
}

export interface IdentityRootProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'a' | 'button'
  size?: 'sm' | 'md' | 'lg'
  children?: ReactNode
}

/**
 * Identity — avatar + title + subtitle strip.
 * Presentational compound; maximize width via truncate (`min-w-0`).
 */
const Root = forwardRef<HTMLElement, IdentityRootProps>(function IdentityRoot(
  { as: Tag = 'div', size = 'md', children, ...rest },
  ref,
) {
  return (
    <IdentityCtx.Provider value={{ size }}>
      <Tag
        ref={ref as never}
        data-aeon-size={size}
        {...mergeProps(scopeAttrs(identityAnatomy.scope, identityAnatomy.root), rest)}
      >
        {children}
      </Tag>
    </IdentityCtx.Provider>
  )
})

const AvatarSlot = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function IdentityAvatar(props, ref) {
    useIdentityCtx()
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(identityAnatomy.scope, identityAnatomy.avatar), props)}
      />
    )
  },
)

const Title = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function IdentityTitle(
  props,
  ref,
) {
  useIdentityCtx()
  return (
    <span
      ref={ref}
      {...mergeProps(partAttrs(identityAnatomy.scope, identityAnatomy.title), props)}
    />
  )
})

const Subtitle = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function IdentitySubtitle(props, ref) {
    useIdentityCtx()
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(identityAnatomy.scope, identityAnatomy.subtitle), props)}
      />
    )
  },
)

const Meta = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function IdentityMeta(
  props,
  ref,
) {
  useIdentityCtx()
  return (
    <span ref={ref} {...mergeProps(partAttrs(identityAnatomy.scope, identityAnatomy.meta), props)} />
  )
})

const Trailing = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function IdentityTrailing(props, ref) {
    useIdentityCtx()
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(identityAnatomy.scope, identityAnatomy.trailing), props)}
      />
    )
  },
)

export const Identity = {
  Root,
  Avatar: AvatarSlot,
  Title,
  Subtitle,
  Meta,
  Trailing,
}
