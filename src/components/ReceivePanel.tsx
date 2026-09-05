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
import { SkeletonQr } from './Skeleton'

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

  const value = mode === 'peerpay' && peerpayUri ? peerpayUri : address
  const subtitle =
    mode === 'peerpay'
      ? 'PeerPay (BRC-125) — identity key payment link'
      : 'Payment address — scan or copy to receive BSV'

  const viaIsSwap = viaId !== 'bsv'
  const viaLabel =
    viaId === 'bsv'
      ? 'BSV'
      : (swapCoins.find((c) => c.code === viaId)?.name ?? viaId)
  const viaEta = viaIsSwap ? SWAP_ETA : NATIVE_BSV_ETA

  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
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
    await copyText(value, { label: mode === 'peerpay' ? 'PeerPay link' : 'address' })
  }

  const openAddMoney = (fromCoin?: string) => {
    playWalletSound('soft')
    openMarketSwap(buildBuyBsvSwapUrl(fromCoin))
  }

  const onViaChange = (next: string) => {
    playWalletSound('soft')
    setViaId(next)
    if (next !== 'bsv') openAddMoney(next)
  }

  return (
    <div className="nav-child-panel receive-panel" data-aeon-scope="receive">
      <div className="receive-layout receive-layout-premium">
        <header className="receive-panel-intro">
          <h3 className="receive-panel-title">Receive BSV</h3>
          <p className="receive-panel-lede">
            Always settle to Bitcoin SV on this device. Swap from other assets when you need to
            top up.
          </p>
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
                alt={mode === 'peerpay' ? 'PeerPay QR code' : 'Receive address QR code'}
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

          {peerpayUri ? (
            <div className="actions receive-mode-actions">
              <button
                type="button"
                className={mode === 'peerpay' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => {
                  playWalletSound('soft')
                  setMode('peerpay')
                }}
              >
                PeerPay
              </button>
              <button
                type="button"
                className={mode === 'address' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => {
                  playWalletSound('soft')
                  setMode('address')
                }}
              >
                Address
              </button>
            </div>
          ) : null}
        </div>

        <div className="receive-info">
          <div className="field receive-via-field">
            <label htmlFor="receive-via">Receive via</label>
            <select
              id="receive-via"
              className="receive-via-select"
              value={viaId}
              onChange={(e) => onViaChange(e.target.value)}
            >
              <option value="bsv">BSV — {NATIVE_BSV_ETA}</option>
              {swapCoins.map((coin) => (
                <option key={coin.code} value={coin.code}>
                  Swap from {coin.code} — {coin.eta}
                </option>
              ))}
            </select>
            <p className="receive-eta-row" data-native={viaIsSwap ? undefined : ''}>
              <span className="receive-eta-label">Arrival</span>
              <strong className="receive-eta-value">{viaEta}</strong>
            </p>
            {viaIsSwap ? (
              <p className="receive-swap-note">
                You’ll still receive BSV here. Opening HandCash swap for {viaLabel}…
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
          <div className="actions receive-actions">
            <button type="button" className="btn btn-primary" onClick={() => void copy()}>
              {mode === 'peerpay' ? 'Copy PeerPay' : 'Copy address'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => openAddMoney()}>
              Add money
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
