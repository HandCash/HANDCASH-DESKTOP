import { dialogAnatomy, partAttrs } from '@aeon-ui/core'
import { dialogMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { useFocusTrap } from '../hooks/use-focus-trap.js'
import { renderPortalled, usePortalledMount } from '../hooks/use-portalled.js'
import { useScrollLock } from '../hooks/use-scroll-lock.js'
import { mergeProps } from '../utils/merge-props.js'

interface DialogContextValue {
  open: boolean
  send: ReturnType<typeof useAeonMachine<typeof dialogMachine>>[1]
  titleId: string
  descriptionId: string
  contentRef: React.RefObject<HTMLDivElement | null>
}

const DialogCtx = createContext<DialogContextValue | null>(null)

function useDialogCtx() {
  const ctx = useContext(DialogCtx)
  if (!ctx) throw new Error('Dialog parts must be used within Dialog.Root')
  return ctx
}

export interface DialogRootProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, DialogRootProps>(function DialogRoot(
  { open, defaultOpen = false, onOpenChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(dialogMachine, {
    input: { open: defaultOpen },
  })

  const resolvedOpen = open ?? snapshot.context.open
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onOpenChange?.(resolvedOpen)
  }, [resolvedOpen, onOpenChange])

  useEffect(() => {
    if (open !== undefined) {
      send({ type: 'SET_OPEN', open })
    }
  }, [open, send])

  const titleId = useId()
  const descriptionId = useId()
  const value = useMemo(
    () => ({ open: resolvedOpen, send, titleId, descriptionId, contentRef }),
    [resolvedOpen, send, titleId, descriptionId],
  )

  return (
    <DialogCtx.Provider value={value}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(dialogAnatomy.scope, dialogAnatomy.root, {
            state: resolvedOpen ? 'open' : 'closed',
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </DialogCtx.Provider>
  )
})

const Trigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function DialogTrigger(
  { onClick, ...rest },
  ref,
) {
  const { send } = useDialogCtx()
  return (
    <button
      ref={ref}
      type="button"
      {...mergeProps(
        partAttrs(dialogAnatomy.scope, dialogAnatomy.trigger),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            send({ type: 'OPEN' })
          },
        },
        rest,
      )}
    />
  )
})

export interface DialogPortalProps extends HTMLAttributes<HTMLDivElement> {
  /** Mount overlay in document.body (default true). */
  portalled?: boolean
  children?: ReactNode
}

const Portal = forwardRef<HTMLDivElement, DialogPortalProps>(function DialogPortal(
  { portalled = true, children, className, ...rest },
  ref,
) {
  const { open } = useDialogCtx()
  const mounted = usePortalledMount()

  useScrollLock(open)

  if (!open) return null

  const node = (
    <div
      ref={ref}
      className={className}
      {...mergeProps(partAttrs(dialogAnatomy.scope, dialogAnatomy.portal, { state: 'open' }), rest)}
    >
      {children}
    </div>
  )

  return renderPortalled(node, portalled, mounted)
})

const Backdrop = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function DialogBackdrop(
  props,
  ref,
) {
  const { open, send } = useDialogCtx()
  if (!open) return null
  return (
    <div
      ref={ref}
      {...mergeProps(
        partAttrs(dialogAnatomy.scope, dialogAnatomy.backdrop, { state: 'open' }),
        {
          onClick: () => send({ type: 'POINTER_DOWN_OUTSIDE' }),
        },
        props,
      )}
    />
  )
})

const Positioner = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function DialogPositioner(
  props,
  ref,
) {
  const { open } = useDialogCtx()
  if (!open) return null
  return (
    <div
      ref={ref}
      {...mergeProps(partAttrs(dialogAnatomy.scope, dialogAnatomy.positioner, { state: 'open' }), props)}
    />
  )
})

const Content = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function DialogContent(
  { onKeyDown, ...rest },
  ref,
) {
  const { open, send, titleId, descriptionId, contentRef } = useDialogCtx()

  useFocusTrap(contentRef, open)

  useEffect(() => {
    if (open) contentRef.current?.focus()
  }, [open, contentRef])

  if (!open) return null
  return (
    <div
      ref={(node) => {
        contentRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      {...mergeProps(
        partAttrs(dialogAnatomy.scope, dialogAnatomy.content, { state: 'open' }),
        {
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            onKeyDown?.(e)
            if (e.key === 'Escape') send({ type: 'ESCAPE' })
          },
        },
        rest,
      )}
    />
  )
})

const Title = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function DialogTitle(
  props,
  ref,
) {
  const { titleId } = useDialogCtx()
  return (
    <h2 ref={ref} id={titleId} {...mergeProps(partAttrs(dialogAnatomy.scope, dialogAnatomy.title), props)} />
  )
})

const Description = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function DialogDescription(props, ref) {
    const { descriptionId } = useDialogCtx()
    return (
      <p
        ref={ref}
        id={descriptionId}
        {...mergeProps(partAttrs(dialogAnatomy.scope, dialogAnatomy.description), props)}
      />
    )
  },
)

const CloseTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function DialogCloseTrigger({ onClick, ...rest }, ref) {
    const { send } = useDialogCtx()
    return (
      <button
        ref={ref}
        type="button"
        {...mergeProps(
          partAttrs(dialogAnatomy.scope, dialogAnatomy.closeTrigger),
          {
            'aria-label': 'Close dialog',
            onClick: (e: MouseEvent<HTMLButtonElement>) => {
              onClick?.(e)
              send({ type: 'CLOSE' })
            },
          },
          rest,
        )}
      />
    )
  },
)

export const Dialog = {
  Root,
  Trigger,
  Portal,
  Backdrop,
  Positioner,
  Content,
  Title,
  Description,
  CloseTrigger,
}
