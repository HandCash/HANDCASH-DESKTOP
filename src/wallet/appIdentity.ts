export type AppPermissionScope = {
  id: string
  label: string
  description: string
}

/** High-level scopes shown on connect — mirrors HandCash Connect language. */
export const CONNECT_SCOPES: AppPermissionScope[] = [
  {
    id: 'public-profile',
    label: 'Public profile',
    description: 'See your public identity key',
  },
  {
    id: 'pay',
    label: 'Pay',
    description: 'Request payments — you approve each one',
  },
  {
    id: 'wallet',
    label: 'Wallet activity',
    description: 'See balance and transaction activity',
  },
  {
    id: 'encrypt',
    label: 'Encrypt & decrypt',
    description: 'Secure data with your wallet keys',
  },
]

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

/** Turn a host into a readable app name: market.handcash.io → Market */
export function appDisplayName(origin: string | undefined): string {
  const host = normalizeAppHost(origin)
  if (host === 'unknown-app') return 'Unknown app'
  if (host === 'localhost' || host.startsWith('127.0.0.1')) return 'Local app'

  const base = host.split(':')[0] ?? host
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

  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
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

export function humanActionCopy(method: string): { eyebrow: string; verb: string } {
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
