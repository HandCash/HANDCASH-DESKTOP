import 'fake-indexeddb/auto'
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { SetupClient } from '@handcash/wallet-engine'
import { describe, expect, it } from 'vitest'
import { originalToolboxDatabaseName, selectToolboxDatabase } from './vaultAccounts'
import { legacyToolboxDatabaseName, resolveWalletEngineDatabase } from './walletEngineMigration'

const BRC29: [2, string] = [2, '3241645161d8']

type Chain = 'main' | 'test'

async function open(chain: Chain, root: PrivateKey, databaseName: string) {
  const setup = await SetupClient.createWalletIdb({
    chain,
    rootKeyHex: root.toHex(),
    databaseName,
  } as Parameters<typeof SetupClient.createWalletIdb>[0])
  const services = setup.services as unknown as Record<string, unknown>
  services.getChainTracker = async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => 900_000 })
  services.getHeight = async () => 900_000
  services.getHeaderForHeight = async () => new Array(80).fill(0)
  services.postBeef = async (_beef: unknown, txids: string[]) => [
    { name: 'stub', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
  ]
  return setup
}

async function fund(setup: Awaited<ReturnType<typeof open>>, sats: number): Promise<void> {
  const sender = PrivateKey.fromRandom().toPublicKey().toString()
  const derivationPrefix = Utils.toBase64(Utils.toArray(`p${sats}`, 'utf8'))
  const derivationSuffix = Utils.toBase64(Utils.toArray('suffix', 'utf8'))
  const payee = setup.keyDeriver
    .derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, sender)
    .toPublicKey()
  const tx = new Transaction()
  tx.addInput({ sourceTXID: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'), sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
  tx.addOutput({ satoshis: sats, lockingScript: new P2PKH().lock(payee.toAddress()) })
  tx.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
  await setup.wallet.internalizeAction({
    tx: tx.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender } }],
    description: 'fund source test',
  })
}

async function balanceAt(chain: Chain, root: PrivateKey, databaseName: string): Promise<number> {
  const setup = await open(chain, root, databaseName)
  try {
    const listed = await setup.wallet.listOutputs({ basket: 'default', limit: 100 })
    return listed.outputs.reduce((sum, output) => sum + output.satoshis, 0)
  } finally {
    await setup.activeStorage.destroy()
  }
}

function account(chain: Chain) {
  const root = PrivateKey.fromRandom()
  const handle = `h${crypto.randomUUID().slice(0, 8)}`
  return { root, handle, chain, args: { chain, handle, rootKeyHex: root.toHex(), accountIndex: 0 } }
}

describe('which database an account opens', () => {
  it('opens the shared toolbox database when only it holds the history', async () => {
    const a = account('main')
    const legacy = legacyToolboxDatabaseName('main')
    const seeded = await open('main', a.root, legacy)
    await fund(seeded, 3_239)
    await seeded.activeStorage.destroy()

    expect(await resolveWalletEngineDatabase(a.args)).toBe(legacy)
    expect(await balanceAt('main', a.root, legacy)).toBe(3_239)
  })

  it('merges what an empty-then-rebuilt account database received, then opens the shared one', async () => {
    const a = account('main')
    const legacy = legacyToolboxDatabaseName('main')
    const own = originalToolboxDatabaseName({ chain: 'main', handle: a.handle, accountIndex: 0 })
    const shared = await open('main', a.root, legacy)
    await fund(shared, 10_000)
    await fund(shared, 20_000)
    await shared.activeStorage.destroy()
    // The engine opened the empty account database, inserted a blank user and received one payment there.
    const blank = await open('main', a.root, own)
    await fund(blank, 500)
    await blank.activeStorage.destroy()

    expect(await resolveWalletEngineDatabase(a.args)).toBe(legacy)
    expect(await balanceAt('main', a.root, legacy)).toBe(30_500)
    // Decided once: the next open does not merge again.
    expect(await resolveWalletEngineDatabase(a.args)).toBe(legacy)
    expect(await balanceAt('main', a.root, legacy)).toBe(30_500)
  })

  it('keeps an account database that is ahead of the shared one', async () => {
    const a = account('main')
    const legacy = legacyToolboxDatabaseName('main')
    const own = originalToolboxDatabaseName({ chain: 'main', handle: a.handle, accountIndex: 0 })
    const shared = await open('main', a.root, legacy)
    await fund(shared, 1_000)
    await shared.activeStorage.destroy()
    const ahead = await open('main', a.root, own)
    await fund(ahead, 2_000)
    await fund(ahead, 3_000)
    await ahead.activeStorage.destroy()

    expect(await resolveWalletEngineDatabase(a.args)).toBe(own)
    expect(await balanceAt('main', a.root, own)).toBe(5_000)
  })

  it('opens the account database on a fresh install with no shared history', async () => {
    const a = account('test')
    const own = originalToolboxDatabaseName({ chain: 'test', handle: a.handle, accountIndex: 0 })
    expect(await resolveWalletEngineDatabase(a.args)).toBe(own)
  })

  it('decides again after a history restore moves the pointer', async () => {
    const a = account('main')
    const legacy = legacyToolboxDatabaseName('main')
    const shared = await open('main', a.root, legacy)
    await fund(shared, 700)
    await shared.activeStorage.destroy()
    expect(await resolveWalletEngineDatabase(a.args)).toBe(legacy)

    const base = originalToolboxDatabaseName({ chain: 'main', handle: a.handle, accountIndex: 0 })
    const restored = `${base}-restore-${crypto.randomUUID()}`
    const copy = await open('main', a.root, restored)
    await fund(copy, 100)
    await fund(copy, 200)
    await copy.activeStorage.destroy()
    selectToolboxDatabase({ chain: 'main', handle: a.handle, accountIndex: 0 }, restored)

    expect(await resolveWalletEngineDatabase(a.args)).toBe(restored)
    expect(await balanceAt('main', a.root, restored)).toBe(300)
  })
})
