import { Button } from '@aeon-ui/react'
import { useEffect, useState } from 'react'
import {
  ACCEPTED_COINS_CHOICES,
  DEFAULT_ACCEPTED_COINS,
  setAcceptedCoins,
  type AcceptedCoins,
} from '../wallet/acceptedCoins'
import { STABLE_MARKET_COINS, type MarketCoin } from '../wallet/bsvMarket'
import { COIN_CHAINS } from '../wallet/coins/coinChains'
import { playWalletSound } from '../wallet/soundService'
import { TickerCoinMark } from './TickerCoinSelector'

export const ONBOARD_ACCEPT_LEDE = 'Just Bitcoin SV is the default. You can change this later in Settings.'

const ACCEPT_COINS: Record<AcceptedCoins, readonly MarketCoin[]> = {
  bitcoin: ['bsv'],
  all: ['bsv', ...COIN_CHAINS, ...STABLE_MARKET_COINS],
}

export function OnboardAcceptPanel({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState<AcceptedCoins>(DEFAULT_ACCEPTED_COINS)

  useEffect(() => {
    setAcceptedCoins(choice)
  }, [choice])

  return (
    <div className="wallet-setup-config" data-aeon-scope="onboard-accept" data-aeon-state={choice}>
      <h2>What do you want to accept?</h2>
      <p className="auth-lede">{ONBOARD_ACCEPT_LEDE}</p>

      <div className="wallet-setup-options onboard-accept-options" role="radiogroup" aria-label="Accept">
        {ACCEPTED_COINS_CHOICES.map((opt) => {
          const active = choice === opt.id
          const coins = ACCEPT_COINS[opt.id]
          return (
            <label
              key={opt.id}
              className={
                active
                  ? 'wallet-setup-option onboard-accept-option is-selected'
                  : 'wallet-setup-option onboard-accept-option'
              }
            >
              <input
                type="radio"
                name="onboard-accept"
                value={opt.id}
                checked={active}
                onChange={() => {
                  playWalletSound('soft')
                  setChoice(opt.id)
                }}
              />
              <span className="onboard-accept-icons" aria-hidden>
                {coins.map((coin) => (
                  <span key={coin} className="onboard-accept-icon" data-coin={coin}>
                    <TickerCoinMark coin={coin} size={28} />
                  </span>
                ))}
              </span>
              <span className="wallet-setup-option-body">
                <strong>{opt.title}</strong>
                <span>{opt.description}</span>
              </span>
            </label>
          )
        })}
      </div>

      <div className="auth-actions" style={{ marginTop: 16 }} data-aeon-part="onboard-accept-actions">
        <Button.Root variant="solid" className="btn btn-primary auth-submit" onClick={onDone}>
          <Button.Label>Continue</Button.Label>
        </Button.Root>
      </div>
    </div>
  )
}
