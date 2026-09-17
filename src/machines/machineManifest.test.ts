import { describe, expect, it } from 'vitest'
import { machineManifest, machineStateManifest } from './machineManifest'

describe('machine manifest', () => {
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
