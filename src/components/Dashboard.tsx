import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBsvSignificant } from '../wallet/session'
import { refreshFromChain } from '../wallet/chainIngest'
import { isPhoneShell } from '../wallet/runtimePlatform'
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
} from './icons'
import { WalletAccountMenu } from './WalletAccountMenu'
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
  revokeOrigin,
  subscribeConnectedApps,
  subscribePermissionRequests,
  type ConnectedApp,
} from '../wallet/permissions'
import {
  getEmbeddedAppBrowser,
  getNavState,
  isMessagesNavChild,
  openReceiveFlow,
  openSendFlow,
  subscribeEmbeddedAppBrowser,
  subscribeNav,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { WalletNav } from './WalletNav'
import { DashboardSideColumn } from './DashboardSideColumn'
import { pollDeviceMeshOnce, startDeviceMesh } from '../wallet/deviceMesh'
import { isDeviceParityEnabled } from '../wallet/paymentPolicy'
import { softPullHistoryIfRemoteNewer } from '../wallet/deviceSync'
import { shouldYieldChainIngestToSpend } from '../wallet/walletCoordinator'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { getActiveWallet } from '../wallet/session'
import { identityQrDataUrl } from '../wallet/identityQr'
import { whenRecomposeIdle } from '../wallet/recompose'

/**
 * Messagebox tip-hint poll — independent of the address-scan interval so a
 * peer payment/item hints can kick ingest before the next full chain tick.
 */
// 1.5s produced ~40 messagebox requests/minute and measurable idle renderer
// load. Five seconds keeps peer receives responsive without a permanent hot loop.
const TIP_HINT_POLL_MS = 5_000
/** Empty inbox + idle outbox — stretch the poll so the renderer is not hot forever. */
const TIP_HINT_POLL_IDLE_MS = 20_000
const TIP_HINT_POLL_HIDDEN_MS = 30_000
/** Consecutive empty visible polls before stretching to IDLE_MS. */
const TIP_HINT_IDLE_AFTER_EMPTY = 2
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
 * Stale inbox / chat tip cards must not re-run funding-only Refresh every 5s.
 * pollInboundTipHints also dispatches `handcash:payment-hint`, so the same
 * txids used to be chased twice per tick. New txids still ingest immediately.
 */
const TIP_CHASE_BACKOFF_MS = CHAIN_POLL_DESKTOP_MS

function paymentHintTxid(raw: string | { txid?: string } | null | undefined): string {
  const id = (typeof raw === 'string' ? raw : raw?.txid ?? '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(id) ? id : ''
}

async function ackIngestedPaymentHints(
  hints: Array<{ txid: string; messageId?: string }>,
  spv: { importedTxids: string[]; ghostTxids: string[] },
  rootKeyHex?: string,
): Promise<void> {
  if (spv.importedTxids.length === 0 && spv.ghostTxids.length === 0) return
  const key = rootKeyHex ?? getActiveWallet()?.rootKeyHex
  if (!key) return
  const ackable = new Set([...spv.importedTxids, ...spv.ghostTxids])
  const ids = hints
    .filter((h) => h.messageId && ackable.has(h.txid))
    .map((h) => h.messageId!)
  if (ids.length === 0) return
  const { acknowledgeMessageIds } = await import('../wallet/messageTransport')
  await acknowledgeMessageIds(ids, key)
}

function nextChainPollMs(): number {
  // syncHealth.pendingTips is collectables-awaiting-origin (pill only). Never
  // accelerate full legacy UTXO rescans off that — it looped Syncing while
  // the hero stayed flat. Payment tips use handcash:payment-hint.
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
  onFail: (error: string) => void
  onAccountSwitched: (profile: WalletProfile, balanceSats: number) => void
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

/** Vault master can host multiple account wallets (BRC-146). */
export function Dashboard({
  profile,
  balanceSats,
  onSent,
  onRefreshBalance,
  onFail,
  onAccountSwitched,
}: Props) {
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>(() => listConnectedApps())
  const [contentFullscreen, setContentFullscreen] = useState(() => {
    const child = getNavState().child
    return (
      isMessagesNavChild(child) ||
      child?.type === 'app-browser' ||
      Boolean(getEmbeddedAppBrowser() && hasPendingPermissionPrompt())
    )
  })
  const [browserPermissionOpen, setBrowserPermissionOpen] = useState(() => {
    return Boolean(getEmbeddedAppBrowser() && hasPendingPermissionPrompt())
  })

  const onRevoke = useCallback((origin: string) => {
    revokeOrigin(origin)
    setConnectedApps(listConnectedApps())
  }, [])
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())
  const [claimedHandle, setClaimedHandle] = useState<ClaimedHandleState | null>(() =>
    claimedHandleForIdentity(profile.identityKey),
  )
  const balanceSlotRef = useRef<HTMLDivElement>(null)
  const balanceBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])
  useEffect(() => {
    const syncLayout = () => {
      const child = getNavState().child
      const session = getEmbeddedAppBrowser()
      const browsing = child?.type === 'app-browser'
      const browserWithPrompt = Boolean(session && hasPendingPermissionPrompt())
      setContentFullscreen(isMessagesNavChild(child) || browsing || browserWithPrompt)
      setBrowserPermissionOpen(browserWithPrompt)
    }
    const unsubNav = subscribeNav(syncLayout)
    const unsubBrowser = subscribeEmbeddedAppBrowser(() => syncLayout())
    const unsubPerm = subscribePermissionRequests(() => syncLayout())
    return () => {
      unsubNav()
      unsubBrowser()
      unsubPerm()
    }
  }, [])

  useEffect(() => {
    const refresh = () => setClaimedHandle(claimedHandleForIdentity(profile.identityKey))
    refresh()
    return subscribeClaimedCloudHandle(refresh)
  }, [profile.identityKey])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
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

  useEffect(() => {
    const onOnline = () => {
      void refreshFromChain({ forceReview: true, announceReceive: false }).then((sats) => {
        if (sats != null) onRefreshBalance(sats)
      })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address, profile.identityKey])

  useEffect(() => {
    let cancelled = false
    let lastHistoryPull = 0
    let tickInFlight = false
    let pollTimer: number | null = null
    let tipHintTimer: number | null = null
    /** Visible polls with empty inbox + idle outbox — drives IDLE tip cadence. */
    let emptyTipPolls = 0
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
      const delay = delayMs ?? nextChainPollMs()
      pollTimer = window.setTimeout(() => {
        void sync().finally(() => scheduleNext())
      }, delay)
    }

    const nextTipHintDelayMs = (): number => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return TIP_HINT_POLL_HIDDEN_MS
      }
      if (emptyTipPolls >= TIP_HINT_IDLE_AFTER_EMPTY) return TIP_HINT_POLL_IDLE_MS
      return TIP_HINT_POLL_MS
    }

    const scheduleTipHintPoll = (delayMs?: number) => {
      if (cancelled) return
      if (tipHintTimer != null) window.clearTimeout(tipHintTimer)
      const delay = delayMs ?? nextTipHintDelayMs()
      tipHintTimer = window.setTimeout(() => {
        void pollTipHints().finally(() => scheduleTipHintPoll())
      }, delay)
    }

    const noteTipPollActivity = (busy: boolean) => {
      if (busy) emptyTipPolls = 0
      else emptyTipPolls += 1
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
        const {
          flushPendingBrc29Outbox,
          pendingBrc29OutboxCount,
        } = await import('../wallet/pendingBrc29Outbox')
        const {
          flushPendingItemOutbox,
          pendingItemOutboxCount,
        } = await import('../wallet/pendingItemOutbox')
        const outboxBusy =
          pendingBrc29OutboxCount() > 0 || pendingItemOutboxCount() > 0
        await flushPendingBrc29Outbox({ rootKeyHex: active.rootKeyHex })
        await flushPendingItemOutbox({ rootKeyHex: active.rootKeyHex })
        const hints = await pollInboundTipHints({
          rootKeyHex: active.rootKeyHex,
          peerIdForSender: (ik) => map.get(ik.toLowerCase()) ?? null,
        })
        // Inbox cards already dispatch `handcash:payment-hint` inside
        // pollInboundTipHints. Skip the 2MB chat walk on that path.
        if (cancelled) return
        if (hints.tipHints > 0) {
          noteTipPollActivity(true)
          return
        }
        const { ingestPaymentsFromTipHints, pendingBrc29HintsFromChat } =
          await import('../wallet/sendBrc29Payment')
        const fromChat = pendingBrc29HintsFromChat()
        const chatOnly = fromChat.filter((h) => paymentHintTxid(h) !== '')
        if (chatOnly.length === 0) {
          noteTipPollActivity(outboxBusy)
          return
        }
        noteTipPollActivity(true)
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
            await ackIngestedPaymentHints(
              hints.paymentHints,
              spv,
              active.rootKeyHex,
            )
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
      // BRC-33 is the fast seller/payment path. Do not hold inbox delivery
      // behind a full chain scan; on an account switch that left sale receipts
      // sitting in messagebox while the visible seller balance stayed stale.
      scheduleTipHintPoll(0)
      await whenRecomposeIdle()
      if (cancelled) return
      void sync().finally(() => {
        scheduleNext()
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

    // Web timers can be suspended while Android backgrounds the WebView. The
    // native shell emits this on resume so we catch up immediately instead of
    // waiting for the old timeout to become runnable again.
    const onAppActive = () => {
      if (cancelled) return
      // Resume is an automatic catch-up, not an explicit Refresh. A forced
      // spendable audit here made every Android app switch compete with taps,
      // inbox ingest, and token classification on the WebView thread.
      void sync().finally(() => scheduleNext())
      scheduleTipHintPoll(0)
    }
    document.addEventListener('handcash:app-active', onAppActive)

    const onPaymentHint = (ev: Event) => {
      if (cancelled) return
      // Peer tip arrived — leave idle tip cadence immediately.
      emptyTipPolls = 0
      scheduleTipHintPoll(0)
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
          itemOrigin?: string
          itemCollectionId?: string
          itemOutputIndex?: number
          items?: import('../wallet/messageStore').ItemTransferMember[]
          provenance?: import('../wallet/oneSatProvenance').ProvenanceV2
        }>
      }>).detail
      const hints = detail?.hints ?? []
      const txids = detail?.txids ?? hints.map((h) => h.txid)
      // A later card for another output of an already-seen batch is new identity
      // evidence, even though its txid is under the ordinary funding backoff.
      for (const hint of hints) {
        if (Number.isInteger(hint.itemOutputIndex)) {
          chasedAt.delete(paymentHintTxid(hint))
        }
      }
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
          await ackIngestedPaymentHints(chaseHints, spv)
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
  }, [profile.address, profile.identityKey])

  return (
    <section
      className={`dashboard${contentFullscreen ? ' dashboard--chat-fullscreen' : ''}${
        browserPermissionOpen ? ' dashboard--browser-permission' : ''
      }`}
      data-aeon-scope="dashboard"
      data-aeon-state="ready"
    >
      <div className="dashboard-main">
        <div className="panel wallet-hero">
          <div className="connected-panel-head wallet-hero-head">
            <h2 className="wallet-hero-title">Your balance</h2>
            {(() => {
              const identity = walletIdentityChip(profile, claimedHandle)
              if (!identity) return null
              return (
                <WalletAccountMenu
                  profile={profile}
                  identityLabel={identity.label}
                  identityCopy={identity.copy}
                  onAccountSwitched={onAccountSwitched}
                />
              )
            })()}
          </div>
          <div className="wallet-hero-main">
            <div className="wallet-balance-block">
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
            </div>

            <div className="actions wallet-actions">
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  openSendFlow()
                }}
              >
                <SendIcon size={22} />
                <span className="wallet-action-label">Send</span>
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  playWalletSound('soft')
                  openReceiveFlow()
                }}
              >
                <ReceiveIcon size={22} />
                <span className="wallet-action-label">Receive</span>
              </button>
            </div>
          </div>
        </div>

        <WalletNav
          profile={profile}
          apps={connectedApps}
          onSent={onSent}
          onFail={onFail}
          onRevoke={onRevoke}
        />
      </div>

      <DashboardSideColumn profile={profile} />
    </section>
  )
}
