import { describe, expect, it } from 'vitest'
import { prepareItemBasketArgs, withCountersignedAssetTags } from '../itemAccess'

const asset = `${'ab'.repeat(32)}_0`
const deployRow = { outpoint: `${'ab'.repeat(32)}.0`, tags: ['csft:deploy', 'id:k1'] }
const heldRow = { outpoint: `${'cd'.repeat(32)}.1`, tags: [`csft:${asset}`, 'id:k2'] }
const otherRow = { outpoint: `${'ef'.repeat(32)}.0`, tags: [`csft:${'ef'.repeat(32)}_0`, 'id:k3'] }

describe('countersigned profiles csft and csnft', () => {
  it('rewrites a scope to its own filing and drops the filter tags', () => {
    const prepared = prepareItemBasketArgs({ basket: 'p csft asset', tags: [`csft:${asset}`] })
    expect(prepared.error).toBeUndefined()
    expect(prepared.args).toEqual({ basket: 'csft', includeTags: true })
    expect(prepared.countersignedViewRequest).toEqual({ scheme: 'csft', scope: 'asset', values: [asset] })
    const items = prepareItemBasketArgs({ basket: 'p csnft all' })
    expect(items.args).toEqual({ basket: 'csnft', includeTags: true })
    expect(items.countersignedViewRequest).toEqual({ scheme: 'csnft', scope: 'all', values: [] })
  })

  it('refuses the bare filing, unknown scopes and scopes without a value', () => {
    expect(prepareItemBasketArgs({ basket: 'csft' }).error?.code).toBe('USE_COUNTERSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'csnft' }).error?.code).toBe('USE_COUNTERSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'p csft collection', tags: ['collection:x'] }).error?.code).toBe(
      'INVALID_COUNTERSIGNED_SCOPE',
    )
    expect(prepareItemBasketArgs({ basket: 'p csnft every' }).error?.code).toBe('INVALID_COUNTERSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'p csnft id' }).error?.code).toBe('MISSING_COUNTERSIGNED_SCOPE_TAG')
  })

  it('never answers a countersigned profile from the plain token or item scopes', () => {
    expect(prepareItemBasketArgs({ basket: 'p p2pft all' }).countersignedViewRequest).toBeUndefined()
    expect(prepareItemBasketArgs({ basket: 'p 1sat all' }).countersignedViewRequest).toBeUndefined()
  })

  it('refuses app writes into either filing and label spends', () => {
    for (const basket of ['csft', 'csnft', 'p csnft all']) {
      expect(prepareItemBasketArgs({ outputs: [{ lockingScript: '51', satoshis: 1, basket }] }).error?.code).toBe(
        'COUNTERSIGNED_WALLET_ONLY',
      )
    }
    expect(prepareItemBasketArgs({ labels: ['p csnft input id k2'] }).error?.code).toBe('COUNTERSIGNED_WALLET_ONLY')
  })

  it('names a deploy row by its own outpoint and filters by scope', () => {
    const listed = { outputs: [deployRow, heldRow, otherRow], totalOutputs: 3 }
    const byAsset = withCountersignedAssetTags(listed, { scheme: 'csft', scope: 'asset', values: [asset] }) as {
      outputs: Array<{ tags: string[] }>
    }
    expect(byAsset.outputs).toHaveLength(2)
    expect(byAsset.outputs[0]!.tags).toContain(`csft:${asset}`)
    const byId = withCountersignedAssetTags(listed, { scheme: 'csft', scope: 'id', values: ['k2'] }) as {
      outputs: unknown[]
    }
    expect(byId.outputs).toEqual([heldRow])
  })
})
