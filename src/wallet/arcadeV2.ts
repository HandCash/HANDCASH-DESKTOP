/**
 * Arcade V2 (bsv-blockchain/arcade) — same stack Babbage wallet-services uses.
 *
 * Public hosts expose:
 * - `/chaintracks/v2/*` — go-chaintracks headers / tip (replaces legacy Chaintracks)
 * - `/tx` — Teranode broadcaster (202 async + SSE status)
 *
 * Browser CORS allows simple GETs; toolbox status/broadcast adds `xdeployment-id`,
 * which Arcade's preflight rejects from localhost. Vite dev proxies same-origin
 * paths (see vite.config.ts) so Electron + `npm run dev` browser can broadcast.
 */
import {
  GoChaintracksServiceClient,
  type Services,
} from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'
import { getOrCreateArcadeCallbackToken } from './arcadeIntegration'
import { preferServiceOrder } from './serviceOrder'

const ARCADE_V2_MAIN = 'https://arcade-v2-us-1.bsvblockchain.tech'
const ARCADE_V2_TEST = 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'

/** Vite dev proxy mount — avoids cross-origin `xdeployment-id` preflight failures. */
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

/**
 * Chaintracks only — no postBeef / status reorder. Arcade V2 go-chaintracks replaces
 * dead `mainnet-chaintracks.babbage.systems`; broadcast stays GorillaPool-first.
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
 * after createWalletIdb and re-run the provider initializers.
 */
export function installArcadeV2Services(services: Services, chain: Chain): void {
  const base = arcadeV2BaseUrl(chain)
  if (!base) return

  try {
    const s = services as unknown as ServicesPatchTarget
    const token = getOrCreateArcadeCallbackToken()

    s.options.chaintracks = new GoChaintracksServiceClient(chain, base, {
      apiPrefix: '/chaintracks/v2',
      requestTimeoutMsecs: 8_000,
    })
    s.options.arcadeUrl = base
    s.options.arcadeConfig = {
      ...(s.options.arcadeConfig ?? {}),
      callbackToken: token,
    }

    if (typeof s.configureOptionalProviders === 'function') {
      const { hasBitails, hasWhatsOnChain } = s.configureOptionalProviders()
      s.initializeReadServices?.(hasBitails, hasWhatsOnChain)
      s.initializePostBeefServices?.(hasBitails, hasWhatsOnChain)
    }

    preferServiceOrder(
      (s as unknown as { postBeefServices?: { services?: Array<{ name: string }>; reset?: () => void } })
        .postBeefServices,
      ['GorillaPoolArcBeef', 'Bitails', 'WhatsOnChain', 'TaalArcBeef', 'ArcadeBeef'],
    )
    preferServiceOrder(
      (s as unknown as { getStatusForTxidsServices?: { services?: Array<{ name: string }>; reset?: () => void } })
        .getStatusForTxidsServices,
      ['Arcade', 'WhatsOnChain'],
    )

    console.info('[arcade-v2] chaintracks + broadcaster on', base)
  } catch (err) {
    console.warn('[arcade-v2] install failed', err)
  }
}
