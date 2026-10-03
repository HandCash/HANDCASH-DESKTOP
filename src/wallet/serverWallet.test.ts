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

vi.mock('./sendBrc29Payment', () => ({ BRC29_PROTOCOL_ID: [2, '3241645161d8'] }))
const spv = vi.hoisted(() => ({
  verdict: { kind: 'verified' } as
    | { kind: 'verified' }
    | { kind: 'incomplete'; reason: string }
    | { kind: 'invalid'; reason: string },
}))
vi.mock('./spvPackage', () => ({ verifySignedPackage: async () => spv.verdict }))
const recover = vi.hoisted(() => ({
  beef: null as unknown,
  registered: [] as Array<{ txid: string; atomicBeef: number[]; flow: string }>,
  internalized: [] as unknown[],
  runtime: null as unknown,
}))
vi.mock('./beefCache', () => ({ getBeefForTxidCached: async () => recover.beef }))
vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: async (args: { txid: string; atomicBeef: number[]; flow: string }) => {
    recover.registered.push(args)
    return args
  },
  startSignedSendPropagation: () => {},
}))
vi.mock('./legacyBeef', () => ({ withVisibleOnChainBeef: (fn: () => unknown) => fn() }))
vi.mock('./spendGuard', () => ({ refreshSpendableBalance: async () => 0 }))
vi.mock('./deviceSync', () => ({ scheduleHistoryBackupPush: () => {} }))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => recover.runtime,
  requireWalletRuntime: () => recover.runtime,
  assertRuntimeCurrent: () => {},
}))

import {
  Beef,
  KeyDeriver,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Transaction,
  Utils,
} from '@bsv/sdk'
import { durableForgetCached } from './durableStorage'
import {
  applyServerWalletReport,
  ingestServerWalletReport,
  matchServerWalletGeneration,
  parseServerWalletReport,
  planServerWalletRecover,
  readServerWalletLedger,
  recoverServerWallet,
  rotateServerWallet,
  serverWalletKey,
  serverWalletSpendKey,
  setUpServerWallet,
  type ServerWalletLedger,
  type ServerWalletLock,
} from './serverWallet'
import type { WalletRuntime } from './walletRuntime'

const BRC29: [2, string] = [2, '3241645161d8']
const root = PrivateKey.fromRandom()
const rootHex = root.toHex()
const identityKey = root.toPublicKey().toString()
const owner = { accountIndex: 0, identityKey, chain: 'main' as const }
const runtime = {
  instance: { ...owner, rootKeyHex: rootHex, services: { getChainTracker: () => ({}) } },
} as unknown as WalletRuntime

const fundingLock: ServerWalletLock = {
  kind: 'brc29',
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  sender: identityKey,
}
const changeLock: ServerWalletLock = {
  kind: 'brc29',
  derivationPrefix: 'Y2hhbmdl',
  derivationSuffix: 'b25l',
  sender: 'self',
}

function lockTo(key: PrivateKey) {
  return new P2PKH().lock(key.toPublicKey().toHash())
}

/** Funding tx (mined) paying the server key, and a server spend of it. */
async function fixture(generation = 1) {
  const server = serverWalletKey(rootHex, generation)
  const fundingKey = serverWalletSpendKey(server, fundingLock)
  const funding = new Transaction()
  funding.addOutput({ lockingScript: lockTo(fundingKey), satoshis: 10_000 })
  funding.merklePath = MerklePath.fromCoinbaseTxidAndHeight(funding.id('hex'), 1)
  const spend = new Transaction()
  spend.addInput({
    sourceTransaction: funding,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(fundingKey),
  })
  spend.addOutput({
    lockingScript: lockTo(serverWalletSpendKey(server, changeLock)),
    satoshis: 3_000,
  })
  spend.addOutput({ lockingScript: lockTo(PrivateKey.fromRandom()), satoshis: 6_900 })
  await spend.sign()
  return { server, funding, spend, fundingOutpoint: `${funding.id('hex')}.0` }
}

function trackedLedger(outpoint: string, generation = 1): ServerWalletLedger {
  return {
    v: 1,
    generation,
    outputs: [{ outpoint, satoshis: 10_000, generation, lock: fundingLock, seenAt: 1 }],
    lastReportAt: null,
    pendingRecover: null,
  }
}

function reportBody(spend: Transaction, outputs: unknown[]): string {
  return JSON.stringify({
    type: 'server-wallet.report',
    v: 1,
    txid: spend.id('hex'),
    beef: Utils.toBase64(spend.toAtomicBEEF()),
    outputs,
  })
}

function writeLedger(ledger: ServerWalletLedger) {
  setUpServerWallet(runtime)
  store.set([...store.keys()].find((k) => k.startsWith('handcash.serverWallet'))!, JSON.stringify(ledger))
  durableForgetCached()
}

describe('server wallet key', () => {
  it('is a derived key separate from the account root, so Refresh never scans it', () => {
    const one = serverWalletKey(rootHex, 1)
    expect(serverWalletKey(rootHex, 1).toHex()).toBe(one.toHex())
    expect(serverWalletKey(rootHex, 2).toHex()).not.toBe(one.toHex())
    expect(lockTo(one).toHex()).not.toBe(lockTo(root).toHex())
  })

  it('unlocks a BRC-29 payment the wallet derived for it', () => {
    const server = serverWalletKey(rootHex, 1)
    const keyID = `${'cHJlZml4'} ${'c3VmZml4'}`
    const walletSide = new KeyDeriver(root).derivePublicKey(BRC29, keyID, server.toPublicKey())
    expect(serverWalletSpendKey(server, fundingLock).toPublicKey().toString()).toBe(
      walletSide.toString(),
    )
  })

  it('matches current, later and retired generations', () => {
    const pub = (g: number) => serverWalletKey(rootHex, g).toPublicKey().toString()
    expect(matchServerWalletGeneration(rootHex, 3, pub(3))).toEqual({ kind: 'current', generation: 3 })
    expect(matchServerWalletGeneration(rootHex, 1, pub(4))).toEqual({ kind: 'later', generation: 4 })
    expect(matchServerWalletGeneration(rootHex, 3, pub(2))).toEqual({ kind: 'retired' })
    expect(matchServerWalletGeneration(rootHex, 1, identityKey)).toEqual({ kind: 'unknown' })
  })
})

describe('server wallet reports', () => {
  beforeEach(() => {
    store.clear()
    durableForgetCached()
    spv.verdict = { kind: 'verified' }
  })

  it('parses only well-formed reports', async () => {
    const { spend } = await fixture()
    const parsed = parseServerWalletReport(reportBody(spend, [{ vout: 0, lock: changeLock }]))
    expect(parsed?.txid).toBe(spend.id('hex'))
    expect(parsed?.outputs).toEqual([{ vout: 0, lock: changeLock }])
    expect(parseServerWalletReport('{"type":"server-wallet.report","v":1}')).toBeNull()
    expect(
      parseServerWalletReport(reportBody(spend, [{ vout: 0, lock: { kind: 'brc29', sender: 'x' } }])),
    ).toBeNull()
  })

  it('retires spent outputs and tracks only outputs locked to their derivation', async () => {
    const { server, spend, fundingOutpoint } = await fixture()
    const report = parseServerWalletReport(
      reportBody(spend, [
        { vout: 0, lock: changeLock },
        { vout: 1, lock: changeLock },
      ]),
    )!
    const applied = applyServerWalletReport({
      ledger: trackedLedger(fundingOutpoint),
      generation: 1,
      server,
      tx: spend,
      report,
      now: 5,
    })
    expect(applied.spent).toBe(1)
    expect(applied.added).toBe(1)
    expect(applied.mismatched).toEqual([1])
    expect(applied.ledger.outputs).toEqual([
      { outpoint: `${spend.id('hex')}.0`, satoshis: 3_000, generation: 1, lock: changeLock, seenAt: 5 },
    ])
  })

  it('ingests a verified report from the server key', async () => {
    const { server, spend, fundingOutpoint } = await fixture()
    writeLedger(trackedLedger(fundingOutpoint))
    const verdict = await ingestServerWalletReport({
      runtime,
      sender: server.toPublicKey().toString(),
      plaintext: reportBody(spend, [{ vout: 0, lock: changeLock }]),
    })
    expect(verdict).toEqual({ kind: 'ingested', added: 1, spent: 1, generation: 1 })
    expect(readServerWalletLedger(owner)?.outputs.map((o) => o.outpoint)).toEqual([
      `${spend.id('hex')}.0`,
    ])
  })

  it('defers an incomplete package and leaves the ledger alone', async () => {
    const { server, spend, fundingOutpoint } = await fixture()
    writeLedger(trackedLedger(fundingOutpoint))
    spv.verdict = { kind: 'incomplete', reason: 'no chain tracker' }
    const verdict = await ingestServerWalletReport({
      runtime,
      sender: server.toPublicKey().toString(),
      plaintext: reportBody(spend, [{ vout: 0, lock: changeLock }]),
    })
    expect(verdict.kind).toBe('deferred')
    expect(readServerWalletLedger(owner)?.outputs.map((o) => o.outpoint)).toEqual([fundingOutpoint])
  })

  it('refuses invalid packages, foreign senders and retired keys', async () => {
    const { server, spend, fundingOutpoint } = await fixture()
    const body = reportBody(spend, [{ vout: 0, lock: changeLock }])
    writeLedger(trackedLedger(fundingOutpoint))
    spv.verdict = { kind: 'invalid', reason: 'Script verification failed' }
    expect(
      await ingestServerWalletReport({ runtime, sender: server.toPublicKey().toString(), plaintext: body }),
    ).toEqual({ kind: 'refused', reason: 'invalid-package' })
    spv.verdict = { kind: 'verified' }
    expect(await ingestServerWalletReport({ runtime, sender: identityKey, plaintext: body })).toEqual({
      kind: 'refused',
      reason: 'unknown-sender',
    })
    writeLedger({ ...trackedLedger(fundingOutpoint), generation: 2 })
    expect(
      await ingestServerWalletReport({ runtime, sender: server.toPublicKey().toString(), plaintext: body }),
    ).toEqual({ kind: 'refused', reason: 'retired-key' })
  })

  it('adopts a later generation from its report (restore from seed)', async () => {
    const { server, spend } = await fixture(3)
    writeLedger({ ...trackedLedger('00'.repeat(32) + '.0'), outputs: [] })
    const verdict = await ingestServerWalletReport({
      runtime,
      sender: server.toPublicKey().toString(),
      plaintext: reportBody(spend, [{ vout: 0, lock: changeLock }]),
    })
    expect(verdict).toMatchObject({ kind: 'ingested', generation: 3 })
    expect(readServerWalletLedger(owner)?.generation).toBe(3)
  })
})

describe('server wallet recover and rotate', () => {
  beforeEach(() => {
    store.clear()
    durableForgetCached()
  })

  it('plans a named path', () => {
    const empty: ServerWalletLedger = {
      v: 1,
      generation: 1,
      outputs: [],
      lastReportAt: null,
      pendingRecover: null,
    }
    expect(planServerWalletRecover(empty)).toEqual({ path: 'refuse', reason: 'nothing-tracked' })
    const dust = trackedLedger('aa'.repeat(32) + '.0')
    dust.outputs[0]!.satoshis = 1
    expect(planServerWalletRecover(dust)).toEqual({ path: 'refuse', reason: 'uneconomical' })
    expect(planServerWalletRecover(trackedLedger('aa'.repeat(32) + '.0'))).toMatchObject({
      path: 'recover',
      totalSats: 10_000,
    })
    const pending = {
      txid: 'bb'.repeat(32),
      atomicBeefB64: 'AA==',
      satoshis: 9_000,
      derivationPrefix: 'a',
      derivationSuffix: 'b',
    }
    expect(planServerWalletRecover({ ...empty, pendingRecover: pending })).toEqual({
      path: 'finish',
      pending,
    })
  })

  it('recovers tracked outputs into a self payment through the signed lifecycle', async () => {
    const { funding, fundingOutpoint } = await fixture()
    const beef = new Beef()
    beef.mergeTransaction(funding)
    recover.beef = beef
    recover.registered = []
    recover.internalized = []
    const wallet = new ProtoWallet(root) as ProtoWallet & { internalizeAction: unknown }
    wallet.internalizeAction = async (args: unknown) => {
      recover.internalized.push(args)
      return { accepted: true }
    }
    recover.runtime = {
      instance: { ...owner, rootKeyHex: rootHex, address: root.toAddress(), wallet },
    }
    writeLedger(trackedLedger(fundingOutpoint))

    const result = await recoverServerWallet()

    const [registered] = recover.registered
    expect(registered?.flow).toBe('server_wallet_recover')
    const tx = Beef.fromBinary(registered!.atomicBeef).findAtomicTransaction(result.txid)!
    expect(await tx.verify('scripts only')).toBe(true)
    expect(result.satoshis).toBeGreaterThan(9_900)
    expect(result.satoshis).toBeLessThan(10_000)
    const remittance = (recover.internalized[0] as {
      outputs: Array<{ paymentRemittance: { derivationPrefix: string; derivationSuffix: string } }>
    }).outputs[0]!.paymentRemittance
    const selfKey = new KeyDeriver(root).derivePrivateKey(
      BRC29,
      `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
      root.toPublicKey(),
    )
    expect(tx.outputs[0]!.lockingScript.toHex()).toBe(lockTo(selfKey).toHex())
    expect(readServerWalletLedger(owner)).toMatchObject({ outputs: [], pendingRecover: null })
  })

  it('refuses to rotate while funds are tracked', () => {
    writeLedger(trackedLedger('aa'.repeat(32) + '.0'))
    expect(() => rotateServerWallet(runtime)).toThrow(/Recover the tracked funds/)
    writeLedger({ ...trackedLedger('aa'.repeat(32) + '.0'), outputs: [] })
    expect(rotateServerWallet(runtime)).toBe(2)
    expect(readServerWalletLedger(owner)?.generation).toBe(2)
  })
})
