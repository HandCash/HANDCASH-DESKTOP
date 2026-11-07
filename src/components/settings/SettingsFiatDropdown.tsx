import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState } from 'react'
import { useFiatCurrency } from '../../hooks/useFiatCurrency'
import { fiatCurrencyMenuMachine } from '../../machines/fiatCurrencyMenuMachine'
import { FIAT_OPTIONS, getFiatOption, setFiatCurrency, type FiatCode } from '../../wallet/fiatCurrency'
import { getCachedFiatPerBsv, refreshUsdPerBsv } from '../../wallet/fx'
import { playWalletSound } from '../../wallet/soundService'
import { CheckIcon, ExpandMoreIcon } from '../icons'

/**
 * Fiat currency picker for Settings. Same component chrome as the account
 * dropdown (WalletAccountMenu): trigger, `wallet-account-dropdown` panel,
 * heading, listbox, option rows with a check on the selected one.
 */
export function SettingsFiatDropdown() {
  const fiat = useFiatCurrency()
  const [menuMachine] = useState(() =>
    fiatCurrencyMenuMachine.provide({
      actions: {
        applyChoice: ({ event }) => {
          if (event.type !== 'CHOOSE') return
          const code = event.code as FiatCode
          setFiatCurrency(code)
          if (getCachedFiatPerBsv(code) == null) void refreshUsdPerBsv(true)
        },
      },
    }),
  )
  const [snapshot, send] = useMachine(menuMachine)
  const rootRef = useRef<HTMLDivElement>(null)
  const open = snapshot.matches('open')
  const current = getFiatOption(fiat)

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
      className="wallet-account-menu settings-fiat-menu"
      data-aeon-scope="wallet-account-menu"
      data-aeon-state={stateToAttr(snapshot.value)}
      ref={rootRef}
    >
      <button
        type="button"
        className="wallet-hero-identity settings-fiat-trigger"
        data-aeon-part="trigger"
        aria-controls="settings-fiat-dropdown"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Currency: ${current.iso}`}
        onClick={() => {
          playWalletSound('soft')
          send({ type: 'TOGGLE' })
        }}
      >
        <span className="settings-fiat-flag" aria-hidden>
          {current.flag}
        </span>
        <span>{current.iso}</span>
        <ExpandMoreIcon size={16} className={open ? 'wallet-account-caret is-open' : 'wallet-account-caret'} />
      </button>

      {open ? (
        <section
          id="settings-fiat-dropdown"
          className="wallet-account-dropdown settings-fiat-dropdown"
          data-aeon-part="content"
          aria-label="Choose currency"
        >
          <header className="wallet-account-heading">
            <div>
              <strong>Choose currency</strong>
            </div>
            <span className="wallet-account-count">{FIAT_OPTIONS.length}</span>
          </header>

          <ul className="wallet-account-list" role="listbox" aria-label="Government currency">
            {FIAT_OPTIONS.map((o) => {
              const selected = o.code === fiat
              return (
                <li key={o.code} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? 'wallet-account-option is-selected' : 'wallet-account-option'}
                    onClick={() => {
                      playWalletSound('soft')
                      send({ type: 'CHOOSE', code: o.code })
                    }}
                  >
                    <span className="wallet-account-option-lead">
                      <span className="settings-fiat-flag" aria-hidden>
                        {o.flag}
                      </span>
                      <span className="wallet-account-option-copy">
                        <strong>{o.iso}</strong>
                        <span>{o.name}</span>
                      </span>
                    </span>
                    {selected ? <CheckIcon size={17} className="wallet-account-option-check" /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
