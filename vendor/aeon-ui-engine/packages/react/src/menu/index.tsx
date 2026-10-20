import { menuAnatomy, partAttrs } from '@aeon-ui/core'
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

interface MenuContextValue {
  open: boolean
  send: ReturnType<typeof useAeonMachine<typeof popoverMachine>>[1]
  triggerId: string
  menuId: string
  triggerRef: React.RefObject<HTMLButtonElement | null>
  positionerRef: React.RefObject<HTMLDivElement | null>
}

const MenuCtx = createContext<MenuContextValue | null>(null)

function useMenuCtx() {
  const ctx = useContext(MenuCtx)
  if (!ctx) throw new Error('Menu parts must be used within Menu.Root')
  return ctx
}

export interface MenuRootProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, MenuRootProps>(function MenuRoot(
  { open, defaultOpen = false, onOpenChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(popoverMachine, { input: { open: defaultOpen } })
  const machineOpen = snapshot.context.open
  const resolvedOpen = open ?? machineOpen
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const positionerRef = useRef<HTMLDivElement>(null)
  const triggerId = useId()
  const menuId = useId()

  /** Machine intent, so a controlled owner still hears its own trigger. */
  const reportedOpen = useRef(machineOpen)
  useEffect(() => {
    if (reportedOpen.current === machineOpen) return
    reportedOpen.current = machineOpen
    onOpenChange?.(machineOpen)
  }, [machineOpen, onOpenChange])

  useEffect(() => {
    if (open !== undefined) send({ type: 'SET_OPEN', open })
  }, [open, send])

  const close = useCallback(() => send({ type: 'CLOSE' }), [send])
  useOutsideClick([rootRef, positionerRef], resolvedOpen, close)

  const value = useMemo(
    () => ({ open: resolvedOpen, send, triggerId, menuId, triggerRef, positionerRef }),
    [resolvedOpen, send, triggerId, menuId],
  )

  return (
    <MenuCtx.Provider value={value}>
      <div
        ref={(node) => {
          rootRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        className={className}
        {...mergeProps(
          partAttrs(menuAnatomy.scope, menuAnatomy.root, { state: resolvedOpen ? 'open' : 'closed' }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </MenuCtx.Provider>
  )
})

const Trigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function MenuTrigger(
  { onClick, ...rest },
  ref,
) {
  const { open, send, triggerId, menuId, triggerRef } = useMenuCtx()
  return (
    <button
      ref={(node) => {
        triggerRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      type="button"
      id={triggerId}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      {...mergeProps(
        partAttrs(menuAnatomy.scope, menuAnatomy.trigger, { state: open ? 'open' : 'closed' }),
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

export interface MenuPositionerProps extends HTMLAttributes<HTMLDivElement> {
  /** Mount menu in document.body (default true). */
  portalled?: boolean
  placement?: AnchorPlacement
  /** Gap between trigger and menu (default 4). */
  gutter?: number
  /** Stack level for the portalled surface (default 50). */
  zIndex?: number
  children?: ReactNode
}

const Positioner = forwardRef<HTMLDivElement, MenuPositionerProps>(function MenuPositioner(
  { portalled = true, placement = 'bottom-start', gutter, zIndex, children, className, ...rest },
  ref,
) {
  const { open, triggerRef, positionerRef } = useMenuCtx()

  return (
    <FloatingPositioner
      ref={ref}
      open={open}
      scope={menuAnatomy.scope}
      part={menuAnatomy.positioner}
      triggerRef={triggerRef}
      positionerRef={positionerRef}
      portalled={portalled}
      placement={placement}
      gutter={gutter}
      zIndex={zIndex}
      className={className}
      {...rest}
    >
      {children}
    </FloatingPositioner>
  )
})

const Content = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function MenuContent(
  { onKeyDown, ...rest },
  ref,
) {
  const { open, send, menuId, triggerRef } = useMenuCtx()
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Focus enters the surface while it is open and returns to the trigger on
  // dismiss, so keyboard users stay inside the menu they opened.
  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    contentRef.current?.focus({ preventScroll: true })
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [open, triggerRef])

  // Escape closes wherever focus sits — trigger, item or elsewhere on the page.
  useEffect(() => {
    if (!open) return
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') send({ type: 'ESCAPE' })
    }
    document.addEventListener('keydown', onDocumentKeyDown)
    return () => document.removeEventListener('keydown', onDocumentKeyDown)
  }, [open, send])

  if (!open) return null
  return (
    <div
      ref={(node) => {
        contentRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      id={menuId}
      role="menu"
      tabIndex={-1}
      {...mergeProps(
        partAttrs(menuAnatomy.scope, menuAnatomy.content, { state: 'open' }),
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

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Close menu after selection (default true). */
  closeOnSelect?: boolean
}

const Item = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { closeOnSelect = true, onClick, ...rest },
  ref,
) {
  const { send } = useMenuCtx()
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      {...mergeProps(
        partAttrs(menuAnatomy.scope, menuAnatomy.item),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            if (closeOnSelect && !e.defaultPrevented) send({ type: 'CLOSE' })
          },
        },
        rest,
      )}
    />
  )
})

const Separator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function MenuSeparator(
  props,
  ref,
) {
  return (
    <div ref={ref} role="separator" {...mergeProps(partAttrs(menuAnatomy.scope, menuAnatomy.separator), props)} />
  )
})

export const Menu = { Root, Trigger, Positioner, Content, Item, Separator }
