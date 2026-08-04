import { navAnatomy, partAttrs, scopeAttrs } from '@aeon-ui/core'
import { tabsMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface NavContextValue {
  value: string
  send: ReturnType<typeof useAeonMachine<typeof tabsMachine>>[1]
  onValueChange?: (value: string) => void
}

const NavCtx = createContext<NavContextValue | null>(null)

function useNavCtx() {
  const ctx = useContext(NavCtx)
  if (!ctx) throw new Error('Nav parts must be used within Nav.Root')
  return ctx
}

export interface NavRootProps extends HTMLAttributes<HTMLElement> {
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
  as?: 'nav' | 'div'
  orientation?: 'horizontal' | 'vertical'
  children?: ReactNode
}

const Root = forwardRef<HTMLElement, NavRootProps>(function NavRoot(
  {
    defaultValue = '',
    value,
    onValueChange,
    as: Tag = 'nav',
    orientation = 'horizontal',
    children,
    ...rest
  },
  ref,
) {
  const [snapshot, send] = useAeonMachine(tabsMachine, {
    input: { value: defaultValue, disabled: false },
  })
  const resolvedValue = value ?? snapshot.context.value

  useEffect(() => {
    if (value !== undefined) send({ type: 'SET_VALUE', value })
  }, [value, send])

  const ctx = useMemo(
    () => ({ value: resolvedValue, send, onValueChange }),
    [resolvedValue, send, onValueChange],
  )

  return (
    <NavCtx.Provider value={ctx}>
      <Tag
        ref={ref as never}
        data-aeon-orientation={orientation}
        {...mergeProps(scopeAttrs(navAnatomy.scope, navAnatomy.root), rest)}
      >
        {children}
      </Tag>
    </NavCtx.Provider>
  )
})

export interface NavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

const Item = forwardRef<HTMLButtonElement, NavItemProps>(function NavItem(
  { value, disabled, onClick, children, ...rest },
  ref,
) {
  const { value: selected, send, onValueChange } = useNavCtx()
  const active = selected === value
  const state = disabled ? 'disabled' : active ? 'active' : 'inactive'

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      data-aeon-value={value}
      onClick={(e) => {
        onClick?.(e)
        if (disabled || e.defaultPrevented) return
        send({ type: 'SELECT', value })
        onValueChange?.(value)
      }}
      {...mergeProps(partAttrs(navAnatomy.scope, navAnatomy.item, { state, disabled }), rest)}
    >
      {children}
    </button>
  )
})

const Indicator = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function NavIndicator(
  props,
  ref,
) {
  return (
    <span
      ref={ref}
      aria-hidden
      {...mergeProps(partAttrs(navAnatomy.scope, navAnatomy.indicator), props)}
    />
  )
})

const Label = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function NavLabel(
  props,
  ref,
) {
  return <span ref={ref} {...mergeProps(partAttrs(navAnatomy.scope, navAnatomy.label), props)} />
})

const Icon = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function NavIcon(
  props,
  ref,
) {
  return <span ref={ref} {...mergeProps(partAttrs(navAnatomy.scope, navAnatomy.icon), props)} />
})

const Badge = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function NavBadge(
  props,
  ref,
) {
  return <span ref={ref} {...mergeProps(partAttrs(navAnatomy.scope, navAnatomy.badge), props)} />
})

/**
 * Nav — navigational collection (top links, bottom tabs, side rail).
 * Selection: tabsMachine. Item states: inactive | active | disabled.
 */
export const Nav = {
  Root,
  Item,
  Indicator,
  Label,
  Icon,
  Badge,
}
