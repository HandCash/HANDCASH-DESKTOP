import { describe, expect, it } from 'vitest'
import { prepareItemBasketArgs, withCosignedAssetTags } from '../itemAccess'

const asset = `${'ab'.repeat(32)}_0`
const deployRow = { outpoint: `${'ab'.repeat(32)}.0`, tags: ['cosigned:deploy', 'cosigned:token', 'id:k1'] }
const heldRow = { outpoint: `${'cd'.repeat(32)}.1`, tags: [`cosigned:${asset}`, 'cosigned:token', 'id:k2'] }
const itemRow = { outpoint: `${'ef'.repeat(32)}.0`, tags: [`cosigned:${'ef'.repeat(32)}_0`, 'cosigned:item', 'id:k3'] }

describe('p cosigned view scope', () => {
  it('rewrites a scope to the filing and drops the filter tags', () => {
    const prepared = prepareItemBasketArgs({ basket: 'p cosigned asset', tags: [`cosigned:${asset}`] })
    expect(prepared.error).toBeUndefined()
    expect(prepared.args).toEqual({ basket: 'cosigned', includeTags: true })
    expect(prepared.cosignedViewRequest).toEqual({ scope: 'asset', values: [asset] })
  })

  it('refuses the bare filing, unknown scopes and scopes without a value', () => {
    expect(prepareItemBasketArgs({ basket: 'cosigned' }).error?.code).toBe('USE_PCOSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'p cosigned every' }).error?.code).toBe('INVALID_PCOSIGNED_SCOPE')
    expect(prepareItemBasketArgs({ basket: 'p cosigned id' }).error?.code).toBe('MISSING_PCOSIGNED_SCOPE_TAG')
  })

  it('refuses app writes into the filing and label spends', () => {
    expect(
      prepareItemBasketArgs({ outputs: [{ lockingScript: '51', satoshis: 1, basket: 'cosigned' }] }).error?.code,
    ).toBe('COSIGNED_WALLET_ONLY')
    expect(prepareItemBasketArgs({ labels: ['p cosigned input id k2'] }).error?.code).toBe('COSIGNED_WALLET_ONLY')
  })

  it('names a deploy row by its own outpoint and filters by scope', () => {
    const listed = { outputs: [deployRow, heldRow, itemRow], totalOutputs: 3 }
    const byAsset = withCosignedAssetTags(listed, { scope: 'asset', values: [asset] }) as { outputs: Array<{ tags: string[] }> }
    expect(byAsset.outputs).toHaveLength(2)
    expect(byAsset.outputs[0]!.tags).toContain(`cosigned:${asset}`)
    const items = withCosignedAssetTags(listed, { scope: 'items', values: [] }) as { outputs: unknown[] }
    expect(items.outputs).toEqual([itemRow])
    const byId = withCosignedAssetTags(listed, { scope: 'id', values: ['k2'] }) as { outputs: unknown[] }
    expect(byId.outputs).toEqual([heldRow])
  })
})
