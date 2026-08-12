/**
 * Wallet configuration chosen at setup (and editable later in Settings).
 * Recommended (HC + Haste BRC-232) is on when BRC-CLOUD is reachable.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.brc100.walletConfig.v1'

/** Public BRC-CLOUD origin (handles, history, BRC-232 trustholders). */
export const DEFAULT_BRC_CLOUD_BASE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_BRC_CLOUD_BASE_URL === 'string' &&
    import.meta.env.VITE_BRC_CLOUD_BASE_URL.trim()) ||
  'https://brc-cloud.bcryderman.workers.dev'

/**
 * Recommended backup is live by default. Set VITE_BACKUP_SERVICES_LIVE=false
 * to gray it out (e.g. offline / local-only builds).
 */
export const BACKUP_SERVICES_LIVE =
  typeof import.meta !== 'undefined' &&
  import.meta.env?.VITE_BACKUP_SERVICES_LIVE === 'false'
    ? false
    : true

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

export const HANDCASH_BACKUP_SERVICE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_HANDCASH_BACKUP_SERVICE_URL === 'string' &&
    import.meta.env.VITE_HANDCASH_BACKUP_SERVICE_URL.trim()) ||
  `${DEFAULT_BRC_CLOUD_BASE_URL}/trustholders/handcash`

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

export const HASTE_BACKUP_SERVICE_URL =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_HASTE_BACKUP_SERVICE_URL === 'string' &&
    import.meta.env.VITE_HASTE_BACKUP_SERVICE_URL.trim()) ||
  `${DEFAULT_BRC_CLOUD_BASE_URL}/trustholders/haste`

export type WalletConfigMode = 'recommended' | 'history' | 'none'

export type WalletConfigPrefs = {
  mode: WalletConfigMode | null
  /** History host URL when mode is history or recommended (parity). */
  historyBaseUrl: string
  /** BRC-232 provider URLs when recommended is applied. */
  backupServiceUrls: string[]
  configuredAt: number | null
}

const DEFAULTS: WalletConfigPrefs = {
  mode: null,
  historyBaseUrl: '',
  backupServiceUrls: [],
  configuredAt: null,
}

export function getWalletConfigPrefs(): WalletConfigPrefs {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<WalletConfigPrefs>
    return {
      mode:
        parsed.mode === 'recommended' ||
        parsed.mode === 'history' ||
        parsed.mode === 'none'
          ? parsed.mode
          : null,
      historyBaseUrl:
        typeof parsed.historyBaseUrl === 'string' ? parsed.historyBaseUrl : '',
      backupServiceUrls: Array.isArray(parsed.backupServiceUrls)
        ? parsed.backupServiceUrls.filter((u) => typeof u === 'string')
        : [],
      configuredAt:
        typeof parsed.configuredAt === 'number' ? parsed.configuredAt : null,
    }
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
    backupServiceUrls:
      patch.backupServiceUrls !== undefined
        ? patch.backupServiceUrls
        : current.backupServiceUrls,
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
  return [
    {
      id: 'recommended',
      title: 'Recommended',
      description:
        'HandCash history plus key shares at HandCash and Haste (BRC-232). Best recovery if you lose this device.',
      disabled: !BACKUP_SERVICES_LIVE,
      disabledReason: BACKUP_SERVICES_LIVE
        ? undefined
        : 'Backup services are not live yet — coming soon.',
    },
    {
      id: 'history',
      title: 'Advanced — history backup only',
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
}
