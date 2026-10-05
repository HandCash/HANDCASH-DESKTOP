import { Hash, Utils, type PrivateKey } from '@bsv/sdk'
import type { Chain } from '../vault'
import { appendAppLog } from '../appLog'
import { yieldToUi } from '../yieldToUi'
import type { KeyDeriver } from './importSource'
import {
  BIP44_GAP,
  MAX_INDEX,
  isIndexedTemplate,
  templatePath,
  templateWalks,
} from './pathCatalog'

/**
 * Find every address a legacy key set has ever used.
 *
 * History, not unspent outputs, is the signal: wallets empty addresses all the
 * time, and an emptied address still marks its sequence as live. Each walk
 * stops after `gap` consecutive unused addresses past its highest hit.
 * Lookups that fail after retries do not abort the scan — the result is
 * marked incomplete so the view can say so instead of reading as empty.
 */

export type DiscoveredAddress = {
  path: string
  address: string
  /** Walk or key label, e.g. "BSV (BIP44) · receive". */
  label: string
  wallets: string
  /**
   * Held under the uncompressed form of the key. Sweeping signs with the
   * compressed key, so these coins are shown but never moved.
   */
  uncompressed?: boolean
}

/** Addresses (of those asked) with any history. Throws when it cannot answer. */
export type HistoryLookup = (addresses: string[]) => Promise<Set<string>>
/** True when the 1Sat index lists outputs the address history cannot see. */
export type ItemsLookup = (address: string) => Promise<boolean>

export type DiscoveryProgress = { checked: number; found: number; walk: string }

export type DiscoveryResult = {
  addresses: DiscoveredAddress[]
  checked: number
  /** False when any lookup failed or the scan was paused. */
  complete: boolean
  failedLookups: number
}

const HISTORY_CHUNK = 20
const STEP = 40

export function uncompressedAddress(key: PrivateKey): string {
  const pub = key.toPublicKey().encode(false) as number[]
  return Utils.toBase58Check(Hash.hash160(pub), [0x00])
}

export async function discoverAddresses(args: {
  deriver: KeyDeriver
  history: HistoryLookup
  items?: ItemsLookup
  /** Overrides every template's own gap — a quick scan, or a deeper one. */
  gap?: number
  onProgress?: (progress: DiscoveryProgress) => void
  shouldStop?: () => boolean
}): Promise<DiscoveryResult> {
  const startedAt = Date.now()
  const found: DiscoveredAddress[] = []
  const seen = new Set<string>()
  let checked = 0
  let failedLookups = 0
  let stopped = false

  const report = (walk: string) =>
    args.onProgress?.({ checked, found: found.length, walk })

  /** Ask history for every candidate, in provider-sized chunks. */
  const usedAmong = async (candidates: DiscoveredAddress[]): Promise<Set<string> | null> => {
    const used = new Set<string>()
    let failed = false
    for (let i = 0; i < candidates.length; i += HISTORY_CHUNK) {
      const chunk = candidates.slice(i, i + HISTORY_CHUNK).map((c) => c.address)
      try {
        for (const address of await args.history(chunk)) used.add(address)
      } catch (err) {
        failed = true
        failedLookups += 1
        appendAppLog(
          'warn',
          `[import] history lookup failed for ${chunk.length} address(es): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    checked += candidates.length
    return failed && used.size === 0 ? null : used
  }

  const keep = (candidate: DiscoveredAddress) => {
    if (seen.has(candidate.address)) return
    seen.add(candidate.address)
    found.push(candidate)
  }

  // Pinned keys and single-address templates: one look each.
  const fixed: DiscoveredAddress[] = []
  for (const pinned of args.deriver.fixed) {
    fixed.push({
      path: pinned.path,
      address: pinned.key.toPublicKey().toAddress(),
      label: pinned.label,
      wallets: pinned.label,
    })
    if (pinned.path.startsWith('wif:') || pinned.path.startsWith('yours:')) {
      fixed.push({
        path: pinned.path,
        address: uncompressedAddress(pinned.key),
        label: `${pinned.label} (uncompressed)`,
        wallets: pinned.label,
        uncompressed: true,
      })
    }
  }
  for (const template of args.deriver.templates) {
    if (isIndexedTemplate(template)) continue
    fixed.push({
      path: template.pattern,
      address: args.deriver.privateKeyAt(template.pattern).toPublicKey().toAddress(),
      label: template.label,
      wallets: template.wallets,
    })
  }
  if (fixed.length > 0) {
    const used = await usedAmong(fixed)
    for (const candidate of fixed) if (used?.has(candidate.address)) keep(candidate)
    report('Pinned keys')
  }

  for (const walk of templateWalks(args.deriver.templates.filter(isIndexedTemplate))) {
    if (stopped) break
    const gap = Math.max(1, args.gap ?? walk.template.gap ?? BIP44_GAP)
    let lastUsed = -1
    let index = 0
    while (index <= lastUsed + gap && index < MAX_INDEX) {
      if (args.shouldStop?.()) {
        stopped = true
        break
      }
      const end = Math.min(index + STEP, lastUsed + gap + 1, MAX_INDEX)
      const batch: Array<DiscoveredAddress & { index: number }> = []
      for (let i = index; i < end; i += 1) {
        const path = templatePath(walk.template, walk.branch, i)
        batch.push({
          index: i,
          path,
          address: args.deriver.privateKeyAt(path).toPublicKey().toAddress(),
          label: walk.label,
          wallets: walk.template.wallets,
        })
      }
      await yieldToUi()
      const used = await usedAmong(batch)
      if (used == null) {
        // A failed window is not evidence of a gap. Move past it without
        // extending the walk; the result is marked incomplete.
        index = end
        report(walk.label)
        continue
      }
      for (const candidate of batch) {
        let hit = used.has(candidate.address)
        if (!hit && walk.template.itemsRoot && args.items) {
          try {
            hit = await args.items(candidate.address)
          } catch {
            failedLookups += 1
          }
        }
        if (!hit) continue
        lastUsed = Math.max(lastUsed, candidate.index)
        const { index: _index, ...address } = candidate
        keep(address)
      }
      index = end
      report(walk.label)
    }
  }

  const complete = !stopped && failedLookups === 0
  const elapsed = Date.now() - startedAt
  appendAppLog(
    'info',
    `[import] discover done ${elapsed}ms checked=${checked} used=${found.length} complete=${complete}`,
  )
  return { addresses: found, checked, complete, failedLookups }
}

function wocBase(chain: Chain): string {
  return `https://api.whatsonchain.com/v1/bsv/${chain === 'main' ? 'main' : 'test'}`
}

function gorillaBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

/** WhatsOnChain free tier: ~3 rps per IP. Stay under it for a long walk. */
const WOC_INTERVAL_MS = 400
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
let wocNextSlot = 0

async function wocSlot(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, wocNextSlot - now)
  wocNextSlot = Math.max(now, wocNextSlot) + WOC_INTERVAL_MS
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

/** Test-only. */
export function resetDiscoveryPacingForTests(): void {
  wocNextSlot = 0
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** One paced, retried WhatsOnChain bulk POST. Throws when it cannot answer. */
export async function wocBulkPost(
  chain: Chain,
  path: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  let lastError = 'no answer'
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    await wocSlot()
    try {
      const res = await fetchImpl(`${wocBase(chain)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return (await res.json()) as unknown
      lastError = `WhatsOnChain ${res.status}`
      if (res.status !== 429 && res.status < 500) break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    const delay = RETRY_DELAYS_MS[attempt]
    if (delay == null) break
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(lastError)
}

/** Bulk history via `POST /addresses/history`, paced and retried. */
export function wocHistoryLookup(chain: Chain, fetchImpl: FetchLike = fetch): HistoryLookup {
  return async (addresses) => {
    const rows = (await wocBulkPost(chain, '/addresses/history', { addresses }, fetchImpl)) as Array<{
      address?: string
      history?: unknown[]
    }>
    const used = new Set<string>()
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.address && Array.isArray(row.history) && row.history.length > 0) {
        used.add(row.address)
      }
    }
    return used
  }
}

/** Minted items are invisible to address history; the 1Sat index sees them. */
export function gorillaItemsLookup(chain: Chain, fetchImpl: FetchLike = fetch): ItemsLookup {
  return async (address) => {
    const res = await fetchImpl(
      `${gorillaBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent?limit=1`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) throw new Error(`Ordinal index ${res.status}`)
    const body = (await res.json()) as unknown
    return Array.isArray(body) && body.length > 0
  }
}

/** Which template and index produced `address` — walks every template deeply. */
export async function locateAddress(args: {
  deriver: KeyDeriver
  address: string
  depth?: number
  shouldStop?: () => boolean
}): Promise<DiscoveredAddress | null> {
  const target = args.address.trim()
  for (const pinned of args.deriver.fixed) {
    if (pinned.key.toPublicKey().toAddress() === target) {
      return { path: pinned.path, address: target, label: pinned.label, wallets: pinned.label }
    }
    if (uncompressedAddress(pinned.key) === target) {
      return {
        path: pinned.path,
        address: target,
        label: `${pinned.label} (uncompressed)`,
        wallets: pinned.label,
        uncompressed: true,
      }
    }
  }
  const depth = Math.max(1, Math.min(args.depth ?? 2_000, MAX_INDEX))
  for (const template of args.deriver.templates) {
    if (isIndexedTemplate(template)) continue
    if (args.deriver.privateKeyAt(template.pattern).toPublicKey().toAddress() === target) {
      return { path: template.pattern, address: target, label: template.label, wallets: template.wallets }
    }
  }
  for (const walk of templateWalks(args.deriver.templates.filter(isIndexedTemplate))) {
    for (let i = 0; i < depth; i += 1) {
      if (i % 200 === 0) {
        if (args.shouldStop?.()) return null
        await yieldToUi()
      }
      const path = templatePath(walk.template, walk.branch, i)
      if (args.deriver.privateKeyAt(path).toPublicKey().toAddress() === target) {
        return { path, address: target, label: walk.label, wallets: walk.template.wallets }
      }
    }
  }
  return null
}
