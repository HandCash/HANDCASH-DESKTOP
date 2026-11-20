import { Hash, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

const alice = { identityKey: '02' + 'a1'.repeat(32), accountIndex: 0, chain: 'main' as const }
const ENTRIES = 25_000

function txid(i: number): string {
  return i.toString(16).padStart(64, '0')
}

/** About 4.4 MB of journal, the size seen on a busy wallet. */
function journalEntries(): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < ENTRIES; i++) {
    out.push(
      i % 3 === 0
        ? { k: 'out', op: `${txid(i)}.0`, sats: 1, r: { p: 'basket insertion', basket: '1sat', ci: 'x'.repeat(40), tags: ['origin', `t${i}`] } }
        : { k: 'out', op: `${txid(i)}.1`, sats: 1000 + i, r: { p: 'wallet payment', prefix: `p${i}`.padEnd(24, 'a'), suffix: `s${i}`.padEnd(24, 'b') } },
    )
  }
  return out
}

/** The pre-change id and root: pure-JS sha256 of every entry on every load. */
function legacyIdsAndRoot(entries: readonly unknown[]): string {
  const ids = new Set<string>()
  for (const e of entries) ids.add(Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(e), 'utf8'))))
  return Utils.toHex(Hash.sha256(Utils.toArray([...ids].sort().join(''), 'utf8')))
}

async function load() {
  vi.resetModules()
  return import('./custodyJournal')
}

describe('custody journal load cost', () => {
  beforeEach(() => store.clear())

  it('loads a 4 MB journal without hashing it, and keeps the same root', async () => {
    const j = await load()
    expect(j.appendCustody(alice, journalEntries()).added).toBe(ENTRIES)
    const bytes = [...store.values()].reduce((n, v) => n + v.length, 0)
    expect(bytes).toBeGreaterThan(4_000_000)
    const held = j.custodyEntries(alice)

    const legacyStarted = performance.now()
    const legacyRoot = legacyIdsAndRoot(held)
    const legacyMs = performance.now() - legacyStarted

    const fresh = await load()
    const loadStarted = performance.now()
    expect(fresh.custodyRecipeFor(alice, `${txid(1)}.1`)?.sats).toBe(1001)
    const loadMs = performance.now() - loadStarted
    const rootStarted = performance.now()
    const root = fresh.custodyJournalRoot(alice)
    const rootMs = performance.now() - rootStarted

    console.info(
      `[custody-journal perf] ${ENTRIES} entries ${(bytes / 1e6).toFixed(2)} MB: ` +
        `before (bsv sha256 per entry on load) ${legacyMs.toFixed(0)}ms; ` +
        `after load ${loadMs.toFixed(0)}ms (parse+dedupe, no hashing), first root ${rootMs.toFixed(0)}ms (noble)`,
    )
    // Byte-identical root: replicas and backups made before this change still compare equal.
    expect(root).toBe(legacyRoot)
    expect(rootMs).toBeLessThan(legacyMs)

    // After one append only the new entry is hashed for the next root.
    fresh.appendCustody(alice, [{ k: 'spent', op: `${txid(1)}.1` }])
    const againStarted = performance.now()
    const next = fresh.custodyJournalRoot(alice)
    const againMs = performance.now() - againStarted
    expect(next).toBe(legacyIdsAndRoot(fresh.custodyEntries(alice)))
    console.info(`[custody-journal perf] root after one append ${againMs.toFixed(0)}ms`)
  }, 60_000)

  it('gives each entry the same id as the pure-JS hash, including non-ASCII text', async () => {
    const j = await load()
    const entry = { k: 'out', op: `${txid(7)}.0`, sats: 5, r: { p: 'basket insertion', basket: 'café ✓', ci: '{"n":"𝔁"}' } } as const
    expect(j.custodyEntryId(entry)).toBe(Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(entry), 'utf8'))))
  })
})
