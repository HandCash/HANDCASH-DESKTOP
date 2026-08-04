import { comboboxAnatomy, partAttrs, partOnlyAttrs } from '@aeon-ui/core'
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
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type FocusEvent,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useAeonMachine } from '../hooks/use-aeon-machine.js'
import { mergeProps } from '../utils/merge-props.js'

interface RegisteredItem {
  value: string
  label: string
}

interface ComboboxContextValue {
  value: string
  open: boolean
  query: string
  listboxId: string
  highlightedValue: string | null
  itemsVersion: number
  setOpen: (open: boolean) => void
  setQuery: (query: string) => void
  setHighlightedValue: (value: string | null) => void
  onValueChange?: (value: string) => void
  registerItem: (item: RegisteredItem) => void
  unregisterItem: (value: string) => void
  getItems: () => RegisteredItem[]
}

const ComboboxCtx = createContext<ComboboxContextValue | null>(null)

function useComboboxCtx() {
  const ctx = useContext(ComboboxCtx)
  if (!ctx) throw new Error('Combobox parts must be used within <Combobox.Root>')
  return ctx
}

function normalizeLabel(label: string | undefined, children: ReactNode): string {
  if (label) return label
  if (typeof children === 'string') return children
  return ''
}

function matchesQuery(label: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return label.toLowerCase().includes(q)
}

export interface ComboboxRootProps {
  value: string
  onValueChange?: (value: string) => void
  children: ReactNode
  className?: string
  disabled?: boolean
}

const Root = forwardRef<HTMLDivElement, ComboboxRootProps>(function ComboboxRoot(
  { value, onValueChange, children, className, disabled },
  ref,
) {
  const [snapshot, send] = useAeonMachine(popoverMachine, { input: { open: false } })
  const [query, setQuery] = useState('')
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null)
  const [itemsVersion, setItemsVersion] = useState(0)
  const itemsRef = useRef<RegisteredItem[]>([])
  const listboxId = useId()

  const open = disabled ? false : snapshot.matches('open')

  const setOpen = useCallback(
    (next: boolean) => {
      if (disabled) return
      if (next) {
        send({ type: 'OPEN' })
        return
      }
      send({ type: 'CLOSE' })
      setQuery('')
      setHighlightedValue(null)
    },
    [disabled, send],
  )

  const registerItem = useCallback((item: RegisteredItem) => {
    itemsRef.current = [...itemsRef.current.filter((i) => i.value !== item.value), item]
    setItemsVersion((v) => v + 1)
  }, [])

  const unregisterItem = useCallback((valueKey: string) => {
    itemsRef.current = itemsRef.current.filter((i) => i.value !== valueKey)
    setItemsVersion((v) => v + 1)
  }, [])

  const getItems = useCallback(() => itemsRef.current, [])

  const ctx = useMemo(
    () => ({
      value,
      open,
      query,
      listboxId,
      highlightedValue,
      itemsVersion,
      setOpen,
      setQuery,
      setHighlightedValue,
      onValueChange,
      registerItem,
      unregisterItem,
      getItems,
    }),
    [
      value,
      open,
      query,
      listboxId,
      highlightedValue,
      itemsVersion,
      setOpen,
      onValueChange,
      registerItem,
      unregisterItem,
      getItems,
    ],
  )

  return (
    <ComboboxCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...partAttrs(comboboxAnatomy.scope, comboboxAnatomy.root, {
          state: open ? 'open' : 'closed',
        })}
      >
        {children}
      </div>
    </ComboboxCtx.Provider>
  )
})

function useVisibleItems() {
  const { query, getItems, itemsVersion } = useComboboxCtx()
  return useMemo(() => {
    void itemsVersion
    return getItems().filter((i) => matchesQuery(i.label, query))
  }, [query, getItems, itemsVersion])
}

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function ComboboxInput(
  { onChange, onKeyDown, onFocus, onClick, value: valueProp, ...rest },
  ref,
) {
  const {
    value: selected,
    open,
    query,
    listboxId,
    highlightedValue,
    itemsVersion,
    setOpen,
    setQuery,
    setHighlightedValue,
    onValueChange,
    getItems,
  } = useComboboxCtx()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const visible = useVisibleItems()

  const selectedLabel = useMemo(() => {
    void itemsVersion
    return getItems().find((i) => i.value === selected)?.label ?? ''
  }, [getItems, selected, itemsVersion])

  const displayValue = open ? query : selectedLabel

  const selectValue = useCallback(
    (next: string) => {
      onValueChange?.(next)
      setOpen(false)
      setQuery('')
      setHighlightedValue(null)
    },
    [onValueChange, setOpen, setQuery, setHighlightedValue],
  )

  const moveHighlight = useCallback(
    (delta: number) => {
      if (visible.length === 0) {
        setHighlightedValue(null)
        return
      }
      const idx = highlightedValue
        ? visible.findIndex((i) => i.value === highlightedValue)
        : -1
      let next = idx + delta
      if (next < 0) next = visible.length - 1
      if (next >= visible.length) next = 0
      setHighlightedValue(visible[next]!.value)
    },
    [visible, highlightedValue, setHighlightedValue],
  )

  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const root = inputRef.current?.closest('[data-aeon-scope="combobox"]')
      if (root && !root.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  const activeDescendant =
    highlightedValue && open
      ? `${listboxId}-option-${highlightedValue}`
      : undefined

  return (
    <>
      <input
        ref={setRefs}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        autoComplete="off"
        value={valueProp ?? displayValue}
        {...partAttrs(comboboxAnatomy.scope, comboboxAnatomy.input, { state: open ? 'open' : 'closed' })}
        {...mergeProps(rest, {
          onFocus: (e: FocusEvent<HTMLInputElement>) => {
            onFocus?.(e)
            setOpen(true)
          },
          onClick: (e: MouseEvent<HTMLInputElement>) => {
            onClick?.(e)
            setOpen(true)
          },
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            onChange?.(e)
            if (!e.defaultPrevented) {
              setOpen(true)
              setQuery(e.target.value)
              setHighlightedValue(null)
            }
          },
          onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
            onKeyDown?.(e)
            if (e.defaultPrevented) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (!open) setOpen(true)
              else moveHighlight(1)
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) setOpen(true)
              else moveHighlight(-1)
            }
            if (e.key === 'Home' && open) {
              e.preventDefault()
              if (visible[0]) setHighlightedValue(visible[0].value)
            }
            if (e.key === 'End' && open) {
              e.preventDefault()
              if (visible[visible.length - 1]) setHighlightedValue(visible[visible.length - 1]!.value)
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const pick = highlightedValue ?? visible[0]?.value
              if (pick) selectValue(pick)
            }
            if (e.key === 'Escape') setOpen(false)
          },
        })}
      />
      <span
        {...partOnlyAttrs(comboboxAnatomy.icon, { state: open ? 'open' : 'closed' })}
        aria-hidden
        style={
          open
            ? { transform: 'rotate(-135deg) translateY(2px)' }
            : undefined
        }
      />
    </>
  )
})

const Content = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ComboboxContent(
  { children, className, ...rest },
  ref,
) {
  const { open, listboxId } = useComboboxCtx()
  if (!open) return null

  return (
    <div
      ref={ref}
      id={listboxId}
      role="listbox"
      className={className}
      data-aeon-scroll=""
      {...partAttrs(comboboxAnatomy.scope, comboboxAnatomy.content)}
      {...rest}
    >
      {children}
    </div>
  )
})

export interface ComboboxItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
  /** Used for typeahead filter when children are not plain text. */
  textValue?: string
}

const Item = forwardRef<HTMLButtonElement, ComboboxItemProps>(function ComboboxItem(
  { value, textValue, children, onClick, ...rest },
  ref,
) {
  const {
    value: selected,
    query,
    highlightedValue,
    listboxId,
    onValueChange,
    setOpen,
    setHighlightedValue,
    registerItem,
    unregisterItem,
  } = useComboboxCtx()
  const label = normalizeLabel(textValue, children)
  const resolvedOptionId = `${listboxId}-option-${value}`

  useEffect(() => {
    registerItem({ value, label })
    return () => unregisterItem(value)
  }, [value, label, registerItem, unregisterItem])

  if (!matchesQuery(label, query)) return null

  const selectedState = value === selected
  const highlighted = value === highlightedValue

  return (
    <button
      ref={ref}
      type="button"
      role="option"
      id={resolvedOptionId}
      aria-selected={selectedState}
      data-highlighted={highlighted ? '' : undefined}
      {...partAttrs(comboboxAnatomy.scope, comboboxAnatomy.item, {
        state: selectedState ? 'selected' : 'idle',
        highlighted,
      })}
      {...mergeProps(rest, {
        onClick: (e: MouseEvent<HTMLButtonElement>) => {
          onClick?.(e)
          if (!e.defaultPrevented) {
            onValueChange?.(value)
            setOpen(false)
          }
        },
        onMouseEnter: () => setHighlightedValue(value),
      })}
    >
      {children}
    </button>
  )
})

const Empty = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ComboboxEmpty(
  { children, className, ...rest },
  ref,
) {
  const { open, query } = useComboboxCtx()
  const visible = useVisibleItems()
  if (!open || !query.trim() || visible.length > 0) return null

  return (
    <div
      ref={ref}
      className={className}
      {...partAttrs(comboboxAnatomy.scope, comboboxAnatomy.empty)}
      {...rest}
    >
      {children ?? 'No results'}
    </div>
  )
})

export const Combobox = {
  Root,
  Input,
  Content,
  Item,
  Empty,
}
