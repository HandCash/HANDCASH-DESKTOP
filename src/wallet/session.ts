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
 *
 * Arcade (own broadcasts) stays first when configured. Public SPV proofs should
 * not share WhatsOnChain's rate budget with rawtx / UTXO / FX.
 */
function installMerklePreferBitails(services: Services): void {
  try {
    const collection = (
      services as unknown as {
        getMerklePathServices?: { services?: Array<{ name: string }>; reset?: () => void }
      }
    ).getMerklePathServices
    preferServiceOrder(collection, ['Arcade', 'Bitails', 'WhatsOnChain'])
  } catch (err) {
    console.warn('[merkle] could not prefer Bitails', err)
  }
}

/**
 * Broadcast: Bitails first (fast public ARC), then Arcade / Gorilla / Taal / WoC.
 * Default order burned soft-timeout budget on slow ARC hosts before Bitails.
 * Tighten UntilSuccess soft caps so a dead endpoint cannot hold the UI for 30s.
 */
function installPostBeefPreferFast(services: Services): void {
  try {
    const collection = (
      services as unknown as {
        postBeefServices?: { services?: Array<{ name: string }>; reset?: () => void }
      }
    ).postBeefServices
    preferServiceOrder(collection, [
      'Bitails',
      'ArcadeBeef',
      'GorillaPoolArcBeef',
      'TaalArcBeef',
      'WhatsOnChain',
    ])
    const s = services as Services & {
      postBeefUntilSuccessSoftTimeoutMs?: number
      postBeefUntilSuccessSoftTimeoutMaxMs?: number
    }
    if (typeof s.postBeefUntilSuccessSoftTimeoutMs === 'number') {
      s.postBeefUntilSuccessSoftTimeoutMs = isPhoneShell() ? 2_500 : 3_500
    }
    if (typeof s.postBeefUntilSuccessSoftTimeoutMaxMs === 'number') {
      s.postBeefUntilSuccessSoftTimeoutMaxMs = isPhoneShell() ? 10_000 : 15_000
    }
  } catch (err) {
    console.warn('[postBeef] could not prefer fast broadcasters', err)
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
  return active
}

/** Prefer toolbox `Wallet.balance()` — localState spendable (managed change), not legacy address UTXOs. See `layers.ts`. */
export async function fetchBalanceSats(wallet?: Wallet | WalletInterface): Promise<number> {
  const w = wallet ?? getActiveWallet()?.wallet
  if (!w) return 0
  const asToolbox = w as Wallet
  if (typeof asToolbox.balance === 'function') {
    try {
      const sats = await asToolbox.balance()
      if (Number.isFinite(sats)) return Math.max(0, Math.trunc(sats))
    } catch (err) {
      console.warn('[balance] Wallet.balance() failed', err)
    }
  }

  try {
    const result = await w.listOutputs({
      basket: specOpWalletBalance,
      limit: 1,
    })
    if (Number.isFinite(result.totalOutputs)) return Math.max(0, Math.trunc(result.totalOutputs))
  } catch (err) {
    console.warn('[balance] specOpWalletBalance failed', err)
  }

  // BRC-112: `balance <basket>` returns satoshi sum in totalOutputs.
  try {
    const result = await w.listOutputs({
      basket: BALANCE_DEFAULT_BASKET,
      limit: 1,
    })
    if (Number.isFinite(result.totalOutputs)) return Math.max(0, Math.trunc(result.totalOutputs))
  } catch (err) {
    console.warn('[balance] BRC-112 balance default failed', err)
  }

  try {
    const outputs = await w.listOutputs({
      basket: 'default',
      limit: 1000,
    })
    const sum = (outputs.outputs ?? []).reduce((s, o) => s + (o.satoshis ?? 0), 0)
    if (sum > 0) return sum
    if (Number.isFinite(outputs.totalOutputs)) return Math.max(0, Math.trunc(outputs.totalOutputs))
    return sum
  } catch (err) {
    console.warn('[balance] listOutputs default failed', err)
    return 0
  }
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
