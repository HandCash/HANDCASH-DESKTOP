import { isMobileWalletPlatform } from '../wallet/isMobilePlatform'
import { applyAmountPadKey, type AmountPadKey } from './amountPadKey'
import { BackspaceIcon } from './icons'

const KEYS: AmountPadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back']

/** On phones amounts are typed on this pad, not the system keyboard; desktop keeps the plain field. */
export function useAmountPad(): boolean {
  return isMobileWalletPlatform()
}

/** Props for an amount input: with the pad it stays focusable but never opens the system keyboard. */
export function amountInputProps(pad: boolean) {
  return pad ? ({ inputMode: 'none', readOnly: true } as const) : ({ inputMode: 'decimal' } as const)
}

type Props = {
  value: string
  onChange: (next: string) => void
  label: string
  disabled?: boolean
}

export function AmountPad({ value, onChange, label, disabled }: Props) {
  return (
    <div className="amount-pad" data-aeon-scope="amount-pad" role="group" aria-label={label}>
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          data-aeon-part="key"
          aria-label={key === 'back' ? 'Delete' : key === '.' ? 'Decimal point' : key}
          disabled={disabled}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onChange(applyAmountPadKey(value, key))}
        >
          {key === 'back' ? <BackspaceIcon size={22} /> : key}
        </button>
      ))}
    </div>
  )
}
