import { tooltipAnatomy, partAttrs } from '@aeon-ui/core'
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
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { FloatingPositioner } from '../floating/FloatingPositioner.js'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { useOutsideClick } from '../hooks/use-outside-click.js'
import { usePrefersHover } from '../hooks/use-prefers-hover.js'
import { mergeProps } from '../utils/merge-props.js'
import type { AnchorPlacement } from '../hooks/use-anchor-position.js'

interface TooltipContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerId: string
  contentId: string
  triggerRef: React.RefObject<HTMLSpanElement | null>
  positionerRef: React.RefObject<HTMLDivElement | null>
  scheduleShow: () => void
  scheduleHide: () => void
  showImmediately: () => void
  hideNow: () => void
  toggleTouch: () => void
  showOnFocus: boolean
  prefersHover: boolean
}

const TooltipCtx = createContext<TooltipContextValue | null>(null)

function useTooltipCtx() {
  const ctx = useContext(TooltipCtx)
  if (!ctx) throw new Error('Tooltip parts must be used within Tooltip.Root')
  return ctx
}

export interface TooltipRootProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  openDelay?: number
  closeDelay?: number
  /** Auto-hide on touch devices after open (0 = until outside tap). Default 5000. */
  touchDurationMs?: number
  /** Ignore outside-dismiss briefly after touch open (ghost-click guard). */
  touchOutsideGraceMs?: number
  /** Focus after click/tap can leave tooltips open; disable for dense click targets. */
  showOnFocus?: boolean
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, TooltipRootProps>(function TooltipRoot(
  {
    open,
    defaultOpen = false,
    onOpenChange,
    openDelay = 400,
    closeDelay = 100,
    touchDurationMs = 5000,
    touchOutsideGraceMs = 400,
    showOnFocus = true,
    children,
    className,
    ...rest
  },
  ref,
) {
  const [snapshot, send] = useAeonMachine(popoverMachine, {
    input: { open: defaultOpen },
  })
  const resolvedOpen = open ?? snapshot.matches('open')
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const positionerRef = useRef<HTMLDivElement>(null)
  const triggerId = useId()
  const contentId = useId()
  const prefersHover = usePrefersHover()
  const [outsideClickEnabled, setOutsideClickEnabled] = useState(false)

  useEffect(() => {
    if (open !== undefined) send({ type: 'SET_OPEN', open })
  }, [open, send])

  useEffect(() => {
    if (!resolvedOpen || prefersHover) {
      setOutsideClickEnabled(false)
      return
    }
    setOutsideClickEnabled(false)
    const id = window.setTimeout(() => setOutsideClickEnabled(true), touchOutsideGraceMs)
    return () => window.clearTimeout(id)
  }, [resolvedOpen, prefersHover, touchOutsideGraceMs])

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) send({ type: next ? 'OPEN' : 'CLOSE' })
      onOpenChange?.(next)
    },
    [open, send, onOpenChange],
  )

  useEffect(() => {
    onOpenChange?.(resolvedOpen)
  }, [resolvedOpen, onOpenChange])

  const hideNow = useCallback(() => {
    if (showTimer.current !== undefined) clearTimeout(showTimer.current)
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
    setOpen(false)
  }, [setOpen])

  const showImmediately = useCallback(() => {
    if (showTimer.current !== undefined) clearTimeout(showTimer.current)
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
    setOpen(true)
    if (!prefersHover && touchDurationMs > 0) {
      hideTimer.current = setTimeout(() => hideNow(), touchDurationMs)
    }
  }, [setOpen, prefersHover, touchDurationMs, hideNow])

  const scheduleShow = useCallback(() => {
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setOpen(true), openDelay)
  }, [setOpen, openDelay])

  const scheduleHide = useCallback(() => {
    if (showTimer.current !== undefined) clearTimeout(showTimer.current)
    if (closeDelay <= 0) {
      setOpen(false)
      return
    }
    hideTimer.current = setTimeout(() => setOpen(false), closeDelay)
  }, [setOpen, closeDelay])

  const toggleTouch = useCallback(() => {
    if (resolvedOpen) hideNow()
    else showImmediately()
  }, [resolvedOpen, hideNow, showImmediately])

  useOutsideClick(
    [triggerRef, positionerRef],
    resolvedOpen && !prefersHover && outsideClickEnabled,
    hideNow,
  )

  const value = useMemo(
    () => ({
      open: resolvedOpen,
      setOpen,
      triggerId,
      contentId,
      triggerRef,
      positionerRef,
      scheduleShow,
      scheduleHide,
      showImmediately,
      hideNow,
      toggleTouch,
      showOnFocus,
      prefersHover,
    }),
    [
      resolvedOpen,
      setOpen,
      triggerId,
      contentId,
      scheduleShow,
      scheduleHide,
      showImmediately,
      hideNow,
      toggleTouch,
      showOnFocus,
      prefersHover,
    ],
  )

  return (
    <TooltipCtx.Provider value={value}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(tooltipAnatomy.scope, tooltipAnatomy.root, {
            state: resolvedOpen ? 'open' : 'closed',
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </TooltipCtx.Provider>
  )
})

const Trigger = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function TooltipTrigger(
  { onClick, onMouseEnter, onMouseLeave, onFocus, onBlur, onPointerDown, ...rest },
  ref,
) {
  const {
    open,
    triggerId,
    contentId,
    triggerRef,
    scheduleShow,
    scheduleHide,
    hideNow,
    toggleTouch,
    showOnFocus,
    prefersHover,
  } = useTooltipCtx()

  return (
    <span
      ref={(node) => {
        triggerRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      id={triggerId}
      tabIndex={0}
      aria-describedby={open ? contentId : undefined}
      {...mergeProps(
        partAttrs(tooltipAnatomy.scope, tooltipAnatomy.trigger, { state: open ? 'open' : 'closed' }),
        {
          onMouseEnter: (e: MouseEvent<HTMLSpanElement>) => {
            onMouseEnter?.(e)
            if (prefersHover) scheduleShow()
          },
          onMouseLeave: (e: MouseEvent<HTMLSpanElement>) => {
            onMouseLeave?.(e)
            if (prefersHover) scheduleHide()
          },
          onFocus: (e: FocusEvent<HTMLSpanElement>) => {
            onFocus?.(e)
            if (showOnFocus && prefersHover) scheduleShow()
          },
          onBlur: (e: FocusEvent<HTMLSpanElement>) => {
            onBlur?.(e)
            if (showOnFocus && prefersHover) scheduleHide()
          },
          onClick: (e: MouseEvent<HTMLSpanElement>) => {
            onClick?.(e)
            if (!e.defaultPrevented && !prefersHover) toggleTouch()
          },
          onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
            onPointerDown?.(e)
            if (showOnFocus && prefersHover && e.pointerType === 'mouse') hideNow()
          },
        },
        rest,
      )}
    />
  )
})

export interface TooltipPositionerProps extends HTMLAttributes<HTMLDivElement> {
  /** Mount tooltip in document.body (default true). */
  portalled?: boolean
  placement?: AnchorPlacement
  children?: ReactNode
}

const Positioner = forwardRef<HTMLDivElement, TooltipPositionerProps>(function TooltipPositioner(
  { portalled = true, placement = 'top-start', children, className, ...rest },
  ref,
) {
  const { open, triggerRef, positionerRef } = useTooltipCtx()

  return (
    <FloatingPositioner
      ref={ref}
      open={open}
      scope={tooltipAnatomy.scope}
      part={tooltipAnatomy.positioner}
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

const Content = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TooltipContent(props, ref) {
  const { open, contentId } = useTooltipCtx()
  if (!open) return null
  return (
    <div
      ref={ref}
      id={contentId}
      role="tooltip"
      {...mergeProps(partAttrs(tooltipAnatomy.scope, tooltipAnatomy.content, { state: 'open' }), props)}
    />
  )
})

const Arrow = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TooltipArrow(props, ref) {
  const { open } = useTooltipCtx()
  if (!open) return null
  return <div ref={ref} {...mergeProps(partAttrs(tooltipAnatomy.scope, tooltipAnatomy.arrow), props)} />
})

export const Tooltip = { Root, Trigger, Positioner, Content, Arrow }
