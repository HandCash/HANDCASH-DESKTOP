import { beforeEach, describe, expect, it, vi } from 'vitest'

const identity = { key: '02'.padEnd(66, 'a') }

vi.mock('./session', () => ({ getActiveWallet: () => ({ identityKey: identity.key }) }))
vi.mock('./collectables', () => ({ getCachedCollectables: () => [] }))

import { heldInventoryOutputs } from './inventoryProjection'
import { rememberHeldBntAssets } from './bnt/heldAssets'
import { grantableTokensFromOutputs } from './itemAccess'

describe('held inventory projection', () => {
  beforeEach(() => {
    identity.key = '02'.padEnd(66, 'a')
    rememberHeldBntAssets(identity.key, [
      { assetId: 'ab'.repeat(20), kind: 'token', sym: 'GOLD' },
      { assetId: 'cd'.repeat(20), kind: 'item', name: 'Badge' },
    ])
  })

  it('names held tokens from the last holdings list, never items', () => {
    const outputs = heldInventoryOutputs('bntft')?.outputs ?? []
    expect(grantableTokensFromOutputs(outputs)).toEqual([{ id: 'ab'.repeat(20), ticker: 'GOLD' }])
  })

  it('answers nothing for another identity', () => {
    identity.key = '03'.padEnd(66, 'b')
    expect(heldInventoryOutputs('p bntft all')?.outputs).toEqual([])
  })

  it('never serves a BSV-21 basket', () => {
    expect(heldInventoryOutputs('bsv21')).toBeNull()
    expect(heldInventoryOutputs('p bsv21 all')).toBeNull()
  })
})
