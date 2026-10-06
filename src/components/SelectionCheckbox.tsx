import { useEffect, useRef } from 'react'

/** Collect's select box: on a card, a row, or a whole shelf (`mixed` when part of it is chosen). */
export function SelectionCheckbox({
  checked,
  mixed = false,
  disabled = false,
  label,
  onChange,
  className = '',
}: {
  checked: boolean
  mixed?: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <label
      className={`collect-select ${className}`.trim()}
      title={label}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden />
    </label>
  )
}
