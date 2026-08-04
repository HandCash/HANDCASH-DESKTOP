import { composerAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'

/**
 * Composer root states.
 * - chat: plain message compose
 * - command: local slash input (BRC-218) — never from received text
 * - lookup: non-confirming verbs (/whois, /help)
 * - idle | sending | disabled | error: transport chrome
 */
export type ComposerState =
  | 'idle'
  | 'sending'
  | 'disabled'
  | 'error'
  | 'chat'
  | 'command'
  | 'lookup'

export interface ComposerRootProps extends FormHTMLAttributes<HTMLFormElement> {
  state?: ComposerState
  children?: ReactNode
}

/**
 * Composer — bottom compose chrome for threads (input + send + command palette).
 * Only local user input is command-eligible (BRC-218 §2.4).
 */
const Root = forwardRef<HTMLFormElement, ComposerRootProps>(function ComposerRoot(
  { state = 'idle', children, ...rest },
  ref,
) {
  return (
    <form
      ref={ref}
      {...mergeProps(scopeAttrs(composerAnatomy.scope, composerAnatomy.root, { state }), rest)}
    >
      {children}
    </form>
  )
})

const Input = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function ComposerInput(props, ref) {
    return (
      <textarea
        ref={ref}
        rows={1}
        {...mergeProps(partAttrs(composerAnatomy.scope, composerAnatomy.input), props)}
      />
    )
  },
)

const Actions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerActions(props, ref) {
    return (
      <div
        ref={ref}
        {...mergeProps(partAttrs(composerAnatomy.scope, composerAnatomy.actions), props)}
      />
    )
  },
)

const Send = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function ComposerSend(props, ref) {
    return (
      <span
        ref={ref}
        {...mergeProps(partAttrs(composerAnatomy.scope, composerAnatomy.send), props)}
      />
    )
  },
)

const Toolbar = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerToolbar(props, ref) {
    return (
      <div
        ref={ref}
        role="toolbar"
        {...mergeProps(partAttrs(composerAnatomy.scope, composerAnatomy.toolbar), props)}
      />
    )
  },
)

const Suggestions = forwardRef<HTMLUListElement, HTMLAttributes<HTMLUListElement>>(
  function ComposerSuggestions(props, ref) {
    return (
      <ul
        ref={ref}
        role="listbox"
        {...mergeProps(partAttrs(composerAnatomy.scope, composerAnatomy.suggestions), props)}
      />
    )
  },
)

const Suggestion = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ComposerSuggestion(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="option"
        {...mergeProps(partAttrs(composerAnatomy.scope, composerAnatomy.suggestion), props)}
      />
    )
  },
)

export const Composer = {
  Root,
  Input,
  Actions,
  Send,
  Toolbar,
  Suggestions,
  Suggestion,
}
