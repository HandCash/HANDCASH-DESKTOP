import { describe, expect, it } from 'vitest'
import { migrateEnvelope, storageRegistry } from './registry'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx') &&
      path !== join(process.cwd(), 'src/storage/registry.ts')
    ) {
      files.push(path)
    }
  }
  return files
}

describe('storage registry', () => {
  it('has one owner and one key per registered store', () => {
    const entries = Object.values(storageRegistry)
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length)
    expect(entries.every((entry) => entry.version > 0)).toBe(true)
  })

  it('registers every production HandCash storage literal', () => {
    const descriptors = Object.values(storageRegistry)
    const nonStorage = new Set([
      'handcash.io',
      'handcash.wallet',
      'handcash.brc39.v2',
      'handcash.wallet.runtime-state',
      'handcash.wallet.account-key-scope',
      'handcash.headless-storage',
      'handcash.brc100.',
    ])
    const missing = new Set<string>()
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/['"`](handcash\.[A-Za-z0-9_.:-]+)/g)) {
        const key = match[1]!
        if (nonStorage.has(key)) continue
        const registered = descriptors.some(
          (entry) =>
            entry.key === key ||
            (/[.:]$/.test(entry.key) && key.startsWith(entry.key)),
        )
        if (!registered) missing.add(key)
      }
    }
    expect([...missing].sort()).toEqual([])
  })

  it('keeps wallet-owned key literals inside the registry authority', () => {
    const walletKeys = Object.values(storageRegistry)
      .filter((entry) => entry.scope === 'wallet')
      .map((entry) => entry.key)
    const violations: string[] = []
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const key of walletKeys) {
        if (source.includes(`'${key}'`) || source.includes(`"${key}"`)) {
          violations.push(`${file.replace(`${process.cwd()}/`, '')}: ${key}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('runs migrations in order', () => {
    const result = migrateEnvelope(
      { v: 0, data: ['old'] },
      2,
      [
        { from: 0, to: 1, migrate: (data) => ({ rows: data }) },
        {
          from: 1,
          to: 2,
          migrate: (data) => ({ ...(data as object), stable: true }),
        },
      ],
      (data) => data as { rows: string[]; stable: boolean },
    )
    expect(result).toEqual({ v: 2, data: { rows: ['old'], stable: true } })
  })

  it('refuses migration gaps and newer unknown data', () => {
    expect(() => migrateEnvelope({ v: 0, data: null }, 1, [], () => null)).toThrow(
      'Missing storage migration',
    )
    expect(() => migrateEnvelope({ v: 2, data: null }, 1, [], () => null)).toThrow(
      'is newer',
    )
  })
})
