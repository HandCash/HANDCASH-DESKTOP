/**
 * Arcade V2 (bsv-blockchain/arcade) — same stack Babbage wallet-services uses.
 *
 * Public hosts expose:
 * - `/chaintracks/v2/*` — go-chaintracks headers / tip (replaces legacy Chaintracks)
 * - `/tx` — Teranode broadcaster (202 accepted is a completed submit)
 *
 * Send completion is that POST success. Do not wait for SSE / callback / merkle.
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
