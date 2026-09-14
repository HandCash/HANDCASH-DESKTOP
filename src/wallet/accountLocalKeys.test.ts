import { describe, expect, it, beforeEach } from 'vitest'
import {
  accountLocalKey,
  bindAccountLocalKeyScope,
  resetAccountLocalKeyScopeForTests,
  peekAccountLocalKeyScope,
} from './accountLocalKeys'

describe('accountLocalKeys', () => {
  beforeEach(() => resetAccountLocalKeyScopeForTests())

  it('keeps primary on legacy unscoped keys', () => {
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'ik0' })
    expect(accountLocalKey('handcash.brc100.friends')).toBe('handcash.brc100.friends')
    expect(peekAccountLocalKeyScope().identityKey).toBeNull()
  })

  it('scopes sub-accounts by identity', () => {
    bindAccountLocalKeyScope({ accountIndex: 2, identityKey: 'ik2abc' })
    expect(accountLocalKey('handcash.brc100.friends')).toBe(
      'handcash.brc100.friends:ik2abc',
    )
    expect(accountLocalKey('handcash.brc100.appActivity')).toBe(
      'handcash.brc100.appActivity:ik2abc',
    )
  })
})
