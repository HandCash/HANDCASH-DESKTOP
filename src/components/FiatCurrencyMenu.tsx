import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useEffect, useRef } from 'react'
import { CheckIcon, ExpandMoreIcon } from './icons'
import { fiatCurrencyMenuMachine } from '../machines/fiatCurrencyMenuMachine'
import { playWalletSound } from '../wallet/soundService'
import { FIAT_OPTIONS, getFiatOption, setFiatCurrency, type FiatCode } from '../wallet/fiatCurrency'
import { useFiatCurrency } from '../hooks/useFiatCurrency'

const menuMachine = fiatCurrencyMenuMachine.provide({
  actions: {
    applyChoice: ({ event }) => {
      if (event.type === 'CHOOSE') setFiatCurrency(event.code as FiatCode)
    },
  },
})

/**
 * Balance chrome: total in the preferred government currency, with the
 * selected currency's flag. Opens the same style of dropdown as the wallet menu.
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
  const [snapshot, send] = useMachine(menuMachine)
  const rootRef = useRef<HTMLDivElement>(null)
  const open = snapshot.matches('open')

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        send({ type: 'CLOSE' })
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') send({ type: 'CLOSE' })
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, send])

  return (
    <div
      className="wallet-nav-actions-pill wallet-hero-metric fiat-currency-menu"
      data-aeon-scope="fiat-currency"
      data-aeon-state={stateToAttr(snapshot.value)}
      ref={rootRef}
    >
      <button
        type="button"
        className="fiat-currency-trigger"
        data-aeon-part="trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="fiat-currency-dropdown"
        title="Choose display currency"
        aria-label={`${pending ? 'Loading' : amountLabel} ${option.iso} · Choose display currency`}
        onClick={() => {
          playWalletSound('soft')
          send({ type: 'TOGGLE' })
        }}
      >
        <span className="fiat-currency-flag" aria-hidden="true">
          {option.flag}
        </span>
        <span className="wallet-hero-metric-amount" aria-busy={pending || undefined}>
          {pending ? '—' : amountLabel}
        </span>
        <ExpandMoreIcon
          size={16}
          className={open ? 'wallet-account-caret is-open' : 'wallet-account-caret'}
        />
      </button>

      {open ? (
        <section
          id="fiat-currency-dropdown"
          className="wallet-account-dropdown fiat-currency-menu-dropdown"
          data-aeon-part="content"
          aria-label="Choose currency"
        >
          <header className="wallet-account-heading">
            <div>
              <strong>Choose currency</strong>
            </div>
            <span className="wallet-account-count">{FIAT_OPTIONS.length}</span>
          </header>
          <ul className="wallet-account-list" role="listbox" aria-label="Currencies">
            {FIAT_OPTIONS.map((o) => {
              const selected = o.code === fiat
              return (
                <li key={o.code}>
                  <div className="wallet-account-row">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={
                        selected ? 'wallet-account-option is-selected' : 'wallet-account-option'
                      }
                      onClick={() => {
                        playWalletSound('soft')
                        send({ type: 'CHOOSE', code: o.code })
                      }}
                    >
                      <span className="wallet-account-option-lead">
                        <span className="fiat-currency-option-flag" aria-hidden="true">
                          {o.flag}
                        </span>
                        <span className="wallet-account-option-copy">
                          <strong>{o.iso}</strong>
                          <span>{o.name}</span>
                        </span>
                      </span>
                      {selected ? (
                        <CheckIcon size={17} className="wallet-account-option-check" />
                      ) : null}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
