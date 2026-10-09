import { BigNumber, KeyDeriver, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountKeyId,
  identityKeyForAccount,
  reservedKeyRefusal,
  rootKeyHexForAccount,
  findVaultAccountByIdentityKey,
  writeVaultAccounts,
  toolboxDatabaseName,
  VAULT_ACCOUNT_PROTOCOL,
} from './vaultAccounts'

const MASTER =
  '0000000000000000000000000000000000000000000000000000000000000001'

describe('vaultAccounts (BRC-208)', () => {
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

  it('reserves the protocol whose keys are account roots', async () => {
    const appVisible = new ProtoWallet(PrivateKey.fromHex(MASTER))
    const { publicKey } = await appVisible.getPublicKey({
      protocolID: [2, 'account'],
      keyID: 'account-1',
      counterparty: 'self',
    })
    expect(publicKey).toBe(identityKeyForAccount(MASTER, 1))

    const refuse = (args: unknown, method = 'getPublicKey') =>
      reservedKeyRefusal(method, args, identityKeyForAccount(MASTER, 0))
    expect(refuse({ protocolID: [2, 'account'], keyID: 'account-1' })).toBe('account-protocol')
    expect(refuse({ protocolID: [2, ' ACCOUNT '] })).toBe('account-protocol')
    expect(refuse({ protocolID: [0, 'account'] })).toBe('account-protocol')
    expect(refuse({ protocolID: [2, 'accounts'] })).toBeNull()
    expect(refuse({ identityKey: true })).toBeNull()
    expect(refuse(null)).toBeNull()
  })

  it('refuses specific linkage with itself: offset plus an exported child is the root', () => {
    const root = PrivateKey.fromHex(MASTER)
    const deriver = new KeyDeriver(root)
    const n = new BigNumber('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 16)
    const self = identityKeyForAccount(MASTER, 0)
    const exported: Array<[[0 | 1 | 2, string], string]> = [
      [[2, 'handcash server wallet'], '1'],
      [[1, 'sigma'], 'identity-1'],
    ]
    for (const [protocolID, keyID] of exported) {
      const child = deriver.derivePrivateKey(protocolID, keyID, 'self')
      const offset = new BigNumber(deriver.revealSpecificSecret('self', protocolID, keyID))
      expect(child.sub(offset).umod(n).toHex(32)).toBe(MASTER)

      for (const counterparty of ['self', self]) {
        expect(
          reservedKeyRefusal('revealSpecificKeyLinkage', { protocolID, keyID, counterparty, verifier: '02ab' }, self),
        ).toBe('self-linkage')
      }
    }
    expect(
      reservedKeyRefusal(
        'revealSpecificKeyLinkage',
        { protocolID: [2, 'handcash server wallet'], keyID: '1', counterparty: identityKeyForAccount(MASTER, 1), verifier: '02ab' },
        self,
      ),
    ).toBeNull()
  })

  it('refuses to reveal the shared secret that yields every account offset', () => {
    const self = identityKeyForAccount(MASTER, 0)
    const reveal = (counterparty: string) =>
      reservedKeyRefusal('revealCounterpartyKeyLinkage', { counterparty, verifier: '02ab' }, self)
    expect(reveal(self)).toBe('self-linkage')
    expect(reveal(self.toUpperCase())).toBe('self-linkage')
    expect(reveal('self')).toBe('self-linkage')
    expect(reveal(identityKeyForAccount(MASTER, 1))).toBeNull()
    expect(
      reservedKeyRefusal('encrypt', { counterparty: self, protocolID: [1, 'chat'] }, self),
    ).toBeNull()
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
