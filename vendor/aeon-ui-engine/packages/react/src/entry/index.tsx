import { entryAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeProps } from '../utils/merge-props.js'

/** Card face — idle resting · selected highlight · muted de-emphasized. */
export type EntryState = 'idle' | 'selected' | 'muted'

export interface EntryListProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/**
 * Entry — compact multi-value content card.
 * Compose feed posts, listings, and activity rows from the same zones.
 * Machine: none (layout). Root projects idle | selected | muted.
 */
const List = forwardRef<HTMLDivElement, EntryListProps>(function EntryList(
  { children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...mergeProps(scopeAttrs(entryAnatomy.scope, entryAnatomy.list), rest)}
    >
      {children}
    </div>
  )
})

export interface EntryRootProps extends HTMLAttributes<HTMLElement> {
  as?: 'article' | 'div' | 'li' | 'section'
  state?: EntryState
  children?: ReactNode
}

const Root = forwardRef<HTMLElement, EntryRootProps>(function EntryRoot(
  { as: Tag = 'article', state = 'idle', children, ...rest },
  ref,
) {
  return (
    <Tag
      ref={ref as never}
      {...mergeProps(scopeAttrs(entryAnatomy.scope, entryAnatomy.root, { state }), rest)}
    >
      {children}
    </Tag>
  )
})

function Part(
  part: string,
  displayName: string,
  defaultTag: 'div' | 'span' | 'header' | 'footer' | 'p' = 'div',
) {
  const Comp = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { as?: typeof defaultTag }>(
    function EntryPart({ as: Tag = defaultTag, ...props }, ref) {
      return (
        <Tag
          ref={ref as never}
          {...mergeProps(partAttrs(entryAnatomy.scope, part), props)}
        />
      )
    },
  )
  Comp.displayName = displayName
  return Comp
}

export const Entry = {
  List,
  Root,
  Header: Part(entryAnatomy.header, 'Entry.Header', 'header'),
  Leading: Part(entryAnatomy.leading, 'Entry.Leading', 'div'),
  Heading: Part(entryAnatomy.heading, 'Entry.Heading', 'div'),
  Title: Part(entryAnatomy.title, 'Entry.Title', 'div'),
  Subtitle: Part(entryAnatomy.subtitle, 'Entry.Subtitle', 'div'),
  Meta: Part(entryAnatomy.meta, 'Entry.Meta', 'span'),
  Media: Part(entryAnatomy.media, 'Entry.Media', 'div'),
  Body: Part(entryAnatomy.body, 'Entry.Body', 'div'),
  Values: Part(entryAnatomy.values, 'Entry.Values', 'div'),
  Value: Part(entryAnatomy.value, 'Entry.Value', 'span'),
  Actions: Part(entryAnatomy.actions, 'Entry.Actions', 'div'),
  Footer: Part(entryAnatomy.footer, 'Entry.Footer', 'footer'),
}
