import { partAttrs, partOnlyAttrs, radioGroupAnatomy } from '@aeon-ui/core'
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
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface RadioGroupContextValue {
  value: string
  send: ReturnType<typeof useAeonMachine<typeof tabsMachine>>[1]
  selectValue: (next: string) => void
}

const RadioGroupCtx = createContext<RadioGroupContextValue | null>(null)

function useRadioGroupCtx() {
  const ctx = useContext(RadioGroupCtx)
  if (!ctx) throw new Error('RadioGroup parts must be used within RadioGroup.Root')
  return ctx
}

interface RadioGroupItemContextValue {
  value: string
  selected: boolean
}

const RadioGroupItemCtx = createContext<RadioGroupItemContextValue | null>(null)

function useRadioGroupItemCtx() {
  const ctx = useContext(RadioGroupItemCtx)
  if (!ctx) throw new Error('RadioGroup item parts must be used within RadioGroup.Item')
  return ctx
}

export interface RadioGroupRootProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, RadioGroupRootProps>(function RadioGroupRoot(
  { value, defaultValue = '', onValueChange, children, className, ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(tabsMachine, {
    input: { value: defaultValue, disabled: false },
  })

  const resolvedValue = value ?? snapshot.context.value
  const controlled = value !== undefined

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

  const ctx = useMemo(() => ({ value: resolvedValue, send, selectValue }), [resolvedValue, send, selectValue])

  return (
    <RadioGroupCtx.Provider value={ctx}>
      <div
        ref={ref}
        role="radiogroup"
        className={className}
        {...mergeProps(
          partAttrs(radioGroupAnatomy.scope, radioGroupAnatomy.root),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </RadioGroupCtx.Provider>
  )
})

export interface RadioGroupItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

const Item = forwardRef<HTMLDivElement, RadioGroupItemProps>(function RadioGroupItem(
  { value: itemValue, children, ...rest },
  ref,
) {
  const { value } = useRadioGroupCtx()
  const selected = value === itemValue
  const itemCtx = useMemo(() => ({ value: itemValue, selected }), [itemValue, selected])

  return (
    <RadioGroupItemCtx.Provider value={itemCtx}>
      <div
        ref={ref}
        {...mergeProps(
          partOnlyAttrs(radioGroupAnatomy.item, {
            state: selected ? 'selected' : 'unselected',
          }),
          rest,
        )}
      >
        {children}
      </div>
    </RadioGroupItemCtx.Provider>
  )
})

const ItemControl = forwardRef<HTMLSpanElement, ButtonHTMLAttributes<HTMLSpanElement>>(function RadioGroupItemControl(
  { onClick, onKeyDown, ...rest },
  ref,
) {
  const { selectValue } = useRadioGroupCtx()
  const { value: itemValue, selected } = useRadioGroupItemCtx()

  const select = () => selectValue(itemValue)

  return (
    <span
      ref={ref}
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      {...mergeProps(
        partOnlyAttrs(radioGroupAnatomy.itemControl, {
          state: selected ? 'selected' : 'unselected',
          highlighted: selected,
        }),
        {
          onClick: (e: MouseEvent<HTMLSpanElement>) => {
            onClick?.(e)
            select()
          },
          onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
            onKeyDown?.(e)
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              select()
            }
          },
        },
        rest,
      )}
    />
  )
})

const ItemIndicator = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function RadioGroupItemIndicator(
  props,
  ref,
) {
  const { selected } = useRadioGroupItemCtx()
  if (!selected) return null

  return (
    <span
      ref={ref}
      {...mergeProps(
        partOnlyAttrs(radioGroupAnatomy.itemIndicator, { state: 'selected' }),
        props,
      )}
    />
  )
})

const ItemLabel = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function RadioGroupItemLabel(
  { onClick, ...rest },
  ref,
) {
  const { selectValue } = useRadioGroupCtx()
  const { value: itemValue } = useRadioGroupItemCtx()

  return (
    <span
      ref={ref}
      {...mergeProps(
        partOnlyAttrs(radioGroupAnatomy.itemLabel),
        {
          onClick: (e: MouseEvent<HTMLSpanElement>) => {
            onClick?.(e)
            selectValue(itemValue)
          },
        },
        rest,
      )}
    />
  )
})

export const RadioGroup = { Root, Item, ItemControl, ItemIndicator, ItemLabel }
