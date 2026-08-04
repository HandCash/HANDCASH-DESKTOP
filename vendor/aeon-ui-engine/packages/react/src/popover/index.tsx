import { popoverAnatomy, partAttrs } from '@aeon-ui/core'
import { popoverMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useCallback,
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
import { FloatingPositioner } from '../floating/FloatingPositioner.js'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { useOutsideClick } from '../hooks/use-outside-click.js'
import { mergeProps } from '../utils/merge-props.js'
import type { AnchorPlacement } from '../hooks/use-anchor-position.js'

interface PopoverContextValue {
  open: boolean
  send: ReturnType<typeof useAeonMachine<typeof popoverMachine>>[1]
  triggerId: string
  contentId: string
  triggerRef: React.RefObject<HTMLButtonElement | null>
  positionerRef: React.RefObject<HTMLDivElement | null>
}

const PopoverCtx = createContext<PopoverContextValue | null>(null)

function usePopoverCtx() {
  const ctx = useContext(PopoverCtx)
  if (!ctx) throw new Error('Popover parts must be used within Popover.Root')
  return ctx
}

export interface PopoverRootProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, PopoverRootProps>(function PopoverRoot(
  { open, defaultOpen = false, onOpenChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(popoverMachine, {
    input: { open: defaultOpen },
  })
  const resolvedOpen = open ?? snapshot.context.open
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const positionerRef = useRef<HTMLDivElement>(null)
  const triggerId = useId()
  const contentId = useId()

  useEffect(() => {
    onOpenChange?.(resolvedOpen)
  }, [resolvedOpen, onOpenChange])

  useEffect(() => {
    if (open !== undefined) send({ type: 'SET_OPEN', open })
  }, [open, send])

  const close = useCallback(() => send({ type: 'CLOSE' }), [send])
  useOutsideClick([rootRef, positionerRef], resolvedOpen, close)

  const value = useMemo(
    () => ({ open: resolvedOpen, send, triggerId, contentId, triggerRef, positionerRef }),
    [resolvedOpen, send, triggerId, contentId],
  )

  return (
    <PopoverCtx.Provider value={value}>
      <div
        ref={(node) => {
          rootRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        className={className}
        {...mergeProps(
          partAttrs(popoverAnatomy.scope, popoverAnatomy.root, {
            state: resolvedOpen ? 'open' : 'closed',
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </PopoverCtx.Provider>
  )
})

const Trigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function PopoverTrigger(
  { onClick, ...rest },
  ref,
) {
  const { open, send, triggerId, contentId, triggerRef } = usePopoverCtx()
  return (
    <button
      ref={(node) => {
        triggerRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      type="button"
      id={triggerId}
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      {...mergeProps(
        partAttrs(popoverAnatomy.scope, popoverAnatomy.trigger, { state: open ? 'open' : 'closed' }),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            if (!e.defaultPrevented) send({ type: 'TOGGLE' })
          },
        },
        rest,
      )}
    />
  )
})

export interface PopoverPositionerProps extends HTMLAttributes<HTMLDivElement> {
  /** Mount panel in document.body (default true). */
  portalled?: boolean
  placement?: AnchorPlacement
  children?: ReactNode
}

const Positioner = forwardRef<HTMLDivElement, PopoverPositionerProps>(function PopoverPositioner(
  { portalled = true, placement = 'bottom-start', children, className, ...rest },
  ref,
) {
  const { open, triggerRef, positionerRef } = usePopoverCtx()

  return (
    <FloatingPositioner
      ref={ref}
      open={open}
      scope={popoverAnatomy.scope}
      part={popoverAnatomy.positioner}
      triggerRef={triggerRef}
      positionerRef={positionerRef}
      portalled={portalled}
      placement={placement}
      className={className}
      {...rest}
    >
      {children}
    </FloatingPositioner>
  )
})

const Content = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function PopoverContent(
  { onKeyDown, ...rest },
  ref,
) {
  const { open, send, triggerId, contentId } = usePopoverCtx()
  if (!open) return null
  return (
    <div
      ref={ref}
      id={contentId}
      role="dialog"
      aria-modal={false}
      aria-labelledby={triggerId}
      {...mergeProps(
        partAttrs(popoverAnatomy.scope, popoverAnatomy.content, { state: 'open' }),
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

const Arrow = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function PopoverArrow(props, ref) {
  const { open } = usePopoverCtx()
  if (!open) return null
  return <div ref={ref} {...mergeProps(partAttrs(popoverAnatomy.scope, popoverAnatomy.arrow), props)} />
})

const CloseTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function PopoverCloseTrigger({ onClick, ...rest }, ref) {
    const { send } = usePopoverCtx()
    return (
      <button
        ref={ref}
        type="button"
        aria-label="Close"
        {...mergeProps(
          partAttrs(popoverAnatomy.scope, popoverAnatomy.closeTrigger),
          {
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

export const Popover = { Root, Trigger, Positioner, Content, Arrow, CloseTrigger }
