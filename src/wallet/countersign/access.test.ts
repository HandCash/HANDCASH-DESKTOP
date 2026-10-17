import { describe, expect, it } from 'vitest'
import { prepareItemBasketArgs, withCountersignedAssetTags } from '../itemAccess'

const asset = `${'ab'.repeat(32)}_0`
const deployRow = { outpoint: `${'ab'.repeat(32)}.0`, tags: ['p2pft-cs:deploy', 'id:k1'] }
const heldRow = { outpoint: `${'cd'.repeat(32)}.1`, tags: [`p2pft-cs:${asset}`, 'id:k2'] }
const otherRow = { outpoint: `${'ef'.repeat(32)}.0`, tags: [`p2pft-cs:${'ef'.repeat(32)}_0`, 'id:k3'] }

describe('countersigned profiles p2pft-cs and 1sat-cs', () => {
  it('rewrites a scope to its own filing and drops the filter tags', () => {
    const prepared = prepareItemBasketArgs({ basket: 'p p2pft-cs asset', tags: [`p2pft-cs:${asset}`] })
    expect(prepared.error).toBeUndefined()
    expect(prepared.args).toEqual({ basket: 'p2pft-cs', includeTags: true })
    expect(prepared.countersignedViewRequest).toEqual({ scheme: 'p2pft-cs', scope: 'asset', values: [asset] })
    const items = prepareItemBasketArgs({ basket: 'p 1sat-cs all' })
    expect(items.args).toEqual({ basket: '1sat-cs', includeTags: true })
    expect(items.countersignedViewRequest).toEqual({ scheme: '1sat-cs', scope: 'all', values: [] })
  })

  it('refuses the bare filing, unknown scopes and scopes without a value', () => {
    expect(prepareItemBasketArgs({ basket: 'p2pft-cs' }).error?.code).toBe('USE_COUNTERSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: '1sat-cs' }).error?.code).toBe('USE_COUNTERSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'p p2pft-cs collection', tags: ['collection:x'] }).error?.code).toBe(
      'INVALID_COUNTERSIGNED_SCOPE',
    )
    expect(prepareItemBasketArgs({ basket: 'p 1sat-cs every' }).error?.code).toBe('INVALID_COUNTERSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'p 1sat-cs id' }).error?.code).toBe('MISSING_COUNTERSIGNED_SCOPE_TAG')
  })

  it('never answers a countersigned profile from the plain token or item scopes', () => {
    expect(prepareItemBasketArgs({ basket: 'p p2pft all' }).countersignedViewRequest).toBeUndefined()
    expect(prepareItemBasketArgs({ basket: 'p 1sat all' }).countersignedViewRequest).toBeUndefined()
  })

  it('refuses app writes into either filing and label spends', () => {
    for (const basket of ['p2pft-cs', '1sat-cs', 'p 1sat-cs all']) {
      expect(prepareItemBasketArgs({ outputs: [{ lockingScript: '51', satoshis: 1, basket }] }).error?.code).toBe(
        'COUNTERSIGNED_WALLET_ONLY',
      )
    }
    expect(prepareItemBasketArgs({ labels: ['p 1sat-cs input id k2'] }).error?.code).toBe('COUNTERSIGNED_WALLET_ONLY')
  })

  it('names a deploy row by its own outpoint and filters by scope', () => {
    const listed = { outputs: [deployRow, heldRow, otherRow], totalOutputs: 3 }
    const byAsset = withCountersignedAssetTags(listed, { scheme: 'p2pft-cs', scope: 'asset', values: [asset] }) as {
      outputs: Array<{ tags: string[] }>
    }
    expect(byAsset.outputs).toHaveLength(2)
    expect(byAsset.outputs[0]!.tags).toContain(`p2pft-cs:${asset}`)
    const byId = withCountersignedAssetTags(listed, { scheme: 'p2pft-cs', scope: 'id', values: ['k2'] }) as {
      outputs: unknown[]
    }
    expect(byId.outputs).toEqual([heldRow])
  })
})
