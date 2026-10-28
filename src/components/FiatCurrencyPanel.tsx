import { stateToAttr } from '@aeon-ui/core'
import { playWalletSound } from '../wallet/soundService'
import {
  FIAT_OPTIONS,
  setFiatCurrency,
  type FiatCode,
} from '../wallet/fiatCurrency'
import { useFiatCurrency } from '../hooks/useFiatCurrency'
import { getCachedFiatPerBsv, refreshUsdPerBsv } from '../wallet/fx'
import { clearNavChild } from '../wallet/navStore'

/**
 * Full-stage government-currency picker (Activity / Currency).
 * Same list as the hero trigger; picking one returns to Activity.
 */
export function FiatCurrencyPanel() {
  const fiat = useFiatCurrency()

  const pick = (code: FiatCode) => {
    playWalletSound('soft')
    setFiatCurrency(code)
    if (getCachedFiatPerBsv(code) == null) void refreshUsdPerBsv(true)
    clearNavChild()
  }

  return (
    <div
      className="panel fiat-currency-panel"
      data-aeon-scope="fiat-currency"
      data-aeon-state={stateToAttr('open')}
    >
      <ul
        className="fiat-currency-panel-list"
        data-aeon-part="list"
        role="listbox"
        aria-label="Government currency"
      >
        {FIAT_OPTIONS.map((o) => (
          <li key={o.code} role="none">
            <button
              type="button"
              role="option"
              className="fiat-currency-option"
              aria-selected={o.code === fiat}
              data-aeon-state={o.code === fiat ? 'selected' : 'idle'}
              onClick={() => pick(o.code)}
            >
              <span className="fiat-currency-option-flag" aria-hidden>
                {o.flag}
              </span>
              <span className="fiat-currency-option-copy">
                <strong>{o.iso}</strong>
                <span>{o.name}</span>
              </span>
              {o.code === fiat ? (
                <span className="fiat-currency-option-check" aria-hidden>
                  ✓
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
