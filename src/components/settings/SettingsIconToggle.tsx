import { RadioGroup } from '@aeon-ui/react'
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
    <RadioGroup.Root
      className="settings-icon-toggle"
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as T)
      }}
    >
      {options.map((opt) => (
        <RadioGroup.Item key={opt.value} value={opt.value} className="settings-icon-toggle-item">
          <RadioGroup.ItemControl
            className="settings-icon-toggle-btn"
            aria-label={opt.label}
            title={opt.label}
            data-selected={opt.value === value ? '' : undefined}
          >
            {opt.icon}
          </RadioGroup.ItemControl>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
