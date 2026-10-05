/**
 * Where legacy wallets kept their keys.
 *
 * A template is a path pattern with `{c}` (chain/branch) and `{i}` (address
 * index). Indexed templates are walked with a history gap limit; fixed ones
 * are a single address. The list follows what BSV wallets actually shipped —
 * BIP44 coin types, HandCash v1, Yours, 1Sat, Twetch and bare BIP32 layouts —
 * so one phrase is checked against every wallet that might have used it.
 */
export type PathTemplate = {
  id: string
  label: string
  /** Wallets known to use it — shown beside a hit. */
  wallets: string
  pattern: string
  /** Values substituted for `{c}`; absent when the pattern has no chain level. */
  branches?: readonly number[]
  /** Consecutive unused addresses before an indexed walk stops. */
  gap?: number
  /** Minted items sit under a non-standard lock address history cannot see. */
  itemsRoot?: boolean
}

export const BIP44_GAP = 20
/** HandCash leaves long unused runs; HandCash/recovery-tool settled on 1,000. */
export const HANDCASH_GAP = 1_000
/** Hard ceiling per walk so a broken provider cannot keep a scan alive forever. */
export const MAX_INDEX = 5_000

export const PHRASE_TEMPLATES: readonly PathTemplate[] = [
  {
    id: 'bip44-bsv',
    label: 'BSV (BIP44)',
    wallets: 'Yours, RelayX, Simply Cash, Exodus',
    pattern: "m/44'/236'/0'/{c}/{i}",
    branches: [0, 1, 2],
  },
  {
    id: 'bip44-bsv-ord',
    label: 'BSV ordinals',
    wallets: 'Yours ordinals',
    pattern: "m/44'/236'/1'/{c}/{i}",
    branches: [0, 1],
  },
  {
    id: 'bip44-btc',
    label: 'BTC coin type',
    wallets: 'MoneyButton, Centbee, ElectrumSV',
    pattern: "m/44'/0'/0'/{c}/{i}",
    branches: [0, 1],
  },
  {
    id: 'bip44-bch',
    label: 'BCH coin type',
    wallets: 'Centi, pre-fork BCH wallets',
    pattern: "m/44'/145'/0'/{c}/{i}",
    branches: [0, 1],
  },
  {
    id: 'handcash-v1',
    label: 'HandCash v1',
    wallets: 'HandCash (2018–2019)',
    pattern: "m/0'/{c}/{i}",
    branches: [0, 1],
  },
  {
    id: 'yours-identity',
    label: 'Yours identity',
    wallets: 'Yours',
    pattern: "m/0'/236'/0'/{c}/{i}",
    branches: [0],
  },
  {
    id: 'onesat-standard',
    label: '1Sat',
    wallets: '1Sat Ordinals',
    pattern: "m/0'/0'/{i}'",
  },
  {
    id: 'bare-branch',
    label: 'BIP32 branch',
    wallets: 'Twetch, DotWallet, older HD wallets',
    pattern: 'm/{c}/{i}',
    branches: [0, 1],
  },
  {
    id: 'bare-flat',
    label: 'BIP32 flat',
    wallets: 'Bitcoin.com, older HD wallets',
    pattern: 'm/{i}',
  },
  {
    id: 'bare-hardened',
    label: 'BIP32 hardened',
    wallets: 'Older HD wallets',
    pattern: "m/{i}'",
  },
  { id: 'root', label: 'Seed root', wallets: 'Single-key wallets', pattern: 'm' },
  {
    id: 'electrum-bsv',
    label: 'ElectrumSV accounts',
    wallets: 'ElectrumSV',
    pattern: "m/44'/236'/{i}'/0/0",
  },
]

/**
 * HandCash v2+ two-key export: ten roots walked identically. `m/9` is where
 * items are minted, under a lock address history cannot see.
 */
export const HANDCASH_TEMPLATES: readonly PathTemplate[] = Array.from(
  { length: 10 },
  (_, root): PathTemplate => ({
    id: `handcash-m${root}`,
    label: root === 9 ? 'HandCash items' : root >= 7 ? 'HandCash tokens' : 'HandCash',
    wallets: 'HandCash',
    pattern: `m/${root}/{i}`,
    gap: HANDCASH_GAP,
    itemsRoot: root === 9,
  }),
)

/** Twetch signed with `m/0/0`; its identity lives there, not in BRC-100. */
export const TWETCH_IDENTITY_PATH = 'm/0/0'

export function isIndexedTemplate(template: PathTemplate): boolean {
  return template.pattern.includes('{i}')
}

/** Concrete path for one address of a template. */
export function templatePath(template: PathTemplate, branch: number | null, index: number): string {
  let path = template.pattern
  if (branch != null) path = path.replace('{c}', String(branch))
  return path.replace('{i}', String(index))
}

/** One walk per (template, branch): each has its own gap window. */
export type TemplateWalk = {
  template: PathTemplate
  branch: number | null
  label: string
}

export function templateWalks(templates: readonly PathTemplate[]): TemplateWalk[] {
  return templates.flatMap((template) => {
    const branches = template.pattern.includes('{c}') ? (template.branches ?? [0]) : [null]
    return branches.map((branch) => ({
      template,
      branch,
      label:
        branch == null || branches.length === 1
          ? template.label
          : `${template.label} · ${branch === 0 ? 'receive' : branch === 1 ? 'change' : `branch ${branch}`}`,
    }))
  })
}
