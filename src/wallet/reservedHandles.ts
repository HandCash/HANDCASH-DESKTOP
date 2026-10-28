/**
 * Reserved handles: names nobody can buy or be issued unless the
 * reservation's owner releases them. The list is `reservedHandles.json`, the
 * one copy; BRC-CLOUD vendors this module with it
 * (`npm run sync:reserved-handles`) and enforces it on the market and on every
 * claim. This module has no imports beyond the list so it bundles anywhere.
 *
 * A name matches after case folding and look-alike normalization, so `App1e`,
 * `g-o-o-g-l-e` and `аpple` (Cyrillic a) all match their name. Brand,
 * product, person, coin and HandCash names also match with a listed affix
 * (`apple_official`, `realelonmusk`).
 */
import data from './reservedHandles.json'

export type ReservedHandleCategory = 'carried-over' | 'handcash' | 'system' | 'coin' | 'brand' | 'product' | 'person'

export type ReservedHandleRule = {
  id: string
  kind: 'name' | 'prefix' | 'regex'
  value: string
  category: ReservedHandleCategory
  reason: string
  /** Where an existing reservation came from. */
  source?: string
  /** The only identity key that can release it; absent means the host's default owner. */
  owner?: string
}

export type ReservedHandleMatch = {
  rule: ReservedHandleRule
  via: 'exact' | 'lookalike' | 'affix' | 'pattern'
}

export type ReservedHandleList = {
  version: number
  affixes: string[]
  rules: ReservedHandleRule[]
}

type RawList = {
  version: number
  affixes: string[]
  patterns: { id: string; match: string; value: string; reason: string; source?: string; owner?: string }[]
  names: { name: string; category: string; reason: string; source?: string; owner?: string }[]
}

const AFFIXED_CATEGORIES = new Set<ReservedHandleCategory>(['handcash', 'coin', 'brand', 'product', 'person'])

/**
 * One character for each look-alike. The first six (1 i 3 0 6 and the
 * separators) are handcash-cloud's alias normalizer; the rest cover other
 * digits, symbols and Cyrillic and Greek letters that render as Latin ones.
 */
const LOOKALIKES: Record<string, string> = {
  '1': 'l', i: 'l', '3': 'e', '0': 'o', '6': 's',
  '!': 'l', '|': 'l', '2': 'z', '4': 'a', '@': 'a', '5': 's', $: 's', '7': 't', '8': 'b', '9': 'g', 'ß': 'ss',
  а: 'a', в: 'b', е: 'e', ё: 'e', і: 'l', ї: 'l', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', ι: 'l', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
}

/** Lower case, without a leading `$` or `@` sigil. */
function plainHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@?\$|^@/, '')
}

/**
 * The form two handles share when they look alike: accents dropped,
 * look-alike characters mapped, separators and anything else removed, `rn`
 * read as `m`, `vv` as `w`, and a letter repeated three times or more read as
 * two (`gooogle`). Single and double letters stay apart: folding them would
 * make `channel` a copy of `chanel`.
 */
export function handleSkeleton(raw: string): string {
  let mapped = ''
  for (const ch of plainHandle(raw).normalize('NFKD').replace(/\p{M}+/gu, '')) mapped += LOOKALIKES[ch] ?? ch
  return mapped.replace(/[^a-z]/g, '').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/(.)\1{2,}/g, '$1$1')
}

export function parseReservedHandleList(raw: RawList): ReservedHandleList {
  const rules: ReservedHandleRule[] = [
    ...raw.patterns.map((p) => ({
      id: p.id,
      kind: p.match === 'prefix' ? ('prefix' as const) : ('regex' as const),
      value: p.value,
      category: 'carried-over' as const,
      reason: p.reason,
      ...(p.source ? { source: p.source } : {}),
      ...(p.owner ? { owner: p.owner.toLowerCase() } : {}),
    })),
    ...raw.names.map((n) => ({
      id: n.name,
      kind: 'name' as const,
      value: n.name,
      category: n.category as ReservedHandleCategory,
      reason: n.reason,
      ...(n.source ? { source: n.source } : {}),
      ...(n.owner ? { owner: n.owner.toLowerCase() } : {}),
    })),
  ]
  return { version: raw.version, affixes: raw.affixes, rules }
}

export const RESERVED_HANDLES: ReservedHandleList = parseReservedHandleList(data as RawList)
export const RESERVED_HANDLES_VERSION = RESERVED_HANDLES.version

type Index = {
  plain: Map<string, ReservedHandleRule[]>
  skeleton: Map<string, ReservedHandleRule[]>
  /** Skeletons of the names that also match with an affix. */
  affixed: Map<string, ReservedHandleRule[]>
  affixes: string[]
  patterns: ReservedHandleRule[]
}

const indexes = new WeakMap<ReservedHandleList, Index>()

function add(map: Map<string, ReservedHandleRule[]>, key: string, rule: ReservedHandleRule): void {
  if (!key) return
  const rules = map.get(key)
  if (rules) rules.push(rule)
  else map.set(key, [rule])
}

function indexOf(list: ReservedHandleList): Index {
  let index = indexes.get(list)
  if (index) return index
  index = { plain: new Map(), skeleton: new Map(), affixed: new Map(), affixes: [], patterns: [] }
  for (const rule of list.rules) {
    if (rule.kind !== 'name') {
      index.patterns.push(rule)
      continue
    }
    add(index.plain, rule.value, rule)
    add(index.skeleton, handleSkeleton(rule.value), rule)
    if (AFFIXED_CATEGORIES.has(rule.category)) add(index.affixed, handleSkeleton(rule.value), rule)
  }
  index.affixes = [...new Set(list.affixes.map((a) => handleSkeleton(a)).filter(Boolean))]
  indexes.set(list, index)
  return index
}

function patternMatches(rule: ReservedHandleRule, plain: string): boolean {
  if (rule.kind === 'prefix') return plain.startsWith(rule.value) || plain.replace(/[._-]/g, '').startsWith(rule.value)
  return new RegExp(rule.value).test(plain)
}

/** Every reservation the handle falls under, or none when it is free to buy and issue. */
export function reservedHandleMatches(raw: string, list: ReservedHandleList = RESERVED_HANDLES): ReservedHandleMatch[] {
  const plain = plainHandle(raw)
  if (!plain) return []
  const index = indexOf(list)
  const found = new Map<ReservedHandleRule, ReservedHandleMatch['via']>()
  const note = (rules: ReservedHandleRule[] | undefined, via: ReservedHandleMatch['via']) => {
    for (const rule of rules ?? []) if (!found.has(rule)) found.set(rule, via)
  }

  for (const rule of index.patterns) if (patternMatches(rule, plain)) note([rule], 'pattern')
  note(index.plain.get(plain.replace(/[._-]/g, '')), 'exact')
  const skeleton = handleSkeleton(plain)
  note(index.skeleton.get(skeleton), 'lookalike')
  for (const affix of index.affixes) {
    if (skeleton.length <= affix.length) continue
    if (skeleton.startsWith(affix)) note(index.affixed.get(skeleton.slice(affix.length)), 'affix')
    if (skeleton.endsWith(affix)) note(index.affixed.get(skeleton.slice(0, -affix.length)), 'affix')
  }
  return [...found].map(([rule, via]) => ({ rule, via }))
}

export function isReservedHandle(raw: string, list: ReservedHandleList = RESERVED_HANDLES): boolean {
  return reservedHandleMatches(raw, list).length > 0
}

/** The refusal people read: which reservation, and who can lift it. */
export function reservedHandleMessage(handle: string, matches: ReservedHandleMatch[]): string {
  const reasons = [...new Set(matches.map((m) => m.rule.reason))]
  return `$${plainHandle(handle)} is reserved (${reasons.join('; ')}). Only the reservation's owner can release it.`
}
