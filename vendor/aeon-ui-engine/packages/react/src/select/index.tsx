import { selectAnatomy, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
import { popoverMachine } from '@aeon-ui/primitives'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
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

interface SelectContextValue {
  value: string
  open: boolean
  listboxId: string
  highlightedValue: string | null
  send: ReturnType<typeof useAeonMachine<typeof popoverMachine>>[1]
  triggerRef: React.RefObject<HTMLButtonElement | null>
  positionerRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  onValueChange?: (value: string) => void
  moveHighlight: (delta: number) => void
  highlightValue: (value: string | null) => void
  selectValue: (value: string) => void
  onListboxKeyDown: (e: KeyboardEvent) => void
}

const SelectCtx = createContext<SelectContextValue | null>(null)

/** Set when `Select.Content` is a descendant of `Select.Positioner`. */
const SelectPositionerCtx = createContext(false)

function useSelectCtx() {
  const ctx = useContext(SelectCtx)
  if (!ctx) throw new Error('Select parts must be used within <Select.Root>')
  return ctx
}

function optionValuesFromDom(listboxId: string, content: HTMLElement | null): string[] {
  if (!content) return []
  const prefix = `${listboxId}-option-`
  return Array.from(content.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)'))
    .map((el) => (el.id.startsWith(prefix) ? el.id.slice(prefix.length) : ''))
    .filter(Boolean)
}

export interface SelectRootProps {
  value: string
  onValueChange?: (value: string) => void
  children: ReactNode
  className?: string
  disabled?: boolean
}

const Root = forwardRef<HTMLDivElement, SelectRootProps>(function SelectRoot(
  { value, onValueChange, children, className, disabled },
  ref,
) {
  const [snapshot, send] = useAeonMachine(popoverMachine, { input: { open: false } })
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const positionerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const open = disabled ? false : snapshot.matches('open')

  const close = useCallback(() => {
    send({ type: 'CLOSE' })
    setHighlightedValue(null)
  }, [send])

  useOutsideClick([rootRef, positionerRef], open, () => send({ type: 'POINTER_DOWN_OUTSIDE' }))

  const getOptionValues = useCallback(
    () => optionValuesFromDom(listboxId, contentRef.current),
    [listboxId, open],
  )

  const selectValue = useCallback(
    (next: string) => {
      onValueChange?.(next)
      close()
    },
    [onValueChange, close],
  )

  const highlightValue = useCallback((next: string | null) => {
    setHighlightedValue(next)
  }, [])

  const moveHighlight = useCallback(
    (delta: number) => {
      const options = getOptionValues()
      if (options.length === 0) {
        setHighlightedValue(null)
        return
      }
      const idx = highlightedValue ? options.indexOf(highlightedValue) : -1
      let next = idx + delta
      if (next < 0) next = options.length - 1
      if (next >= options.length) next = 0
      setHighlightedValue(options[next]!)
    },
    [getOptionValues, highlightedValue],
  )

  const onListboxKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return

      if ((e.key === 'Enter' || e.key === ' ') && !open) {
        e.preventDefault()
        send({ type: 'OPEN' })
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!open) send({ type: 'OPEN' })
        else moveHighlight(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!open) send({ type: 'OPEN' })
        else moveHighlight(-1)
        return
      }
      if (e.key === 'Home' && open) {
        e.preventDefault()
        const first = getOptionValues()[0]
        if (first) highlightValue(first)
        return
      }
      if (e.key === 'End' && open) {
        e.preventDefault()
        const options = getOptionValues()
        const last = options[options.length - 1]
        if (last) highlightValue(last)
        return
      }
      if ((e.key === 'Enter' || e.key === ' ') && open) {
        e.preventDefault()
        const pick = highlightedValue ?? getOptionValues()[0]
        if (pick) selectValue(pick)
        return
      }
      if (e.key === 'Escape') send({ type: 'ESCAPE' })
    },
    [open, send, moveHighlight, getOptionValues, highlightValue, highlightedValue, selectValue],
  )

  const ctx = useMemo(
    () => ({
      value,
      open,
      listboxId,
      highlightedValue,
      send,
      triggerRef,
      positionerRef,
      contentRef,
      onValueChange,
      moveHighlight,
      highlightValue,
      selectValue,
      onListboxKeyDown,
    }),
    [
      value,
      open,
      listboxId,
      highlightedValue,
      send,
      onValueChange,
      moveHighlight,
      highlightValue,
      selectValue,
      onListboxKeyDown,
    ],
  )

  return (
    <SelectCtx.Provider value={ctx}>
      <div
        ref={(node) => {
          rootRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        className={className}
        {...partAttrs(selectAnatomy.scope, selectAnatomy.root, {
          state: open ? 'open' : 'closed',
        })}
      >
        {children}
      </div>
    </SelectCtx.Provider>
  )
})

const ValueText = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(function SelectValueText(
  props,
  ref,
) {
  return <span ref={ref} {...partOnlyAttrs(selectAnatomy.value)} {...props} />
})

const Trigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function SelectTrigger(
  { children, onClick, onKeyDown, ...rest },
  ref,
) {
  const { open, send, listboxId, triggerRef, onListboxKeyDown } = useSelectCtx()

  return (
    <button
      ref={(node) => {
        triggerRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      {...partAttrs(selectAnatomy.scope, selectAnatomy.trigger, { state: open ? 'open' : 'closed' })}
      {...mergeProps(rest, {
        onClick: (e: MouseEvent<HTMLButtonElement>) => {
          onClick?.(e)
          if (!e.defaultPrevented) send({ type: 'TOGGLE' })
        },
        onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
          onKeyDown?.(e)
          onListboxKeyDown(e)
        },
      })}
    >
      {children}
      <span {...partOnlyAttrs(selectAnatomy.icon)} aria-hidden />
    </button>
  )
})

export interface SelectPositionerProps extends HTMLAttributes<HTMLDivElement> {
  /** Mount listbox in document.body (default true). */
  portalled?: boolean
  children?: ReactNode
}

const Positioner = forwardRef<HTMLDivElement, SelectPositionerProps>(function SelectPositioner(
  { portalled = true, children, className, ...rest },
  ref,
) {
  const { open, triggerRef, positionerRef } = useSelectCtx()

  return (
    <SelectPositionerCtx.Provider value={true}>
      <FloatingPositioner
        ref={ref}
        open={open}
        scope={selectAnatomy.scope}
        part={selectAnatomy.positioner}
        triggerRef={triggerRef}
        positionerRef={positionerRef}
        portalled={portalled}
        matchAnchorWidth
        className={className}
        {...rest}
      >
        {children}
      </FloatingPositioner>
    </SelectPositionerCtx.Provider>
  )
})

export interface SelectContentProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * When `Select.Content` is not wrapped in `Select.Positioner`, portal to body (default true).
   * Ignored when a `Select.Positioner` ancestor is present.
   */
  portalled?: boolean
}

const Content = forwardRef<HTMLDivElement, SelectContentProps>(function SelectContent(
  { portalled = true, onKeyDown, children, className, ...rest },
  ref,
) {
  const inPositioner = useContext(SelectPositionerCtx)
  const { open, listboxId, contentRef, highlightedValue, onListboxKeyDown, triggerRef, positionerRef } =
    useSelectCtx()

  if (!open) return null

  const activeId =
    highlightedValue && open ? `${listboxId}-option-${highlightedValue}` : undefined

  const listbox = (
    <div
      ref={(node) => {
        contentRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      id={listboxId}
      role="listbox"
      aria-activedescendant={activeId}
      className={className}
      data-aeon-scroll=""
      {...partAttrs(selectAnatomy.scope, selectAnatomy.content, { state: 'open' })}
      {...mergeProps(rest, {
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          onKeyDown?.(e)
          onListboxKeyDown(e)
        },
      })}
    >
      {children}
    </div>
  )

  if (inPositioner) return listbox

  return (
    <FloatingPositioner
      open={open}
      scope={selectAnatomy.scope}
      part={selectAnatomy.positioner}
      triggerRef={triggerRef}
      positionerRef={positionerRef}
      portalled={portalled}
      matchAnchorWidth
    >
      {listbox}
    </FloatingPositioner>
  )
})

export interface SelectItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
  disabled?: boolean
}

const Item = forwardRef<HTMLButtonElement, SelectItemProps>(function SelectItem(
  { value, disabled = false, children, onClick, ...rest },
  ref,
) {
  const { value: selected, listboxId, highlightedValue, selectValue } = useSelectCtx()
  const selectedState = value === selected
  const highlighted = value === highlightedValue

  return (
    <button
      ref={ref}
      type="button"
      role="option"
      id={`${listboxId}-option-${value}`}
      aria-selected={selectedState}
      disabled={disabled}
      {...partAttrs(selectAnatomy.scope, selectAnatomy.item, {
        state: selectedState ? 'selected' : highlighted ? 'highlighted' : 'idle',
        highlighted,
      })}
      {...mergeProps(rest, {
        onClick: (e: MouseEvent<HTMLButtonElement>) => {
          onClick?.(e)
          if (!e.defaultPrevented && !disabled) selectValue(value)
        },
      })}
    >
      {children}
    </button>
  )
})

export const Select = {
  Root,
  Trigger,
  ValueText,
  Positioner,
  Content,
  Item,
}
