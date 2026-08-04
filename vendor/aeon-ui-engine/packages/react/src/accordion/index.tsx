import { accordionAnatomy, partOnlyAttrs, scopeAttrs } from '@aeon-ui/core'
import { accordionMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
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

interface AccordionContextValue {
  value: string[]
  send: ReturnType<typeof useAeonMachine<typeof accordionMachine>>[1]
}

const AccordionCtx = createContext<AccordionContextValue | null>(null)

function useAccordionCtx() {
  const ctx = useContext(AccordionCtx)
  if (!ctx) throw new Error('Accordion parts must be used within Accordion.Root')
  return ctx
}

export interface AccordionRootProps {
  value?: string[]
  defaultValue?: string[]
  multiple?: boolean
  collapsible?: boolean
  onValueChange?: (value: string[]) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, AccordionRootProps>(function AccordionRoot(
  {
    value,
    defaultValue = [],
    multiple = false,
    collapsible = true,
    onValueChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const [snapshot, send] = useAeonMachine(accordionMachine, {
    input: { value: defaultValue, multiple, collapsible },
  })

  const resolvedValue = value ?? snapshot.context.value

  useEffect(() => {
    onValueChange?.(resolvedValue)
  }, [resolvedValue, onValueChange])

  useEffect(() => {
    if (value !== undefined) send({ type: 'SET_VALUE', value })
  }, [value, send])

  const ctx = useMemo(() => ({ value: resolvedValue, send }), [resolvedValue, send])

  return (
    <AccordionCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          scopeAttrs(accordionAnatomy.scope, accordionAnatomy.root),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </AccordionCtx.Provider>
  )
})

export interface AccordionItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

const Item = forwardRef<HTMLDivElement, AccordionItemProps>(function AccordionItem(
  { value: itemValue, children, ...rest },
  ref,
) {
  const { value } = useAccordionCtx()
  const open = value.includes(itemValue)

  return (
    <div
      ref={ref}
      {...mergeProps(
        partOnlyAttrs(accordionAnatomy.item, {
          state: open ? 'open' : 'closed',
        }),
        rest,
      )}
    >
      {children}
    </div>
  )
})

export interface AccordionItemTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

const ItemTrigger = forwardRef<HTMLButtonElement, AccordionItemTriggerProps>(function AccordionItemTrigger(
  { value: itemValue, onClick, ...rest },
  ref,
) {
  const { value, send } = useAccordionCtx()
  const open = value.includes(itemValue)

  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      {...mergeProps(
        partOnlyAttrs(accordionAnatomy.itemTrigger, {
          state: open ? 'open' : 'closed',
        }),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            send({ type: 'TOGGLE', item: itemValue })
          },
        },
        rest,
      )}
    />
  )
})

export interface AccordionItemContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

const ItemContent = forwardRef<HTMLDivElement, AccordionItemContentProps>(function AccordionItemContent(
  { value: itemValue, children, ...rest },
  ref,
) {
  const { value } = useAccordionCtx()
  if (!value.includes(itemValue)) return null

  return (
    <div
      ref={ref}
      {...mergeProps(
        partOnlyAttrs(accordionAnatomy.itemContent, { state: 'open' }),
        rest,
      )}
    >
      {children}
    </div>
  )
})

const ItemIndicator = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function AccordionItemIndicator(
  props,
  ref,
) {
  return (
    <span
      ref={ref}
      {...mergeProps(partOnlyAttrs(accordionAnatomy.itemIndicator), props)}
    />
  )
})

export const Accordion = { Root, Item, ItemTrigger, ItemContent, ItemIndicator }
