import { useEffect, useMemo, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { AssetPicker, NETWORK_OPTIONS, swapCoinOption, useNetworkOptions } from './NetworkPicker'
import { useCoinPrices, useHeldArcUsd, useHeldCoins } from '../features/heldCoins'
import { COIN_WALLETS } from '../features/coinWallets'
import { coinUsd as coinUnitsUsd } from '../wallet/heldValue'
import { COIN_INFO, formatCoin, formatCoinShort, isCoinChain } from '../wallet/coins/coinChains'
import { parseTokenAmount } from '../wallet/amounts'
import type { MarketCoin } from '../wallet/bsvMarket'
import {
  ARC_USD_DECIMALS,
  ARC_USD_PAYMENT_ETA,
  arcUsdWallet,
  formatUsdcAtoms,
} from '../wallet/arcUsdc'
import { ListRow } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import { sendMachine } from '../machines/sendMachine'
import {
  amountToSats,
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  formatTypedAmount,
  formatUsd,
  getCachedFiatPerBsv,
  getCachedUsdPerBsv,
  satsToFiat,
  satsToUsd,
  subscribeUsdRate,
} from '../wallet/fx'
import { getFiatOption, getFiatSymbol } from '../wallet/fiatCurrency'
import { useFiatCurrency } from '../hooks/useFiatCurrency'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  setDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  identityKeyFromRecipient,
  listFriends,
  normalizeIdentityKey,
  searchFriends,
  subscribeFriends,
  createPinnedHandleResolveDebouncer,
  type Friend,
} from '../wallet/friends'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import { AmountPad, amountInputProps, useAmountPad } from './AmountPad'
import {
  assertSendableBalanceForReview,
  refreshSpendableBalance,
  sendSatsToAddress,
} from '../wallet/sendPayment'
import {
  claimBrc29SettlementUri,
  sendBrc29ToIdentityKey,
} from '../wallet/sendBrc29Payment'
import { tryParseBrc29SettlementUri } from '../wallet/brc29Uri'
import { toastSuccess } from '../wallet/toast'
import { tryParsePeerPayUri } from '../wallet/peerPayUri'
import { parseHandleInput } from '../wallet/handleResolve'
import { offlinePaymentBlockedMessage } from '../wallet/paymentPolicy'
import type { Chain } from '../wallet/vault'
import { useDisplayBalanceSats } from '../hooks/useDisplayBalanceSats'
import { formatBsvSignificant } from '../wallet/session'
import { releaseWarmedQrCamera } from '../wallet/qrCameraWarm'
import { CheckIcon, CloseIcon, FriendsIcon, ScanQrIcon } from './icons'
import { RecipientQrScan } from './QrScanner'
import { useWalletActionDock } from './WalletActionDock'
import {
  buildSellBsvSwapUrl,
  fetchSwapCurrencies,
  NATIVE_BSV_ETA,
  openMarketSwap,
  SWAP_ETA,
  type MarketSwapCurrency,
} from '../wallet/marketSwap'

type Props = {
  chain: Chain
  identityKey: string
  /** Prefill from QR scan (PeerPay / identity / address). */
  initialRecipient?: string
  onSent: (balanceSats: number) => void
  onFail: (error: string) => void
  onClose: () => void
}

function shortenAddress(value: string): string {
  const v = value.trim()
  if (v.length <= 20) return v
  return `${v.slice(0, 10)}…${v.slice(-8)}`
}

function trimAmountInput(raw: number): string {
  const formatted = raw.toFixed(8)
  if (!formatted.includes('.')) return formatted
  let end = formatted.length
  while (end > 0 && formatted[end - 1] === '0') end -= 1
  if (end > 0 && formatted[end - 1] === '.') end -= 1
  return formatted.slice(0, end)
}

const REVIEW_BALANCE_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(id)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(id)
        reject(err)
      },
    )
  })
}

/** Keep the satoshi value when the send form swaps fiat <-> coin. */
function amountInputFromSats(
  sats: number,
  currency: DisplayCurrency,
  usdPerBsv: number | null,
): string {
  if (!(sats > 0)) return ''
  const raw =
    currency === 'usd'
      ? (() => {
          const perBsv = getCachedFiatPerBsv() ?? usdPerBsv
          return perBsv != null && perBsv > 0 ? satsToFiat(sats, undefined, perBsv) : null
        })()
      : sats / 1e8
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return ''
  return trimAmountInput(raw)
}

function resolvedRecipientName(
  friendLabel: string | null,
  to: string,
  payeeIdentityKey: string | null,
): string | null {
  if (friendLabel) return friendLabel
  if (payeeIdentityKey) return shortenAddress(to)
  const trimmed = to.trim()
  if (trimmed.length >= 26) return shortenAddress(trimmed)
  return null
}

export function SendPanel({
  chain,
  identityKey,
  initialRecipient,
  onSent,
  onFail,
  onClose,
}: Props) {
  const balanceSats = useDisplayBalanceSats({ identityKey, chain })
  const [sendSnap, send] = useMachine(sendMachine)
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [showFriendMatches, setShowFriendMatches] = useState(false)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const fiatCode = useFiatCurrency()
  const fiatOption = getFiatOption(fiatCode)
  const fiatSymbol = getFiatSymbol(fiatCode)
  const [offlineBlock, setOfflineBlock] = useState(() => offlinePaymentBlockedMessage())
  /** Local balance read before Review — a phase of `editing`, owned by the chart. */
  const reviewBusy = sendSnap.matches({ editing: 'checking' })
  const [scanningTo, setScanningTo] = useState(false)
  const [network, setNetwork] = useState<MarketCoin>('bsv')
  const [destAssetId, setDestAssetId] = useState('bsv')
  const [swapCoins, setSwapCoins] = useState<MarketSwapCurrency[]>([])
  /** Local draft — syncing every keystroke through XState re-rendered the whole panel. */
  const [amountDraft, setAmountDraft] = useState(() => sendSnap.context.amount)
  const amountPad = useAmountPad()
  const sendState = stateToAttr(sendSnap.value)
  const appliedPrefill = useRef(false)
  const handleResolveRef = useRef(createPinnedHandleResolveDebouncer())

  /** A native coin network: the same flow pays that coin from this wallet's own key on its chain. */
  const coin = isCoinChain(network) ? network : null
  const isArcUsd = network === 'arc-usd'
  const coinInfo = coin ? COIN_INFO[coin] : null
  const coinWallet = coin ? COIN_WALLETS[coin] : null
  const heldCoins = useHeldCoins()
  const heldArcUsd = useHeldArcUsd()
  const coinPrices = useCoinPrices()
  const heldUnits = isArcUsd ? heldArcUsd : coin ? heldCoins[coin] : 0n
  const usdPerCoin = isArcUsd ? 1 : coin ? coinPrices[coin] : null
  const ticker = isArcUsd ? 'USDC' : coinInfo?.ticker ?? 'BSV'
  const payableDecimals = isArcUsd ? ARC_USD_DECIMALS : coinInfo?.decimals ?? null
  const destIsNative = destAssetId === 'bsv'
  const destAsset = isArcUsd
    ? { id: 'arc-usd', label: 'USDC', eta: ARC_USD_PAYMENT_ETA }
    : coin && coinInfo && coinWallet
    ? { id: coin, label: coinInfo.label, eta: coinWallet.binding.paymentEta }
    : destIsNative
    ? { id: 'bsv', label: 'BSV', eta: NATIVE_BSV_ETA }
    : {
        id: destAssetId,
        label: swapCoins.find((c) => c.code === destAssetId)?.code ?? destAssetId,
        eta: SWAP_ETA,
      }
  const destReady = coin !== null || isArcUsd || destIsNative
  /** Every coin this wallet sends natively, with what it holds of each, then coins a recipient gets through a swap. */
  const networkOptions = useNetworkOptions()
  const nativeTickers = new Set(NETWORK_OPTIONS.map((o) => o.sym))
  nativeTickers.add('USDC')
  const coinOptions = [
    ...networkOptions.map((o) => ({
      ...o,
      detail:
        o.value === 'bsv'
          ? formatBsvSignificant(balanceSats, 4).replace(/\s*BSV$/, '')
          : isCoinChain(o.value)
            ? formatCoinShort(o.value, heldCoins[o.value])
            : o.value === 'arc-usd'
              ? formatUsdcAtoms(heldArcUsd)
              : undefined,
    })),
    ...(networkOptions.length > 1 ? swapCoins : [])
      .filter((c) => !nativeTickers.has(c.code))
      .map((c) => ({ ...swapCoinOption(c, `Swap · ${c.eta}`), value: `swap:${c.code}` })),
  ]
  const coinValue = destIsNative ? network : `swap:${destAssetId}`

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => () => handleResolveRef.current.cancel(), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    const ac = new AbortController()
    void fetchSwapCurrencies({ signal: ac.signal, limit: 12 })
      .then(setSwapCoins)
      .catch(() => {
        /* Native BSV send still works without the catalog. */
      })
    return () => ac.abort()
  }, [])
  useEffect(() => {
    const sync = () => setOfflineBlock(offlinePaymentBlockedMessage())
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const isFailure = sendSnap.matches('failure')
  useEffect(() => {
    if (!isFailure) return
    playWalletSound('error')
  }, [isFailure])

  const friendMatches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const coinUsd = coin || isArcUsd ? usdPerCoin : usdPerBsv
  /** The amount in the network's smallest unit: satoshis on BSV, the coin's own smallest unit elsewhere. */
  const amountUnits = (draft: string) =>
    payableDecimals != null && currency === 'bsv'
      ? Number(parseTokenAmount(draft.trim(), payableDecimals) ?? 0)
      : amountToSats(draft, currency, coinUsd)
  const amountSats = amountUnits(amountDraft)
  const coinAmountUsd = isArcUsd
    ? Number(BigInt(amountSats)) / 10 ** ARC_USD_DECIMALS
    : coin
      ? coinUnitsUsd(coin, BigInt(amountSats), usdPerCoin)
      : null
  const amountLabel = isArcUsd
    ? `${formatUsdcAtoms(BigInt(amountSats))} USDC`
    : coin
      ? `${formatCoin(coin, BigInt(amountSats))} ${ticker}`
      : formatTypedAmount(amountDraft, currency)
  const amountSecondary =
    amountSats <= 0 ? null
    : coin || isArcUsd ? (coinAmountUsd == null ? null : formatUsd(coinAmountUsd))
    : formatSecondaryFromSats(amountSats, currency, usdPerBsv)
  const overHeld = (coin !== null || isArcUsd) && BigInt(amountSats) > heldUnits

  const canReview =
    destReady &&
    !offlineBlock &&
    !reviewBusy &&
    sendSnap.context.to.trim().length > 0 &&
    amountSats > 0 &&
    !overHeld &&
    (currency === 'bsv' || coinUsd != null)

  const syncAmountToMachine = (value: string) => {
    if (value !== sendSnap.context.amount) {
      send({ type: 'EDIT', amount: value })
    }
  }

  const goReview = async () => {
    if (reviewBusy || offlineBlock || !destReady) return
    playWalletSound('soft')
    syncAmountToMachine(amountDraft)
    send({ type: 'CHECK' })
    if (coinWallet || isArcUsd) {
      try {
        // A payment to an identity is refused here, before review, unless its wallet's signed record says it receives the coin.
        if (isArcUsd) {
          await arcUsdWallet.preflightRecipient(coinRecipientArgs(String(amountSats)))
        } else {
          await coinWallet!.preflightRecipient(coinRecipientArgs(String(amountSats)))
        }
        send({ type: 'REVIEW' })
      } catch (err) {
        send({ type: 'REFUSE' })
        playWalletSound('error')
        onFail(err instanceof Error ? err.message : String(err))
      }
      return
    }
    try {
      const satoshis = amountToSats(amountDraft, currency, usdPerBsv)
      if (!Number.isFinite(satoshis) || satoshis <= 0) {
        throw new Error(
          currency === 'usd' && usdPerBsv == null
            ? 'USD rate unavailable'
            : 'Invalid amount',
        )
      }
      // Fast local read only — promotion/heal runs on Confirm inside runExclusiveSpend.
      const available = await withTimeout(
        assertSendableBalanceForReview(satoshis),
        REVIEW_BALANCE_TIMEOUT_MS,
        'Balance check timed out. Wallet storage may be busy — wait a moment and try again.',
      )
      onSent(available)
      send({ type: 'REVIEW' })
    } catch (err) {
      send({ type: 'REFUSE' })
      playWalletSound('error')
      onFail(err instanceof Error ? err.message : String(err))
      try {
        const available = await refreshSpendableBalance()
        onSent(available)
      } catch {
        // ignore secondary refresh failure
      }
    }
  }

  const recipientLabel =
    sendSnap.context.friendLabel || shortenAddress(sendSnap.context.to)
  const payeeKey = sendSnap.context.payeeIdentityKey?.trim() || null
  /** A coin goes to the payee's identity when one is named (BRC-213 §7), otherwise to the address typed. */
  const coinRecipientArgs = (litoshi: string) =>
    payeeKey ? { identityKey: normalizeIdentityKey(payeeKey), litoshi } : { address: sendSnap.context.to.trim(), litoshi }
  const resolvedName = resolvedRecipientName(
    sendSnap.context.friendLabel,
    sendSnap.context.to,
    sendSnap.context.payeeIdentityKey,
  )

  const setSendCurrency = (next: DisplayCurrency) => {
    if (next === currency) return
    const sats = amountUnits(amountDraft)
    playWalletSound('soft')
    if (sats > 0) {
      const converted = amountInputFromSats(sats, next, coinUsd)
      if (converted) {
        setAmountDraft(converted)
        syncAmountToMachine(converted)
      }
    }
    setDisplayCurrency(next)
  }

  const selectFriend = (friend: Friend) => {
    handleResolveRef.current.cancel()
    setRecipientQuery(friend.label)
    setShowFriendMatches(false)
    send({
      type: 'EDIT',
      to: normalizeIdentityKey(friend.identityKey),
      friendLabel: friend.label,
      payeeIdentityKey: friend.identityKey,
    })
  }

  const applyRecipientInput = (value: string) => {
    handleResolveRef.current.cancel()
    setRecipientQuery(value)
    setShowFriendMatches(true)
    if (!coin && tryParseBrc29SettlementUri(value)) {
      void (async () => {
        try {
          const result = await claimBrc29SettlementUri(value)
          if (result.accepted) {
            if (result.balanceSats != null) onSent(result.balanceSats)
            playPaymentSuccessSound()
            toastSuccess('Payment claimed', 'The BRC-29 payment is in your wallet.')
            setRecipientQuery('')
            return
          }
          onFail(result.reason || 'Could not claim BRC-29 payment')
        } catch (err) {
          onFail(err instanceof Error ? err.message : String(err))
        }
      })()
      return
    }
    const peer = tryParsePeerPayUri(value)
    if (peer) {
      const patch: {
        to: string
        friendLabel: null
        payeeIdentityKey: string
        amount?: string
      } = {
        to: normalizeIdentityKey(peer.identityKey),
        friendLabel: null,
        payeeIdentityKey: peer.identityKey,
      }
      if (!coin && peer.sats != null) {
        if (currency === 'usd' && usdPerBsv != null && usdPerBsv > 0) {
          const usd = satsToUsd(peer.sats, usdPerBsv)
          patch.amount = String(Number(usd.toFixed(4)))
        } else {
          patch.amount = String(peer.sats / 1e8)
        }
      }
      send({ type: 'EDIT', ...patch })
      return
    }
    if (parseHandleInput(value)) {
      // Until this handle resolves, the previous recipient must not stay payable under it.
      send({ type: 'EDIT', to: '', friendLabel: null, payeeIdentityKey: null })
      handleResolveRef.current.schedule(value, {
        onResolved: (resolved) => {
          send({
            type: 'EDIT',
            to: normalizeIdentityKey(resolved.identityKey),
            friendLabel: resolved.display,
            payeeIdentityKey: resolved.identityKey,
          })
        },
        onError: (err) => onFail(err.message),
      })
      return
    }
    send({
      type: 'EDIT',
      to: value.trim(),
      friendLabel: null,
      payeeIdentityKey: identityKeyFromRecipient(value),
    })
  }

  useEffect(() => {
    if (appliedPrefill.current || !initialRecipient?.trim()) return
    appliedPrefill.current = true
    applyRecipientInput(initialRecipient.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRecipient])

  /**
   * Hand the payment to the wallet and get out of the way.
   *
   * Everything after this point is already visible outside the panel — the
   * sidebar mirrors live progress and Activity carries the settled or failed
   * row — so keeping the user on a status screen only hides the surfaces that
   * outlive it. Only a pre-flight refusal stays here, where the amount can
   * still be edited.
   */
  const confirmSend = () => {
    if (!destReady) return
    syncAmountToMachine(amountDraft)
    if ((coinWallet && coinInfo) || isArcUsd) {
      const args = coinRecipientArgs(String(amountSats))
      const label = recipientLabel
      const toLabel = sendSnap.context.friendLabel ?? undefined
      const sent = amountLabel
      const networkLabel = isArcUsd ? 'Arc' : coinInfo!.label
      send({ type: 'CONFIRM' })
      onClose()
      void (async () => {
        try {
          const paid = isArcUsd
            ? await arcUsdWallet.send(args, { toLabel })
            : await coinWallet!.send(args, { toLabel })
          playPaymentSuccessSound()
          toastSuccess(
            paid.status === 'sent' ? 'Sent' : 'Signed',
            paid.status === 'sent'
              ? `${sent} on the way to ${label}.`
              : `${sent} to ${label} is signed; ${networkLabel} did not take it yet, so the wallet keeps broadcasting it.`,
          )
        } catch (err) {
          onFail(err instanceof Error ? err.message : String(err))
        }
        try {
          onSent(await refreshSpendableBalance())
        } catch {
          // ignore — the outcome is already reported
        }
      })()
      return
    }
    const satoshis = amountToSats(amountDraft, currency, usdPerBsv)
    if (!Number.isFinite(satoshis) || satoshis <= 0) {
      send({
        type: 'FAIL',
        error:
          currency === 'usd' && usdPerBsv == null
            ? 'USD rate unavailable'
            : 'Invalid amount',
      })
      return
    }

    const to = sendSnap.context.to.trim()
    const friendLabel = sendSnap.context.friendLabel
    const label = recipientLabel

    send({ type: 'CONFIRM' })
    onClose()

    // Deliberately not awaited: the panel is gone by the time this settles.
    void (async () => {
      try {
        let balanceSats: number
        let selfReceived = false
        if (payeeKey != null) {
          const next = await sendBrc29ToIdentityKey({
            payeeIdentityKey: payeeKey,
            satoshis,
            friendLabel,
          })
          balanceSats = next.balanceSats
          selfReceived = next.selfReceive
        } else {
          const next = await sendSatsToAddress({ to, satoshis, friendLabel })
          balanceSats = next.balanceSats
        }
        playPaymentSuccessSound()
        toastSuccess(
          'Sent',
          selfReceived
            ? `${amountLabel} on the way back to this wallet.`
            : `${amountLabel} on the way to ${label}.`,
        )
        onSent(balanceSats)
      } catch (err) {
        onFail(err instanceof Error ? err.message : String(err))
        try {
          onSent(await refreshSpendableBalance())
        } catch {
          // ignore — the failure is already reported
        }
      }
    })()
  }

  useWalletActionDock(
    sendSnap.matches('editing')
      ? {
          ariaLabel: 'Send actions',
          secondary: {
            label: 'Cancel',
            onClick: onClose,
            icon: <CloseIcon size={18} />,
            tone: 'danger',
          },
          primary: destReady
            ? {
                label: reviewBusy ? 'Checking…' : 'Review',
                onClick: () => void goReview(),
                disabled: !canReview,
                icon: <CheckIcon size={18} />,
                tone: 'primary',
              }
            : {
                label: 'Continue',
                onClick: () => openMarketSwap(buildSellBsvSwapUrl(destAssetId)),
                icon: <CheckIcon size={18} />,
                tone: 'primary',
              },
        }
      : sendSnap.matches('confirming')
        ? {
            ariaLabel: 'Confirm transaction',
            secondary: {
              label: 'Cancel',
              onClick: onClose,
              icon: <CloseIcon size={18} />,
              tone: 'danger',
            },
            primary: {
              label: 'Confirm',
              onClick: confirmSend,
              disabled: !destReady,
              icon: <CheckIcon size={18} />,
              tone: 'primary',
            },
          }
        : {
            ariaLabel: 'Send failure actions',
            secondary: {
              label: 'Close',
              onClick: onClose,
              icon: <CloseIcon size={18} />,
            },
            primary: {
              label: 'Edit',
              onClick: () => send({ type: 'BACK' }),
              icon: <CheckIcon size={18} />,
              tone: 'primary',
            },
          },
  )

  return (
    <div className="nav-child-panel send-panel" data-aeon-scope="send" data-aeon-state={sendState}>
      {offlineBlock ? (
        <p className="wallet-sync-note is-error" role="alert">
          {offlineBlock}
        </p>
      ) : null}
      {sendSnap.matches('editing') && (
        <AssetPicker
          label="Coin"
          value={coinValue}
          options={coinOptions}
          onChange={(next) => {
            playWalletSound('soft')
            if (next.startsWith('swap:')) {
              const code = next.slice('swap:'.length)
              setDestAssetId(code)
              openMarketSwap(buildSellBsvSwapUrl(code))
              return
            }
            // A recipient means one network; never carry it to the other.
            handleResolveRef.current.cancel()
            setRecipientQuery('')
            setShowFriendMatches(false)
            setAmountDraft('')
            send({ type: 'EDIT', to: '', amount: '', friendLabel: null, payeeIdentityKey: null })
            setDestAssetId('bsv')
            setNetwork(next as MarketCoin)
          }}
        />
      )}
      {sendSnap.matches('editing') && (
        <div className="send-stage send-stage-edit">
          <div className="send-layout">
            <header className="send-panel-intro">
              <h3 className="send-panel-title">{`Send ${ticker}`}</h3>
            </header>

            <div className="send-amount-hero" data-currency={currency}>
              <label htmlFor="amount" className="send-amount-label">
                Amount
              </label>
              <div className="send-amount-row">
                <span className="send-amount-prefix" aria-hidden>
                  {currency === 'usd' ? fiatSymbol : ticker}
                </span>
                <input
                  id="amount"
                  className="send-amount-input"
                  {...amountInputProps(amountPad)}
                  value={amountDraft}
                  onChange={(e) => setAmountDraft(e.target.value)}
                  onBlur={() => syncAmountToMachine(amountDraft)}
                  placeholder="0"
                  autoFocus
                  aria-label={
                    currency === 'usd'
                      ? `Amount in ${fiatOption.name}`
                      : `Amount in ${ticker}`
                  }
                  aria-invalid={overHeld || undefined}
                />
              </div>
              <div className="send-currency-toggle" role="group" aria-label="Amount currency">
                <button
                  type="button"
                  className="send-currency-opt"
                  data-active={currency === 'usd' ? '' : undefined}
                  aria-pressed={currency === 'usd'}
                  onClick={() => setSendCurrency('usd')}
                >
                  {fiatOption.iso}
                </button>
                <button
                  type="button"
                  className="send-currency-opt"
                  data-active={currency === 'bsv' ? '' : undefined}
                  aria-pressed={currency === 'bsv'}
                  onClick={() => setSendCurrency('bsv')}
                >
                  {ticker}
                </button>
              </div>
              <div className="send-amount-note" aria-live="polite">
                {currency === 'usd' && coinUsd == null ? (
                  <span className="send-amount-warning">
                    {fiatOption.iso} rate unavailable — switch to {ticker} or refresh
                  </span>
                ) : overHeld ? (
                  <span className="send-amount-warning">
                    More than this wallet can send on {isArcUsd ? 'Arc' : coinInfo?.label}
                  </span>
                ) : amountSecondary ? (
                  <span className="send-amount-secondary">≈ {amountSecondary}</span>
                ) : null}
              </div>
              <p className="send-available">
                {isArcUsd ? (
                  <>
                    Available {formatUsdcAtoms(heldUnits)} USDC
                    {` · ${formatUsd(Number(heldUnits) / 10 ** ARC_USD_DECIMALS)}`}
                    {' · less the Arc fee'}
                  </>
                ) : coin && coinInfo ? (
                  <>
                    Available {formatCoin(coin, heldUnits)} {ticker}
                    {usdPerCoin != null ? ` · ${formatUsd(coinUnitsUsd(coin, heldUnits, usdPerCoin) ?? 0)}` : ''}
                    {` · less the ${coinInfo.label} fee`}
                  </>
                ) : (
                  <>
                    Available {formatPrimaryFromSats(balanceSats, currency, usdPerBsv)} ·{' '}
                    {formatSecondaryFromSats(balanceSats, currency, usdPerBsv)}
                  </>
                )}
                {reviewBusy ? ' · refreshing…' : ''}
              </p>
              {amountPad ? (
                <AmountPad
                  label="Amount keypad"
                  value={amountDraft}
                  onChange={(next) => {
                    setAmountDraft(next)
                    syncAmountToMachine(next)
                  }}
                />
              ) : null}
            </div>

            <div className="send-side">
              <div className="field friend-recipient-field send-to-field">
                <label htmlFor="to">To</label>
                {scanningTo ? (
                  <RecipientQrScan
                    onCancel={() => {
                      playWalletSound('soft')
                      releaseWarmedQrCamera()
                      setScanningTo(false)
                    }}
                    onValue={(value) => {
                      applyRecipientInput(value)
                      releaseWarmedQrCamera()
                      setScanningTo(false)
                    }}
                  />
                ) : (
                  <div className="send-to-input">
                    <input
                      id="to"
                      value={recipientQuery}
                      onChange={(e) => applyRecipientInput(e.target.value)}
                      onFocus={() => setShowFriendMatches(true)}
                      onBlur={() => {
                        window.setTimeout(() => setShowFriendMatches(false), 120)
                      }}
                      placeholder={
                        isArcUsd
                          ? '0x Arc address'
                          : coinInfo
                            ? `Friend, $handle, wallet key, or ${coinInfo.label} address (${coinInfo.addressHint})`
                            : 'Friend, $handle, peerpay:, address, or wallet key'
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="send-to-scan"
                      aria-label="Scan address QR"
                      title="Scan address QR"
                      onClick={() => {
                        playWalletSound('soft')
                        setShowFriendMatches(false)
                        setScanningTo(true)
                      }}
                    >
                      <ScanQrIcon size={18} />
                    </button>
                  </div>
                )}
                {resolvedName ? (
                  <p className="send-resolved" aria-live="polite">
                    Sending to <strong>{resolvedName}</strong>
                  </p>
                ) : null}
                {showFriendMatches && friendMatches.length > 0 ? (
                  <ul className="friend-suggest-list send-friend-suggest" role="listbox">
                    {friendMatches.map((friend) => (
                      <li key={friend.id}>
                        <ListRow.Root
                          as="button"
                          type="button"
                          className="friend-suggest-item"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => selectFriend(friend)}
                        >
                          <ListRow.Leading className="friend-suggest-leading" aria-hidden>
                            <FriendsIcon size={16} />
                          </ListRow.Leading>
                          <span className="friend-suggest-copy">
                            <ListRow.Label>{friend.label}</ListRow.Label>
                            <ListRow.Description className="mono">
                              {friend.identityKey.slice(0, 16)}…
                            </ListRow.Description>
                          </span>
                        </ListRow.Root>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <p className="send-eta-row" data-ready={destReady ? '' : undefined}>
                <span className="send-eta-label">Arrival</span>
                <strong className="send-eta-value">{destAsset.eta}</strong>
              </p>
              {!destReady ? (
                <p className="send-dest-soon" role="status">
                  Opening swap to send BSV as {destAsset.label}…
                </p>
              ) : null}

            </div>
          </div>
        </div>
      )}

      {sendSnap.matches('confirming') && (
        <div className="send-stage send-stage-confirm">
          <div className="send-layout send-layout-confirm">
            <div className="send-amount-hero">
              <p className="send-eyebrow">You’re sending</p>
              <p className="send-confirm-amount">{amountLabel}</p>
              <div className="send-amount-note">
                {amountSecondary ? (
                  <span className="send-amount-secondary">≈ {amountSecondary}</span>
                ) : null}
              </div>
              <p className="send-eta-row" data-ready="">
                <span className="send-eta-label">{destAsset.label}</span>
                <strong className="send-eta-value">{destAsset.eta}</strong>
              </p>
            </div>
            <div className="send-side">
              <p className="send-confirm-to">
                to <strong>{recipientLabel}</strong>
              </p>
              {sendSnap.context.friendLabel || coin || isArcUsd ? (
                <p className="mono send-confirm-address">{sendSnap.context.to}</p>
              ) : null}
              {isArcUsd ? (
                <p className="send-confirm-note">Plus the Arc network fee. Can't be undone.</p>
              ) : coinInfo ? (
                <p className="send-confirm-note">
                  Plus the {coinInfo.label} network fee. Can't be undone.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {sendSnap.matches('failure') && (
        <div className="send-stage send-stage-failure">
          <div className="send-stage-body send-stage-body-center">
            <p className="send-status-title">Couldn’t send</p>
            <p className="error send-failure-error">{sendSnap.context.error}</p>
          </div>
        </div>
      )}
    </div>
  )
}
