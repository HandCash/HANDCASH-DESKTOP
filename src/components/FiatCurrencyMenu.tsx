import { ExpandMoreIcon } from './icons'
import { playWalletSound } from '../wallet/soundService'
import { getFiatOption } from '../wallet/fiatCurrency'
import { useFiatCurrency } from '../hooks/useFiatCurrency'
import { openFiatCurrency } from '../wallet/navStore'

/**
 * Balance chrome: total in the preferred government currency.
 * Opens Activity / Currency — not an in-pill ticker or coin list.
 */
export function FiatCurrencyMenu({
  amountLabel,
  pending,
}: {
  amountLabel: string
  pending?: boolean
}) {
  const fiat = useFiatCurrency()
  const option = getFiatOption(fiat)

  return (
    <div
      className="wallet-nav-actions-pill wallet-hero-metric fiat-currency-menu"
      data-aeon-scope="fiat-currency"
      data-aeon-state="closed"
    >
      <button
        type="button"
        className="fiat-currency-trigger"
        data-aeon-part="trigger"
        aria-haspopup="dialog"
        title="Choose display currency"
        aria-label={`${pending ? 'Loading' : amountLabel} ${option.iso} · Choose display currency`}
        onClick={() => {
          playWalletSound('soft')
          openFiatCurrency()
        }}
      >
        <span className="wallet-hero-metric-amount" aria-busy={pending || undefined}>
          {pending ? '—' : amountLabel}
        </span>
        <ExpandMoreIcon size={16} className="wallet-account-caret" />
      </button>
    </div>
  )
}
