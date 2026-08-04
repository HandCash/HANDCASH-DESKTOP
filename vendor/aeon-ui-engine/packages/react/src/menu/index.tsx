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
  const resolvedOpen = open ?? snapshot.context.open
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const positionerRef = useRef<HTMLDivElement>(null)
  const triggerId = useId()
  const menuId = useId()

  useEffect(() => {
    onOpenChange?.(resolvedOpen)
  }, [resolvedOpen, onOpenChange])

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
  children?: ReactNode
}

const Positioner = forwardRef<HTMLDivElement, MenuPositionerProps>(function MenuPositioner(
  { portalled = true, placement = 'bottom-start', children, className, ...rest },
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
  const { open, send, menuId } = useMenuCtx()
  if (!open) return null
  return (
    <div
      ref={ref}
      id={menuId}
      role="menu"
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
