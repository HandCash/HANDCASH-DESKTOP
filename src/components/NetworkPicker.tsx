import { useId, type RefObject } from 'react'
import { Select } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { TickerCoinMark } from './TickerCoinSelector'
import type { MarketCoin } from '../wallet/bsvMarket'
import { COIN_CHAINS, COIN_INFO } from '../wallet/coins/coinChains'

const NETWORKS: readonly { coin: MarketCoin; name: string; sym: string }[] = [
  { coin: 'bsv', name: 'Bitcoin SV', sym: 'BSV' },
  ...COIN_CHAINS.map((chain) => ({ coin: chain, name: COIN_INFO[chain].label, sym: COIN_INFO[chain].ticker })),
]

function NetworkRow({ coin, name, sym, detail, nameId }: (typeof NETWORKS)[number] & { detail?: string; nameId?: string }) {
  return (
    <>
      <TickerCoinMark coin={coin} size={22} />
      <span data-network-part="name" id={nameId}>
        {name}
      </span>
      {detail ? <span data-network-part="detail">{detail}</span> : null}
      <span data-network-part="sym">{sym}</span>
    </>
  )
}

type CoinSelectProps = {
  value: MarketCoin
  onChange: (next: MarketCoin) => void
  labelledBy: string
  disabled?: boolean
  /** Shown beside each coin in the open list, e.g. what the wallet holds. */
  detail?: (coin: MarketCoin) => string | undefined
  /** Coins listed but not choosable. */
  unavailable?: (coin: MarketCoin) => boolean
  /** Open the list across this region instead of under the trigger alone. */
  anchorRef?: RefObject<HTMLElement | null>
}

/** A dropdown of every chain by logo, name and ticker; BSV first. */
export function CoinSelect({ value, onChange, labelledBy, disabled, detail, unavailable, anchorRef }: CoinSelectProps) {
  const current = NETWORKS.find((n) => n.coin === value) ?? NETWORKS[0]!
  const valueId = useId()
  return (
    <Select.Root value={value} disabled={disabled} onValueChange={(next) => next !== value && onChange(next as MarketCoin)}>
      <Select.Trigger aria-labelledby={`${labelledBy} ${valueId}`} disabled={disabled} data-network-picker="">
        <Select.ValueText>
          <NetworkRow {...current} nameId={valueId} />
        </Select.ValueText>
      </Select.Trigger>
      <Select.Positioner anchorRef={anchorRef}>
        <Select.Content aria-labelledby={labelledBy} data-network-picker="">
          {NETWORKS.map((network) => (
            <Select.Item key={network.coin} value={network.coin} disabled={unavailable?.(network.coin) ?? false}>
              <NetworkRow {...network} detail={detail?.(network.coin)} />
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
  )
}

/** Which chain a send or receive uses, chosen from a dropdown by name and logo; BSV is first and the default. */
export function NetworkPicker({ value, onChange, disabled }: { value: MarketCoin; onChange: (next: MarketCoin) => void; disabled?: boolean }) {
  const labelId = useId()
  return (
    <div data-aeon-scope="network-picker" data-aeon-state={stateToAttr(value)}>
      <span data-aeon-part="label" id={labelId}>
        Network
      </span>
      <CoinSelect value={value} onChange={onChange} disabled={disabled} labelledBy={labelId} />
    </div>
  )
}
