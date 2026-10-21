import { partAttrs, textareaAnatomy } from '@aeon-ui/core'
import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type TextareaHTMLAttributes,
} from 'react'
import { assignRef } from '../utils/assign-ref.js'
import { mergeProps } from '../utils/merge-props.js'

/** Row limits as the CSS variables Aeon's auto-growing textareas read (Textarea, Composer.Input). */
export function rowLimits(minRows?: number, maxRows?: number): CSSProperties {
  return {
    ...(minRows === undefined ? {} : { '--aeon-textarea-min-rows': minRows }),
    ...(maxRows === undefined ? {} : { '--aeon-textarea-max-rows': maxRows }),
  } as CSSProperties
}

const growsByItself =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

/**
 * Grows a textarea to its content where CSS `field-sizing` is missing (Firefox); the recipe's
 * min / max height still clamp it. Spread the result onto the textarea.
 */
export function useAutoGrow(forwarded: ForwardedRef<HTMLTextAreaElement>, value: unknown) {
  const node = useRef<HTMLTextAreaElement | null>(null)

  const fit = useCallback(() => {
    const el = node.current
    if (growsByItself || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [])

  useLayoutEffect(fit, [fit, value])

  const ref = useCallback(
    (el: HTMLTextAreaElement | null) => {
      node.current = el
      assignRef(forwarded, el)
    },
    [forwarded],
  )

  return { ref, onInput: fit }
}

export interface TextareaRootProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Height floor in lines. */
  minRows?: number
  /** Height ceiling in lines; past it the textarea scrolls. Omit to grow without limit. */
  maxRows?: number
}

const Root = forwardRef<HTMLTextAreaElement, TextareaRootProps>(function TextareaRoot(
  { minRows = 2, maxRows, style, disabled, ...rest },
  ref,
) {
  const grow = useAutoGrow(ref, rest.value)

  return (
    <textarea
      rows={minRows}
      disabled={disabled}
      style={{ ...rowLimits(minRows, maxRows), ...style }}
      {...mergeProps(partAttrs(textareaAnatomy.scope, textareaAnatomy.root, { disabled }), grow, rest)}
    />
  )
})

export const Textarea = { Root }
