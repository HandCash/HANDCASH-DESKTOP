import type { ReactNode } from 'react'
import { appDisplayName } from '../wallet/appIdentity'
import { WALLET_ACTIVITY_ORIGIN } from '../wallet/appActivity'
import type {
  PaymentFilters,
  PaymentKindFilter,
  PaymentOriginOption,
  PaymentTimeFilter,
} from '../wallet/paymentFilters'

type Props = {
  id?: string
  value: PaymentFilters
  origins: PaymentOriginOption[]
  onChange: (next: PaymentFilters) => void
}

const KIND_OPTIONS: { id: PaymentKindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'spent', label: 'Sent' },
  { id: 'earned', label: 'Received' },
  { id: 'event', label: 'Actions' },
]

const TIME_OPTIONS: { id: PaymentTimeFilter; label: string }[] = [
  { id: 'all', label: 'Any time' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
]

function originLabel(opt: PaymentOriginOption): string {
  if (opt.id === 'all' || opt.id === WALLET_ACTIVITY_ORIGIN) return opt.label
  return opt.label?.trim() || appDisplayName(opt.id)
}

function FilterOption({
  label,
  active,
  title,
  onClick,
}: {
  label: string
  active: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={active ? 'payment-filter-option is-active' : 'payment-filter-option'}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function FilterRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="payment-filter-row">
      <span className="payment-filter-row-label">{label}</span>
      <div className="payment-filter-options" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

export function PaymentFiltersPanel({ id, value, origins, onChange }: Props) {
  return (
    <aside
      id={id}
      className="payment-filters"
      data-aeon-scope="payment-filters"
      aria-label="Activity filters"
    >
      <FilterRow label="Type">
        {KIND_OPTIONS.map((opt) => (
          <FilterOption
            key={`kind-${opt.id}`}
            label={opt.label}
            active={value.kind === opt.id}
            onClick={() => onChange({ ...value, kind: opt.id })}
          />
        ))}
      </FilterRow>

      <FilterRow label="App">
        {origins.map((opt) => (
          <FilterOption
            key={`origin-${opt.id}`}
            label={originLabel(opt)}
            active={value.origin === opt.id}
            title={opt.id === 'all' || opt.id === WALLET_ACTIVITY_ORIGIN ? undefined : opt.id}
            onClick={() => onChange({ ...value, origin: opt.id })}
          />
        ))}
      </FilterRow>

      <FilterRow label="When">
        {TIME_OPTIONS.map((opt) => (
          <FilterOption
            key={`time-${opt.id}`}
            label={opt.label}
            active={value.time === opt.id}
            onClick={() => onChange({ ...value, time: opt.id })}
          />
        ))}
      </FilterRow>
    </aside>
  )
}
