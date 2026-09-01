/**
 * Arcade V2 (bsv-blockchain/arcade) — same stack Babbage wallet-services uses.
 *
 * Public hosts expose:
 * - `/chaintracks/v2/*` — go-chaintracks headers / tip (replaces legacy Chaintracks)
 * - `/tx` — Teranode broadcaster (202 async + SSE status)
 *
 * Browser CORS is enabled on arcade-v2-*.bsvblockchain.tech (2026-09).
 */
import {
  GoChaintracksServiceClient,
  type Services,
} from '@bsv/wallet-toolbox-client'
import type { Chain } from './vault'
import { getOrCreateArcadeCallbackToken } from './arcadeIntegration'
import { preferServiceOrder } from './serviceOrder'

/** Credential-free public Arcade V2 hosts (wallet-toolbox `publicArcadeUrl`). */
export function arcadeV2BaseUrl(chain: Chain): string | null {
  switch (chain) {
    case 'main':
      return 'https://arcade-v2-us-1.bsvblockchain.tech'
    case 'test':
      return 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'
    default:
      return null
  }
}

type ServicesInternals = Services & {
  configureOptionalProviders?: () => { hasBitails: boolean; hasWhatsOnChain: boolean }
  initializeReadServices?: (hasBitails: boolean, hasWhatsOnChain: boolean) => void
  initializePostBeefServices?: (hasBitails: boolean, hasWhatsOnChain: boolean) => void
  options: Services['options'] & {
    chaintracks?: unknown
    arcadeUrl?: string
    arcadeConfig?: Record<string, unknown>
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
    const s = services as ServicesInternals
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
      ['ArcadeBeef', 'GorillaPoolArcBeef', 'Bitails', 'WhatsOnChain', 'TaalArcBeef'],
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
