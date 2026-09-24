export type AppPermissionScope = {
  id: string
  label: string
  /** One-line summary shown on chips and detail header. */
  description: string
  /** Short bullets for the detail subcontext. */
  allows: string[]
  /** BRC-100 methods whose access this scope describes. */
  methods: string[]
}

const WALLET_ACCESS_SCOPE: AppPermissionScope = {
  id: 'wallet-access',
  label: 'Wallet access',
  description:
    'Use connected, non-spending wallet APIs. Spending, signatures, encryption, identity proofs, and protected inventory require separate approval.',
  allows: [
    'App-specific public keys',
    'Balance, app activity, and ordinary outputs',
    'HMAC creation and signature verification',
    'No silent spending, signing, encryption, or protected inventory',
  ],
  methods: [
    'getPublicKey',
    'getBalance',
    'listActions',
    'abortAction',
    'listOutputs',
    'listCertificates',
    'discoverByIdentityKey',
    'discoverByAttributes',
    'createHmac',
    'verifyHmac',
    'verifySignature',
  ],
}

const RECEIVE_SCOPE: AppPermissionScope = {
  id: 'receive',
  label: 'Receive BSV',
  description:
    'Accept plain BSV this app sends you automatically. Items and tokens require a separate grant.',
  allows: [
    'Incoming plain BSV from this app',
    'Accepted without a second prompt',
    'No collectables or tokens',
  ],
  methods: ['internalizeAction'],
}

const ITEM_VIEW_SCOPE: AppPermissionScope = {
  id: 'items-view',
  label: 'View collectables',
  description:
    'List only the collectables covered by the inventory grant you approved for this app.',
  allows: ['Approved 1Sat inventory', 'Approved collection, app, creator, or item filters'],
  methods: ['listOutputs'],
}

const TOKEN_VIEW_SCOPE: AppPermissionScope = {
  id: 'tokens-view',
  label: 'View tokens',
  description:
    'List only the BSV-21 tokens covered by the inventory grant you approved for this app.',
  allows: ['Approved BSV-21 inventory', 'Approved token filters'],
  methods: ['listOutputs'],
}

const ITEM_RECEIVE_SCOPE: AppPermissionScope = {
  id: 'items-receive',
  label: 'Receive items & tokens',
  description:
    'Accept collectables and BSV-21 tokens into your inventory without another receive prompt.',
  allows: ['Receive 1Sat collectables', 'Receive BSV-21 tokens', 'No permission to send them'],
  methods: ['internalizeAction'],
}

/** Capabilities granted by a fresh Connect authorization. */
export const CONNECT_GRANTED_SCOPES: AppPermissionScope[] = [
  WALLET_ACCESS_SCOPE,
  RECEIVE_SCOPE,
]

const PERSISTED_PERMISSION_SCOPES = [
  ITEM_VIEW_SCOPE,
  TOKEN_VIEW_SCOPE,
  ITEM_RECEIVE_SCOPE,
] as const

export const AUTO_PAY_SCOPE: AppPermissionScope = {
  id: 'auto-pay',
  label: 'Auto-pay',
  description:
    'Auto-approve matching BSV payments within your limits. Never covers collectables or tokens. Turn off anytime.',
  allows: ['BSV payments under your max', 'Within your time window', 'Never spends items or tokens'],
  methods: ['createAction', 'signAction'],
}

export type PermissionGrantSnapshot = {
  acceptIncomingFunds: boolean
  itemAccess: {
    view: 'none' | 'all' | 'filtered'
    canReceive: boolean
  }
  tokenAccess: {
    view: 'none' | 'all' | 'filtered'
  }
  autoPayEnabled: boolean
}

/** Return only permissions currently persisted for a connected app. */
export function grantedPermissionScopes(
  grants: PermissionGrantSnapshot,
): AppPermissionScope[] {
  const scopes = [WALLET_ACCESS_SCOPE]
  if (grants.acceptIncomingFunds) scopes.push(RECEIVE_SCOPE)
  if (grants.itemAccess.view !== 'none') scopes.push(ITEM_VIEW_SCOPE)
  if (grants.tokenAccess.view !== 'none') scopes.push(TOKEN_VIEW_SCOPE)
  if (grants.itemAccess.canReceive) scopes.push(ITEM_RECEIVE_SCOPE)
  if (grants.autoPayEnabled) scopes.push(AUTO_PAY_SCOPE)
  return scopes
}

const ALL_PERMISSION_SCOPES: AppPermissionScope[] = [
  ...CONNECT_GRANTED_SCOPES,
  ...PERSISTED_PERMISSION_SCOPES,
  AUTO_PAY_SCOPE,
]

export function getPermissionScope(scopeId: string): AppPermissionScope | null {
  // Legacy alias — auto-accept funds is the Connect "receive" scope.
  const normalized = scopeId === 'accept-incoming' ? 'receive' : scopeId
  return ALL_PERMISSION_SCOPES.find((scope) => scope.id === normalized) ?? null
}

export function normalizeAppHost(origin: string | undefined): string {
  if (!origin || !origin.trim()) return 'unknown-app'
  const raw = origin.trim().toLowerCase()
  try {
    if (raw.includes('://')) return new URL(raw).host
  } catch {
    // fall through
  }
  return raw.replace(/^www\./, '')
}

/**
 * Suffixes where the app owns a subdomain rather than the registrable domain, so
 * the leftmost label names the app: brc-cloud.bcryderman.workers.dev is BRC
 * Cloud, not "Workers".
 */
const APP_SUBDOMAIN_SUFFIXES = [
  'workers.dev',
  'pages.dev',
  'github.io',
  'vercel.app',
  'netlify.app',
  'fly.dev',
  'onrender.com',
  'herokuapp.com',
]

const NAME_ACRONYMS = new Set(['brc', 'bsv', 'bsva', 'nft', 'api', 'ai', 'dao', 'p2p'])

function titleCaseLabel(label: string): string {
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (NAME_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** Turn a host into a readable app name: market.handcash.io → Market */
export function appDisplayName(origin: string | undefined): string {
  const host = normalizeAppHost(origin)
  if (host === 'unknown-app') return 'Unknown app'
  if (host === 'localhost' || host.startsWith('127.0.0.1')) return 'Local app'

  const base = host.split(':')[0] ?? host
  if (base === 'handcash.io' || base === 'www.handcash.io') return 'HandCash'
  if (
    base === 'market.handcash.io' ||
    base === 'preprod-market.handcash.io' ||
    base === 'market-v2.handcash.io'
  ) {
    return 'HandCash'
  }

  const hosted = APP_SUBDOMAIN_SUFFIXES.find((suffix) => base.endsWith(`.${suffix}`))
  if (hosted) {
    const own = base.slice(0, -(hosted.length + 1)).split('.')[0]
    if (own) return titleCaseLabel(own)
  }

  const parts = base.split('.').filter(Boolean)
  const skip = new Set(['www', 'app', 'www2', 'm', 'api', 'dev', 'staging'])
  let label = parts[0] ?? host
  if (parts.length >= 2 && skip.has(parts[0]!)) {
    label = parts[1]!
  } else if (parts.length >= 3 && parts[parts.length - 2]!.length <= 3) {
    // foo.co.uk → foo
    label = parts[parts.length - 3] ?? label
  } else if (parts.length >= 2) {
    label = parts[parts.length - 2] ?? label
  }

  return titleCaseLabel(label)
}

export function appHomepage(origin: string | undefined): string | null {
  const host = normalizeAppHost(origin)
  if (host === 'unknown-app') return null
  if (host === 'localhost' || host.startsWith('127.0.0.1')) {
    return `http://${host}`
  }
  return `https://${host}`
}

/**
 * Favicon candidates.
 *
 * Shared hosting domains return the platform's generic favicon for every app.
 * Only trust icons served by the app itself there; a missing icon should fall
 * back to our crisp vector app mark instead of a blurry Workers/Pages badge.
 */
export function appFaviconCandidates(origin: string | undefined): string[] {
  const host = normalizeAppHost(origin)
  if (host === 'unknown-app') return []
  const bare = host.split(':')[0] ?? host
  const home = appHomepage(origin)
  const urls: string[] = []
  if (home) {
    urls.push(
      `${home}/apple-touch-icon.png`,
      `${home}/favicon.svg`,
      `${home}/favicon.png`,
      `${home}/favicon.ico`,
    )
  }
  const sharedHost = APP_SUBDOMAIN_SUFFIXES.some(
    (suffix) => bare === suffix || bare.endsWith(`.${suffix}`),
  )
  if (!sharedHost) {
    urls.push(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(bare)}&sz=256`,
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(bare)}.ico`,
    )
  }
  return urls
}

export function appInitials(origin: string | undefined): string {
  const name = appDisplayName(origin)
  const bits = name.split(/\s+/).filter(Boolean)
  if (bits.length >= 2) return `${bits[0]![0]}${bits[1]![0]}`.toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function humanActionCopy(
  method: string,
  title?: string,
): { eyebrow: string; verb: string } {
  if (title === 'Send item' || title === 'Confirm item send' || title === 'Release item') {
    return { eyebrow: 'Item transfer', verb: 'wants to send or release a collectable' }
  }
  if (
    title === 'Send token' ||
    title === 'Confirm token send' ||
    title === 'Release token'
  ) {
    return { eyebrow: 'Token transfer', verb: 'wants to send or release a fungible token' }
  }
  if (title === 'Mint token') {
    return {
      eyebrow: 'Identity mint',
      verb: 'wants to mint a token backed by your identity',
    }
  }
  if (title === 'Receive token') {
    return { eyebrow: 'Receive token', verb: 'wants to add a fungible token to your inventory' }
  }
  if (title === 'Receive item') {
    return { eyebrow: 'Receive item', verb: 'wants to add a collectable to your inventory' }
  }
  if (title === 'View items' || method === 'listOutputs') {
    return { eyebrow: 'View items', verb: 'wants to see collectables in your wallet' }
  }
  switch (method) {
    case 'createAction':
      return { eyebrow: 'Payment request', verb: 'wants to make a payment' }
    case 'signAction':
      return { eyebrow: 'Confirm payment', verb: 'wants you to confirm a payment' }
    case 'internalizeAction':
      return { eyebrow: 'Incoming funds', verb: 'wants to add funds to your wallet' }
    case 'decrypt':
      return { eyebrow: 'Decrypt', verb: 'wants to decrypt data with your keys' }
    case 'createSignature':
      if (title === 'Prove wallet identity') {
        return {
          eyebrow: 'Identity proof',
          verb: 'wants proof that this wallet approved its challenge',
        }
      }
      return { eyebrow: 'Signature', verb: 'wants a signature from your wallet' }
    case 'revealCounterpartyKeyLinkage':
    case 'revealSpecificKeyLinkage':
      return { eyebrow: 'Key access', verb: 'wants to reveal key linkage details' }
    case 'acquireCertificate':
    case 'proveCertificate':
    case 'relinquishCertificate':
      return { eyebrow: 'Certificate', verb: 'wants to use a wallet certificate' }
    case 'relinquishOutput':
      return { eyebrow: 'Release funds', verb: 'wants to relinquish a wallet output' }
    default:
      return { eyebrow: 'Wallet request', verb: 'wants to use your wallet' }
  }
}
