import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
})
vi.stubGlobal('window', { handcash: undefined })

const h = vi.hoisted(() => ({
  runtime: null as unknown,
  server: null as unknown,
  opened: [] as Array<{ chain: string; rootKeyHex: string; storageUrl?: string }>,
  funded: [] as Array<{ txid: string; atomicBeef: number[] }>,
  handcashInternalized: [] as unknown[],
  failHandcashInternalize: false,
  lifecycle: null as { dispose?: (runtime: unknown, reason: string) => void } | null,
}))

vi.mock('@bsv/wallet-toolbox-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bsv/wallet-toolbox-client')>()),
  SetupClient: {
    createWalletClientNoEnv: async (args: { chain: string; rootKeyHex: string; storageUrl?: string }) => {
      h.opened.push(args)
      return h.server
    },
  },
}))
vi.mock('./cryptoBackend', () => ({ walletCryptoBackend: () => undefined }))
vi.mock('./beefCache', () => ({
  atomicBeefForSubject: (bin: number[] | undefined) => (bin?.length ? bin : undefined),
  getBeefForTxidCached: async (_active: unknown, txid: string) => {
    const hit = h.funded.find((f) => f.txid === txid)
    if (!hit) throw new Error('no beef')
    return { toBinary: () => hit.atomicBeef }
  },
}))
vi.mock('./legacyBeef', () => ({ withVisibleOnChainBeef: (fn: () => unknown) => fn() }))
vi.mock('./spendGuard', () => ({ refreshSpendableBalance: async () => 0 }))
vi.mock('./deviceSync', () => ({ scheduleHistoryBackupPush: () => {} }))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => h.runtime,
  requireWalletRuntime: () => h.runtime,
  registerWalletRuntimeLifecycle: (hook: { dispose?: (runtime: unknown, reason: string) => void }) => {
    h.lifecycle = hook
    return () => {}
  },
}))
vi.mock('./sendBrc29Payment', async () => {
  const { MerklePath, P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction } = await import('@bsv/sdk')
  const BRC29_PROTOCOL_ID: [2, string] = [2, '3241645161d8']
  return {
    BRC29_PROTOCOL_ID,
    sendBrc29ToIdentityKey: async (args: { payeeIdentityKey: string; satoshis: number }) => {
      const sender = new ProtoWallet(
        PrivateKey.fromHex((h.runtime as { instance: { rootKeyHex: string } }).instance.rootKeyHex),
      )
      const derivationPrefix = `p${h.funded.length}`
      const derivationSuffix = 's'
      const { publicKey } = await sender.getPublicKey({
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: args.payeeIdentityKey,
      })
      const tx = new Transaction()
      tx.addOutput({
        lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash()),
        satoshis: args.satoshis,
      })
      tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), 1)
      const txid = tx.id('hex')
      const atomicBeef = tx.toAtomicBEEF()
      h.funded.push({ txid, atomicBeef })
      return { txid, remittance: { derivationPrefix, derivationSuffix, outputIndex: 0 }, atomicBeef }
    },
  }
})

import {
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  type CreateActionArgs,
  type InternalizeActionArgs,
  type ListOutputsArgs,
} from '@bsv/sdk'
import { durableForgetCached } from './durableStorage'
import {
  exportServerWalletConfig,
  fundServerWallet,
  planServerWalletRecover,
  readServerWalletLedger,
  recoverServerWallet,
  refreshServerWallet,
  rotateServerWallet,
  serverWalletKey,
  setUpServerWallet,
  type ServerWalletLedger,
} from './serverWallet'
import type { ActiveWallet } from './session'
import type { WalletRuntime } from './walletRuntime'

const BRC29: [2, string] = [2, '3241645161d8']
const root = PrivateKey.fromRandom()
const rootHex = root.toHex()
const identityKey = root.toPublicKey().toString()
const handcash = new ProtoWallet(root)

type StoredOutput = { basket: string; satoshis: number; tags: string[] }

/**
 * The server's Toolbox wallet over shared storage: real BRC-42 crypto from
 * the server key, outputs held in memory. Internalize refuses a payment whose
 * lock is not the BRC-29 key the remittance names.
 */
function fakeServerWallet(key: PrivateKey) {
  const crypto = new ProtoWallet(key)
  const outputs: StoredOutput[] = []
  const created: CreateActionArgs[] = []
  return {
    outputs,
    created,
    getPublicKey: crypto.getPublicKey.bind(crypto),
    createHmac: crypto.createHmac.bind(crypto),
    async listOutputs(args: ListOutputsArgs) {
      const all = outputs.filter((o) => o.basket === args.basket)
      const offset = args.offset ?? 0
      const page = all.slice(offset, offset + (args.limit ?? 10))
      return {
        totalOutputs: all.length,
        outputs: page.map((o) => ({
          satoshis: o.satoshis,
          spendable: true,
          outpoint: 'x.0',
          ...(args.includeTags ? { tags: o.tags } : {}),
        })),
      }
    },
    async internalizeAction(args: InternalizeActionArgs) {
      const tx = Transaction.fromAtomicBEEF(args.tx)
      for (const out of args.outputs) {
        const r = out.paymentRemittance!
        const { publicKey } = await crypto.getPublicKey({
          protocolID: BRC29,
          keyID: `${r.derivationPrefix} ${r.derivationSuffix}`,
          counterparty: r.senderIdentityKey,
          forSelf: true,
        })
        const output = tx.outputs[out.outputIndex]!
        if (output.lockingScript.toHex() !== new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()) {
          throw new Error('lock does not match remittance')
        }
        outputs.push({ basket: 'default', satoshis: output.satoshis ?? 0, tags: [] })
      }
      return { accepted: true }
    },
    async createAction(args: CreateActionArgs) {
      created.push(args)
      const pay = args.outputs![0]!
      const money = outputs.filter((o) => o.basket === 'default')
      const total = money.reduce((s, o) => s + o.satoshis, 0)
      for (const o of money) outputs.splice(outputs.indexOf(o), 1)
      const change = total - pay.satoshis - 30
      if (change > 0) outputs.push({ basket: 'default', satoshis: change, tags: [] })
      const tx = new Transaction()
      tx.addOutput({ lockingScript: LockingScript.fromHex(pay.lockingScript), satoshis: pay.satoshis })
      tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), 2)
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    },
  }
}

let server: ReturnType<typeof fakeServerWallet>

const active = {
  accountIndex: 0,
  identityKey,
  chain: 'main' as const,
  rootKeyHex: rootHex,
  wallet: {
    internalizeAction: async (args: InternalizeActionArgs) => {
      if (h.failHandcashInternalize) throw new Error('internalize failed')
      h.handcashInternalized.push(args)
      return { accepted: true }
    },
  },
} as unknown as ActiveWallet
const runtime = { instance: active } as unknown as WalletRuntime
h.runtime = runtime

function ledgerKey(): string {
  return [...store.keys()].find((k) => k.startsWith('handcash.serverWallet'))!
}

beforeEach(() => {
  h.lifecycle?.dispose?.(runtime, 'locked')
  store.clear()
  durableForgetCached()
  h.opened.length = 0
  h.funded.length = 0
  h.handcashInternalized.length = 0
  h.failHandcashInternalize = false
  server = fakeServerWallet(serverWalletKey(rootHex, 1))
  h.server = server
})

describe('server wallet key', () => {
  it('is a derived child per generation, never the account root', () => {
    const one = serverWalletKey(rootHex, 1)
    expect(one.toHex()).toBe(serverWalletKey(rootHex, 1).toHex())
    expect(one.toHex()).not.toBe(rootHex)
    expect(serverWalletKey(rootHex, 2).toHex()).not.toBe(one.toHex())
  })

  it('exports the BSVA server template env for the same key and storage this wallet opens', async () => {
    setUpServerWallet(runtime)
    const env = exportServerWalletConfig(runtime)
    expect(env).toBe(
      `SERVER_PRIVATE_KEY=${serverWalletKey(rootHex, 1).toHex()}\n` +
        'WALLET_STORAGE_URL=https://storage.babbage.systems\nBSV_NETWORK=main\n',
    )
    await refreshServerWallet(runtime)
    expect(h.opened[0]).toMatchObject({
      chain: 'main',
      rootKeyHex: serverWalletKey(rootHex, 1).toHex(),
      storageUrl: 'https://storage.babbage.systems',
    })
  })
})

describe('summary', () => {
  it('counts money, items and distinct tokens', async () => {
    setUpServerWallet(runtime)
    server.outputs.push(
      { basket: 'default', satoshis: 700, tags: [] },
      { basket: 'default', satoshis: 300, tags: [] },
      { basket: '1sat', satoshis: 1, tags: [] },
      { basket: '1sat', satoshis: 1, tags: [] },
      { basket: 'bsv21', satoshis: 1, tags: ['bsv21', `bsv21:${'a'.repeat(64)}_0`, 'amt:5'] },
      { basket: 'bsv21', satoshis: 1, tags: ['bsv21', `bsv21:${'a'.repeat(64)}_0`, 'amt:2'] },
      { basket: 'bsv21', satoshis: 1, tags: ['bsv21', `bsv21:${'b'.repeat(64)}_1`, 'amt:9'] },
    )
    expect(await refreshServerWallet(runtime)).toEqual({ money: 1000, moneyOutputs: 2, items: 2, tokens: 2 })
  })
})

describe('fund', () => {
  it('pays the server by BRC-29 and internalizes into its storage', async () => {
    setUpServerWallet(runtime)
    await fundServerWallet(5_000)
    expect(server.outputs).toEqual([{ basket: 'default', satoshis: 5_000, tags: [] }])
    expect(readServerWalletLedger(active)!.pendingFunds).toEqual([])
  })

  it('keeps a missed internalize pending and settles it on the next refresh', async () => {
    setUpServerWallet(runtime)
    const internalize = server.internalizeAction
    server.internalizeAction = async () => {
      throw new Error('storage down')
    }
    await fundServerWallet(4_000)
    expect(readServerWalletLedger(active)!.pendingFunds).toHaveLength(1)
    server.internalizeAction = internalize
    expect((await refreshServerWallet(runtime)).money).toBe(4_000)
    expect(readServerWalletLedger(active)!.pendingFunds).toEqual([])
  })

  it('migrates a v1 ledger: its fund payments become internalizations', async () => {
    setUpServerWallet(runtime)
    await fundServerWallet(2_500)
    server.outputs.length = 0
    const [{ txid }] = h.funded
    store.set(
      ledgerKey(),
      JSON.stringify({
        v: 1,
        generation: 1,
        outputs: [
          {
            outpoint: `${txid}.0`,
            satoshis: 2_500,
            generation: 1,
            lock: { kind: 'brc29', derivationPrefix: 'p0', derivationSuffix: 's', sender: identityKey },
          },
          { outpoint: `${'c'.repeat(64)}.1`, satoshis: 9, generation: 1, lock: { kind: 'root' } },
        ],
        lastReportAt: null,
        pendingRecover: null,
      }),
    )
    durableForgetCached()
    expect(readServerWalletLedger(active)!.pendingFunds).toHaveLength(1)
    expect((await refreshServerWallet(runtime)).money).toBe(2_500)
  })
})

describe('recover', () => {
  it('refuses with a named reason when there is nothing worth moving', () => {
    const ledger: ServerWalletLedger = {
      v: 2,
      generation: 1,
      storageUrl: 'https://storage.babbage.systems',
      pendingFunds: [],
      pendingRecover: null,
    }
    expect(planServerWalletRecover(ledger, { money: 0, moneyOutputs: 0 })).toEqual({
      path: 'refuse',
      reason: 'nothing-to-recover',
    })
    expect(planServerWalletRecover(ledger, { money: 20, moneyOutputs: 1 })).toEqual({
      path: 'refuse',
      reason: 'uneconomical',
    })
    expect(planServerWalletRecover(ledger, { money: 10_000, moneyOutputs: 2 })).toEqual({
      path: 'recover',
      satoshis: 10_000 - 38,
    })
  })

  it('has the server wallet pay this wallet by BRC-29, then internalizes it', async () => {
    setUpServerWallet(runtime)
    server.outputs.push({ basket: 'default', satoshis: 10_000, tags: [] }, { basket: '1sat', satoshis: 1, tags: [] })
    const result = await recoverServerWallet()
    expect(result.satoshis).toBe(10_000 - 23)

    const serverPub = serverWalletKey(rootHex, 1).toPublicKey().toString()
    const [args] = h.handcashInternalized as InternalizeActionArgs[]
    const r = args!.outputs[0]!.paymentRemittance!
    expect(r.senderIdentityKey).toBe(serverPub)
    const { publicKey } = await handcash.getPublicKey({
      protocolID: BRC29,
      keyID: `${r.derivationPrefix} ${r.derivationSuffix}`,
      counterparty: serverPub,
      forSelf: true,
    })
    const paid = Transaction.fromAtomicBEEF(args!.tx).outputs[0]!
    expect(paid.lockingScript.toHex()).toBe(new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex())
    expect(server.outputs.filter((o) => o.basket === '1sat')).toHaveLength(1)
    expect(readServerWalletLedger(active)!.pendingRecover).toBeNull()
  })

  it('keeps a broadcast recovery pending and finishes it without spending again', async () => {
    setUpServerWallet(runtime)
    server.outputs.push({ basket: 'default', satoshis: 8_000, tags: [] })
    h.failHandcashInternalize = true
    await expect(recoverServerWallet()).rejects.toThrow('internalize failed')
    expect(readServerWalletLedger(active)!.pendingRecover).not.toBeNull()
    h.failHandcashInternalize = false
    await recoverServerWallet()
    expect(server.created).toHaveLength(1)
    expect(readServerWalletLedger(active)!.pendingRecover).toBeNull()
    expect(h.handcashInternalized).toHaveLength(1)
  })
})

describe('rotate', () => {
  it('is refused while the server wallet holds anything, then moves to the next key', async () => {
    setUpServerWallet(runtime)
    server.outputs.push({ basket: '1sat', satoshis: 1, tags: [] })
    await expect(rotateServerWallet(runtime)).rejects.toThrow('Empty the server wallet')
    server.outputs.length = 0
    expect(await rotateServerWallet(runtime)).toBe(2)
    expect(readServerWalletLedger(active)!.generation).toBe(2)
  })
})
