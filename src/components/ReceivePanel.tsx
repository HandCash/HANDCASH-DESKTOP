import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { copyText } from '../wallet/clipboard'
import { buildPeerPayUri } from '../wallet/peerPayUri'
import { toastError } from '../wallet/toast'
import { playWalletSound } from '../wallet/soundService'
import { ADD_MONEY_URL } from '../wallet/walletConfig'
import { DeferredImage } from './DeferredImage'
import { SkeletonQr } from './Skeleton'

export type ReceiveMode = 'peerpay' | 'address'

export function defaultReceiveMode(): ReceiveMode {
  return 'address'
}

type ReceiveViaId = 'bsv' | 'btc' | 'eth' | 'usd'

type ReceiveVia = {
  id: ReceiveViaId
  label: string
  eta: string
  kind: 'native' | 'swap'
}

const RECEIVE_VIA: ReceiveVia[] = [
  { id: 'bsv', label: 'BSV', eta: 'Instant', kind: 'native' },
  { id: 'btc', label: 'BTC', eta: '~10–60 min', kind: 'swap' },
  { id: 'eth', label: 'ETH', eta: '~10–60 min', kind: 'swap' },
  { id: 'usd', label: 'USD / card', eta: '~a few minutes', kind: 'swap' },
]

type Props = {
  address: string
  identityKey: string
}

export function ReceivePanel({ address, identityKey }: Props) {
  const [mode, setMode] = useState<ReceiveMode>(defaultReceiveMode())
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [viaId, setViaId] = useState<ReceiveViaId>('bsv')

  const via = RECEIVE_VIA.find((v) => v.id === viaId) ?? RECEIVE_VIA[0]!

  const peerpayUri = useMemo(() => {
    try {
      return buildPeerPayUri(identityKey)
    } catch {
      return null
    }
  }, [identityKey])

  const value = mode === 'peerpay' && peerpayUri ? peerpayUri : address
  const subtitle =
    mode === 'peerpay'
      ? 'PeerPay (BRC-125) — identity key payment link'
      : 'Payment address — scan or copy to receive BSV'

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

  const openAddMoney = () => {
    playWalletSound('soft')
    void window.handcash?.openExternal?.(ADD_MONEY_URL)
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
        </div>

        <div className="receive-info">
          <div className="field receive-via-field">
            <label htmlFor="receive-via">Receive via</label>
            <select
              id="receive-via"
              className="receive-via-select"
              value={viaId}
              onChange={(e) => {
                playWalletSound('soft')
                setViaId(e.target.value as ReceiveViaId)
              }}
            >
              {RECEIVE_VIA.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.kind === 'native'
                    ? `${option.label} — ${option.eta}`
                    : `Swap from ${option.label} — ${option.eta}`}
                </option>
              ))}
            </select>
            <p className="receive-eta-row" data-native={via.kind === 'native' ? '' : undefined}>
              <span className="receive-eta-label">Arrival</span>
              <strong className="receive-eta-value">{via.eta}</strong>
            </p>
            {via.kind === 'swap' ? (
              <p className="receive-swap-note">
                You’ll still receive BSV here. Use Add money to buy or swap from {via.label}.
              </p>
            ) : null}
          </div>

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
            <button type="button" className="btn btn-ghost" onClick={openAddMoney}>
              Add money
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
