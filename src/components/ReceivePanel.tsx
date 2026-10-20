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
import { AssetPicker, NETWORK_OPTIONS, swapCoinOption } from './NetworkPicker'
import { SkeletonQr } from './Skeleton'
import { CoinDepositProgress } from './CoinDepositProgress'
import { useCoinDeposits } from '../features/coinDeposits'
import { COIN_WALLETS } from '../features/coinWallets'
import { depositWaiting } from '../wallet/coins/depositPhase'
import { COIN_INFO, isCoinChain } from '../wallet/coins/coinChains'

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
  const [coinAddress, setCoinAddress] = useState<{ chain: string; address: string } | null>(null)
  const coin = isCoinChain(viaId) ? viaId : null
  const coinInfo = coin ? COIN_INFO[coin] : null
  const waitingDeposits = useCoinDeposits(coin).filter((d) => depositWaiting(d.phase))

  useEffect(() => {
    if (!coin) return
    // Asking for the address also tells the watcher to expect coins.
    try {
      setCoinAddress({ chain: coin, address: COIN_WALLETS[coin].getAddress() })
    } catch (err) {
      toastError(`${COIN_INFO[coin].label} address unavailable`, err instanceof Error ? err.message : String(err))
    }
  }, [coin])

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

  const value = coin
    ? (coinAddress?.chain === coin ? coinAddress.address : '')
    : mode === 'peerpay' && peerpayUri ? peerpayUri : address
  const subtitle = coinInfo
    ? `${coinInfo.label} deposit address — send only ${coinInfo.ticker} here`
    : mode === 'peerpay'
      ? 'PeerPay (BRC-125) — wallet key payment link'
      : 'Payment address — scan or copy to receive BSV'

  const viaIsSwap = viaId !== 'bsv' && !coin
  const viaLabel =
    viaId === 'bsv'
      ? 'BSV'
      : (swapCoins.find((c) => c.code === viaId)?.name ?? viaId)
  const viaEta = coinInfo ? `${coinInfo.confirmations} ${coinInfo.label} confirmations` : viaIsSwap ? SWAP_ETA : NATIVE_BSV_ETA

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
    await copyText(value, { label: coinInfo ? `${coinInfo.label} address` : mode === 'peerpay' ? 'PeerPay link' : 'address' })
  }

  const openAddMoney = (fromCoin?: string) => {
    playWalletSound('soft')
    openMarketSwap(buildBuyBsvSwapUrl(fromCoin))
  }

  const onViaChange = (next: string) => {
    playWalletSound('soft')
    setViaId(next)
    if (next !== 'bsv' && !isCoinChain(next)) openAddMoney(next)
  }

  return (
    <div className="nav-child-panel receive-panel" data-aeon-scope="receive" data-chain={coin ?? 'bsv'}>
      <div className="receive-layout receive-layout-premium">
        <header className="receive-panel-intro">
          <h3 className="receive-panel-title">{coinInfo ? `Receive ${coinInfo.ticker}` : 'Receive BSV'}</h3>
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
                alt={coinInfo ? `${coinInfo.label} deposit address QR code` : mode === 'peerpay' ? 'PeerPay QR code' : 'Receive address QR code'}
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
          <p className="receive-qr-hint">Tap QR to copy</p>

          {peerpayUri && !coin ? (
            <div className="actions receive-mode-actions">
              <Button.Root variant="ghost"
                className={mode === 'peerpay' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => {
                  playWalletSound('soft')
                  setMode('peerpay')
                }}
              >
                <Button.Label>PeerPay</Button.Label>
              </Button.Root>
              <Button.Root variant="ghost"
                className={mode === 'address' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => {
                  playWalletSound('soft')
                  setMode('address')
                }}
              >
                <Button.Label>Address</Button.Label>
              </Button.Root>
            </div>
          ) : null}
        </div>

        <div className="receive-info">
          <div className="field receive-via-field">
            <AssetPicker
              label="Receive via"
              value={viaId}
              options={[
                ...NETWORK_OPTIONS.map((o) =>
                  isCoinChain(o.value)
                    ? { ...o, detail: `${COIN_INFO[o.value].confirmations} confirmations` }
                    : { ...o, detail: NATIVE_BSV_ETA },
                ),
                ...swapCoins
                  .filter((c) => !NETWORK_OPTIONS.some((o) => o.sym === c.code))
                  .map((c) => swapCoinOption(c, `Swap · ${c.eta}`)),
              ]}
              onChange={onViaChange}
            />
            <p className="receive-eta-row" data-native={viaIsSwap ? undefined : ''}>
              <span className="receive-eta-label">Arrival</span>
              <strong className="receive-eta-value">{viaEta}</strong>
            </p>
            {viaIsSwap ? (
              <p className="receive-swap-note">
                Opening swap for {viaLabel}…
              </p>
            ) : null}
          </div>

          <p className="qr-subtitle receive-subtitle">{subtitle}</p>
          <button
            type="button"
            className="mono qr-value receive-address"
            title="Click to copy"
            onClick={() => void copy()}
          >
            {value}
          </button>
          {coin && waitingDeposits.length > 0 ? (
            <ul data-aeon-part="deposit-list" aria-label={`${COIN_INFO[coin].label} deposits confirming`}>
              {waitingDeposits.map((d) => (
                <li key={`${d.txid}:${d.vout}`}>
                  <CoinDepositProgress chain={coin} view={d} />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="actions receive-actions">
            <Button.Root variant="solid" className="btn btn-primary" disabled={!value} onClick={() => void copy()}>
              <Button.Label>{coinInfo ? `Copy ${coinInfo.ticker} address` : mode === 'peerpay' ? 'Copy PeerPay' : 'Copy address'}</Button.Label>
            </Button.Root>
            {coin ? null : (
              <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => openAddMoney()}>
                <Button.Label>Add money</Button.Label>
              </Button.Root>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
