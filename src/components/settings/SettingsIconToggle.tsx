import type { ReactNode } from 'react'

export type SettingsIconToggleOption<T extends string> = {
  value: T
  label: string
  icon: ReactNode
}

type Props<T extends string> = {
  value: T
  options: SettingsIconToggleOption<T>[]
  onChange: (next: T) => void
  ariaLabel: string
}

/** Segmented icon pill — same control as items-market ProfileSheet theme toggle. */
export function SettingsIconToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: Props<T>) {
  return (
    <div className="settings-icon-toggle" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            className="settings-icon-toggle-btn"
            aria-checked={selected}
            aria-label={opt.label}
            title={opt.label}
            data-selected={selected ? '' : undefined}
            onClick={() => {
              if (!selected) onChange(opt.value)
            }}
          >
            {opt.icon}
          </button>
        )
      })}
    </div>
  )
}
