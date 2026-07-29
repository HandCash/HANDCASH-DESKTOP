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

function Chip({
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
      className={active ? 'payment-filter-chip is-active' : 'payment-filter-chip'}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
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
      <div className="payment-filter-carousel" role="toolbar" aria-label="Activity filters">
        <div className="payment-filter-segment" role="group" aria-label="Type">
          {KIND_OPTIONS.map((opt) => (
            <Chip
              key={`kind-${opt.id}`}
              label={opt.label}
              active={value.kind === opt.id}
              onClick={() => onChange({ ...value, kind: opt.id })}
            />
          ))}
        </div>

        <span className="payment-filter-sep" aria-hidden />

        <div className="payment-filter-segment" role="group" aria-label="App">
          {origins.map((opt) => (
            <Chip
              key={`origin-${opt.id}`}
              label={originLabel(opt)}
              active={value.origin === opt.id}
              title={opt.id === 'all' || opt.id === WALLET_ACTIVITY_ORIGIN ? undefined : opt.id}
              onClick={() => onChange({ ...value, origin: opt.id })}
            />
          ))}
        </div>

        <span className="payment-filter-sep" aria-hidden />

        <div className="payment-filter-segment" role="group" aria-label="Time">
          {TIME_OPTIONS.map((opt) => (
            <Chip
              key={`time-${opt.id}`}
              label={opt.label}
              active={value.time === opt.id}
              onClick={() => onChange({ ...value, time: opt.id })}
            />
          ))}
        </div>
      </div>
    </aside>
  )
}
