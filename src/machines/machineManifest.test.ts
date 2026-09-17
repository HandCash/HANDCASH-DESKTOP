import { describe, expect, it } from 'vitest'
import { machineManifest, machineStateManifest } from './machineManifest'

describe('machine manifest', () => {
  it('ratchets every source *Machine.ts export into the catalog', () => {
    const sourceModules = import.meta.glob('../**/*Machine.ts', {
      eager: true,
    }) as Record<string, Record<string, unknown>>
    const catalog = new Set(Object.values(machineManifest))
    const missing: string[] = []

    for (const [path, exports] of Object.entries(sourceModules)) {
      for (const [name, value] of Object.entries(exports)) {
        if (!name.endsWith('Machine')) continue
        if (!catalog.has(value as (typeof machineManifest)[keyof typeof machineManifest])) {
          missing.push(`${path}:${name}`)
        }
      }
    }

    expect(missing).toEqual([])
    expect(catalog.size).toBe(28)
  })

  it('gives every authoritative flow a stable id and states', () => {
    const states = machineStateManifest()
    expect(Object.keys(states)).toEqual(Object.keys(machineManifest))
    for (const [id, values] of Object.entries(states)) {
      expect(values.length, id).toBeGreaterThan(0)
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('keeps UTXO mutation paths in the executable catalog', () => {
    expect(Object.keys(machineManifest)).toEqual(
      expect.arrayContaining([
        'collectableSend',
        'itemSend',
        'brc29Send',
        'bsvSend',
        'burn',
        'walletCoordinator',
      ]),
    )
  })
})
