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

export type ArcadeTxFate =
  | { kind: 'accepted'; status: string }
  | { kind: 'rejected'; status: string; reason: string }
  | { kind: 'retryable'; status: string; reason: string; ancestorTxid?: string }
  | { kind: 'unknown' }

const PARENT_REJECTED_RE =
  /parent rejected \(ancestor ([0-9a-f]{64})\): retryable/i

/** Interpret Arcade's authoritative transaction lifecycle response. */
export function classifyArcadeTxStatus(body: unknown): ArcadeTxFate {
  if (body == null || typeof body !== 'object') return { kind: 'unknown' }
  const record = body as { txStatus?: unknown; extraInfo?: unknown }
  const status = String(record.txStatus ?? '').trim().toUpperCase()
  const reason = String(record.extraInfo ?? status).trim().slice(0, 240)
  if (!status) return { kind: 'unknown' }
  if (status === 'REJECTED' && /parent rejected/i.test(reason) && /retryable/i.test(reason)) {
    return {
      kind: 'retryable',
      status,
      reason,
      ancestorTxid: PARENT_REJECTED_RE.exec(reason)?.[1]?.toLowerCase(),
    }
  }
  if (
    status === 'REJECTED' ||
    status === 'INVALID' ||
    status === 'DOUBLE_SPEND_ATTEMPTED'
  ) {
    return {
      kind: 'rejected',
      status,
      reason,
    }
  }
  if (
    status === 'MINED' ||
    status === 'SEEN_ON_NETWORK' ||
    status === 'ANNOUNCED_TO_NETWORK' ||
    status === 'STORED' ||
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
      return {
        kind: 'rejected',
        status: fate.status,
        reason: `ancestor ${fate.ancestorTxid} rejected: ${ancestor.reason}`.slice(0, 240),
      }
    }
    return fate
  } catch {
    return { kind: 'unknown' }
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
    s.options.chaintracks = new GoChaintracksServiceClient(chain, base, {
      apiPrefix: '/chaintracks/v2',
      requestTimeoutMsecs: 8_000,
    })
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

    s.options.chaintracks = new GoChaintracksServiceClient(chain, base, {
      apiPrefix: '/chaintracks/v2',
      requestTimeoutMsecs: 8_000,
    })
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
