import { Button } from '@aeon-ui/react'
import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { copyText } from '../wallet/clipboard'
import { buildPeerPayUri } from '../wallet/peerPayUri'
import { toastError } from '../wallet/toast'
import { playWalletSound } from '../wallet/soundService'
import {
  buildBuyBsvSwapUrl,
  fetchSwapCurrencies,
  NATIVE_BSV_ETA,
  openMarketSwap,
  SWAP_ETA,
  type MarketSwapCurrency,
} from '../wallet/marketSwap'
import { DeferredImage } from './DeferredImage'
import { AssetPicker, NETWORK_OPTIONS, swapCoinOption, useNetworkOptions } from './NetworkPicker'
import { SkeletonQr } from './Skeleton'
import { CoinDepositProgress } from './CoinDepositProgress'
import { useCoinDeposits } from '../features/coinDeposits'
import { COIN_WALLETS } from '../features/coinWallets'
import { depositWaiting } from '../wallet/coins/depositPhase'
import { COIN_INFO, isCoinChain } from '../wallet/coins/coinChains'
import { ARC_USD_PAYMENT_ETA, arcUsdWallet } from '../wallet/arcUsdc'

export type ReceiveMode = 'peerpay' | 'address'

export function defaultReceiveMode(): ReceiveMode {
  return 'peerpay'
}

type Props = {
  address: string
  identityKey: string
}

export function ReceivePanel({ address, identityKey }: Props) {
  const [mode, setMode] = useState<ReceiveMode>(() =>
    // Prefer PeerPay when we can build a URI; fall back to address otherwise.
    (() => {
      try {
        buildPeerPayUri(identityKey)
        return defaultReceiveMode()
      } catch {
        return 'address'
      }
    })(),
  )
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [viaId, setViaId] = useState('bsv')
  const [swapCoins, setSwapCoins] = useState<MarketSwapCurrency[]>([])
  const networkOptions = useNetworkOptions()
  const [coinAddress, setCoinAddress] = useState<{ chain: string; address: string } | null>(null)
  const coin = isCoinChain(viaId) ? viaId : null
  const isArcUsd = viaId === 'arc-usd'
  const coinInfo = coin ? COIN_INFO[coin] : null
  const waitingDeposits = useCoinDeposits(coin).filter((d) => depositWaiting(d.phase))

  useEffect(() => {
    if (coin) {
      // Asking for the address also tells the watcher to expect coins.
      try {
        setCoinAddress({ chain: coin, address: COIN_WALLETS[coin].getAddress() })
      } catch (err) {
        toastError(`${COIN_INFO[coin].label} address unavailable`, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (isArcUsd) {
      try {
        setCoinAddress({ chain: 'arc-usd', address: arcUsdWallet.getAddress() })
        void arcUsdWallet.refresh().catch(() => {})
      } catch (err) {
        toastError('USDC address unavailable', err instanceof Error ? err.message : String(err))
      }
    }
  }, [coin, isArcUsd])

  const peerpayUri = useMemo(() => {
    try {
      return buildPeerPayUri(identityKey)
    } catch {
      return null
    }
  }, [identityKey])

  useEffect(() => {
    if (!peerpayUri && mode === 'peerpay') setMode('address')
  }, [peerpayUri, mode])

  useEffect(() => {
    const ac = new AbortController()
    void fetchSwapCurrencies({ signal: ac.signal, limit: 12 })
      .then(setSwapCoins)
      .catch(() => {
        /* Keep BSV Instant only if catalog is unreachable. */
      })
    return () => ac.abort()
  }, [])

  const nativeReceive = coin || isArcUsd
  const value = nativeReceive
    ? (coinAddress?.chain === viaId ? coinAddress.address : '')
    : mode === 'peerpay' && peerpayUri ? peerpayUri : address
  const subtitle = isArcUsd
    ? 'USDC on Arc · send only USDC'
    : coinInfo
      ? `${coinInfo.ticker} address · send only ${coinInfo.ticker}`
      : mode === 'peerpay'
        ? 'PeerPay link'
        : 'BSV address'

  const viaIsSwap = viaId !== 'bsv' && !coin && !isArcUsd
  const viaLabel =
    viaId === 'bsv'
      ? 'BSV'
      : isArcUsd
        ? 'USDC'
        : (swapCoins.find((c) => c.code === viaId)?.name ?? viaId)
  const viaEta = isArcUsd
    ? ARC_USD_PAYMENT_ETA
    : coinInfo
      ? `${coinInfo.confirmations} ${coinInfo.label} confirmations`
      : viaIsSwap
        ? SWAP_ETA
        : NATIVE_BSV_ETA

  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    if (!value) return
    void QRCode.toDataURL(value, {
      width: 260,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toastError('QR failed', err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [value])

  const copy = async () => {
    if (!value) return
    await copyText(value, {
      label: isArcUsd
        ? 'USDC address'
        : coinInfo
          ? `${coinInfo.label} address`
          : mode === 'peerpay'
            ? 'PeerPay link'
            : 'address',
    })
  }

  const openAddMoney = (fromCoin?: string) => {
    playWalletSound('soft')
    openMarketSwap(buildBuyBsvSwapUrl(fromCoin))
  }

  const onViaChange = (next: string) => {
    playWalletSound('soft')
    setViaId(next)
    if (next !== 'bsv' && !isCoinChain(next) && next !== 'arc-usd') openAddMoney(next)
  }

  return (
    <div className="nav-child-panel receive-panel" data-aeon-scope="receive" data-chain={coin ?? (isArcUsd ? 'arc-usd' : 'bsv')}>
      <AssetPicker
        label="Coin"
        value={viaId}
        options={[
          ...networkOptions.map((o) =>
            isCoinChain(o.value)
              ? { ...o, detail: `${COIN_INFO[o.value].confirmations} confirmations` }
              : { ...o, detail: NATIVE_BSV_ETA },
          ),
          ...(networkOptions.length > 1 ? swapCoins : [])
            .filter((c) => !NETWORK_OPTIONS.some((o) => o.sym === c.code) && c.code !== 'USDC')
            .map((c) => swapCoinOption(c, `Swap · ${c.eta}`)),
        ]}
        onChange={onViaChange}
      />
      <div className="receive-layout">
        <header className="receive-panel-intro">
          <h3 className="receive-panel-title">
            {isArcUsd ? 'Receive USDC' : coinInfo ? `Receive ${coinInfo.ticker}` : 'Receive BSV'}
          </h3>
        </header>

        <div className="receive-qr" data-aeon-part="media">
          <button
            type="button"
            className="qr-frame receive-qr-frame"
            title="Click to copy"
            onClick={() => void copy()}
          >
            {dataUrl ? (
              <DeferredImage
                src={dataUrl}
                alt={
                  isArcUsd
                    ? 'USDC deposit address QR code'
                    : coinInfo
                      ? `${coinInfo.label} deposit address QR code`
                      : mode === 'peerpay'
                        ? 'PeerPay QR code'
                        : 'Receive address QR code'
                }
                width={260}
                height={260}
                skeletonWidth={260}
                skeletonHeight={260}
                skeletonRadius={4}
                skeletonClassName="skeleton-qr"
              />
            ) : (
              <SkeletonQr size={260} />
            )}
          </button>
          {peerpayUri && !nativeReceive ? (
            <div className="receive-mode-toggle" role="group" aria-label="Receive with">
              {(['peerpay', 'address'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className="receive-mode-opt"
                  data-active={mode === m ? '' : undefined}
                  aria-pressed={mode === m}
                  onClick={() => {
                    playWalletSound('soft')
                    setMode(m)
                  }}
                >
                  {m === 'peerpay' ? 'PeerPay' : 'Address'}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="receive-side">
          <div className="field receive-address-field">
            <label htmlFor="receive-address">{subtitle}</label>
            <button
              id="receive-address"
              type="button"
              className="mono qr-value receive-address"
              title="Click to copy"
              onClick={() => void copy()}
            >
              {value}
            </button>
          </div>
          {coin && waitingDeposits.length > 0 ? (
            <ul data-aeon-part="deposit-list" aria-label={`${COIN_INFO[coin].label} deposits confirming`}>
              {waitingDeposits.map((d) => (
                <li key={`${d.txid}:${d.vout}`}>
                  <CoinDepositProgress chain={coin} view={d} />
                </li>
              ))}
            </ul>
          ) : null}
          <p className="receive-eta-row" data-native={viaIsSwap ? undefined : ''}>
            <span className="receive-eta-label">Arrival</span>
            <strong className="receive-eta-value">{viaEta}</strong>
          </p>
          {viaIsSwap ? <p className="receive-swap-note">Opening swap for {viaLabel}…</p> : null}
        </div>

        <div className="actions receive-actions">
          <Button.Root variant="solid" className="btn btn-primary" disabled={!value} onClick={() => void copy()}>
            <Button.Label>
              {isArcUsd
                ? 'Copy USDC address'
                : coinInfo
                  ? `Copy ${coinInfo.ticker} address`
                  : mode === 'peerpay'
                    ? 'Copy PeerPay'
                    : 'Copy address'}
            </Button.Label>
          </Button.Root>
          {coin ? null : (
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => openAddMoney()}>
              <Button.Label>Add money</Button.Label>
            </Button.Root>
          )}
        </div>
      </div>
    </div>
  )
}
