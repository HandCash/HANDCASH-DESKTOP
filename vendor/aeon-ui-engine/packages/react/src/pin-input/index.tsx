import { partAttrs, partOnlyAttrs, pinInputAnatomy } from '@aeon-ui/core'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { mergeProps } from '../utils/merge-props.js'

interface PinInputContextValue {
  length: number
  values: string[]
  disabled: boolean
  type: 'numeric' | 'alphanumeric'
  setChar: (index: number, char: string) => void
  focusInput: (index: number) => void
  registerInput: (index: number, el: HTMLInputElement | null) => void
}

const PinInputCtx = createContext<PinInputContextValue | null>(null)

function usePinInputCtx() {
  const ctx = useContext(PinInputCtx)
  if (!ctx) throw new Error('PinInput parts must be used within PinInput.Root')
  return ctx
}

function normalizePinValue(raw: string, length: number) {
  return raw.replace(/\s/g, '').slice(0, length).split('')
}

export interface PinInputRootProps {
  length?: number
  value?: string
  defaultValue?: string
  disabled?: boolean
  onValueChange?: (value: string) => void
  onComplete?: (value: string) => void
  type?: 'numeric' | 'alphanumeric'
  children?: ReactNode
  className?: string
}

const Root = forwardRef<HTMLDivElement, PinInputRootProps>(function PinInputRoot(
  {
    length = 4,
    value,
    defaultValue = '',
    disabled = false,
    onValueChange,
    onComplete,
    type = 'numeric',
    children,
    className,
    ...rest
  },
  ref,
) {
  const [uncontrolled, setUncontrolled] = useState(() => normalizePinValue(defaultValue, length))
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])
  const controlled = value !== undefined
  const chars = controlled ? normalizePinValue(value, length) : uncontrolled
  while (chars.length < length) chars.push('')

  const resolved = chars.slice(0, length).join('')

  useEffect(() => {
    onValueChange?.(resolved)
    if (resolved.length === length && !resolved.includes('')) onComplete?.(resolved)
  }, [resolved, length, onValueChange, onComplete])

  const setChars = useCallback(
    (next: string[]) => {
      const joined = next.slice(0, length).join('')
      if (!controlled) setUncontrolled(next.slice(0, length))
      onValueChange?.(joined)
      if (joined.length === length && !joined.includes('')) onComplete?.(joined)
    },
    [controlled, length, onValueChange, onComplete],
  )

  const setChar = useCallback(
    (index: number, char: string) => {
      const next = [...chars.slice(0, length)]
      while (next.length < length) next.push('')
      next[index] = char
      setChars(next)
    },
    [chars, length, setChars],
  )

  const focusInput = useCallback((index: number) => {
    const el = inputRefs.current[index]
    el?.focus()
    el?.select()
  }, [])

  const registerInput = useCallback((index: number, el: HTMLInputElement | null) => {
    inputRefs.current[index] = el
  }, [])

  const ctx = useMemo(
    () => ({ length, values: chars.slice(0, length), disabled, type, setChar, focusInput, registerInput }),
    [length, chars, disabled, type, setChar, focusInput, registerInput],
  )

  return (
    <PinInputCtx.Provider value={ctx}>
      <div
        ref={ref}
        className={className}
        {...mergeProps(
          partAttrs(pinInputAnatomy.scope, pinInputAnatomy.root, {
            state: resolved.length === length && !resolved.includes('') ? 'complete' : 'idle',
            disabled,
          }),
          rest as HTMLAttributes<HTMLDivElement>,
        )}
      >
        {children}
      </div>
    </PinInputCtx.Provider>
  )
})

export interface PinInputInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  index: number
  onChange?: InputHTMLAttributes<HTMLInputElement>['onChange']
}

const Input = forwardRef<HTMLInputElement, PinInputInputProps>(function PinInputInput(
  { index, onKeyDown, onChange, onPaste, ...rest },
  ref,
) {
  const { length, values, disabled, type, setChar, focusInput, registerInput } = usePinInputCtx()
  const value = values[index] ?? ''
  const pattern = type === 'numeric' ? /^[0-9]$/ : /^[0-9a-zA-Z]$/

  const acceptChar = (raw: string) => {
    if (!raw) return ''
    const char = raw.slice(-1)
    return pattern.test(char) ? char : ''
  }

  return (
    <input
      ref={(node) => {
        registerInput(index, node)
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      type="text"
      inputMode={type === 'numeric' ? 'numeric' : 'text'}
      autoComplete={rest.autoComplete ?? 'one-time-code'}
      maxLength={1}
      value={value}
      disabled={disabled}
      aria-label={`Character ${index + 1} of ${length}`}
      {...mergeProps(partOnlyAttrs(pinInputAnatomy.input, { state: value ? 'filled' : 'empty' }), rest, {
        onChange: (e: ChangeEvent<HTMLInputElement>) => {
          onChange?.(e)
          const char = acceptChar(e.target.value)
          setChar(index, char)
          if (char && index < length - 1) focusInput(index + 1)
        },
        onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
          onKeyDown?.(e)
          if (e.key === 'Backspace' && !value && index > 0) {
            e.preventDefault()
            setChar(index - 1, '')
            focusInput(index - 1)
          }
          if (e.key === 'ArrowLeft' && index > 0) {
            e.preventDefault()
            focusInput(index - 1)
          }
          if (e.key === 'ArrowRight' && index < length - 1) {
            e.preventDefault()
            focusInput(index + 1)
          }
        },
        onPaste: (e: ClipboardEvent<HTMLInputElement>) => {
          onPaste?.(e)
          e.preventDefault()
          const text = e.clipboardData.getData('text').replace(/\s/g, '').slice(0, length - index)
          if (!text) return
          for (let i = 0; i < text.length && index + i < length; i++) {
            const char = acceptChar(text[i]!)
            if (char) setChar(index + i, char)
          }
          focusInput(Math.min(index + text.length, length - 1))
        },
      })}
    />
  )
})

/** Convenience row — renders `length` inputs. */
const Group = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { inputClassName?: string }>(
  function PinInputGroup({ inputClassName, className, ...rest }, ref) {
    const { length } = usePinInputCtx()
    return (
      <div ref={ref} className={className} {...rest}>
        {Array.from({ length }, (_, index) => (
          <Input key={index} index={index} className={inputClassName} />
        ))}
      </div>
    )
  },
)

export const PinInput = { Root, Input, Group }
