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
  servers: new Map<string, unknown>(),
  built: [] as Array<{ identityKey: string; services: unknown; storageUrl: string }>,
  funded: [] as Array<{ txid: string; atomicBeef: number[] }>,
  handcashInternalized: [] as unknown[],
  failHandcashInternalize: false,
  material: null as unknown,
  master: null as unknown,
  lifecycle: null as { dispose?: (runtime: unknown, reason: string) => void } | null,
}))

vi.mock('@bsv/wallet-toolbox-client', async (importOriginal) => {
  class WalletStorageManager {
    constructor(readonly identityKey: string) {}
    async addWalletStorageProvider(client: { wallet: { identityKey: string; services: unknown }; url: string }) {
      h.built.push({ identityKey: client.wallet.identityKey, services: client.wallet.services, storageUrl: client.url })
    }
    async makeAvailable() {}
  }
  class StorageClient {
    constructor(
      readonly wallet: unknown,
      readonly url: string,
    ) {}
  }
  class Wallet {
    constructor(args: { keyDeriver: { identityKey: string }; services: unknown }) {
      const server = h.servers.get(args.keyDeriver.identityKey)
      if (!server) throw new Error('no server for key')
      return Object.assign(server as object, { identityKey: args.keyDeriver.identityKey, services: args.services })
    }
  }
  return {
    ...(await importOriginal<typeof import('@bsv/wallet-toolbox-client')>()),
    Wallet,
    WalletStorageManager,
    StorageClient,
  }
})
vi.mock('./cryptoBackend', () => ({ walletCryptoBackend: () => undefined }))
vi.mock('./permissions', () => ({ approveWalletPayment: vi.fn(async () => {}) }))
vi.mock('./publicIdentities', async () => {
  const { bapKey } = await import('./bapRecords')
  return {
    presentedIdentityMaterial: () => h.material,
    presentedIdentityKeyAt: (_runtime: unknown, bapId: string, seq: number) => {
      const m = h.material as { kind: string; identity: { bapId: string } } | null
      return m?.kind === 'presented' && m.identity.bapId === bapId
        ? bapKey(h.master as import('@bsv/sdk').PrivateKey, seq)
        : null
    },
  }
})
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
import { bapAddress, bapIdFor, bapKey } from './bapRecords'
import { durableForgetCached } from './durableStorage'
import {
  derivedDevKey,
  DevKeyRefused,
  devSignEligibility,
  devWalletStatus,
  exportDevKeyConfig,
  feeShortfall,
  fundDevWallet,
  generateDevKey,
  listDevKeys,
  planDevWalletRecover,
  readDevKeyLedger,
  recoverDevWallet,
  refreshDevWallet,
  removeDevKey,
} from './devKeys'
import { approveWalletPayment } from './permissions'
import type { ActiveWallet } from './session'
import type { WalletRuntime } from './walletRuntime'

const BRC29: [2, string] = [2, '3241645161d8']
const root = PrivateKey.fromRandom()
const rootHex = root.toHex()
const identityKey = root.toPublicKey().toString()
const handcash = new ProtoWallet(root)
const master = PrivateKey.fromRandom()
h.master = master
const BAP_ID = bapIdFor(master)

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
  const server = {
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
      const pay = args.outputs![0]!
      const money = outputs.filter((o) => o.basket === 'default')
      const total = money.reduce((s, o) => s + o.satoshis, 0)
      const fee = 30
      if (pay.satoshis + fee > total) {
        throw new Error(
          `Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (${
            pay.satoshis + fee - total
          } more satoshis are needed, for a total of ${pay.satoshis + fee})`,
        )
      }
      created.push(args)
      for (const o of money) outputs.splice(outputs.indexOf(o), 1)
      const change = total - pay.satoshis - fee
      if (change > 0) outputs.push({ basket: 'default', satoshis: change, tags: [] })
      const tx = new Transaction()
      tx.addOutput({ lockingScript: LockingScript.fromHex(pay.lockingScript), satoshis: pay.satoshis })
      tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), 2)
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    },
  }
  h.servers.set(key.toPublicKey().toString(), server)
  return server
}

const services = { name: 'session services' }
const active = {
  accountIndex: 0,
  identityKey,
  chain: 'main' as const,
  rootKeyHex: rootHex,
  services,
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

/** The identity this account presents, its current key at `seq`. */
function present(seq: number, extra: { revoked?: boolean } = {}): void {
  h.material = {
    kind: 'presented',
    issuedAt: '2026-10-03T00:00:00.000Z',
    pkg: { v: 1, bapId: BAP_ID, beefB64: '' },
    identity: {
      bapId: BAP_ID,
      name: 'Studio',
      keys: Array.from({ length: seq + 1 }, (_, i) => ({ seq: i, address: bapAddress(master, i) })).slice(1),
      ...extra,
    },
    signingKey: bapKey(master, seq),
  }
}

function ledgerKey(): string {
  return [...store.keys()].find((k) => k.startsWith('handcash.serverWallet'))!
}

const walletKey = () => generateDevKey(runtime, { sign: false, wallet: true })

beforeEach(() => {
  h.lifecycle?.dispose?.(runtime, 'locked')
  store.clear()
  durableForgetCached()
  h.servers.clear()
  h.built.length = 0
  h.funded.length = 0
  h.handcashInternalized.length = 0
  h.failHandcashInternalize = false
  h.material = null
  vi.mocked(approveWalletPayment).mockReset().mockResolvedValue(undefined)
})

describe('generate', () => {
  it('needs at least one capability', () => {
    expect(() => generateDevKey(runtime, { sign: false, wallet: false })).toThrow(DevKeyRefused)
  })

  it('numbers keys and never reuses a number', async () => {
    expect(walletKey()).toBe(1)
    expect(walletKey()).toBe(2)
    fakeServerWallet(derivedDevKey(rootHex, 2))
    await removeDevKey(runtime, 2)
    expect(walletKey()).toBe(3)
  })

  it('derives a wallet-only key per number, never the account root', () => {
    expect(derivedDevKey(rootHex, 1).toHex()).not.toBe(rootHex)
    expect(derivedDevKey(rootHex, 2).toHex()).not.toBe(derivedDevKey(rootHex, 1).toHex())
  })

  it('exports a wallet key as the BSVA server env and opens it on the session services', async () => {
    const n = walletKey()
    fakeServerWallet(derivedDevKey(rootHex, n))
    expect(exportDevKeyConfig(runtime, n)).toBe(
      `SERVER_PRIVATE_KEY=${derivedDevKey(rootHex, n).toHex()}\n` +
        'WALLET_STORAGE_URL=https://storage.babbage.systems\nBSV_NETWORK=main\n',
    )
    await refreshDevWallet(runtime, n)
    expect(h.built).toEqual([
      {
        identityKey: derivedDevKey(rootHex, n).toPublicKey().toString(),
        services,
        storageUrl: 'https://storage.babbage.systems',
      },
    ])
  })
})

describe('sign capability', () => {
  it('carries the current identity key, never the master or root', () => {
    present(2)
    const n = generateDevKey(runtime, { sign: true, wallet: false })
    const env = exportDevKeyConfig(runtime, n)
    expect(env).toBe(`SERVER_PRIVATE_KEY=${bapKey(master, 2).toHex()}\nBSV_NETWORK=main\nBAP_ID=${BAP_ID}\n`)
    expect(env).not.toContain(master.toHex())
    expect(env).not.toContain(bapKey(master, 0).toHex())
    expect(listDevKeys(runtime)[0]).toMatchObject({ sign: { seq: 2, state: 'active' }, wallet: null })
  })

  it('lets one key both sign and hold a wallet', async () => {
    present(1)
    const n = generateDevKey(runtime, { sign: true, wallet: true })
    fakeServerWallet(bapKey(master, 1))
    expect(exportDevKeyConfig(runtime, n)).toContain('WALLET_STORAGE_URL=')
    expect(exportDevKeyConfig(runtime, n)).toContain(`BAP_ID=${BAP_ID}`)
    await refreshDevWallet(runtime, n)
    expect(h.built[0]!.identityKey).toBe(bapKey(master, 1).toPublicKey().toString())
  })

  it('refuses without a published identity, after withdrawal, and for the root', () => {
    expect(devSignEligibility(runtime)).toMatchObject({ kind: 'refused', reason: 'not-published' })
    h.material = { kind: 'withdrawn', issuedAt: '2026-10-03T00:00:00.000Z' }
    expect(devSignEligibility(runtime)).toMatchObject({ kind: 'refused', reason: 'revoked' })
    present(0)
    expect(() => generateDevKey(runtime, { sign: true, wallet: false })).toThrow(DevKeyRefused)
  })

  it('is held by one key until a rotation retires it', async () => {
    present(1)
    const first = generateDevKey(runtime, { sign: true, wallet: false })
    expect(devSignEligibility(runtime)).toMatchObject({ kind: 'refused', reason: 'sign-key-held' })
    await expect(removeDevKey(runtime, first)).rejects.toMatchObject({ reason: 'still-signing' })

    present(2)
    expect(listDevKeys(runtime)[0]).toMatchObject({ sign: { seq: 1, state: 'retired' } })
    const second = generateDevKey(runtime, { sign: true, wallet: false })
    expect(listDevKeys(runtime).map((k) => k.sign?.state)).toEqual(['retired', 'active'])
    await removeDevKey(runtime, first)
    expect(listDevKeys(runtime).map((k) => k.n)).toEqual([second])
  })
})

describe('summary', () => {
  it('counts money, items and distinct tokens', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    server.outputs.push(
      { basket: 'default', satoshis: 700, tags: [] },
      { basket: 'default', satoshis: 300, tags: [] },
      { basket: '1sat', satoshis: 1, tags: [] },
      { basket: '1sat', satoshis: 1, tags: [] },
      { basket: 'bsv21', satoshis: 1, tags: ['bsv21', `bsv21:${'a'.repeat(64)}_0`, 'amt:5'] },
      { basket: 'bsv21', satoshis: 1, tags: ['bsv21', `bsv21:${'a'.repeat(64)}_0`, 'amt:2'] },
      { basket: 'bsv21', satoshis: 1, tags: ['bsv21', `bsv21:${'b'.repeat(64)}_1`, 'amt:9'] },
    )
    expect(await refreshDevWallet(runtime, n)).toEqual({ money: 1000, moneyOutputs: 2, items: 2, tokens: 2 })
  })
})

describe('wallet status', () => {
  const summary = { money: 1000, moneyOutputs: 2, items: 1, tokens: 0 }
  const fund = { txid: 'a'.repeat(64), outputIndex: 0, satoshis: 400, derivationPrefix: 'p', derivationSuffix: 's' }
  const recover = { txid: 'b'.repeat(64), atomicBeefB64: '', satoshis: 900, derivationPrefix: 'p', derivationSuffix: 's' }
  const idle = { pendingFunds: [], pendingRecover: null }

  it('is loading until the first read, then ready', () => {
    expect(devWalletStatus(idle, undefined, true)).toEqual({ kind: 'loading' })
    expect(devWalletStatus(idle, { summary, error: null }, false)).toEqual({ kind: 'ready', summary })
  })

  it('names what is still settling in each direction', () => {
    expect(devWalletStatus({ pendingFunds: [fund, fund], pendingRecover: recover }, { summary, error: null }, false))
      .toEqual({ kind: 'settling', summary, funding: 800, recovering: 900 })
  })

  it('is unreachable after a failed read, keeping the last summary, but not while a retry runs', () => {
    const read = { summary, error: 'Failed to fetch' }
    expect(devWalletStatus(idle, read, false)).toEqual({ kind: 'unreachable', summary, error: 'Failed to fetch' })
    expect(devWalletStatus(idle, read, true)).toEqual({ kind: 'ready', summary })
  })

  it('lists a wallet key with its storage host and status', async () => {
    const n = walletKey()
    fakeServerWallet(derivedDevKey(rootHex, n))
    await refreshDevWallet(runtime, n)
    expect(listDevKeys(runtime)[0]!.wallet).toEqual({
      status: { kind: 'ready', summary: { money: 0, moneyOutputs: 0, items: 0, tokens: 0 } },
      storageHost: expect.stringMatching(/storage\.babbage\.systems$/),
      refreshing: false,
    })
  })
})

describe('fund', () => {
  it('asks for payment approval, pays by BRC-29 and internalizes into its storage', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    await fundDevWallet(n, 5_000)
    expect(approveWalletPayment).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fund dev wallet', amountSats: 5_000 }),
    )
    expect(server.outputs).toEqual([{ basket: 'default', satoshis: 5_000, tags: [] }])
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingFunds).toEqual([])
  })

  it('pays nothing when the approval is declined', async () => {
    const n = walletKey()
    fakeServerWallet(derivedDevKey(rootHex, n))
    vi.mocked(approveWalletPayment).mockRejectedValueOnce(new Error('declined'))
    await expect(fundDevWallet(n, 5_000)).rejects.toThrow('declined')
    expect(h.funded).toEqual([])
  })

  it('keeps a missed internalize pending and settles it on the next refresh', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    const internalize = server.internalizeAction
    server.internalizeAction = async () => {
      throw new Error('storage down')
    }
    await fundDevWallet(n, 4_000)
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingFunds).toHaveLength(1)
    server.internalizeAction = internalize
    expect((await refreshDevWallet(runtime, n)).money).toBe(4_000)
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingFunds).toEqual([])
  })
})

describe('migration', () => {
  it('turns a v2 server wallet into the numbered key with its wallet', () => {
    walletKey()
    store.set(
      ledgerKey(),
      JSON.stringify({ v: 2, generation: 3, storageUrl: 'https://box.example', pendingFunds: [], pendingRecover: null }),
    )
    durableForgetCached()
    expect(readDevKeyLedger(active)).toMatchObject({
      v: 3,
      next: 4,
      keys: [{ n: 3, material: { kind: 'derived' }, wallet: { storageUrl: 'https://box.example' } }],
    })
    expect(exportDevKeyConfig(runtime, 3)).toContain(`SERVER_PRIVATE_KEY=${derivedDevKey(rootHex, 3).toHex()}`)
  })

  it('turns v1 fund payments into internalizations', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    await fundDevWallet(n, 2_500)
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
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingFunds).toHaveLength(1)
    expect((await refreshDevWallet(runtime, 1)).money).toBe(2_500)
  })
})

describe('recover', () => {
  it('refuses with a named reason when there is nothing worth moving', () => {
    const wallet = { pendingRecover: null }
    expect(planDevWalletRecover(wallet, { money: 0, moneyOutputs: 0 })).toEqual({
      path: 'refuse',
      reason: 'nothing-to-recover',
    })
    expect(planDevWalletRecover(wallet, { money: 20, moneyOutputs: 1 })).toEqual({
      path: 'refuse',
      reason: 'uneconomical',
    })
    expect(planDevWalletRecover(wallet, { money: 10_000, moneyOutputs: 2 })).toEqual({
      path: 'recover',
      satoshis: 10_000 - 38,
    })
  })

  it('has the server wallet pay this wallet by BRC-29, then internalizes it', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    server.outputs.push({ basket: 'default', satoshis: 10_000, tags: [] }, { basket: '1sat', satoshis: 1, tags: [] })
    const result = await recoverDevWallet(n)
    // The estimate (23) undershoots the storage's fee (30); its shortfall settles the amount.
    expect(result.satoshis).toBe(10_000 - 30)
    expect(server.outputs.filter((o) => o.basket === 'default')).toEqual([])

    const serverPub = derivedDevKey(rootHex, n).toPublicKey().toString()
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
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingRecover).toBeNull()
  })

  it('keeps a broadcast recovery pending and finishes it without spending again', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    server.outputs.push({ basket: 'default', satoshis: 8_000, tags: [] })
    h.failHandcashInternalize = true
    await expect(recoverDevWallet(n)).rejects.toThrow('internalize failed')
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingRecover).not.toBeNull()
    h.failHandcashInternalize = false
    await recoverDevWallet(n)
    expect(server.created).toHaveLength(1)
    expect(readDevKeyLedger(active).keys[0]!.wallet!.pendingRecover).toBeNull()
    expect(h.handcashInternalized).toHaveLength(1)
  })
})

describe('fee shortfall', () => {
  it('reads the Toolbox insufficient-funds answer, typed or over storage RPC', () => {
    expect(feeShortfall(Object.assign(new Error('x'), { moreSatoshisNeeded: 142 }))).toBe(142)
    expect(
      feeShortfall(new Error('Insufficient funds … (142 more satoshis are needed, for a total of 10142)')),
    ).toBe(142)
    expect(feeShortfall(new Error('storage down'))).toBeNull()
  })
})

describe('remove', () => {
  it('is refused while the wallet holds anything', async () => {
    const n = walletKey()
    const server = fakeServerWallet(derivedDevKey(rootHex, n))
    server.outputs.push({ basket: '1sat', satoshis: 1, tags: [] })
    await expect(removeDevKey(runtime, n)).rejects.toMatchObject({ reason: 'not-empty' })
    server.outputs.length = 0
    await removeDevKey(runtime, n)
    expect(listDevKeys(runtime)).toEqual([])
  })
})
