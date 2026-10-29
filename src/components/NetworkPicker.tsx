import { useId, useMemo, type ReactNode, type RefObject } from 'react'
import { Select } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { TickerCoinMark } from './TickerCoinSelector'
import { DeferredImage } from './DeferredImage'
import { isStableMarketCoin, type MarketCoin } from '../wallet/bsvMarket'
import { COIN_CHAINS, COIN_INFO } from '../wallet/coins/coinChains'
import { useShownCoinChains, useShownMarketCoins } from '../features/acceptedCoins'
import { TICKER_COINS } from '../wallet/tickerCoin'
import type { MarketSwapCurrency } from '../wallet/marketSwap'

const MARK_SIZE = 22

export type AssetOption = {
  value: string
  name: string
  sym: string
  mark: ReactNode
  /** Shown beside the name in the open list, e.g. a balance or arrival time. */
  detail?: string
  disabled?: boolean
}

export const NETWORK_OPTIONS: readonly AssetOption[] = [
  { value: 'bsv', name: 'Bitcoin SV', sym: 'BSV', mark: <TickerCoinMark coin="bsv" size={MARK_SIZE} /> },
  ...COIN_CHAINS.map((chain) => ({
    value: chain,
    name: COIN_INFO[chain].label,
    sym: COIN_INFO[chain].ticker,
    mark: <TickerCoinMark coin={chain} size={MARK_SIZE} />,
  })),
]

const BSV_NETWORK_ONLY: readonly AssetOption[] = NETWORK_OPTIONS.slice(0, 1)

/** Bitcoin SV, then the other coins the wallet accepts (UTXO coins + Arc USD). */
export function useNetworkOptions(): readonly AssetOption[] {
  const chains = useShownCoinChains()
  const markets = useShownMarketCoins()
  return useMemo(() => {
    if (chains.length === 0) return BSV_NETWORK_ONLY
    const stables = markets.filter(isStableMarketCoin)
    if (stables.length === 0) return NETWORK_OPTIONS
    return [
      ...NETWORK_OPTIONS,
      ...stables.map((coin) => ({
        value: coin,
        name: TICKER_COINS[coin].name,
        sym: TICKER_COINS[coin].sym,
        mark: <TickerCoinMark coin={coin} size={MARK_SIZE} />,
      })),
    ]
  }, [chains, markets])
}

/** A coin from the market swap catalog, by its own icon or its ticker's initial. */
export function swapCoinOption(coin: MarketSwapCurrency, detail: string): AssetOption {
  const initial = <span data-network-part="initial">{coin.code.slice(0, 1)}</span>
  return {
    value: coin.code,
    name: coin.name,
    sym: coin.code,
    detail,
    mark: coin.icon ? (
      <DeferredImage
        src={coin.icon}
        alt=""
        width={MARK_SIZE}
        height={MARK_SIZE}
        skeletonRadius={MARK_SIZE / 2}
        fallback={initial}
        draggable={false}
      />
    ) : (
      initial
    ),
  }
}

function AssetRow({ option, nameId, withDetail }: { option: AssetOption; nameId?: string; withDetail: boolean }) {
  return (
    <>
      <span data-network-part="mark" aria-hidden>
        {option.mark}
      </span>
      <span data-network-part="name" id={nameId}>
        {option.name}
      </span>
      {withDetail && option.detail ? <span data-network-part="detail">{option.detail}</span> : null}
      <span data-network-part="sym">{option.sym}</span>
    </>
  )
}

type AssetSelectProps = {
  value: string
  options: readonly AssetOption[]
  onChange: (next: string) => void
  labelledBy: string
  disabled?: boolean
  /** Open the list across this region instead of under the trigger alone. */
  anchorRef?: RefObject<HTMLElement | null>
}

/** A dropdown of assets by logo, name and ticker — Swap's picker, shared with Send and Receive. */
export function AssetSelect({ value, options, onChange, labelledBy, disabled, anchorRef }: AssetSelectProps) {
  const current = options.find((o) => o.value === value) ?? options[0]!
  const valueId = useId()
  return (
    <Select.Root value={value} disabled={disabled} onValueChange={(next) => next !== value && onChange(next)}>
      <Select.Trigger aria-labelledby={`${labelledBy} ${valueId}`} disabled={disabled} data-network-picker="">
        <Select.ValueText>
          <AssetRow option={current} nameId={valueId} withDetail={false} />
        </Select.ValueText>
      </Select.Trigger>
      <Select.Positioner anchorRef={anchorRef}>
        <Select.Content aria-labelledby={labelledBy} data-network-picker="">
          {options.map((option) => (
            <Select.Item key={option.value} value={option.value} disabled={option.disabled ?? false}>
              <AssetRow option={option} withDetail />
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
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
  anchorRef?: RefObject<HTMLElement | null>
}

/** A dropdown of every chain by logo, name and ticker; BSV first. */
export function CoinSelect({ value, onChange, labelledBy, disabled, detail, unavailable, anchorRef }: CoinSelectProps) {
  const options = useNetworkOptions().map((o) => ({
    ...o,
    detail: detail?.(o.value as MarketCoin),
    disabled: unavailable?.(o.value as MarketCoin) ?? false,
  }))
  return (
    <AssetSelect
      value={value}
      options={options}
      onChange={(next) => onChange(next as MarketCoin)}
      labelledBy={labelledBy}
      disabled={disabled}
      anchorRef={anchorRef}
    />
  )
}

/** A labelled asset dropdown for a send or receive form. */
export function AssetPicker({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: readonly AssetOption[]
  onChange: (next: string) => void
  disabled?: boolean
}) {
  const labelId = useId()
  return (
    <div data-aeon-scope="network-picker" data-aeon-state={stateToAttr(value)}>
      <span data-aeon-part="label" id={labelId}>
        {label}
      </span>
      <AssetSelect value={value} options={options} onChange={onChange} disabled={disabled} labelledBy={labelId} />
    </div>
  )
}

/** Which chain a send uses, chosen from a dropdown by name and logo; BSV is first and the default. */
export function NetworkPicker({ value, onChange, disabled }: { value: MarketCoin; onChange: (next: MarketCoin) => void; disabled?: boolean }) {
  const options = useNetworkOptions()
  return (
    <AssetPicker
      label="Network"
      value={value}
      options={options}
      onChange={(next) => onChange(next as MarketCoin)}
      disabled={disabled}
    />
  )
}
