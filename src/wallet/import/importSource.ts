import { HD, Mnemonic, PrivateKey } from '@bsv/sdk'
import { rootKeyFromMnemonicBrc75 } from '../vault'
import {
  HandCashKeyring,
  describeKeyPairProblem,
  extractExtendedKeys,
} from './handcashShares'
import {
  HANDCASH_TEMPLATES,
  PHRASE_TEMPLATES,
  TWETCH_IDENTITY_PATH,
  type PathTemplate,
} from './pathCatalog'

/**
 * Legacy wallets the Import section can hold.
 *
 * None of these is ever a BRC-100 identity or an account in the switcher: an
 * imported source is a stored, viewable key set, and only an explicit sweep
 * moves compatible assets out of it.
 */
export type ImportSourceKind = 'handcash' | 'phrase' | 'twetch' | 'yours' | 'wif'

export type ImportSecret =
  | { kind: 'handcash'; first: string; second: string }
  | { kind: 'phrase'; mnemonic: string; passphrase: string }
  | { kind: 'twetch'; mnemonic: string; passphrase: string }
  | {
      kind: 'yours'
      mnemonic: string | null
      /** WIF keys from the export, by role. */
      keys: Array<{ role: 'pay' | 'ord' | 'identity'; wif: string; path: string | null }>
    }
  | { kind: 'wif'; wifs: string[] }

/** HandCash first — it is the wallet most users are leaving. */
export const IMPORT_SOURCE_KINDS: readonly ImportSourceKind[] = [
  'handcash',
  'phrase',
  'twetch',
  'yours',
  'wif',
]

export const IMPORT_SOURCE_LABELS: Readonly<Record<ImportSourceKind, string>> = {
  handcash: 'HandCash',
  phrase: 'Recovery phrase',
  twetch: 'Twetch',
  yours: 'Yours export',
  wif: 'Private key',
}

export const IMPORT_SOURCE_HINTS: Readonly<Record<ImportSourceKind, string>> = {
  handcash: 'The two keys from HandCash → Settings → Export keys',
  phrase: '12 or 24 words from any BSV wallet',
  twetch: 'Your Twetch 12-word phrase — shown here, never used to sign in apps',
  yours: 'The JSON file from Yours → Settings → Export keys',
  wif: 'One or more WIF private keys',
}

/** A key the source pins outright rather than deriving from a template. */
export type FixedKey = { path: string; label: string; key: PrivateKey }

export type KeyDeriver = {
  templates: readonly PathTemplate[]
  fixed: FixedKey[]
  privateKeyAt(path: string): PrivateKey
  /** Display-only identity for the Import section; never a BRC-100 identity. */
  identity: { label: string; path: string } | null
}

export type ParsedSecret = { ok: true; secret: ImportSecret } | { ok: false; error: string }

function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

function mnemonicProblem(mnemonic: string): string | null {
  const words = mnemonic.split(' ').filter(Boolean).length
  if (![12, 15, 18, 21, 24].includes(words)) return 'Enter a 12- or 24-word recovery phrase.'
  try {
    if (Mnemonic.fromString(mnemonic).check()) return null
  } catch {
    /* unknown word */
  }
  return 'That phrase is not a valid BIP39 mnemonic.'
}

function wifProblem(wif: string): string | null {
  try {
    PrivateKey.fromWif(wif)
    return null
  } catch {
    return `Not a valid private key: ${wif.slice(0, 6)}…`
  }
}

type YoursExport = {
  mnemonic?: unknown
  payPk?: unknown
  ordPk?: unknown
  identityPk?: unknown
  payDerivationPath?: unknown
  ordDerivationPath?: unknown
  identityDerivationPath?: unknown
}

function parseYoursExport(raw: string): ParsedSecret {
  let body: YoursExport
  try {
    body = JSON.parse(raw) as YoursExport
  } catch {
    return { ok: false, error: 'That is not a Yours export file (expected JSON).' }
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'That is not a Yours export file.' }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const keys: Extract<ImportSecret, { kind: 'yours' }>['keys'] = []
  for (const [role, wifField, pathField] of [
    ['pay', body.payPk, body.payDerivationPath],
    ['ord', body.ordPk, body.ordDerivationPath],
    ['identity', body.identityPk, body.identityDerivationPath],
  ] as const) {
    const wif = str(wifField)
    if (!wif) continue
    const problem = wifProblem(wif)
    if (problem) return { ok: false, error: `${role} key: ${problem}` }
    keys.push({ role, wif, path: str(pathField) })
  }
  const mnemonicRaw = str(body.mnemonic)
  const mnemonic = mnemonicRaw ? normalizeMnemonic(mnemonicRaw) : null
  if (mnemonic) {
    const problem = mnemonicProblem(mnemonic)
    if (problem) return { ok: false, error: problem }
  }
  if (!mnemonic && keys.length === 0) {
    return { ok: false, error: 'The export holds no phrase and no keys.' }
  }
  return { ok: true, secret: { kind: 'yours', mnemonic, keys } }
}

/** Validate what the user pasted for `kind`. Nothing is derived or stored here. */
export function parseImportSecret(
  kind: ImportSourceKind,
  fields: { primary: string; secondary?: string; passphrase?: string },
): ParsedSecret {
  switch (kind) {
    case 'handcash': {
      // An export pasted as one block lands in either field and still splits.
      const pasted = extractExtendedKeys(`${fields.primary}\n${fields.secondary ?? ''}`)
      const [first, second] =
        pasted.length >= 2
          ? [pasted[0]!, pasted[1]!]
          : [fields.primary.trim(), (fields.secondary ?? '').trim()]
      const problem = describeKeyPairProblem(first, second)
      if (problem) return { ok: false, error: problem }
      return { ok: true, secret: { kind: 'handcash', first, second } }
    }
    case 'phrase':
    case 'twetch': {
      const mnemonic = normalizeMnemonic(fields.primary)
      const problem = mnemonicProblem(mnemonic)
      if (problem) return { ok: false, error: problem }
      return { ok: true, secret: { kind, mnemonic, passphrase: fields.passphrase ?? '' } }
    }
    case 'yours':
      return parseYoursExport(fields.primary)
    case 'wif': {
      const wifs = [...new Set(fields.primary.split(/[\s,]+/).filter(Boolean))]
      if (wifs.length === 0) return { ok: false, error: 'Paste at least one private key.' }
      for (const wif of wifs) {
        const problem = wifProblem(wif)
        if (problem) return { ok: false, error: problem }
      }
      return { ok: true, secret: { kind: 'wif', wifs } }
    }
  }
}

/**
 * BIP32 deriver that derives each parent node once. A walk asks for hundreds
 * of siblings, and re-deriving hardened levels from the seed for each one is
 * where a scan's time would go.
 */
function hdDeriver(master: HD): (path: string) => PrivateKey {
  const parents = new Map<string, HD>()
  const parentOf = (path: string): HD => {
    if (path === 'm' || path === '') return master
    const cached = parents.get(path)
    if (cached) return cached
    const node = master.derive(path)
    parents.set(path, node)
    return node
  }
  return (path: string) => {
    if (path === 'm') return master.privKey
    const separator = path.lastIndexOf('/')
    const segment = path.slice(separator + 1)
    const hardened = segment.endsWith("'")
    const index = Number(hardened ? segment.slice(0, -1) : segment)
    if (!Number.isInteger(index) || index < 0) throw new Error(`Bad path ${path}`)
    const child = parentOf(path.slice(0, separator)).deriveChild(
      hardened ? index + 0x80000000 : index,
    )
    return child.privKey
  }
}

function phraseDeriver(
  mnemonic: string,
  passphrase: string,
  identity: KeyDeriver['identity'],
): KeyDeriver {
  const master = HD.fromSeed(Mnemonic.fromString(mnemonic).toSeed(passphrase))
  const fixed: FixedKey[] = []
  try {
    const brc75 = rootKeyFromMnemonicBrc75(mnemonic, passphrase)
    fixed.push({
      path: 'brc75',
      label: 'BRC-75 root (HandCash / Yours)',
      key: PrivateKey.fromHex(brc75.rootKeyHex),
    })
  } catch {
    /* invalid phrases never reach a deriver */
  }
  const derive = hdDeriver(master)
  return {
    templates: PHRASE_TEMPLATES,
    fixed,
    identity,
    privateKeyAt: (path) => {
      const pinned = fixed.find((k) => k.path === path)
      return pinned ? pinned.key : derive(path)
    },
  }
}

const YOURS_ROLE_LABELS = { pay: 'Yours pay key', ord: 'Yours ordinals key', identity: 'Yours identity key' }

/** The key set behind a stored source. */
export function keyDeriverFor(secret: ImportSecret): KeyDeriver {
  switch (secret.kind) {
    case 'handcash': {
      const keyring = HandCashKeyring.fromExtendedKeys(secret.first, secret.second)
      return {
        templates: HANDCASH_TEMPLATES,
        fixed: [],
        identity: null,
        privateKeyAt: (path) => keyring.privateKeyAt(path),
      }
    }
    case 'phrase':
      return phraseDeriver(secret.mnemonic, secret.passphrase, null)
    case 'twetch':
      return phraseDeriver(secret.mnemonic, secret.passphrase, {
        label: 'Twetch identity',
        path: TWETCH_IDENTITY_PATH,
      })
    case 'yours': {
      const fixed: FixedKey[] = secret.keys.map((k) => ({
        path: `yours:${k.role}`,
        label: YOURS_ROLE_LABELS[k.role],
        key: PrivateKey.fromWif(k.wif),
      }))
      const identity = secret.keys.some((k) => k.role === 'identity')
        ? { label: 'Yours identity', path: 'yours:identity' }
        : null
      if (secret.mnemonic) {
        const base = phraseDeriver(secret.mnemonic, '', identity)
        return {
          ...base,
          fixed: [...fixed, ...base.fixed],
          privateKeyAt: (path) => fixed.find((k) => k.path === path)?.key ?? base.privateKeyAt(path),
        }
      }
      return {
        templates: [],
        fixed,
        identity,
        privateKeyAt: (path) => {
          const pinned = fixed.find((k) => k.path === path)
          if (!pinned) throw new Error(`No key at ${path}`)
          return pinned.key
        },
      }
    }
    case 'wif': {
      const fixed: FixedKey[] = secret.wifs.map((wif, i) => ({
        path: `wif:${i}`,
        label: secret.wifs.length === 1 ? 'Private key' : `Private key ${i + 1}`,
        key: PrivateKey.fromWif(wif),
      }))
      return {
        templates: [],
        fixed,
        identity: null,
        privateKeyAt: (path) => {
          const pinned = fixed.find((k) => k.path === path)
          if (!pinned) throw new Error(`No key at ${path}`)
          return pinned.key
        },
      }
    }
  }
}

/** Short non-secret fingerprint so two saves of one wallet are recognised. */
export function sourceFingerprint(secret: ImportSecret): string {
  const deriver = keyDeriverFor(secret)
  const probe =
    deriver.fixed[0]?.path ??
    (secret.kind === 'handcash' ? 'm/0/0' : "m/44'/236'/0'/0/0")
  return deriver.privateKeyAt(probe).toPublicKey().toAddress()
}
