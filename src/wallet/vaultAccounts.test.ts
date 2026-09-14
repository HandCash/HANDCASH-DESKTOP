import { describe, expect, it } from 'vitest'
import {
  accountKeyId,
  identityKeyForAccount,
  rootKeyHexForAccount,
  toolboxDatabaseName,
  VAULT_ACCOUNT_PROTOCOL,
} from './vaultAccounts'

const MASTER =
  '0000000000000000000000000000000000000000000000000000000000000001'

describe('vaultAccounts (BRC-146)', () => {
  it('keeps account 0 as the master root', () => {
    expect(rootKeyHexForAccount(MASTER, 0)).toBe(MASTER)
  })

  it('derives distinct deterministic roots for n >= 1', () => {
    const a1 = rootKeyHexForAccount(MASTER, 1)
    const a2 = rootKeyHexForAccount(MASTER, 2)
    expect(a1).not.toBe(MASTER)
    expect(a2).not.toBe(a1)
    expect(rootKeyHexForAccount(MASTER, 1)).toBe(a1)
    expect(identityKeyForAccount(MASTER, 1)).not.toBe(
      identityKeyForAccount(MASTER, 0),
    )
  })

  it('uses stable protocol and key ids', () => {
    expect(VAULT_ACCOUNT_PROTOCOL).toEqual([2, 'account'])
    expect(accountKeyId(3)).toBe('account-3')
  })

  it('keeps primary toolbox DB name historical', () => {
    expect(
      toolboxDatabaseName({ chain: 'main', handle: 'alice', accountIndex: 0 }),
    ).toBe('handcash-brc100-main-alice')
    expect(
      toolboxDatabaseName({ chain: 'main', handle: 'alice', accountIndex: 2 }),
    ).toBe('handcash-brc100-main-alice-a2')
  })
})
