import { ExpandMoreIcon } from './icons'
import { playWalletSound } from '../wallet/soundService'
import { getFiatOption } from '../wallet/fiatCurrency'
import { useFiatCurrency } from '../hooks/useFiatCurrency'
import { openFiatCurrency } from '../wallet/navStore'

/**
 * Balance chrome: total in the preferred government currency.
 * Opens Activity / Currency — not an in-pill ticker or coin list.
 * Compact/mobile uses "~" when the label needs to squish.
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
        onClick={() => {
          playWalletSound('soft')
          openFiatCurrency()
        }}
      >
        <h2 className="wallet-hero-title" aria-label="Balance">
          <span className="wallet-hero-title-full">Balance</span>
          <span className="wallet-hero-title-approx" aria-hidden="true">
            ~
          </span>
        </h2>
        <span className="wallet-hero-metric-amount" aria-busy={pending || undefined}>
          {pending ? '—' : amountLabel}
        </span>
        <span className="fiat-currency-flag" aria-hidden>
          {option.flag}
        </span>
        <ExpandMoreIcon size={16} className="wallet-account-caret" />
      </button>
    </div>
  )
}
