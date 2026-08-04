import { conversationAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

export type ConversationItemState = 'idle' | 'unread' | 'selected'

export interface ConversationRootProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

/**
 * Conversation — inbox / DM list (universal messaging chrome).
 * Item states: idle | unread | selected.
 */
const Root = forwardRef<HTMLElement, ConversationRootProps>(function ConversationRoot(
  { children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref as never}
      {...mergeProps(scopeAttrs(conversationAnatomy.scope, conversationAnatomy.root), rest)}
    >
      {children}
    </div>
  )
})

export interface ConversationItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  state?: ConversationItemState
  as?: 'button' | 'div' | 'a'
}

const Item = forwardRef<HTMLElement, ConversationItemProps>(function ConversationItem(
  { state = 'idle', as: Tag = 'button', type, children, ...rest },
  ref,
) {
  const buttonType = Tag === 'button' ? (type ?? 'button') : undefined
  return (
    <Tag
      ref={ref as never}
      type={buttonType as never}
      {...mergeProps(
        partAttrs(conversationAnatomy.scope, conversationAnatomy.item, { state }),
        rest,
      )}
    >
      {children}
    </Tag>
  )
})

function Part(part: string, displayName: string) {
  const Comp = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function ConversationPart(
    props,
    ref,
  ) {
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(conversationAnatomy.scope, part), props)}
      />
    )
  })
  Comp.displayName = displayName
  return Comp
}

export const Conversation = {
  Root,
  Item,
  Leading: Part(conversationAnatomy.leading, 'Conversation.Leading'),
  Body: Part(conversationAnatomy.body, 'Conversation.Body'),
  Title: Part(conversationAnatomy.title, 'Conversation.Title'),
  Preview: Part(conversationAnatomy.preview, 'Conversation.Preview'),
  Meta: Part(conversationAnatomy.meta, 'Conversation.Meta'),
  Badge: Part(conversationAnatomy.badge, 'Conversation.Badge'),
}
