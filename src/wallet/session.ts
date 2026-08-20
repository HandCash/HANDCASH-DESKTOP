import { PrivateKey, type ChainTracker, type WalletInterface } from '@bsv/sdk'
import { fetchBlockHeaderForHeight } from './blockHeaders'
import { createFallbackChainTracker } from './chainTrackerFallback'
import { installRawTxFallback } from './rawTxFallback'
import { preferServiceOrder } from './serviceOrder'
import { SetupClient, Wallet, sdk, type Services } from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'
import { BALANCE_DEFAULT_BASKET } from './brc112'
import { clearSessionBackupPassword } from './sessionBackupAuth'
import { isPhoneShell } from './runtimePlatform'
import { appendAppLog } from './appLog'
import { readTrustedBalance, writeTrustedBalance } from './balanceSnapshot'

const { specOpWalletBalance } = sdk

export type ActiveWallet = {
  /** Full toolbox wallet (has balance()). */
  wallet: Wallet
  services: Services
  /** Background proof/header loop — pause during hardened sign to avoid IDB AbortError. */
  monitor?: { stopTasks?: () => void; startTasks?: () => void | Promise<void> }
  rootKeyHex: string
  identityKey: string
  address: string
  handle: string
  chain: Chain
}

let active: ActiveWallet | null = null

/**
 * Route every merkle-root check through the failover tracker.
 *
 * `Services.getChainTracker()` builds a fresh Chaintracks client per call and
 * has no failover, so a single unreachable host silently disables all incoming
 * value. Wrapping the method covers the toolbox's own callers (internalizeAction,
 * verifyInputBeef, the proof monitor) as well as ours.
 */
function installFallbackChainTracker(services: Services, chain: Chain): void {
  try {
    const original = services.getChainTracker.bind(services)
    let cached: ChainTracker | null = null
    services.getChainTracker = async () => {
      if (cached) return cached
      let primary: ChainTracker | null = null
      try {
        primary = await original()
      } catch {
        // Chaintracks not configured at all — WhatsOnChain alone still works.
      }
      cached = createFallbackChainTracker(chain, primary)
      return cached
    }
  } catch (err) {
    console.warn('[chaintracker] could not install fallback', err)
  }
}

/**
 * Give the chain tip its own failover.
 *
 * `Services.getHeight()` does not go through `getChainTracker()` — it reaches
 * past it into `services.options.chaintracks` — and the monitor holds that same
 * object. So when the Chaintracks host answers "At least one bulk ingestor must
 * implement getPresentHeight", the wrapper above never sees the call and every
 * height lookup in the wallet fails. Patching the shared object covers both
 * callers at once.
 */
function installHeightFailover(services: Services, chain: Chain): void {
  try {
    const chaintracks = services.options.chaintracks as
      | { currentHeight?: () => Promise<number> }
      | undefined
    if (typeof chaintracks?.currentHeight !== 'function') return
    const tracker = createFallbackChainTracker(chain, {
      isValidRootForHeight: async () => false,
      currentHeight: chaintracks.currentHeight.bind(chaintracks),
    })
    chaintracks.currentHeight = () => tracker.currentHeight()
  } catch (err) {
    console.warn('[chaintracker] could not install height failover', err)
  }
}

/**
 * Give block-header lookups the same failover as roots and the tip.
 *
 * Internalizing an ordinal records which block its proof belongs to, and that
 * step calls `Services.getHeaderForHeight` — which, like `getHeight()`, reaches
 * past `getChainTracker()` straight into `options.chaintracks`. A host whose
 * store stops short of the tip returns nothing for a freshly mined block, and
 * the toolbox reports it as "The hash parameter must be valid height 'N' on
 * mined chain main". Payments never reach this code path, so the wallet took
 * money in while every collectable bounced.
 */
function installHeaderFailover(services: Services, chain: Chain): void {
  try {
    const chaintracks = services.options.chaintracks as
      | { findHeaderForHeight?: (height: number) => Promise<unknown> }
      | undefined
    if (typeof chaintracks?.findHeaderForHeight !== 'function') return
    const original = chaintracks.findHeaderForHeight.bind(chaintracks)
    chaintracks.findHeaderForHeight = async (height: number) => {
      try {
        const header = await original(height)
        if (header != null) return header
      } catch {
        // Same treatment as a miss: ask someone who can actually answer.
      }
      return (await fetchBlockHeaderForHeight(chain, height)) ?? undefined
    }
  } catch (err) {
    console.warn('[chaintracker] could not install header failover', err)
  }
}

/**
 * Merkle proofs for BEEF — Bitails before WhatsOnChain.
 * Public SPV proofs should not share WhatsOnChain's rate budget with
 * rawtx / UTXO / FX.
 */
function installMerklePreferBitails(services: Services): void {
  try {
    const collection = (
      services as unknown as {
        getMerklePathServices?: { services?: Array<{ name: string }>; reset?: () => void }
      }
    ).getMerklePathServices
    preferServiceOrder(collection, [
      'Bitails',
      'Taal',
      'GorillaPool',
      'WhatsOnChain',
    ])
  } catch (err) {
    console.warn('[merkle] could not prefer Bitails', err)
  }
}

/**
 * Broadcast: Taal / GorillaPool ARC first, then public Bitails / WoC.
 * Arcade stays out of the BRC wallet path (Cloud may still use it).
 * Soft timeouts must stay long enough for ordinal BEEFs — 2.5s races caused
 * false failures and delayed paths that returned ghost txids (WoC 404).
 */
function installPostBeefPreferFast(services: Services): void {
  try {
    const collection = (
      services as unknown as {
        postBeefServices?: { services?: Array<{ name: string }>; reset?: () => void }
      }
    ).postBeefServices
    preferServiceOrder(collection, [
      'TaalArcBeef',
      'GorillaPoolArcBeef',
      'Bitails',
      'WhatsOnChain',
    ])
    const s = services as Services & {
      postBeefUntilSuccessSoftTimeoutMs?: number
      postBeefUntilSuccessSoftTimeoutMaxMs?: number
    }
    if (typeof s.postBeefUntilSuccessSoftTimeoutMs === 'number') {
      s.postBeefUntilSuccessSoftTimeoutMs = isPhoneShell() ? 8_000 : 5_000
    }
    if (typeof s.postBeefUntilSuccessSoftTimeoutMaxMs === 'number') {
      s.postBeefUntilSuccessSoftTimeoutMaxMs = isPhoneShell() ? 30_000 : 20_000
    }
  } catch (err) {
    console.warn('[postBeef] could not prefer ARC broadcasters', err)
  }
}

/**
 * TaskNewHeader polls `findChainTipHeader`. That call skipped our height/header
 * failover and died whenever Chaintracks 500'd — flooding the log with
 * `Failed to fetch` while proofs never solicited. Fall through to Bitails tip
 * + self-proving public headers (same path as ordinal header ingest).
 */
function installTipHeaderFailover(services: Services, chain: Chain): void {
  try {
    const chaintracks = services.options.chaintracks as
      | { findChainTipHeader?: () => Promise<unknown> }
      | undefined
    if (typeof chaintracks?.findChainTipHeader !== 'function') return
    const original = chaintracks.findChainTipHeader.bind(chaintracks)
    let logged = false
    chaintracks.findChainTipHeader = async () => {
      try {
        const tip = await original()
        if (tip != null) return tip
      } catch {
        // Public tip below.
      }
      const tipUrl =
        chain === 'main'
          ? 'https://api.bitails.io/block/latest'
          : chain === 'test'
            ? 'https://test-api.bitails.io/block/latest'
            : null
      if (tipUrl == null) throw new Error('No chain tip header provider')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      try {
        const res = await fetch(tipUrl, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) throw new Error(`tip ${res.status}`)
        const body = (await res.json()) as { height?: number }
        const height = body.height
        if (typeof height !== 'number' || !Number.isFinite(height)) {
          throw new Error('tip missing height')
        }
        const header = await fetchBlockHeaderForHeight(chain, height)
        if (header == null) throw new Error(`no public header at ${height}`)
        if (!logged) {
          logged = true
          appendAppLog(
            'info',
            `[headers] NewHeader tip from Bitails height ${height} (Chaintracks unreachable)`,
          )
        }
        return header
      } finally {
        clearTimeout(timer)
      }
    }
  } catch (err) {
    console.warn('[chaintracker] could not install tip-header failover', err)
  }
}

export function getActiveWallet(): ActiveWallet | null {
  return active
}

export function setActiveWallet(next: ActiveWallet | null): void {
  active = next
}

export function clearActiveWallet(): void {
  active = null
  clearSessionBackupPassword()
}

export async function bootWallet(args: {
  rootKeyHex: string
  handle: string
  chain: Chain
}): Promise<ActiveWallet> {
  const root = PrivateKey.fromHex(args.rootKeyHex)
  const identityKey = root.toPublicKey().toString()
  const address = root.toAddress()

  const setup = await SetupClient.createWalletIdb({
    chain: args.chain,
    rootKeyHex: args.rootKeyHex,
    databaseName: `handcash-brc100-${args.chain}-${args.handle}`,
  })

  installFallbackChainTracker(setup.services as Services, args.chain)
  installHeightFailover(setup.services as Services, args.chain)
  installHeaderFailover(setup.services as Services, args.chain)
  installTipHeaderFailover(setup.services as Services, args.chain)
  installMerklePreferBitails(setup.services as Services)
  installPostBeefPreferFast(setup.services as Services)
  installRawTxFallback(setup.services as Services, args.chain)

  try {
    // MonitorCallHistory JSON.stringifies the entire services call log and writes
    // it to IndexedDB on every first runAfter unlock. That blocked the WebView for
    // ~3s while the user tapped nav (every crash log: TaskMonitorCallHistory → stall).
    setup.monitor?.removeTask?.('MonitorCallHistory')
    // ReviewProvenTxs is a lagged backup audit for reorgs that TaskReorg already
    // handles from header events. It resumes from the last height it recorded,
    // and a wallet that has never completed a run starts at block 0 — 100 header
    // lookups a minute, forever, none of them about our transactions. That load
    // competes with deposit lookups on the same rate-limited providers.
    setup.monitor?.removeTask?.('ReviewProvenTxs')
  } catch {
    // optional task
  }

  // Defer the remaining monitor loop so unlock + first taps are not racing
  // TaskNewHeader / proofs / IDB writes on the UI thread. Phone shells wait
  // longer; desktop only needs a short tick so unlock stays responsive.
  const startMonitor = () => {
    try {
      void setup.monitor?.startTasks?.()
    } catch {
      // optional
    }
  }
  if (isPhoneShell()) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(startMonitor, { timeout: 8_000 })
    } else {
      setTimeout(startMonitor, 3_000)
    }
  } else {
    setTimeout(startMonitor, 400)
  }

  active = {
    wallet: setup.wallet,
    services: setup.services as Services,
    monitor: setup.monitor
      ? {
          stopTasks: () => setup.monitor?.stopTasks?.(),
          startTasks: () => setup.monitor?.startTasks?.(),
        }
      : undefined,
    rootKeyHex: args.rootKeyHex,
    identityKey: setup.identityKey || identityKey,
    address,
    handle: args.handle,
    chain: args.chain,
  }
  // Cold start begins with the last balance actually read for this identity,
  // never another wallet's figure and never a fabricated address balance.
  lastKnownBalanceSats = readTrustedBalance(active.identityKey, active.chain)
  lastBalanceBreakdown = ''
  return active
}

/**
 * Displayed owned cash. Toolbox `balance()` is only the spendable set; in-flight
 * change of a live local send is credited on top so Sending does not drop by
 * payment + change. See `balanceView.ts`.
 *
 * `creditUnconfirmed` defaults to true (hero / Activity). The send gate passes
 * `false` when it only needs confirmed spendable — scanning the unspendable
 * graveyard is then wasted IndexedDB work on every tap of Send.
 */
export type BalanceRead =
  | { kind: 'ok'; sats: number }
  /**
   * Every spendable-read strategy failed. This is **not** proof of an empty
   * wallet — under heavy IndexedDB contention all four can time out at once.
   * Callers must never render or spend against this as zero.
   */
  | { kind: 'unavailable'; reason: 'noWallet' | 'storageUnreadable' }

/**
 * Last balance actually read from storage, for the hero number only.
 *
 * Showing `$0.00` because a read failed is the single most alarming thing a
 * wallet can do, so a failed read falls back to the last real figure instead
 * of inventing a zero. Spend gates must not use this — they take the tagged
 * `fetchBalanceRead` and fail closed.
 */
let lastKnownBalanceSats: number | null = null
let lastBalanceBreakdown = ''

export function lastKnownBalance(): number | null {
  return lastKnownBalanceSats
}

export async function fetchBalanceRead(
  wallet?: Wallet | WalletInterface,
  opts?: { creditUnconfirmed?: boolean },
): Promise<BalanceRead> {
  const session = getActiveWallet()
  const w = wallet ?? session?.wallet
  if (!w) return { kind: 'unavailable', reason: 'noWallet' }
  let spendable = 0
  let haveSpendable = false
  const asToolbox = w as Wallet
  if (typeof asToolbox.balance === 'function') {
    try {
      const sats = await asToolbox.balance()
      if (Number.isFinite(sats)) {
        spendable = Math.max(0, Math.trunc(sats))
        haveSpendable = true
      }
    } catch (err) {
      console.warn('[balance] Wallet.balance() failed', err)
    }
  }

  if (!haveSpendable) {
    try {
      const result = await w.listOutputs({
        basket: specOpWalletBalance,
        limit: 1,
      })
      if (Number.isFinite(result.totalOutputs)) {
        spendable = Math.max(0, Math.trunc(result.totalOutputs))
        haveSpendable = true
      }
    } catch (err) {
      console.warn('[balance] specOpWalletBalance failed', err)
    }
  }

  // BRC-112: `balance <basket>` returns satoshi sum in totalOutputs.
  if (!haveSpendable) {
    try {
      const result = await w.listOutputs({
        basket: BALANCE_DEFAULT_BASKET,
        limit: 1,
      })
      if (Number.isFinite(result.totalOutputs)) {
        spendable = Math.max(0, Math.trunc(result.totalOutputs))
        haveSpendable = true
      }
    } catch (err) {
      console.warn('[balance] BRC-112 balance default failed', err)
    }
  }

  if (!haveSpendable) {
    try {
      const outputs = await w.listOutputs({
        basket: 'default',
        limit: 1000,
      })
      const sum = (outputs.outputs ?? []).reduce((s, o) => s + (o.satoshis ?? 0), 0)
      if (sum > 0) spendable = sum
      else if (Number.isFinite(outputs.totalOutputs)) {
        spendable = Math.max(0, Math.trunc(outputs.totalOutputs))
      }
    } catch (err) {
      console.warn('[balance] listOutputs default failed', err)
    }
  }

  // All four strategies failed. Reporting 0 here is what turned a busy-storage
  // moment into an empty-looking wallet.
  if (!haveSpendable) {
    console.warn('[balance] every spendable read failed — balance unavailable')
    return { kind: 'unavailable', reason: 'storageUnreadable' }
  }

  if (opts?.creditUnconfirmed === false) return { kind: 'ok', sats: spendable }

  let pendingChange = 0
  try {
    const { unconfirmedChangeSats } = await import('./balanceView')
    pendingChange = await unconfirmedChangeSats()
    spendable += pendingChange
  } catch (err) {
    console.warn('[balance] unconfirmed change credit skipped', err)
  }
  const breakdown = `${spendable - pendingChange}:${pendingChange}:${spendable}`
  if (breakdown !== lastBalanceBreakdown) {
    lastBalanceBreakdown = breakdown
    console.info(
      `[balance] spendable=${spendable - pendingChange} pendingChange=${pendingChange} displayed=${spendable}`,
    )
  }
  lastKnownBalanceSats = spendable
  if (session && w === session.wallet) {
    writeTrustedBalance(session.identityKey, session.chain, spendable)
  }
  return { kind: 'ok', sats: spendable }
}

/**
 * Displayed balance in satoshis.
 *
 * An unreadable balance resolves to the last figure this wallet actually read
 * rather than 0, so storage contention cannot make a funded wallet look empty.
 * Confirmed-only reads (spend gates) get 0 instead — those callers must fail
 * closed, and `spendGuard` uses `fetchBalanceRead` to refuse with a real
 * reason rather than pretending the wallet is broke.
 */
export async function fetchBalanceSats(
  wallet?: Wallet | WalletInterface,
  opts?: { creditUnconfirmed?: boolean },
): Promise<number> {
  const read = await fetchBalanceRead(wallet, opts)
  if (read.kind === 'ok') return read.sats
  if (opts?.creditUnconfirmed === false) return 0
  return lastKnownBalanceSats ?? 0
}

/** Below this, amounts display as sats; at/above, as BSV. */
export const SATS_DISPLAY_THRESHOLD = 9999

/** Format satoshis for any UI amount: sats under 9999, otherwise BSV. */
export function formatBsv(sats: number): string {
  const safe = Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0
  if (safe < SATS_DISPLAY_THRESHOLD) {
    return `${safe.toLocaleString('en-US')} sats`
  }
  const bsv = safe / 1e8
  const formatted = bsv.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  })
  return `${formatted} BSV`
}

/** Compact BSV (or sats) with at most `maxSignificant` significant digits. */
export function formatBsvSignificant(sats: number, maxSignificant = 5): string {
  const safe = Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0
  // Tiny amounts only — never show sat labels once the figure has 5+ digits.
  if (safe < 10_000) {
    return `${safe.toLocaleString('en-US')} sats`
  }

  const bsv = safe / 1e8
  let raw = bsv.toPrecision(maxSignificant)
  if (/e/i.test(raw)) {
    raw = Number(raw).toLocaleString('en-US', {
      maximumSignificantDigits: maxSignificant,
      useGrouping: false,
    })
  }
  if (raw.includes('.')) {
    raw = raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  const neg = raw.startsWith('-')
  const unsigned = neg ? raw.slice(1) : raw
  const [intPart, fracPart] = unsigned.split('.')
  const intGrouped = Number(intPart).toLocaleString('en-US')
  const body = fracPart != null ? `${intGrouped}.${fracPart}` : intGrouped
  return `${neg ? '-' : ''}${body} BSV`
}

export function formatSats(sats: number): string {
  const safe = Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0
  return safe.toLocaleString('en-US')
}
