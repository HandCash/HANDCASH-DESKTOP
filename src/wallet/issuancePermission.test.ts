import { describe, expect, it, vi } from 'vitest'

vi.mock('./autoPay', () => ({
  canAutoProcessPayment: () => true,
  reserveAutoPayPayment: () => ({ key: 'auto-pay', id: 'reservation' }),
  clearAutoPaySettings: () => {},
}))

import {
  cancelPendingPermissions,
  requestActionApproval,
  resolvePermission,
  subscribePermissionRequests,
  type PendingPrompt,
} from './permissions'

const ORIGIN = 'mint.example'
const mint = {
  description: 'Issue award',
  outputs: [{ satoshis: 1_000, lockingScript: `76a914${'d'.repeat(40)}88ac`, outputDescription: 'Platform fee' }],
}
const issuer = { identityKey: '02'.padEnd(66, 'b'), displayName: 'Studio' }

describe('identity-signed issuance approval', () => {
  it('Auto-pay may cover a payment, never the same action once the issuer identity signs it', async () => {
    cancelPendingPermissions()
    let current: PendingPrompt | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      current = next
    })
    try {
      const automatic = vi.fn()
      await expect(requestActionApproval(ORIGIN, 'createAction', mint, automatic)).resolves.toBe('allow')
      expect(automatic).toHaveBeenCalledTimes(1)

      automatic.mockClear()
      const decision = requestActionApproval(ORIGIN, 'createAction', mint, automatic, undefined, issuer)
      const prompt = current as PendingPrompt | null
      if (!prompt || prompt.kind !== 'action') throw new Error('identity-signed mint did not prompt')
      expect(automatic).not.toHaveBeenCalled()
      expect(prompt.issuance).toEqual({ ...issuer, anchor: true })
      expect(resolvePermission(prompt.id, 'deny')).toBe(true)
      await expect(decision).resolves.toBe('deny')
    } finally {
      unsubscribe()
      cancelPendingPermissions()
    }
  })

  it('names no anchor when the app funds the mint itself', async () => {
    cancelPendingPermissions()
    let current: PendingPrompt | null = null
    const unsubscribe = subscribePermissionRequests((next) => {
      current = next
    })
    try {
      const funded = { ...mint, inputs: [{ outpoint: `${'c'.repeat(64)}.0`, inputDescription: 'fund' }] }
      const decision = requestActionApproval(ORIGIN, 'createAction', funded, undefined, undefined, issuer)
      const prompt = current as PendingPrompt | null
      if (!prompt || prompt.kind !== 'action') throw new Error('missing prompt')
      expect(prompt.issuance?.anchor).toBe(false)
      resolvePermission(prompt.id, 'deny')
      await decision
    } finally {
      unsubscribe()
      cancelPendingPermissions()
    }
  })
})
