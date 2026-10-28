import { Button } from '@aeon-ui/react'
import {
  FIAT_OPTIONS,
  getFiatCurrency,
  setFiatCurrency,
  type FiatCode,
} from '../wallet/fiatCurrency'
import { getCachedFiatPerBsv, refreshUsdPerBsv } from '../wallet/fx'
import { playWalletSound } from '../wallet/soundService'
import { useFiatCurrency } from '../hooks/useFiatCurrency'

export function OnboardFiatPanel({ onDone }: { onDone: () => void }) {
  const fiat = useFiatCurrency()

  const pick = (code: FiatCode) => {
    if (code === getFiatCurrency()) return
    playWalletSound('soft')
    setFiatCurrency(code)
    if (getCachedFiatPerBsv(code) == null) void refreshUsdPerBsv(true)
  }

  return (
    <div
      className="wallet-setup-config"
      data-aeon-scope="onboard-fiat"
      data-aeon-state={fiat}
    >
      <h2>Show balances in</h2>
      <p className="auth-lede">
        Government currency for totals on the home screen. You can change this anytime from
        Activity.
      </p>

      <div
        className="onboard-fiat-options"
        role="listbox"
        aria-label="Government currency"
        data-aeon-part="fiat"
      >
        {FIAT_OPTIONS.map((o) => (
          <button
            key={o.code}
            type="button"
            role="option"
            className="onboard-fiat-option"
            aria-selected={o.code === fiat}
            aria-label={`${o.iso} — ${o.name}`}
            data-aeon-state={o.code === fiat ? 'selected' : 'idle'}
            onClick={() => pick(o.code)}
          >
            <span className="onboard-fiat-flag" aria-hidden>
              {o.flag}
            </span>
            <span className="onboard-fiat-iso">{o.iso}</span>
          </button>
        ))}
      </div>

      <div className="auth-actions" style={{ marginTop: 16 }} data-aeon-part="onboard-fiat-actions">
        <Button.Root variant="solid" className="btn btn-primary auth-submit" onClick={onDone}>
          <Button.Label>Continue</Button.Label>
        </Button.Root>
      </div>
    </div>
  )
}
