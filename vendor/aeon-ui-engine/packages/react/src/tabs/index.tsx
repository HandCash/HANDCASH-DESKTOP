import { partAttrs, tabsAnatomy } from '@aeon-ui/core'
import { tabsMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface TabsContextValue {
  value: string
  selectValue: (value: string) => void
}

const TabsCtx = createContext<TabsContextValue | null>(null)

function useTabsCtx() {
  const ctx = useContext(TabsCtx)
  if (!ctx) throw new Error('Tabs parts must be used within Tabs.Root')
  return ctx
}

export interface TabsRootProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange' | 'children'> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, TabsRootProps>(function TabsRoot(
  { value, defaultValue = '', onValueChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(tabsMachine, {
    input: { value: defaultValue, disabled: false },
  })

  const controlled = value !== undefined
  const resolvedValue = value ?? snapshot.context.value

  const selectValue = useCallback(
    (next: string) => {
      if (controlled) onValueChange?.(next)
      else send({ type: 'SELECT', value: next })
    },
    [controlled, onValueChange, send],
  )

  useEffect(() => {
    if (controlled) return
    onValueChange?.(snapshot.context.value)
  }, [snapshot.context.value, controlled, onValueChange])

  useEffect(() => {
    if (value !== undefined) send({ type: 'SET_VALUE', value })
  }, [value, send])

  const ctx = useMemo(() => ({ value: resolvedValue, selectValue }), [resolvedValue, selectValue])

  return (
    <TabsCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(partAttrs(tabsAnatomy.scope, tabsAnatomy.root), rest as HTMLAttributes<HTMLDivElement>)}
      >
        {children}
      </div>
    </TabsCtx.Provider>
  )
})

const List = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TabsList(props, ref) {
  return <div ref={ref} role="tablist" {...mergeProps(partAttrs(tabsAnatomy.scope, tabsAnatomy.list), props)} />
})

export interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

const Trigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { value: triggerValue, onClick, ...rest },
  ref,
) {
  const { value, selectValue } = useTabsCtx()
  const selected = value === triggerValue

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={selected}
      data-selected={selected ? '' : undefined}
      {...mergeProps(
        partAttrs(tabsAnatomy.scope, tabsAnatomy.trigger, {
          state: selected ? 'selected' : 'unselected',
          highlighted: selected,
        }),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            if (!e.defaultPrevented && value !== triggerValue) selectValue(triggerValue)
          },
        },
        rest,
      )}
    />
  )
})

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

const Content = forwardRef<HTMLDivElement, TabsContentProps>(function TabsContent(
  { value: contentValue, ...rest },
  ref,
) {
  const { value } = useTabsCtx()
  if (value !== contentValue) return null

  return (
    <div
      ref={ref}
      role="tabpanel"
      {...mergeProps(
        partAttrs(tabsAnatomy.scope, tabsAnatomy.content, { state: 'active' }),
        rest,
      )}
    />
  )
})

const Indicator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TabsIndicator(
  props,
  ref,
) {
  return <div ref={ref} {...mergeProps(partAttrs(tabsAnatomy.scope, tabsAnatomy.indicator), props)} />
})

export const Tabs = { Root, List, Trigger, Content, Indicator }
