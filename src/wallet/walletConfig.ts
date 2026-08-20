/**
 * Wallet configuration chosen at setup (and editable later in Settings).
 * History backup on BRC-CLOUD is the default. Custody keys remain local.
 */
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.brc100.walletConfig.v1'
const DEPRECATED_CLOUD_KEY_STORAGE_KEYS = [
  'handcash.brc100.trustholderEnrollments.v1',
  'handcash.brc100.trustholderSharePlan.v1',
] as const

function purgeDeprecatedCloudKeyState(): void {
  for (const key of DEPRECATED_CLOUD_KEY_STORAGE_KEYS) {
    durableRemoveItem(key)
  }
}

/** Public BRC-CLOUD origin (handles, history). */
export const DEFAULT_BRC_CLOUD_BASE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_BRC_CLOUD_BASE_URL === 'string' &&
    import.meta.env.VITE_BRC_CLOUD_BASE_URL.trim()) ||
  'https://brc-cloud.bcryderman.workers.dev'

export const DEFAULT_METANET_HANDLES_BASE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_METANET_HANDLES_BASE_URL === 'string' &&
    import.meta.env.VITE_METANET_HANDLES_BASE_URL.trim()) ||
  DEFAULT_BRC_CLOUD_BASE_URL

/** Same host as handles — history lives on BRC-CLOUD. */
export const DEFAULT_HISTORY_BACKUP_SETUP_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_HISTORY_BACKUP_BASE_URL === 'string' &&
    import.meta.env.VITE_HISTORY_BACKUP_BASE_URL.trim()) ||
  DEFAULT_BRC_CLOUD_BASE_URL

/** items-market origin that hosts the Desktop swap ("Add money") flow. */
export const DEFAULT_MARKET_BASE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_MARKET_BASE_URL === 'string' &&
    import.meta.env.VITE_MARKET_BASE_URL.trim()) ||
  'https://handcash.io'

/** Buy BSV with other crypto; pays into this device over the BRC-100 bridge. */
export const ADD_MONEY_URL = `${DEFAULT_MARKET_BASE_URL.replace(/\/+$/, '')}/wallet/swap`

/**
 * Claim $handle → identityKey (items-market `/claim-handle`).
 * Default: preprod until prod secrets are live; override with VITE_CLAIM_HANDLE_URL.
 */
export const CLAIM_HANDLE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_CLAIM_HANDLE_URL === 'string' &&
    import.meta.env.VITE_CLAIM_HANDLE_URL.trim()) ||
  'https://preprod-market.handcash.io/claim-handle'

export type WalletConfigMode = 'history' | 'none'

export type WalletConfigPrefs = {
  mode: WalletConfigMode | null
  /** History host URL when history backup is enabled. */
  historyBaseUrl: string
  configuredAt: number | null
}

const DEFAULTS: WalletConfigPrefs = {
  mode: null,
  historyBaseUrl: '',
  configuredAt: null,
}

export function getWalletConfigPrefs(): WalletConfigPrefs {
  purgeDeprecatedCloudKeyState()
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as {
      mode?: unknown
      historyBaseUrl?: unknown
      configuredAt?: unknown
      backupServiceUrls?: unknown
    }
    const next: WalletConfigPrefs = {
      // Legacy "recommended" included active key-share providers. Treat it as
      // history-only; never retain or act on its provider URLs.
      mode:
        parsed.mode === 'recommended' || parsed.mode === 'history'
          ? 'history'
          : parsed.mode === 'none'
            ? 'none'
            : null,
      historyBaseUrl:
        typeof parsed.historyBaseUrl === 'string' ? parsed.historyBaseUrl : '',
      configuredAt:
        typeof parsed.configuredAt === 'number' ? parsed.configuredAt : null,
    }
    if (parsed.mode === 'recommended' || parsed.backupServiceUrls !== undefined) {
      durableSetItem(KEY, JSON.stringify(next))
    }
    return next
  } catch {
    return { ...DEFAULTS }
  }
}

export function setWalletConfigPrefs(
  patch: Partial<WalletConfigPrefs>,
): WalletConfigPrefs {
  const current = getWalletConfigPrefs()
  const next: WalletConfigPrefs = {
    ...current,
    ...patch,
  }
  durableSetItem(KEY, JSON.stringify(next))
  return next
}

export type WalletConfigOption = {
  id: WalletConfigMode
  title: string
  description: string
  disabled: boolean
  disabledReason?: string
  warning?: string
}

export function listWalletConfigOptions(): WalletConfigOption[] {
  const options: WalletConfigOption[] = [
    {
      id: 'history',
      title: 'History backup',
      description:
        'HandCash history, friends, and spend locks across devices. Keys stay only on your devices (phrase / slices).',
      disabled: false,
    },
    {
      id: 'none',
      title: 'More advanced — no backup services',
      description: 'Local vault only. You are responsible for phrase or BRC-140 slices.',
      disabled: false,
      warning:
        'No remote recovery or device parity. Losing this device without an offline backup means losing access.',
    },
  ]
  return options
}
