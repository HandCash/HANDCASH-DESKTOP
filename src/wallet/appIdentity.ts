export type AppPermissionScope = {
  id: string
  label: string
  /** One-line summary shown on chips and detail header. */
  description: string
  /** Short bullets for the detail subcontext. */
  allows: string[]
}

/** High-level scopes shown on connect — mirrors HandCash Connect language. */
export const CONNECT_SCOPES: AppPermissionScope[] = [
  {
    id: 'public-profile',
    label: 'Public profile',
    description: 'Read your public identity key. Cannot unlock or spend.',
    allows: ['Identity key', 'Public recognition in the app'],
  },
  {
    id: 'pay',
    label: 'Pay',
    description:
      'Request BSV payments. You approve each one unless auto-pay is on. Does not include collectables.',
    allows: ['BSV payment requests', 'Amounts shown for confirmation', 'Never spends NFTs / items'],
  },
  {
    id: 'wallet',
    label: 'Wallet activity',
    description: 'Read balance and activity. Does not approve payments or show item inventory.',
    allows: ['Balance & status', 'Related activity'],
  },
  {
    id: 'encrypt',
    label: 'Encrypt & decrypt',
    description: 'Encrypt or decrypt with keys for this app. Plaintext stays in the wallet.',
    allows: ['Encrypt for this app', 'Decrypt for this app'],
  },
  {
    id: 'items-view',
    label: 'View items',
    description:
      'See collectables on this device when you approve. Local only — not other phones or desktops.',
    allows: [
      'List 1Sat inventory on this wallet',
      'Optional collection filter',
      'Optional creator filter',
    ],
  },
  {
    id: 'items-send',
    label: 'Send items',
    description: 'Transfer a collectable. Separate from Pay — auto-pay never applies.',
    allows: ['Send 1Sat ordinals', 'Release item outputs'],
  },
  {
    id: 'items-receive',
    label: 'Receive items',
    description: 'Accept collectables into your inventory when you approve.',
    allows: ['Receive 1Sat ordinals'],
  },
]

export const AUTO_PAY_SCOPE: AppPermissionScope = {
  id: 'auto-pay',
  label: 'Auto-pay',
  description:
    'Auto-approve matching BSV payments within your limits. Never covers collectables. Turn off anytime.',
  allows: ['BSV payments under your max', 'Within your time window', 'Never spends NFTs / items'],
}

export function getPermissionScope(scopeId: string): AppPermissionScope | null {
  if (scopeId === AUTO_PAY_SCOPE.id) return AUTO_PAY_SCOPE
  return CONNECT_SCOPES.find((s) => s.id === scopeId) ?? null
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
  if (base === 'market.handcash.io' || base === 'preprod-market.handcash.io') {
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

/** Favicon candidates — Google/DuckDuckGo first (reliable), then site icon. */
export function appFaviconCandidates(origin: string | undefined): string[] {
  const host = normalizeAppHost(origin)
  if (host === 'unknown-app') return []
  const bare = host.split(':')[0] ?? host
  const home = appHomepage(origin)
  const urls: string[] = [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(bare)}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(bare)}.ico`,
  ]
  if (home) {
    urls.push(`${home}/favicon.ico`, `${home}/favicon.png`, `${home}/apple-touch-icon.png`)
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
  if (title === 'Mint token') {
    return {
      eyebrow: 'Identity mint',
      verb: 'wants to mint a token backed by your identity',
    }
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
