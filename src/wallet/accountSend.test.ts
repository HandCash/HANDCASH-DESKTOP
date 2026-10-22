import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

vi.mock('./appActivity', () => ({ recordWalletEvent: vi.fn() }))

import { UNKNOWN_ELSEWHERE } from './accountHolding'
import {
  listPendingAccountSends,
  listSendableSubAccounts,
  parseAccountSendPackage,
  receiveAccountSends,
  resetAccountSendForTests,
  sendSubAccountToIdentityKey,
  storePendingAccountSend,
  type AccountSendIo,
  type AccountSendPackage,
} from './accountSend'
import {
  createVaultAccount,
  ensureVaultAccounts,
  identityKeyForAccount,
  rootKeyHexForAccount,
  setAccountHolding,
  writeVaultAccounts,
} from './vaultAccounts'
import { brc42VaultMaster, vaultIdentityKey } from './vaultMaster'

const MASTER = brc42VaultMaster(PrivateKey.fromRandom().toHex())
const RECIPIENT = PrivateKey.fromRandom()
const RECIPIENT_IK = RECIPIENT.toPublicKey().toString()

function resetAccounts() {
  const store = ensureVaultAccounts(MASTER)
  store.accounts = store.accounts.filter((a) => a.index === 0)
  store.activeIndex = 0
  writeVaultAccounts(store)
}

function seedSub(name = 'Savings') {
  resetAccounts()
  createVaultAccount({ master: MASTER, name, index: 1 })
}

beforeEach(() => {
  resetAccountSendForTests()
  resetAccounts()
})

describe('listSendableSubAccounts', () => {
  it('is empty when the vault holds only Primary', () => {
    expect(listSendableSubAccounts(MASTER)).toEqual([])
  })

  it('lists held sub-accounts and skips Primary', () => {
    seedSub()
    const sendable = listSendableSubAccounts(MASTER)
    expect(sendable).toHaveLength(1)
    expect(sendable[0]!.index).toBe(1)
    expect(sendable[0]!.name).toBe('Savings')
  })
})

describe('parseAccountSendPackage', () => {
  it('accepts a well-formed package and refuses a mismatched root', () => {
    seedSub()
    const root = rootKeyHexForAccount(MASTER, 1)
    const good: AccountSendPackage = {
      v: 1,
      kind: 'handcash-account-send',
      accountIdentityKey: identityKeyForAccount(MASTER, 1),
      accountRootKeyHex: root,
      name: 'Savings',
      index: 1,
      fromIdentityKey: identityKeyForAccount(MASTER, 0),
      at: 1,
    }
    expect(parseAccountSendPackage(JSON.stringify(good), RECIPIENT_IK)).toEqual({
      ...good,
      accountIdentityKey: good.accountIdentityKey.toLowerCase(),
      accountRootKeyHex: root.toLowerCase(),
      fromIdentityKey: good.fromIdentityKey.toLowerCase(),
    })

    const bad = { ...good, accountRootKeyHex: PrivateKey.fromRandom().toHex() }
    expect(parseAccountSendPackage(JSON.stringify(bad), RECIPIENT_IK)).toBeNull()
    expect(parseAccountSendPackage('{', RECIPIENT_IK)).toBeNull()
  })
})

describe('sendSubAccountToIdentityKey', () => {
  it('refuses when there is nothing to send', async () => {
    await expect(
      sendSubAccountToIdentityKey({
        master: MASTER,
        accountIndex: 1,
        recipientIdentityKey: RECIPIENT_IK,
        confirmedRecipientIdentityKey: RECIPIENT_IK,
        fromIdentityKey: identityKeyForAccount(MASTER, 0),
        io: fakeIo(),
      }),
    ).rejects.toMatchObject({ code: 'not-sendable' })
  })

  it('refuses an unconfirmed recipient and self', async () => {
    seedSub()
    const from = identityKeyForAccount(MASTER, 0)
    await expect(
      sendSubAccountToIdentityKey({
        master: MASTER,
        accountIndex: 1,
        recipientIdentityKey: RECIPIENT_IK,
        confirmedRecipientIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
        fromIdentityKey: from,
        io: fakeIo(),
      }),
    ).rejects.toMatchObject({ code: 'unconfirmed' })

    await expect(
      sendSubAccountToIdentityKey({
        master: MASTER,
        accountIndex: 1,
        recipientIdentityKey: from,
        confirmedRecipientIdentityKey: from,
        fromIdentityKey: from,
        io: fakeIo(),
      }),
    ).rejects.toMatchObject({ code: 'self' })
  })

  it('seals, releases, marks gifted, and leaves nothing sendable', async () => {
    seedSub()
    const io = fakeIo()
    const from = identityKeyForAccount(MASTER, 0)
    const result = await sendSubAccountToIdentityKey({
      master: MASTER,
      accountIndex: 1,
      recipientIdentityKey: RECIPIENT_IK,
      confirmedRecipientIdentityKey: RECIPIENT_IK,
      recipientLabel: 'Bob',
      fromIdentityKey: from,
      io,
    })
    expect(result.name).toBe('Savings')
    expect(io.sent).toHaveLength(1)
    expect(io.released).toEqual([{ index: 1 }])
    expect(io.stopped).toContain(result.accountIdentityKey)
    expect(listSendableSubAccounts(MASTER)).toEqual([])

    const pkg = parseAccountSendPackage(io.sent[0]!.plaintext, RECIPIENT_IK)
    expect(pkg?.accountIdentityKey).toBe(result.accountIdentityKey)
    expect(pkg?.name).toBe('Savings')

    await expect(
      sendSubAccountToIdentityKey({
        master: MASTER,
        accountIndex: 1,
        recipientIdentityKey: RECIPIENT_IK,
        confirmedRecipientIdentityKey: RECIPIENT_IK,
        fromIdentityKey: from,
        io: fakeIo(),
      }),
    ).rejects.toMatchObject({ code: 'already-gifted' })
  })
})

describe('receiveAccountSends', () => {
  it('stores a package and lists it as pending', async () => {
    seedSub()
    const root = rootKeyHexForAccount(MASTER, 1)
    const pkg: AccountSendPackage = {
      v: 1,
      kind: 'handcash-account-send',
      accountIdentityKey: identityKeyForAccount(MASTER, 1),
      accountRootKeyHex: root,
      name: 'Savings',
      index: 1,
      fromIdentityKey: identityKeyForAccount(MASTER, 0),
      at: 42,
    }
    const ack: string[] = []
    const found = await receiveAccountSends({
      identityKey: RECIPIENT_IK,
      rootKeyHex: RECIPIENT.toHex(),
      list: async () => [{ messageId: 'm1', plaintext: JSON.stringify(pkg) }],
      acknowledge: async (_r, _b, ids) => {
        ack.push(...ids)
      },
    })
    expect(found).toHaveLength(1)
    expect(ack).toEqual(['m1'])
    expect(listPendingAccountSends()[0]!.name).toBe('Savings')
  })

  it('keeps a pending package until listed', () => {
    seedSub()
    storePendingAccountSend({
      v: 1,
      kind: 'handcash-account-send',
      accountIdentityKey: identityKeyForAccount(MASTER, 1),
      accountRootKeyHex: rootKeyHexForAccount(MASTER, 1),
      name: 'Savings',
      index: 1,
      fromIdentityKey: identityKeyForAccount(MASTER, 0),
      at: 1,
    })
    expect(listPendingAccountSends()).toHaveLength(1)
    expect(vaultIdentityKey(MASTER)).toBeTruthy()
  })
})

function fakeIo(): AccountSendIo & {
  sent: Array<{ recipientIdentityKey: string; plaintext: string }>
  released: Array<{ index: number }>
  stopped: string[]
} {
  const sent: Array<{ recipientIdentityKey: string; plaintext: string }> = []
  const released: Array<{ index: number }> = []
  const stopped: string[] = []
  return {
    sent,
    released,
    stopped,
    send: async ({ recipientIdentityKey, plaintext }) => {
      sent.push({ recipientIdentityKey, plaintext })
    },
    release: async (_master, index) => {
      released.push({ index })
      setAccountHolding(vaultIdentityKey(MASTER), index, UNKNOWN_ELSEWHERE)
    },
    stopMonitor: (ik) => {
      stopped.push(ik)
    },
    now: () => 1_700_000_000_000,
  }
}
