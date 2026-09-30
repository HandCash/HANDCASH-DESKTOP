/**
 * Arcade V2 (bsv-blockchain/arcade) — same stack Babbage wallet-services uses.
 *
 * Public hosts expose:
 * - `/chaintracks/v2/*` — go-chaintracks headers / tip (replaces legacy Chaintracks)
 * - `/tx` — Teranode broadcaster (202 accepted is a queued submit)
 *
 * POST `/tx` is propagation, not header finality and not a cheque cancel.
 * Unconfirmed txs chain by carrying parent bodies; MINED is BUMP vs headers.
 * Do not wait on SSE / callback before accounting a locally SPV-valid signed tx.
 *
 * Arcade CORS allow-list is Content-Type + X-CallbackToken (not XDeployment-ID).
 * The toolbox ARC client always sends XDeployment-ID, so we strip it. Vite still
 * proxies `/arcade-v2` in `npm run dev` so Electron localhost never preflights.
 */
import { defaultHttpClient, type HttpClient } from '@bsv/sdk'
import {
  GoChaintracksServiceClient,
  type Services,
} from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'
import { configurePostBeefServices } from './serviceOrder'

const ARCADE_V2_MAIN = 'https://arcade-v2-us-1.bsvblockchain.tech'
const ARCADE_V2_TEST = 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'

/** Vite dev proxy mount — same-origin, no Arcade CORS preflight. */
export const ARCADE_V2_DEV_PROXY_MAIN = '/arcade-v2'
export const ARCADE_V2_DEV_PROXY_TEST = '/arcade-v2-testnet'

/** Credential-free public Arcade V2 hosts (wallet-toolbox `publicArcadeUrl`). */
export function arcadeV2BaseUrl(chain: Chain): string | null {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    switch (chain) {
      case 'main':
        return ARCADE_V2_DEV_PROXY_MAIN
      case 'test':
        return ARCADE_V2_DEV_PROXY_TEST
      default:
        return null
    }
  }
  switch (chain) {
    case 'main':
      return ARCADE_V2_MAIN
    case 'test':
      return ARCADE_V2_TEST
    default:
      return null
  }
}

/**
 * `stalled` is Arcade's `PENDING_RETRY`: no node gave a verdict and Arcade
 * parked the body for durable rebroadcast. Teranode answers a parent it does
 * not hold with an opaque `PROCESSING` that Arcade reads as a missing parent —
 * and it drops a transaction once every output is spent and mined past its
 * 288-block retention, so a coin spent long ago reads exactly like a parent
 * still propagating. Not a verdict; the landing watch asks for the coins.
 *
 * Arcade's own give-up after its retry budget ("no network verdict after N
 * durable retry attempts") is written as `REJECTED` but is the same silence,
 * so it is `stalled` too. Only a node's answer is a rejection.
 *
 * `conflict` is Arcade's 466: a node named the transaction that already
 * spends one of the inputs.
 */
export type ArcadeTxFate =
  | { kind: 'accepted'; status: string }
  | {
      kind: 'rejected'
      status: string
      reason: string
      conflict?: { outpoint: string; spender: string }
    }
  | { kind: 'retryable'; status: string; reason: string; ancestorTxid?: string }
  | { kind: 'stalled'; status: string; reason: string }
  | { kind: 'unknown' }

/**
 * Statuses where a node, not just Arcade's queue, holds the transaction.
 * `RECEIVED` / `SENT_TO_NETWORK` are Arcade's own queue states;
 * `STUMP_PROCESSING` is a block holding it while its BUMP is built.
 */
const ARCADE_LANDED_STATUSES = new Set([
  'SEEN_ON_NETWORK',
  'SEEN_MULTIPLE_NODES',
  'ACCEPTED_BY_NETWORK',
  'STUMP_PROCESSING',
  'MINED',
  'IMMUTABLE',
])

export function arcadeStatusLanded(status: string): boolean {
  return ARCADE_LANDED_STATUSES.has(status.trim().toUpperCase())
}

/** ARC status codes Arcade attaches to a node's answer. */
const ARC_STATUS_CONFLICT = 466
const ARC_STATUS_NOT_FINAL = 476

const PARENT_REJECTED_RE =
  /parent rejected \(ancestor ([0-9a-f]{64})\): retryable/i
const NO_VERDICT_RE = /^no network verdict after \d+/i
const SPENT_BY_RE = /([0-9a-f]{64}):(\d+) utxo already spent by tx ([0-9a-f]{64})/i

/** Interpret Arcade's authoritative transaction lifecycle response. */
export function classifyArcadeTxStatus(body: unknown): ArcadeTxFate {
  if (body == null || typeof body !== 'object') return { kind: 'unknown' }
  const record = body as { txStatus?: unknown; extraInfo?: unknown; status?: unknown }
  const status = String(record.txStatus ?? '').trim().toUpperCase()
  const extraInfo = String(record.extraInfo ?? '').trim()
  const reason = (extraInfo || status).slice(0, 240)
  const code = Number(record.status)
  if (!status) return { kind: 'unknown' }
  if (status === 'REJECTED' && /parent rejected/i.test(reason) && /retryable/i.test(reason)) {
    return {
      kind: 'retryable',
      status,
      reason,
      ancestorTxid: PARENT_REJECTED_RE.exec(reason)?.[1]?.toLowerCase(),
    }
  }
  if (status === 'REJECTED' && code === ARC_STATUS_NOT_FINAL) {
    return { kind: 'retryable', status, reason }
  }
  if (status === 'REJECTED' && NO_VERDICT_RE.test(extraInfo)) {
    return { kind: 'stalled', status, reason }
  }
  if (
    status === 'REJECTED' ||
    status === 'INVALID' ||
    status === 'DOUBLE_SPEND_ATTEMPTED'
  ) {
    const spent = code === ARC_STATUS_CONFLICT ? SPENT_BY_RE.exec(extraInfo) : null
    return {
      kind: 'rejected',
      status,
      reason,
      ...(spent
        ? {
            conflict: {
              outpoint: `${spent[1]!.toLowerCase()}.${Number(spent[2])}`,
              spender: spent[3]!.toLowerCase(),
            },
          }
        : {}),
    }
  }
  if (status === 'PENDING_RETRY') return { kind: 'stalled', status, reason }
  if (
    arcadeStatusLanded(status) ||
    status === 'SENT_TO_NETWORK' ||
    status === 'ANNOUNCED_TO_NETWORK' ||
    status === 'STORED' ||
    status === 'RECEIVED' ||
    status === 'ACCEPTED'
  ) {
    return { kind: 'accepted', status }
  }
  return { kind: 'unknown' }
}

/**
 * Arcade `/tx/{txid}` is the objective exit for old proof requests.
 * Explorer 404 only means "not found"; Arcade `REJECTED` names an SPV failure.
 */
export async function fetchArcadeTxFate(
  chain: Chain,
  txid: string,
): Promise<ArcadeTxFate> {
  return fetchArcadeTxFateRecursive(chain, txid, new Set(), 0)
}

async function fetchArcadeTxFateRecursive(
  chain: Chain,
  txid: string,
  seen: Set<string>,
  depth: number,
): Promise<ArcadeTxFate> {
  const id = txid.trim().toLowerCase()
  const base = arcadeV2BaseUrl(chain)
  if (!base || !/^[0-9a-f]{64}$/.test(id)) return { kind: 'unknown' }
  if (seen.has(id) || depth > 12) return { kind: 'unknown' }
  seen.add(id)
  try {
    const res = await fetch(`${base}/tx/${id}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return { kind: 'unknown' }
    const fate = classifyArcadeTxStatus(await res.json())
    if (fate.kind !== 'retryable' || !fate.ancestorTxid) return fate
    const ancestor = await fetchArcadeTxFateRecursive(
      chain,
      fate.ancestorTxid,
      seen,
      depth + 1,
    )
    if (ancestor.kind === 'rejected') {
      // Name the root, not the chain. Nesting "ancestor X rejected: ancestor Y
      // rejected: …" ran past the 240-char cap by the second generation and
      // cut off the miner's own reason — the one fact that says why the
      // chain died. A reason that already names a root passes through.
      const reason = /^ancestor [0-9a-f]{64} rejected: /i.test(ancestor.reason)
        ? ancestor.reason
        : `ancestor ${fate.ancestorTxid} rejected: ${ancestor.reason}`.slice(0, 240)
      return { kind: 'rejected', status: fate.status, reason }
    }
    return fate
  } catch {
    return { kind: 'unknown' }
  }
}

/**
 * Fetch that never depends on call-site `this`.
 *
 * `GoChaintracksServiceClient` stores `options.fetch ?? fetch` and later calls
 * `this.fetcher(url, init)`. On Android WebView, an unbound window `fetch`
 * throws `TypeError: Illegal invocation` (lab phone hc-a580a: monitor
 * `_init` → `getChain` → `consumeWithTimeout`). An arrow wrapper always
 * reaches `globalThis.fetch` with the right receiver.
 */
export const arcadeBoundFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init)

/** Options shared by every Arcade go-chaintracks client we install. */
function goChaintracksOptions(): {
  apiPrefix: '/chaintracks/v2'
  requestTimeoutMsecs: number
  fetch: typeof fetch
} {
  return {
    apiPrefix: '/chaintracks/v2',
    requestTimeoutMsecs: 8_000,
    fetch: arcadeBoundFetch,
  }
}

/** Arcade preflight rejects this header from https://localhost (Capacitor / Vite). */
export function stripArcadeCorsForbiddenHeaders(
  headers?: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === 'xdeployment-id') continue
    next[key] = value
  }
  return next
}

/**
 * Toolbox `HttpClient` that posts to Arcade without `XDeployment-ID`.
 * POST `/tx` 200/202 is the send ACK — no callback token / webhook.
 */
export function arcadeCorsSafeHttpClient(): HttpClient {
  const inner = defaultHttpClient()
  return {
    request: (url, options) =>
      inner.request(url, {
        ...options,
        headers: stripArcadeCorsForbiddenHeaders(options.headers),
      }),
  }
}

/** Post-create patch surface — avoid intersecting private SDK members (CI tsc). */
type ServicesPatchTarget = {
  configureOptionalProviders?: () => { hasBitails: boolean; hasWhatsOnChain: boolean }
  initializeReadServices?: (hasBitails: boolean, hasWhatsOnChain: boolean) => void
  initializePostBeefServices?: (hasBitails: boolean, hasWhatsOnChain: boolean) => void
  options: {
    chaintracks?: unknown
    arcadeUrl?: string
    arcadeConfig?: Record<string, unknown>
  }
}

function postBeefNames(services: ServicesPatchTarget): string[] {
  const list = (
    services as unknown as {
      postBeefServices?: { services?: Array<{ name: string }> }
    }
  ).postBeefServices?.services
  return Array.isArray(list) ? list.map((s) => s.name).filter(Boolean) : []
}

/**
 * Chaintracks only — no postBeef / status reorder. Arcade V2 go-chaintracks replaces
 * dead `mainnet-chaintracks.babbage.systems`. Broadcast order is set in session.
 */
export function installArcadeV2ChaintracksOnly(services: Services, chain: Chain): void {
  const base = arcadeV2BaseUrl(chain)
  if (!base) return

  try {
    const s = services as unknown as ServicesPatchTarget
    s.options.chaintracks = new GoChaintracksServiceClient(
      chain,
      base,
      goChaintracksOptions(),
    )
    console.info('[arcade-v2] chaintracks on', base)
  } catch (err) {
    console.warn('[arcade-v2] chaintracks install failed', err)
  }
}

/**
 * Point toolbox chaintracks + Arcade broadcaster at the public V2 host.
 *
 * SetupClient builds Services before we can pass custom options, so we patch
 * after createWalletIdb and re-run the provider initializers. That is what
 * actually inserts `ArcadeBeef` into postBeef — preferring a missing name is
 * a no-op (lab phone hc-a580a: GP/Bitails/WoC/Taal, never Arcade).
 *
 * Submit ACK (POST /tx) completes the send. No callback token, no SSE webhook.
 */
export function installArcadeV2Services(services: Services, chain: Chain): void {
  const base = arcadeV2BaseUrl(chain)
  if (!base) return

  try {
    const s = services as unknown as ServicesPatchTarget

    s.options.chaintracks = new GoChaintracksServiceClient(
      chain,
      base,
      goChaintracksOptions(),
    )
    s.options.arcadeUrl = base
    s.options.arcadeConfig = {
      ...(s.options.arcadeConfig ?? {}),
      httpClient: arcadeCorsSafeHttpClient(),
    }
    delete s.options.arcadeConfig.callbackToken
    delete s.options.arcadeConfig.callbackUrl

    if (typeof s.configureOptionalProviders === 'function') {
      const { hasBitails, hasWhatsOnChain } = s.configureOptionalProviders()
      s.initializeReadServices?.(hasBitails, hasWhatsOnChain)
      s.initializePostBeefServices?.(hasBitails, hasWhatsOnChain)
    }

    configurePostBeefServices(
      (s as unknown as {
        postBeefServices?: {
          services?: Array<{ name: string }>
          reset?: () => void
        }
      }).postBeefServices,
    )

    console.info(
      '[arcade-v2] chaintracks + broadcaster on',
      base,
      'postBeef',
      postBeefNames(s).join(',') || '(empty)',
    )
  } catch (err) {
    console.warn('[arcade-v2] install failed', err)
  }
}
