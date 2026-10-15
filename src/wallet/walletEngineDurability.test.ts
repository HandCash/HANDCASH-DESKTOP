import 'fake-indexeddb/auto'
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { SetupClient, type StorageIdb, type Wallet } from '@handcash/wallet-engine'
import { describe, expect, it } from 'vitest'
import { persistNoSendActions } from './toolboxActionBatch'
import { toolboxDatabaseName } from './vaultAccounts'
import {
  __resetWalletEngineMigrationForTests,
  legacyToolboxDatabaseName,
  settleWalletEngineStorage,
} from './walletEngineMigration'

const BRC29: [2, string] = [2, '3241645161d8']

type Opened = {
  setup: {
    wallet: Wallet
    keyDeriver: {
      derivePrivateKey: (protocol: [2, string], keyId: string, counterparty: string) => {
        toPublicKey: () => { toAddress: () => string }
      }
    }
    activeStorage: StorageIdb
    services: unknown
  }
  root: PrivateKey
  wallet: Wallet
}

async function openWallet(databaseName: string, root = PrivateKey.fromRandom()): Promise<Opened> {
  const setup = await SetupClient.createWalletIdb({
    chain: 'main',
    rootKeyHex: root.toHex(),
    databaseName,
  } as Parameters<typeof SetupClient.createWalletIdb>[0])
  const services = setup.services as unknown as Record<string, unknown>
  services.getChainTracker = async () => ({
    isValidRootForHeight: async () => true,
    currentHeight: async () => 900_000,
  })
  services.getHeight = async () => 900_000
  services.getHeaderForHeight = async () => new Array(80).fill(0)
  services.postBeef = async (_beef: unknown, txids: string[]) => [
    {
      name: 'stub',
      status: 'success',
      txidResults: txids.map((txid) => ({ txid, status: 'success' })),
    },
  ]
  return { setup: setup as Opened['setup'], root, wallet: setup.wallet }
}

async function fund(opened: Opened, sats = 100_000): Promise<string> {
  const sender = PrivateKey.fromRandom().toPublicKey().toString()
  const derivationPrefix = Utils.toBase64(Utils.toArray('prefix', 'utf8'))
  const derivationSuffix = Utils.toBase64(Utils.toArray('suffix', 'utf8'))
  const payee = opened.setup.keyDeriver
    .derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, sender)
    .toPublicKey()
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex(''),
  })
  tx.addOutput({ satoshis: sats, lockingScript: new P2PKH().lock(payee.toAddress()) })
  const txid = tx.id('hex')
  tx.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: txid, txid: true }]])
  const args = {
    tx: tx.toAtomicBEEF(),
    outputs: [{
      outputIndex: 0,
      protocol: 'wallet payment' as const,
      paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender },
    }],
    description: 'fund durability test',
  }
  await opened.wallet.internalizeAction(args)
  await opened.wallet.internalizeAction(args).catch(() => undefined)
  return `${txid}.0`
}

async function spendableSats(wallet: Wallet): Promise<number> {
  const listed = await wallet.listOutputs({ basket: 'default', limit: 100 })
  return listed.outputs
    .filter((output) => output.spendable !== false)
    .reduce((sum, output) => sum + output.satoshis, 0)
}

function payment(satoshis: number) {
  return {
    description: 'durability payment',
    outputs: [{
      satoshis,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
      outputDescription: 'payee',
    }],
    options: { noSend: true, signAndProcess: false as const, randomizeOutputs: false },
  }
}

describe('wallet engine commit boundaries', () => {
  it('seals a reserved input until the unsigned action is aborted', async () => {
    const opened = await openWallet(`reserve-${crypto.randomUUID()}`)
    await fund(opened)
    const first = await opened.wallet.createAction(payment(50_000))
    const reference = first.signableTransaction?.reference
    expect(reference).toBeTruthy()
    await expect(opened.wallet.createAction(payment(40_000))).rejects.toThrow()
    await opened.wallet.abortAction({ reference: reference! })
    expect((await opened.wallet.createAction(payment(40_000))).signableTransaction?.reference).toBeTruthy()
    await opened.setup.activeStorage.destroy()
  })

  it('does not duplicate an internalized payment or show it in another account', async () => {
    const a = await openWallet(`account-a-${crypto.randomUUID()}`)
    const outpoint = await fund(a, 21_000)
    const listed = await a.wallet.listOutputs({ basket: 'default', limit: 10 })
    expect(listed.outputs.map((output) => output.outpoint)).toEqual([outpoint])
    expect(await spendableSats(a.wallet)).toBe(21_000)

    const b = await openWallet(`account-b-${crypto.randomUUID()}`)
    expect(await spendableSats(b.wallet)).toBe(0)
    await a.setup.activeStorage.destroy()
    await b.setup.activeStorage.destroy()
  })

  it('reopens a signed noSend cheque after the storage connection closes', async () => {
    const name = `cheque-${crypto.randomUUID()}`
    const first = await openWallet(name)
    persistNoSendActions(first.wallet)
    await fund(first)
    const signed = await first.wallet.createAction({
      ...payment(1_000),
      options: { noSend: true, signAndProcess: true, randomizeOutputs: false },
    })
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/)
    await first.setup.activeStorage.destroy()

    const reopened = await openWallet(name, first.root)
    persistNoSendActions(reopened.wallet)
    const actions = await reopened.wallet.listActions({ labels: [], limit: 10 })
    expect(actions.actions.find((action) => action.txid === signed.txid)?.status).toBe('nosend')
    await reopened.setup.activeStorage.destroy()
  })

  it('copies legacy history into a new database and leaves the original in place', async () => {
    const root = PrivateKey.fromRandom()
    const handle = `dur${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
    const legacy = await openWallet(legacyToolboxDatabaseName('main'), root)
    const outpoint = await fund(legacy, 8_000)
    await legacy.setup.activeStorage.destroy()
    __resetWalletEngineMigrationForTests()

    await settleWalletEngineStorage({
      chain: 'main',
      rootKeyHex: root.toHex(),
      handle,
      accountIndex: 3,
    })
    const selected = toolboxDatabaseName({ chain: 'main', handle, accountIndex: 3 })
    expect(selected).toContain('-restore-engine-v1-')

    const staged = await openWallet(selected, root)
    const listed = await staged.wallet.listOutputs({ basket: 'default', limit: 10 })
    expect(listed.outputs.map((output) => output.outpoint)).toEqual([outpoint])
    expect(await spendableSats(staged.wallet)).toBe(8_000)

    const original = await openWallet(legacyToolboxDatabaseName('main'), root)
    expect(await spendableSats(original.wallet)).toBe(8_000)
    await staged.setup.activeStorage.destroy()
    await original.setup.activeStorage.destroy()
  })
})

describe('wallet engine planning pages', () => {
  it('reads a newest change page without walking the whole basket', async () => {
    const opened = await openWallet(`pages-${crypto.randomUUID()}`)
    const storage = opened.setup.activeStorage
    const { user } = await storage.findOrInsertUser(opened.root.toPublicKey().toString())
    const basket = (await storage.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } }))[0]
    expect(basket?.basketId).toBeGreaterThan(0)
    const now = new Date()
    const txid = 'cd'.repeat(32)
    const transactionId = await storage.insertTransaction({
      created_at: now,
      updated_at: now,
      transactionId: 0,
      userId: user.userId,
      status: 'completed',
      reference: Utils.toBase64(Utils.toArray('seed', 'utf8')),
      isOutgoing: false,
      satoshis: 10_000_000,
      description: 'seeded change',
      txid,
    })
    const sizes = [50, 500, 2_000, 10_000]
    let written = 0
    const pageMs: number[] = []
    for (const size of sizes) {
      await storage.transaction(async (trx) => {
        for (; written < size; written += 1) {
          await storage.insertOutput({
            created_at: now,
            updated_at: now,
            outputId: 0,
            userId: user.userId,
            transactionId,
            basketId: basket!.basketId,
            spendable: true,
            change: true,
            outputDescription: 'seeded change',
            vout: written,
            satoshis: 1_000,
            providedBy: 'storage',
            purpose: 'change',
            type: 'P2PKH',
            txid,
            derivationPrefix: Utils.toBase64(Utils.toArray('prefix', 'utf8')),
            derivationSuffix: Utils.toBase64(Utils.toArray('suffix', 'utf8')),
          }, trx)
        }
      })
      const started = performance.now()
      const page = await storage.findOutputs({
        partial: {
          userId: user.userId,
          basketId: basket!.basketId,
          spendable: true,
          type: 'P2PKH',
          change: true,
          providedBy: 'storage',
          purpose: 'change',
        },
        noScript: true,
        orderDescending: true,
        paged: { limit: 24, offset: 0 },
      })
      pageMs.push(performance.now() - started)
      expect(page).toHaveLength(24)
      expect(page.every((output) => output.lockingScript == null)).toBe(true)
    }
    expect(pageMs[3]).toBeLessThan(Math.max(250, (pageMs[0] ?? 1) * 30))
    await storage.destroy()
  }, 120_000)
})
