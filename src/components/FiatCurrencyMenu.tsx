import { useEffect, useRef, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { ExpandMoreIcon } from './icons'
import { playWalletSound } from '../wallet/soundService'
import {
  FIAT_OPTIONS,
  getFiatOption,
  setFiatCurrency,
  type FiatCode,
} from '../wallet/fiatCurrency'
import { useFiatCurrency } from '../hooks/useFiatCurrency'
import { getCachedFiatPerBsv, refreshUsdPerBsv } from '../wallet/fx'

/**
 * Your-balance chrome: total in the preferred government currency, with a
 * flag dropdown to switch USD / EUR / GBP / JPY / …
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
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** Suppress the trigger click that can retarget after an option unmounts. */
  const suppressTriggerClick = useRef(false)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (code: FiatCode) => {
    suppressTriggerClick.current = true
    playWalletSound('soft')
    setFiatCurrency(code)
    setOpen(false)
    if (getCachedFiatPerBsv(code) == null) void refreshUsdPerBsv(true)
  }

  return (
    <div
      ref={rootRef}
      className="wallet-nav-actions-pill wallet-hero-metric fiat-currency-menu"
      data-aeon-scope="fiat-currency"
      data-aeon-state={stateToAttr(open ? 'open' : 'closed')}
    >
      <button
        type="button"
        className="fiat-currency-trigger"
        data-aeon-part="trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="fiat-currency-list"
        title="Choose display currency"
        onClick={() => {
          if (suppressTriggerClick.current) {
            suppressTriggerClick.current = false
            return
          }
          playWalletSound('soft')
          setOpen((v) => !v)
        }}
      >
        <h2 className="wallet-hero-title">Your balance</h2>
        <span className="wallet-hero-metric-amount" aria-busy={pending || undefined}>
          {pending ? '—' : amountLabel}
        </span>
        <span className="fiat-currency-flag" aria-hidden>
          {option.flag}
        </span>
        <ExpandMoreIcon
          size={16}
          className={open ? 'wallet-account-caret is-open' : 'wallet-account-caret'}
        />
      </button>

      {open ? (
        <ul
          id="fiat-currency-list"
          className="fiat-currency-dropdown"
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
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  pick(o.code)
                }}
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
      ) : null}
    </div>
  )
}
