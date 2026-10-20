import { useRef, type InputHTMLAttributes } from 'react'
import { CloseIcon, SearchIcon } from './icons'
import { searchKeyAction } from './searchKeyAction'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'id'> & {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
}

/** The wallet's one search field: a mark, the input, and a clear button once there is text. */
export function SearchField({ id, label, value, onValueChange, onKeyDown, disabled, ...input }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const clear = () => {
    onValueChange('')
    inputRef.current?.focus()
  }

  return (
    <div
      className="search-field"
      data-aeon-scope="search-field"
      data-aeon-state={value ? 'filled' : 'empty'}
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <SearchIcon size={16} data-aeon-part="mark" />
      <input
        autoComplete="off"
        spellCheck={false}
        {...input}
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.defaultPrevented) return
          const action = searchKeyAction(e.key, value)
          if (action === 'clear') {
            e.preventDefault()
            e.stopPropagation()
            onValueChange('')
          } else if (action === 'leave') {
            e.currentTarget.blur()
          }
        }}
      />
      {value ? (
        <button
          type="button"
          data-aeon-part="clear"
          aria-label="Clear search"
          title="Clear search"
          disabled={disabled}
          onClick={clear}
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
    </div>
  )
}
