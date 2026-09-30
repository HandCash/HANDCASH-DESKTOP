import { describe, expect, it } from 'vitest'
import {
  ACTION_BRC100_METHODS,
  MIGRATION_BRC100_METHODS,
  brc100Contract,
} from './brc100'
import {
  cancelPendingPermissions,
  requestActionApproval,
  resolvePermission,
  subscribePermissionRequests,
  type PendingPrompt,
} from '../wallet/permissions'

describe('frozen BRC-100 contract', () => {
  it('classifies every declared action and migration method', () => {
    for (const method of ACTION_BRC100_METHODS) {
      expect(brc100Contract.isActionMethod(method)).toBe(true)
    }
    for (const method of MIGRATION_BRC100_METHODS) {
      expect(brc100Contract.isMigrationMethod(method)).toBe(true)
    }
  })

  it('never lets one approval stand for another payment, even an identical one', async () => {
    cancelPendingPermissions()
    let current: PendingPrompt | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      current = next
    })
    try {
      const args = { description: 'pay', outputs: [{ satoshis: 1000, lockingScript: '51' }] }
      const first = requestActionApproval('synthetic-app.invalid', 'createAction', args)
      const second = requestActionApproval('synthetic-app.invalid', 'createAction', args)

      const firstPrompt = current as PendingPrompt | null
      if (!firstPrompt || firstPrompt.kind !== 'action') throw new Error('missing first prompt')
      expect(resolvePermission(firstPrompt.id, 'allow')).toBe(true)
      await expect(first).resolves.toBe('allow')

      const secondPrompt = current as PendingPrompt | null
      if (!secondPrompt || secondPrompt.kind !== 'action') throw new Error('missing second prompt')
      expect(secondPrompt.id).not.toBe(firstPrompt.id)
      expect(resolvePermission(secondPrompt.id, 'deny')).toBe(true)
      await expect(second).resolves.toBe('deny')
    } finally {
      unsubscribe()
      cancelPendingPermissions()
    }
  })

  it('does not make unknown methods public by default', () => {
    expect(brc100Contract.isPublicMethod('futureMethod')).toBe(false)
    expect(brc100Contract.isActionMethod('futureMethod')).toBe(false)
    expect(brc100Contract.isMigrationMethod('futureMethod')).toBe(false)
  })
})
