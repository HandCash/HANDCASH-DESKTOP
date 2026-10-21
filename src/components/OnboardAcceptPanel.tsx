import { Button } from '@aeon-ui/react'
import { useEffect, useState } from 'react'
import {
  ACCEPTED_COINS_CHOICES,
  DEFAULT_ACCEPTED_COINS,
  setAcceptedCoins,
  type AcceptedCoins,
} from '../wallet/acceptedCoins'
import { playWalletSound } from '../wallet/soundService'

export const ONBOARD_ACCEPT_LEDE = 'Just Bitcoin SV is the default. You can change this later in Settings.'

export function OnboardAcceptPanel({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState<AcceptedCoins>(DEFAULT_ACCEPTED_COINS)

  useEffect(() => {
    setAcceptedCoins(choice)
  }, [choice])

  return (
    <div className="wallet-setup-config" data-aeon-scope="onboard-accept" data-aeon-state={choice}>
      <h2>What do you want to accept?</h2>
      <p className="auth-lede">{ONBOARD_ACCEPT_LEDE}</p>

      <div className="wallet-setup-options" role="radiogroup" aria-label="Accept">
        {ACCEPTED_COINS_CHOICES.map((opt) => {
          const active = choice === opt.id
          return (
            <label key={opt.id} className={active ? 'wallet-setup-option is-selected' : 'wallet-setup-option'}>
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
