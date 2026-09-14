import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountKeyId,
  identityKeyForAccount,
  rootKeyHexForAccount,
  findVaultAccountByIdentityKey,
  writeVaultAccounts,
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

describe('findVaultAccountByIdentityKey', () => {
  const masterIk = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const childIk = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  const mem = new Map<string, string>()

  beforeEach(() => {
    mem.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v)
      },
      removeItem: (k: string) => {
        mem.delete(k)
      },
    })
  })

  it('returns the matching vault account', () => {
    writeVaultAccounts({
      version: 1,
      masterIdentityKey: masterIk,
      activeIndex: 0,
      accounts: [
        { index: 0, name: 'Primary', identityKey: masterIk },
        { index: 1, name: 'Child', identityKey: childIk },
      ],
    })
    expect(findVaultAccountByIdentityKey(masterIk, childIk.toUpperCase())?.index).toBe(1)
    expect(findVaultAccountByIdentityKey(masterIk, '02dead')).toBeNull()
  })
})
