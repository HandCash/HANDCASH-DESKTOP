import { partAttrs, promptAnatomy, scopeAttrs } from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { Dialog } from '../dialog/index.js'
import { mergeProps } from '../utils/merge-props.js'

export type PromptStatus = 'pending' | 'confirming' | 'dismissed' | 'confirmed'

interface PromptContextValue {
  status: PromptStatus
}

const PromptCtx = createContext<PromptContextValue | null>(null)

function usePromptCtx() {
  const ctx = useContext(PromptCtx)
  if (!ctx) throw new Error('Prompt parts must be used within Prompt.Root')
  return ctx
}

export interface PromptRootProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Projected onto data-aeon-state (default: pending when open). */
  status?: PromptStatus
  children?: ReactNode
  className?: string
}

/**
 * Prompt — confirm / permission / “restart to update” dialog.
 * Composes Dialog (portal, focus trap, escape) with product-facing parts.
 */
const Root = forwardRef<HTMLDivElement, PromptRootProps>(function PromptRoot(
  { status = 'pending', children, className, ...dialogProps },
  ref,
) {
  const value = useMemo(() => ({ status }), [status])
  return (
    <PromptCtx.Provider value={value}>
      <Dialog.Root {...dialogProps}>
        <div
          ref={ref}
          className={className}
          {...scopeAttrs(promptAnatomy.scope, promptAnatomy.root, { state: status })}
        >
          {children}
        </div>
      </Dialog.Root>
    </PromptCtx.Provider>
  )
})

const Eyebrow = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function PromptEyebrow(props, ref) {
    const { status } = usePromptCtx()
    return (
      <p
        ref={ref}
        {...mergeProps(partAttrs(promptAnatomy.scope, promptAnatomy.eyebrow, { state: status }), props)}
      />
    )
  },
)

const Meta = forwardRef<HTMLDListElement, HTMLAttributes<HTMLDListElement>>(function PromptMeta(
  props,
  ref,
) {
  const { status } = usePromptCtx()
  return (
    <dl
      ref={ref}
      {...mergeProps(partAttrs(promptAnatomy.scope, promptAnatomy.meta, { state: status }), props)}
    />
  )
})

const Amount = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function PromptAmount(
  props,
  ref,
) {
  const { status } = usePromptCtx()
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(promptAnatomy.scope, promptAnatomy.amount, { state: status }), props)}
    />
  )
})

/** Command verb face — e.g. `/pay` (BRC-218 §4 confirmation). */
const Verb = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function PromptVerb(props, ref) {
    const { status } = usePromptCtx()
    return (
      <p
        ref={ref}
        {...mergeProps(partAttrs(promptAnatomy.scope, promptAnatomy.verb, { state: status }), props)}
      />
    )
  },
)

/** Fully-qualified recipient `@handle@domain` — never alias alone. */
const Recipient = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function PromptRecipient(props, ref) {
    const { status } = usePromptCtx()
    return (
      <p
        ref={ref}
        {...mergeProps(
          partAttrs(promptAnatomy.scope, promptAnatomy.recipient, { state: status }),
          props,
        )}
      />
    )
  },
)

/** Plain-language effect statement for the confirmation sheet. */
const Effect = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function PromptEffect(props, ref) {
    const { status } = usePromptCtx()
    return (
      <p
        ref={ref}
        {...mergeProps(partAttrs(promptAnatomy.scope, promptAnatomy.effect, { state: status }), props)}
      />
    )
  },
)

const Actions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function PromptActions(
  props,
  ref,
) {
  const { status } = usePromptCtx()
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(promptAnatomy.scope, promptAnatomy.actions, { state: status }), props)}
    />
  )
})

const Primary = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function PromptPrimary(props, ref) {
    const { status } = usePromptCtx()
    return (
      <button
        ref={ref}
        type="button"
        {...mergeProps(
          partAttrs(promptAnatomy.scope, promptAnatomy.primary, { state: status }),
          props,
        )}
      />
    )
  },
)

const Secondary = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function PromptSecondary(props, ref) {
    const { status } = usePromptCtx()
    return (
      <button
        ref={ref}
        type="button"
        {...mergeProps(
          partAttrs(promptAnatomy.scope, promptAnatomy.secondary, { state: status }),
          props,
        )}
      />
    )
  },
)

export const Prompt = {
  Root,
  Trigger: Dialog.Trigger,
  Portal: Dialog.Portal,
  Backdrop: Dialog.Backdrop,
  Positioner: Dialog.Positioner,
  Content: Dialog.Content,
  Title: Dialog.Title,
  Description: Dialog.Description,
  CloseTrigger: Dialog.CloseTrigger,
  Eyebrow,
  Meta,
  Amount,
  Verb,
  Recipient,
  Effect,
  Actions,
  Primary,
  Secondary,
}
