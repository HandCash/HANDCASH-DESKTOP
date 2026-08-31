import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBsvSignificant } from '../wallet/session'
import { refreshFromChain } from '../wallet/chainIngest'
import { isPhoneShell } from '../wallet/runtimePlatform'
import { isMobileWalletPlatform } from '../wallet/isMobilePlatform'
import {
  formatUsdFromSats,
  getCachedUsdPerBsv,
  refreshUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  toggleDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import type { WalletProfile } from '../machines/appMachine'
import {
  SendIcon,
  ReceiveIcon,
  LockIcon,
  AddMoneyIcon,
  ScanQrIcon,
} from './icons'
import { copyText } from '../wallet/clipboard'
import {
  claimedHandleForIdentity,
  subscribeClaimedCloudHandle,
  type ClaimedHandleState,
} from '../wallet/handleClaim'
import { formatHandCashHandle } from '../wallet/handleFormat'
import { buildPeerPayUri, isCompressedIdentityKeyHex } from '../wallet/peerPayUri'
import { useFitFontSize } from './FitSlot'
import {
  listConnectedApps,
  hasPendingPermissionPrompt,
  resolvePermission,
  revokeOrigin,
  subscribeConnectedApps,
  subscribePermissionRequests,
  type ConnectedApp,
  type PendingAction,
  type PendingPrompt,
} from '../wallet/permissions'
import { openReceiveFlow, openScanFlow, openSendFlow, getSideScanOpen, subscribeSideScan } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastSuccess } from '../wallet/toast'
import { appDisplayName } from '../wallet/appIdentity'
import { setAutoPaySettings } from '../wallet/autoPay'
import { releaseWarmedQrCamera } from '../wallet/qrCameraWarm'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { ScanPanel } from './ScanPanel'
import { WalletNav } from './WalletNav'
import { RecentActivityPanel } from './RecentActivity'
import { PermissionRequestPanel } from './PermissionRequestPanel'
import { PermissionItemPreview } from './PermissionItemPreview'
import {
  clearPaymentProgress,
  getPaymentProgress,
  marketBusyCopy,
  setPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../wallet/paymentProgress'
import { pollDeviceMeshOnce, startDeviceMesh } from '../wallet/deviceMesh'
import { isDeviceParityEnabled } from '../wallet/paymentPolicy'
import { softPullHistoryIfRemoteNewer } from '../wallet/deviceSync'
import { shouldYieldChainIngestToSpend } from '../wallet/walletCoordinator'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { getActiveWallet } from '../wallet/session'
import { ADD_MONEY_URL } from '../wallet/walletConfig'
import { identityQrDataUrl } from '../wallet/identityQr'
import { getSyncHealth, subscribeSyncHealth } from '../wallet/walletHealth'
import { whenRecomposeIdle } from '../wallet/recompose'

/**
 * Messagebox tip-hint poll — independent of the address-scan interval so a
 * peer payment/item hints can kick ingest before the next full chain tick.
 */
// 1.5s produced ~40 messagebox requests/minute and measurable idle renderer
// load. Five seconds keeps peer receives responsive without a permanent hot loop.
const TIP_HINT_POLL_MS = 5_000
const TIP_HINT_POLL_HIDDEN_MS = 30_000
/** Cloud history is a full encrypted replica merge, not a presence heartbeat. */
const HISTORY_PULL_INTERVAL_MS = 5 * 60_000
/**
 * Address scans return the complete P2PKH UTXO set. Large ordinal wallets can
 * produce hundreds of thousands of rows, so hidden windows must not continuously
 * download and parse that set. Messagebox hints remain on their lightweight loop.
 */
const CHAIN_POLL_HIDDEN_MS = 15 * 60_000
/**
 * Foreground fallback for sends that did not provide a BRC-29/item hint.
 * Direct peer receives still ingest from the 5s hint poll; explicit Refresh runs
 * immediately. Keeping the complete address scan at two minutes prevents the
 * 800k-item stress wallet from living in a permanent parse/GC loop.
 */
const CHAIN_POLL_PHONE_MS = 2 * 60_000
const CHAIN_POLL_DESKTOP_MS = 2 * 60_000
/** Device parity has its own history cadence; it does not need faster chain scans. */
const CHAIN_POLL_PARITY_MS = 2 * 60_000
/**
 * Pending hints may be waiting on BEEF/indexer propagation. Retry promptly but
 * never turn a complete address scan into a hot loop.
 */
const CHAIN_POLL_PENDING_MS = 30_000
/**
 * Stale inbox / chat tip cards must not re-run funding-only Refresh every 5s.
 * pollInboundTipHints also dispatches `handcash:payment-hint`, so the same
 * txids used to be chased twice per tick. New txids still ingest immediately.
 */
const TIP_CHASE_BACKOFF_MS = CHAIN_POLL_DESKTOP_MS

function paymentHintTxid(raw: string | { txid?: string } | null | undefined): string {
  const id = (typeof raw === 'string' ? raw : raw?.txid ?? '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(id) ? id : ''
}

function nextChainPollMs(pendingTips: number): number {
  if (pendingTips > 0) return CHAIN_POLL_PENDING_MS
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return CHAIN_POLL_HIDDEN_MS
  }
  if (isDeviceParityEnabled()) return CHAIN_POLL_PARITY_MS
  return isPhoneShell() ? CHAIN_POLL_PHONE_MS : CHAIN_POLL_DESKTOP_MS
}

type Props = {
  profile: WalletProfile
  balanceSats: number
  onSent: (balanceSats: number) => void
  onRefreshBalance: (balanceSats: number) => void
  onLock: () => void
  onFail: (error: string) => void
}

function shortIdentityLabel(key: string): string {
  const k = key.trim()
  if (k.length <= 16) return k
  return `${k.slice(0, 8)}…${k.slice(-6)}`
}

/** Handle, then BRC-169 identity key, then PeerPay. One label only. */
function walletIdentityChip(
  profile: WalletProfile,
  claimed: ClaimedHandleState | null,
): { label: string; copy: string } | null {
  if (claimed?.handle) {
    const label = formatHandCashHandle(claimed.handle, null)
    if (label) return { label, copy: label }
  }
  const key = profile.identityKey.trim()
  if (isCompressedIdentityKeyHex(key)) {
    return { label: shortIdentityLabel(key), copy: key }
  }
  try {
    const uri = buildPeerPayUri(key)
    return { label: `peerpay:${shortIdentityLabel(key)}`, copy: uri }
  } catch {
    return null
  }
}

/** One identity / one pot (BRC-75). */
export function Dashboard({
  profile,
  balanceSats,
  onSent,
  onRefreshBalance,
  onLock,
  onFail,
}: Props) {
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>(() => listConnectedApps())
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [paymentProgress, setPaymentProgressState] = useState<PaymentProgress>(() =>
    getPaymentProgress(),
  )
  const [lastApproved, setLastApproved] = useState<PendingAction | null>(null)
  const [claimedHandle, setClaimedHandle] = useState<ClaimedHandleState | null>(() =>
    claimedHandleForIdentity(profile.identityKey),
  )
  const balanceSlotRef = useRef<HTMLDivElement>(null)
  const balanceBtnRef = useRef<HTMLButtonElement>(null)
  const sideRef = useRef<HTMLElement>(null)
  const sideBusy =
    !isMobileWalletPlatform() &&
    (pendingPrompt != null || paymentProgress.phase !== 'idle')
  const sideApproval = !isMobileWalletPlatform() && pendingPrompt != null

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])

  useEffect(() => {
    const refresh = () => setClaimedHandle(claimedHandleForIdentity(profile.identityKey))
    refresh()
    return subscribeClaimedCloudHandle(refresh)
  }, [profile.identityKey])
  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribePermissionRequests(setPendingPrompt)
  }, [])
  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribePaymentProgress(setPaymentProgressState)
  }, [])
  useEffect(() => {
    if (pendingPrompt) setLastApproved(null)
  }, [pendingPrompt?.id])
  useEffect(() => {
    if (!sideBusy || !sideRef.current) return
    sideRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [sideBusy, pendingPrompt?.id, paymentProgress.phase])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])

  const onPermissionAllow = useCallback(
    (autoPay?: { enabled: boolean; maxUsd: number; windowHours: number }) => {
      if (!pendingPrompt) return false
      if (!resolvePermission(pendingPrompt.id, 'allow')) return false
      if (autoPay) setAutoPaySettings(pendingPrompt.origin, autoPay)
      const name = appDisplayName(pendingPrompt.origin)
      // Mutating action requests stay represented after approval. In
      // particular, a market listing can spend/sign/broadcast for several
      // seconds; dropping the prompt with no Working state made Approve look
      // non-blocking and encouraged repeat submissions.
      if (
        pendingPrompt.kind === 'action' &&
        (pendingPrompt.method === 'createAction' ||
          pendingPrompt.method === 'signAction' ||
          pendingPrompt.method === 'createMarketListingAdvert' ||
          pendingPrompt.method === 'createCancelMarketListingAdvert' ||
          pendingPrompt.method === 'purchaseMarketListing')
      ) {
        setLastApproved(pendingPrompt)
        const market = marketBusyCopy(pendingPrompt.method)
        setPaymentProgress(
          'preparing',
          market?.detail ?? 'Starting…',
          pendingPrompt.itemOutpoint,
          market?.label,
        )
      } else if (
        pendingPrompt.kind === 'action' &&
        getPaymentProgress().detail === 'Starting…'
      ) {
        // Recover from a prior View-items approve that left Working stuck.
        clearPaymentProgress()
        setLastApproved(null)
      }
      playWalletSound('connect')
      if (pendingPrompt.kind === 'connect') {
        toastSuccess('Connected', `${name} can use your wallet`)
      } else {
        toastSuccess('Approved', pendingPrompt.title || name)
      }
      return true
    },
    [pendingPrompt],
  )

  const onPermissionDeny = useCallback(() => {
    if (!pendingPrompt) return false
    if (!resolvePermission(pendingPrompt.id, 'deny')) return false
    playWalletSound('deny')
    return true
  }, [pendingPrompt])
  useEffect(() => {
    return startDeviceMesh(profile.identityKey)
  }, [profile.identityKey])
  useEffect(() => {
    // Mobile uses this lifecycle to keep the unlocked wallet's foreground
    // service alive while Android backgrounds the WebView.
    document.dispatchEvent(new Event('handcash:wallet-unlocked'))
    return () => {
      document.dispatchEvent(new Event('handcash:wallet-locked'))
    }
  }, [])
  useEffect(() => {
    // First Identity tab visit used to block ~3s generating this QR on a phone.
    void identityQrDataUrl(profile.identityKey)
  }, [profile.identityKey])

  const hostScanInSide = !isPhoneShell()
  const [sideScanOpen, setSideScanOpen] = useState(
    () => hostScanInSide && getSideScanOpen(),
  )
  useEffect(() => {
    if (!hostScanInSide) {
      setSideScanOpen(false)
      return
    }
    return subscribeSideScan((open) => {
      setSideScanOpen(open)
      if (!open) releaseWarmedQrCamera()
    })
  }, [hostScanInSide])

  useEffect(() => {
    void refreshUsdPerBsv()
    const id = window.setInterval(() => {
      void refreshUsdPerBsv()
    }, 5 * 60_000)
    return () => window.clearInterval(id)
  }, [])

  const usdLabel = formatUsdFromSats(balanceSats, usdPerBsv)
  const bsvLabel = formatBsvSignificant(balanceSats, 5)

  useFitFontSize(balanceSlotRef, balanceBtnRef, {
    maxPx: 28,
    minPx: 8,
    watch: `${currency}|${usdLabel}|${bsvLabel}`,
  })

  const addMoney = () => {
    playWalletSound('soft')
    void window.handcash?.openExternal?.(ADD_MONEY_URL)
  }

  useEffect(() => {
    const onOnline = () => {
      void refreshFromChain({ forceReview: true, announceReceive: false }).then((sats) => {
        if (sats != null) onRefreshBalance(sats)
      })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address])

  useEffect(() => {
    let cancelled = false
    let lastHistoryPull = 0
    let tickInFlight = false
    let pollTimer: number | null = null
    let tipHintTimer: number | null = null
    let scheduledDelayMs = 0
    const chasedAt = new Map<string, number>()
    const chaseHeld = new Set<string>()

    const takeChaseable = (txids: Iterable<string>): string[] => {
      const now = Date.now()
      const out: string[] = []
      const seen = new Set<string>()
      for (const raw of txids) {
        const id = paymentHintTxid(raw)
        if (!id || seen.has(id)) continue
        seen.add(id)
        if (chaseHeld.has(id)) continue
        if (now - (chasedAt.get(id) ?? 0) < TIP_CHASE_BACKOFF_MS) continue
        chaseHeld.add(id)
        out.push(id)
      }
      return out
    }

    const releaseChase = (txids: Iterable<string>, remember: boolean) => {
      const now = Date.now()
      for (const raw of txids) {
        const id = paymentHintTxid(raw)
        if (!id) continue
        chaseHeld.delete(id)
        if (remember) chasedAt.set(id, now)
      }
    }

    const scheduleNext = (delayMs?: number) => {
      if (cancelled) return
      if (pollTimer != null) window.clearTimeout(pollTimer)
      const delay = delayMs ?? nextChainPollMs(getSyncHealth().pendingTips)
      scheduledDelayMs = delay
      pollTimer = window.setTimeout(() => {
        void sync().finally(() => scheduleNext())
      }, delay)
    }

    const scheduleTipHintPoll = (delayMs?: number) => {
      if (cancelled) return
      if (tipHintTimer != null) window.clearTimeout(tipHintTimer)
      const hidden =
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
      const delay =
        delayMs ?? (hidden ? TIP_HINT_POLL_HIDDEN_MS : TIP_HINT_POLL_MS)
      tipHintTimer = window.setTimeout(() => {
        void pollTipHints().finally(() => scheduleTipHintPoll())
      }, delay)
    }

    let ingestInFlight = false
    const pollTipHints = async () => {
      if (cancelled) return
      if (hasPendingPermissionPrompt()) return
      if (shouldYieldChainIngestToSpend()) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }
      let chaseable: string[] = []
      try {
        const active = getActiveWallet()
        if (!active?.rootKeyHex) return
        const { pollInboundTipHints } = await import('../wallet/messageTransport')
        const { listFriends } = await import('../wallet/friends')
        const map = new Map(
          listFriends().map((f) => [f.identityKey.toLowerCase(), f.id]),
        )
        const { flushPendingBrc29Outbox } = await import(
          '../wallet/pendingBrc29Outbox'
        )
        await flushPendingBrc29Outbox({ rootKeyHex: active.rootKeyHex })
        const hints = await pollInboundTipHints({
          rootKeyHex: active.rootKeyHex,
          peerIdForSender: (ik) => map.get(ik.toLowerCase()) ?? null,
        })
        // Inbox cards already dispatch `handcash:payment-hint` inside
        // pollInboundTipHints. Skip the 2MB chat walk on that path.
        if (cancelled) return
        if (hints.tipHints > 0) return
        const { ingestPaymentsFromTipHints, pendingBrc29HintsFromChat } =
          await import('../wallet/sendBrc29Payment')
        const fromChat = pendingBrc29HintsFromChat()
        const chatOnly = fromChat.filter((h) => paymentHintTxid(h) !== '')
        if (chatOnly.length === 0) return
        const combined = chatOnly
        const chaseable = takeChaseable(combined.map((h) => h.txid))
        if (chaseable.length === 0) return
        if (ingestInFlight) {
          releaseChase(chaseable, false)
          return
        }
        ingestInFlight = true
        // SPV-first: tip/pay card hands us the txid → BEEF → sweep our outs.
        // Address scan is only the fallback / secondary verify.
        void (async () => {
          try {
            const spv = await ingestPaymentsFromTipHints(
              combined.filter((h) => chaseable.includes(paymentHintTxid(h))),
            )
            if (cancelled) return
            if (spv.balanceSats != null) onRefreshBalance(spv.balanceSats)
            if (spv.importedTxids.length > 0 || spv.ghostTxids.length > 0) {
              const ackable = new Set([...spv.importedTxids, ...spv.ghostTxids])
              const ids = hints.paymentHints
                .filter((h) => h.messageId && ackable.has(h.txid))
                .map((h) => h.messageId!)
              if (ids.length > 0) {
                const { acknowledgeMessageIds } = await import(
                  '../wallet/messageTransport'
                )
                await acknowledgeMessageIds(ids, active.rootKeyHex)
              }
            }
            if (spv.imported > 0) {
              scheduleNext()
              return
            }
            await chasePaymentIngest(chaseable)
            scheduleNext()
          } catch (err) {
            console.warn(
              '[dashboard] SPV payment ingest failed',
              err instanceof Error ? err.message : String(err),
            )
            await chasePaymentIngest(chaseable)
            scheduleNext()
          } finally {
            ingestInFlight = false
            releaseChase(chaseable, true)
          }
        })()
      } catch {
        releaseChase(chaseable, false)
        /* optional accelerator */
      }
    }

    /**
     * After a DM tip/pay notify: SPV-chase the tipped txids first, then a few
     * funding-only address scans if the indexer still lags (~6s). Full Refresh
     * (ordinals + audit) is not needed to credit a payment.
     */
    const chasePaymentIngest = async (paymentTxids: string[]) => {
      const { fetchBalanceSats } = await import('../wallet/session')
      let before = 0
      try {
        const w = getActiveWallet()
        if (w) before = await fetchBalanceSats(w.wallet)
      } catch {
        /* ignore */
      }

      const tipIds = [...new Set(paymentTxids.map(paymentHintTxid).filter(Boolean))]
      if (tipIds.length > 0) {
        try {
          const { ingestPaymentsFromTipHints } = await import(
            '../wallet/sendBrc29Payment'
          )
          const spv = await ingestPaymentsFromTipHints(tipIds)
          if (cancelled) return
          if (spv.balanceSats != null) onRefreshBalance(spv.balanceSats)
          if (spv.imported > 0) return
          if (spv.balanceSats != null && spv.balanceSats > before) return
        } catch (err) {
          console.warn(
            '[dashboard] chase SPV ingest failed',
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (cancelled) return
        if (hasPendingPermissionPrompt() || shouldYieldChainIngestToSpend()) {
          await new Promise((r) => window.setTimeout(r, 750))
          continue
        }
        while (tickInFlight && !cancelled) {
          await new Promise((r) => window.setTimeout(r, 200))
        }
        if (cancelled) return
        tickInFlight = true
        try {
          const sats = await refreshFromChain({
            fundingOnly: true,
            audit: false,
            announceReceive: true,
          })
          if (cancelled) return
          if (sats != null) onRefreshBalance(sats)
          if (sats != null && sats > before) return
        } finally {
          tickInFlight = false
        }
        let after = before
        try {
          const w = getActiveWallet()
          if (w) after = await fetchBalanceSats(w.wallet)
        } catch {
          /* ignore */
        }
        if (after > before) return
        if (attempt < 2) {
          await new Promise((r) => window.setTimeout(r, 1_500))
        }
      }
    }

    const sync = async (opts?: { forceReview?: boolean }) => {
      // Skip overlapping poll ticks — prior soft-pull + chain sync must finish.
      if (tickInFlight) return
      // Don't fight the permission UI / createAction bridge reply.
      if (hasPendingPermissionPrompt()) return
      // A send is queued or running — leave the FIFO free, but retry soon so
      // Syncing cannot starve after the spend finishes.
      if (shouldYieldChainIngestToSpend()) {
        scheduleNext(750)
        return
      }
      tickInFlight = true
      try {
        // Parity devices merge strictly-newer cloud history before reading the chain,
        // so the balance stays current without an explicit Refresh.
        if (
          isDeviceParityEnabled() &&
          getSessionBackupPassword() &&
          Date.now() - lastHistoryPull >= HISTORY_PULL_INTERVAL_MS
        ) {
          lastHistoryPull = Date.now()
          await softPullHistoryIfRemoteNewer()
          if (cancelled) return
          if (shouldYieldChainIngestToSpend()) {
            scheduleNext(750)
            return
          }
        }
        // Background polls never audit: reviewSpendableOutputs is report-only and
        // was colliding with nav taps right after unlock. Manual Refresh / online
        // recovery still force the audit.
        const sats = await refreshFromChain({
          audit: opts?.forceReview === true,
          forceReview: opts?.forceReview === true,
        })
        if (cancelled) return
        if (sats != null) onRefreshBalance(sats)
        void pollDeviceMeshOnce()
      } finally {
        tickInFlight = false
      }
    }

    // Phone shells defer the first poll so unlock taps are not fighting BEEF
    // internalization. Desktop starts immediately — yieldToUi already keeps the
    // UI live, and the old idle wait made desktop sync feel slower than mobile.
    let idleHandle: number | null = null
    let deferTimer: number | null = null
    const startFirst = async () => {
      if (cancelled) return
      await whenRecomposeIdle()
      if (cancelled) return
      void sync().finally(() => {
        scheduleNext()
        scheduleTipHintPoll(0)
      })
    }
    if (isPhoneShell()) {
      if (typeof requestIdleCallback === 'function') {
        idleHandle = requestIdleCallback(startFirst, { timeout: 2500 }) as unknown as number
      } else {
        deferTimer = window.setTimeout(startFirst, 1200)
      }
    } else {
      deferTimer = window.setTimeout(startFirst, 0)
    }

    // If a tip becomes pending mid-wait, collapse a quiet interval immediately.
    const unsubHealth = subscribeSyncHealth((health) => {
      if (cancelled || tickInFlight || health.pendingTips <= 0) return
      if (pollTimer == null) return
      if (scheduledDelayMs <= CHAIN_POLL_PENDING_MS) return
      scheduleNext(CHAIN_POLL_PENDING_MS)
    })

    // Web timers can be suspended while Android backgrounds the WebView. The
    // native shell emits this on resume so we catch up immediately instead of
    // waiting for the old timeout to become runnable again.
    const onAppActive = () => {
      if (cancelled) return
      void sync({ forceReview: true }).finally(() => scheduleNext())
      scheduleTipHintPoll(0)
    }
    document.addEventListener('handcash:app-active', onAppActive)

    const onPaymentHint = (ev: Event) => {
      if (cancelled) return
      const detail = (ev as CustomEvent<{
        txids?: string[]
        hints?: Array<{
          txid: string
          messageId?: string
          senderIdentityKey?: string
          satoshis?: number
          brc29?: {
            derivationPrefix: string
            derivationSuffix: string
            outputIndex?: number
          }
          beefUrl?: string
          tx?: number[]
          item?: boolean
          itemName?: string
        }>
      }>).detail
      const hints = detail?.hints ?? []
      const txids = detail?.txids ?? hints.map((h) => h.txid)
      const chaseable = takeChaseable(txids)
      if (chaseable.length === 0) return
      const chaseHints = hints.filter((h) => chaseable.includes(paymentHintTxid(h)))
      void (async () => {
        try {
          const { ingestPaymentsFromTipHints } = await import(
            '../wallet/sendBrc29Payment'
          )
          const spv = await ingestPaymentsFromTipHints(
            chaseHints.length > 0 ? chaseHints : chaseable,
          )
          if (cancelled) return
          if (spv.balanceSats != null) onRefreshBalance(spv.balanceSats)
          if (spv.importedTxids.length > 0 || spv.ghostTxids.length > 0) {
            const ackable = new Set([...spv.importedTxids, ...spv.ghostTxids])
            const ids = chaseHints
              .filter((h) => h.messageId && ackable.has(h.txid))
              .map((h) => h.messageId!)
            if (ids.length > 0) {
              const active = getActiveWallet()
              if (active?.rootKeyHex) {
                const { acknowledgeMessageIds } = await import(
                  '../wallet/messageTransport'
                )
                await acknowledgeMessageIds(ids, active.rootKeyHex)
              }
            }
          }
          if (spv.imported > 0) {
            scheduleNext()
            return
          }
        } catch {
          /* fall through */
        }
        await chasePaymentIngest(chaseable)
        scheduleNext()
      })().finally(() => releaseChase(chaseable, true))
    }
    document.addEventListener('handcash:payment-hint', onPaymentHint)

    const onVisibility = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      // Foreground again — do not sit on a leftover 30s hidden timer.
      void sync().finally(() => scheduleNext())
      scheduleTipHintPoll(0)
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      unsubHealth()
      document.removeEventListener('handcash:app-active', onAppActive)
      document.removeEventListener('handcash:payment-hint', onPaymentHint)
      document.removeEventListener('visibilitychange', onVisibility)
      if (pollTimer != null) window.clearTimeout(pollTimer)
      if (tipHintTimer != null) window.clearTimeout(tipHintTimer)
      if (idleHandle != null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleHandle)
      }
      if (deferTimer != null) window.clearTimeout(deferTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address])

  return (
    <section className="dashboard" data-aeon-scope="dashboard" data-aeon-state="ready">
      <div className="dashboard-main">
        <div className="panel wallet-hero">
          <div className="connected-panel-head wallet-hero-head">
            <h2 className="wallet-hero-title">Your balance</h2>
            {(() => {
              const identity = walletIdentityChip(profile, claimedHandle)
              if (!identity) return null
              return (
                <button
                  type="button"
                  className="wallet-hero-identity"
                  title={`Click to copy ${identity.copy}`}
                  onClick={() => {
                    playWalletSound('soft')
                    void copyText(identity.copy, { label: 'identity' })
                  }}
                >
                  <span>{identity.label}</span>
                </button>
              )
            })()}
          </div>
          <div className="wallet-hero-main">
            <div className="wallet-balance-slot" ref={balanceSlotRef}>
              <button
                ref={balanceBtnRef}
                type="button"
                className="wallet-balance"
                data-aeon-part="balance"
                data-aeon-state={currency}
                aria-label={
                  currency === 'usd'
                    ? 'Balance in USD. Click to show BSV first.'
                    : 'Balance in BSV. Click to show USD first.'
                }
                title="Click to swap currency"
                onClick={() => {
                  playWalletSound('soft')
                  toggleDisplayCurrency()
                }}
              >
                {currency === 'usd' ? (
                  <>
                    <span className="balance balance-primary balance-fiat">{usdLabel}</span>
                    <span className="balance-secondary balance-bsv">{bsvLabel}</span>
                  </>
                ) : (
                  <>
                    <span className="balance balance-primary balance-bsv">{bsvLabel}</span>
                    <span className="balance-secondary balance-fiat">{usdLabel}</span>
                  </>
                )}
              </button>
            </div>

            <div className="actions wallet-actions">
              <button
                className="btn btn-primary btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  openSendFlow()
                }}
              >
                <SendIcon size={16} />
                <span className="wallet-action-label">Send</span>
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  openReceiveFlow()
                }}
              >
                <ReceiveIcon size={16} />
                <span className="wallet-action-label">Receive</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Add money — buy BSV with other crypto"
                title="Buy BSV with other crypto (opens handcash.io in your browser)"
                onClick={addMoney}
              >
                <AddMoneyIcon size={16} />
                <span className="wallet-action-label">Add money</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Scan QR code"
                title="Scan QR code"
                onClick={() => {
                  playWalletSound('soft')
                  openScanFlow()
                }}
              >
                <ScanQrIcon size={16} />
                <span className="wallet-action-label">Scan</span>
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  onLock()
                }}
              >
                <LockIcon size={16} />
                <span className="wallet-action-label">Lock</span>
              </button>
            </div>
          </div>
        </div>

        <WalletNav
          profile={profile}
          apps={connectedApps}
          balanceSats={balanceSats}
          onSent={onSent}
          onFail={onFail}
          onRevoke={(origin) => {
            revokeOrigin(origin)
            setConnectedApps(listConnectedApps())
          }}
        />
      </div>

      <aside
        ref={sideRef}
        className="dashboard-side"
        data-aeon-scope="dashboard-side"
        data-aeon-state={sideBusy ? 'permission' : 'idle'}
      >
        {sideApproval && pendingPrompt ? (
          <section
            className="panel permission-side-panel"
            aria-label="Permission request"
          >
            <PermissionRequestPanel
              pending={pendingPrompt}
              onAllow={onPermissionAllow}
              onDeny={onPermissionDeny}
              actions="inline"
            />
          </section>
        ) : sideBusy ? (
          <section
            className="panel permission-side-panel permission-side-panel--processing"
            aria-label={paymentProgress.label || 'Working'}
            aria-busy="true"
          >
            <div className="send-spinner" aria-hidden />
            <p className="send-status-title">
              {paymentProgress.label || 'Working…'}
            </p>
            <p className="send-status-sub">
              {paymentProgress.detail ||
                (lastApproved
                  ? `${lastApproved.title} — ${appDisplayName(lastApproved.origin)}`
                  : 'Finishing the approved request.')}
            </p>
            {lastApproved?.itemOutpoint || lastApproved?.tokenId || lastApproved?.itemName ? (
              <PermissionItemPreview
                outpoint={lastApproved.itemOutpoint}
                tokenId={lastApproved.tokenId}
                itemName={lastApproved.itemName}
                itemImageUrl={lastApproved.itemImageUrl}
                previewKind={lastApproved.previewKind}
              />
            ) : null}
          </section>
        ) : (
          <>
            {sideScanOpen ? <ScanPanel placement="side" /> : <WhatIsBsvPanel />}
            <RecentActivityPanel chain={profile.chain} />
          </>
        )}
      </aside>
    </section>
  )
}
