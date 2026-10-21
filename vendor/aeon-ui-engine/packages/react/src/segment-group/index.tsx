import { partAttrs, partOnlyAttrs, segmentGroupAnatomy } from '@aeon-ui/core'
import { tabsMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { assignRef } from '../utils/assign-ref.js'
import { mergeProps } from '../utils/merge-props.js'

interface SegmentGroupContextValue {
  value: string
  disabled: boolean
  /** The one item Tab lands on: the selected item, or the first enabled one when that is missing or disabled. */
  tabStop: string | null
  selectValue: (next: string) => void
}

const SegmentGroupCtx = createContext<SegmentGroupContextValue | null>(null)

function useSegmentGroupCtx() {
  const ctx = useContext(SegmentGroupCtx)
  if (!ctx) throw new Error('SegmentGroup parts must be used within SegmentGroup.Root')
  return ctx
}

const ROOT = `[data-aeon-scope="${segmentGroupAnatomy.scope}"]`

/** This group's enabled items in DOM order, leaving out items of nested groups. */
function enabledItems(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>(`[data-aeon-part="${segmentGroupAnatomy.item}"]:not(:disabled)`),
  ).filter((item) => item.closest(ROOT) === root)
}

export interface SegmentGroupRootProps extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  orientation?: 'horizontal' | 'vertical'
}

const Root = forwardRef<HTMLDivElement, SegmentGroupRootProps>(function SegmentGroupRoot(
  { value, defaultValue = '', onValueChange, disabled = false, orientation = 'horizontal', ...rest },
  ref,
) {
  const [snapshot, send] = useAeonMachine(tabsMachine, {
    input: { value: value ?? defaultValue, disabled },
  })
  const controlled = value !== undefined
  const resolvedValue = value ?? snapshot.context.value

  useEffect(() => {
    if (controlled) send({ type: 'SET_VALUE', value })
  }, [controlled, value, send])

  const selectValue = useCallback(
    (next: string) => {
      if (disabled || next === resolvedValue) return
      if (!controlled) send({ type: 'SELECT', value: next })
      onValueChange?.(next)
    },
    [disabled, resolvedValue, controlled, send, onValueChange],
  )

  const node = useRef<HTMLDivElement | null>(null)
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el
      assignRef(ref, el)
    },
    [ref],
  )

  /* Items can be added, removed or disabled at any render, so the tab stop is re-read from the DOM each time. */
  const [tabStop, setTabStop] = useState<string | null>(null)
  useLayoutEffect(() => {
    const items = node.current ? enabledItems(node.current) : []
    const next = (items.find((item) => item.dataset.value === resolvedValue) ?? items[0])?.dataset.value ?? null
    setTabStop((prev) => (prev === next ? prev : next))
  })

  const ctx = useMemo(
    () => ({ value: resolvedValue, disabled, tabStop, selectValue }),
    [resolvedValue, disabled, tabStop, selectValue],
  )

  return (
    <SegmentGroupCtx.Provider value={ctx}>
      <div
        ref={setRef}
        role="radiogroup"
        aria-orientation={orientation}
        aria-disabled={disabled || undefined}
        data-orientation={orientation}
        {...mergeProps(partAttrs(segmentGroupAnatomy.scope, segmentGroupAnatomy.root, { disabled }), rest)}
      />
    </SegmentGroupCtx.Provider>
  )
})

const KEY_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

export interface SegmentGroupItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string
}

const Item = forwardRef<HTMLButtonElement, SegmentGroupItemProps>(function SegmentGroupItem(
  { value: itemValue, disabled: itemDisabled, onClick, onKeyDown, ...rest },
  ref,
) {
  const { value, disabled: groupDisabled, tabStop, selectValue } = useSegmentGroupCtx()
  const selected = value === itemValue
  const disabled = groupDisabled || Boolean(itemDisabled)

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      data-value={itemValue}
      disabled={disabled}
      tabIndex={itemValue === tabStop ? 0 : -1}
      {...mergeProps(
        partOnlyAttrs(segmentGroupAnatomy.item, {
          state: selected ? 'selected' : 'unselected',
          disabled,
        }),
        {
          onClick: (e: MouseEvent<HTMLButtonElement>) => {
            onClick?.(e)
            if (!e.defaultPrevented) selectValue(itemValue)
          },
          onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
            onKeyDown?.(e)
            if (e.defaultPrevented) return
            const root = e.currentTarget.closest<HTMLElement>(ROOT)
            const items = root ? enabledItems(root) : []
            const at = items.indexOf(e.currentTarget)
            const step = KEY_STEP[e.key]
            const target =
              e.key === 'Home' ? items[0]
              : e.key === 'End' ? items[items.length - 1]
              : step === undefined || at < 0 ? undefined
              : items[(at + step + items.length) % items.length]
            if (!target) return
            e.preventDefault()
            target.focus()
            selectValue(target.dataset.value ?? '')
          },
        },
        rest,
      )}
    />
  )
})

export const SegmentGroup = { Root, Item }
