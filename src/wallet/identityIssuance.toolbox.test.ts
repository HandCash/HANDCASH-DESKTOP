import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { Beef, MerklePath, P2PKH, PrivateKey, PublicKey, Script, Transaction, Utils } from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
import type { WalletRuntime } from './walletRuntime'

const state = vi.hoisted(() => ({
  active: null as unknown,
  values: new Map<string, string>(),
  retained: new Map<string, unknown>(),
  toolbox: new Map<string, unknown>(),
  provider: new Map<string, unknown>(),
}))
vi.mock('./walletRuntime', () => ({
  runtimeIsCurrent: (runtime: { instance: unknown }) => runtime.instance === state.active,
}))
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => state.values.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    state.values.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    state.values.delete(key)
  },
}))
vi.mock('./spendGuard', () => ({
  runExclusiveSpend: (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./permissions', () => ({
  approveWalletPayment: vi.fn(async () => {}),
}))
vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: vi.fn(async (args: { txid: string; flow: string }) => args),
  startSignedSendPropagation: vi.fn(),
}))
vi.mock('./beefCache', () => ({
  rememberBeefBinary: vi.fn(),
  hydrateInputBeef: async (_active: unknown, beef: Beef) => beef.toBinary(),
  buildMergedInputBeef: vi.fn(),
  peekSessionBeef: (txid: string) => state.retained.get(txid) ?? null,
  getLocalTxForTxid: async () => null,
  getLocalBeefForTxid: async (_wallet: unknown, txid: string) => state.toolbox.get(txid) ?? null,
  getBeefForTxidCached: async (_wallet: unknown, txid: string) => {
    const beef = state.provider.get(txid)
    if (!beef) throw new Error(`no provider body for ${txid}`)
    return beef
  },
}))

import { withImmediateAppBroadcast } from './appCreateAction'
import {
  bapAliasScript,
  bapIdFor,
  bapIdForAddress,
  bapIdScript,
  bapKey,
  BAP_BASKET,
  IMPORTED_BAP_BASKET,
} from './bapRecords'
import {
  enrichIdentityIssuance,
  finishIdentityIssuance,
  releaseIdentityIssuance,
} from './identityIssuance'
import { groupCollectables } from './collectableGroups'
import type { Collectable } from './collectables'
import { resetIssuerAttributionForTests, retainedIssuerMetadata, retainedScriptIs, retainedSignedBy } from './issuerAttribution'
import { appendIssuerMetadata, issuerMetadataFromScript } from './issuerMetadata'
import {
  displayIssuerAttribution,
  displayIssuerIdentity,
  importIssuerPrivateKey,
  issuanceSigner,
  selectPublicIdentity,
} from './publicIdentities'
import {
  IdentityPublishRefused,
  planIdentityPublish,
  publishIdentityPlan,
  syncHeldIssuerIdentities,
  type IdentityPublishRequest,
} from './identityPublish'
import { issuerIdentityImageDataUrl, type IssuerIdentity } from './issuerIdentity'
import { issuerIdentityFor, resetIssuerIdentitiesForTests } from './issuerIdentities'
import { identityPackagesForDelivery, rememberDeliveredIdentities } from './issuerIdentityDelivery'
import { PNG_1PX } from './issuerIdentity.fixture'
import { approveWalletPayment } from './permissions'
import { registerSignedSend } from './signedSendLifecycle'
import { encodeBsv21Binary } from './token/decode162'
import { resetTokenGenesisForTests, retainTokenGenesis } from './token/genesisStore'
import { sigmaSignDeployLockingScript, verifySigmaIssuer } from './token/issuer'
import {
  proveHeldTokenTip,
  recordProvenTokenTips,
  resetTokenLineageForTests,
  tokenAttestationGap,
  tokenIssuerAttested,
  tokenLineageFromBeef,
  withTokenLineage,
} from './token/lineage'
import { decodeTokenOutput } from './token/prove176'
import type { FungibleToken } from './token/types'

const FUNDING = 100_000
const BRC29: [2, string] = [2, '3241645161d8']
const BROADCAST = /^(unproven|completed|sending)$/

type Harness = {
  runtime: WalletRuntime
  active: ActiveWallet
  posted: string[][]
  sendWaiting: () => Promise<string>
}

async function fundedWallet(): Promise<Harness> {
  const root = PrivateKey.fromRandom()
  const setup = await SetupClient.createWalletIdb({
    chain: 'main',
    rootKeyHex: root.toHex(),
    databaseName: 'issuance',
  } as Parameters<typeof SetupClient.createWalletIdb>[0])
  const services = setup.services as unknown as Record<string, unknown>
  services.getChainTracker = async () => ({
    isValidRootForHeight: async () => true,
    currentHeight: async () => 900_000,
  })
  services.getHeight = async () => 900_000
  services.getHeaderForHeight = async () => new Array(80).fill(0)
  const posted: string[][] = []
  services.postBeef = async (_beef: Beef, txids: string[]) => {
    posted.push([...txids])
    return [
      { name: 'stub', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
    ]
  }

  const sender = PrivateKey.fromRandom().toPublicKey().toString()
  const derivationPrefix = Utils.toBase64(Utils.toArray('issue-prefix', 'utf8'))
  const derivationSuffix = Utils.toBase64(Utils.toArray('issue-suffix', 'utf8'))
  const payee = setup.keyDeriver
    .derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, sender)
    .toPublicKey()
  const fund = new Transaction()
  fund.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
  fund.addOutput({ satoshis: FUNDING, lockingScript: new P2PKH().lock(payee.toAddress()) })
  const txid = fund.id('hex')
  fund.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: txid, txid: true }]])
  await setup.wallet.internalizeAction({
    tx: fund.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender } }],
    description: 'fund issuance test',
  })
  const active = {
    wallet: setup.wallet,
    identityKey: root.toPublicKey().toString(),
    rootKeyHex: root.toHex(),
    chain: 'main',
    accountIndex: 0,
  } as unknown as ActiveWallet
  state.active = active
  type Task = { name: string; runTask(): Promise<string> }
  type TaskClass = new (monitor: unknown, triggerMsecs: number, agedMsecs: number) => Task
  const monitor = setup.monitor as unknown as { _tasks: Task[]; addDefaultTasks(): void }
  monitor.addDefaultTasks()
  const SendWaiting = monitor._tasks.find((t) => t.name === 'SendWaiting')!.constructor as TaskClass
  const sendWaiting = () => new SendWaiting(monitor, 0, 0).runTask()
  return { runtime: { instance: active } as WalletRuntime, active, posted, sendWaiting }
}

function itemOutput(lock: string) {
  const script = new Script()
  script.writeOpCode(0x00)
  script.writeOpCode(0x63)
  script.writeBin(Utils.toArray('ord'))
  script.writeOpCode(0x51)
  script.writeBin(Utils.toArray('text/plain'))
  script.writeOpCode(0x00)
  script.writeBin(Utils.toArray('Award #1'))
  script.writeOpCode(0x68)
  return {
    lockingScript: script.toHex() + lock,
    satoshis: 1,
    basket: '1sat',
    outputDescription: 'Award',
    tags: ['ordinal'],
    customInstructions: JSON.stringify({ name: 'Award #1' }),
  }
}

function tokenOutput(lock: string) {
  return {
    satoshis: 1,
    basket: 'bsv21',
    outputDescription: 'Deploy TEST',
    tags: ['op:deploy+mint', 'sym:TEST'],
    customInstructions: JSON.stringify({ op: 'deploy+mint', amt: '1000', sym: 'TEST' }),
    lockingScript: encodeBsv21Binary({ amount: 1000n, payload: { sym: 'TEST' }, rest: lock }).toHex(),
  }
}

function appCreateAction(active: ActiveWallet, args: unknown) {
  return active.wallet.createAction(withImmediateAppBroadcast(args) as Parameters<ActiveWallet['wallet']['createAction']>[0])
}

function attribution(outpoint: string, script: string) {
  const { issuer, bapId } = retainedIssuerMetadata(outpoint) ?? {}
  return {
    issuer,
    bapId,
    issuerAttested: !!issuer && retainedScriptIs(outpoint, script) && retainedSignedBy(outpoint, issuer),
  }
}

function shelfItem(outpoint: string, script: string): Collectable {
  return {
    outpoint,
    origin: outpoint,
    name: outpoint.slice(0, 6),
    imageUrl: `https://content.test/${outpoint}`,
    satoshis: 1,
    traits: [],
    extras: [],
    proven: false,
    authenticity: 'unproven',
    ...attribution(outpoint, script),
  }
}

function shelfToken(outpoint: string, script: string): FungibleToken {
  return {
    tokenId: outpoint,
    sym: 'TEST',
    amt: '1000',
    dec: 0,
    utxoCount: 1,
    outpoint,
    spendKind: 'plain',
    ...attribution(outpoint, script),
  }
}

async function spendable(h: Harness): Promise<number> {
  const { outputs } = await h.active.wallet.listOutputs({ basket: 'default', limit: 1000 })
  return outputs.filter((o) => o.spendable).reduce((sum, o) => sum + o.satoshis, 0)
}

async function approveAndPublish(h: Harness, request: IdentityPublishRequest): Promise<IssuerIdentity> {
  return publishIdentityPlan(h.runtime, request, await planIdentityPublish(h.runtime, request))
}

const profileRequest = (
  identityKey: string,
  fields = { name: 'Studio', description: 'Awards' },
): IdentityPublishRequest => ({ kind: 'profile', identityKey, fields, image: PNG_1PX })

function publish(h: Harness, identityKey = h.active.identityKey): Promise<IssuerIdentity> {
  return approveAndPublish(h, profileRequest(identityKey))
}

function rotate(h: Harness, identityKey = h.active.identityKey): Promise<IssuerIdentity> {
  return approveAndPublish(h, { kind: 'rotate', identityKey })
}

const master = (h: Harness) => PrivateKey.fromHex(h.active.rootKeyHex)
const signingKey = (h: Harness, seq = 1) => bapKey(master(h), seq).toPublicKey().toString()
const walletLock = (h: Harness) => new P2PKH().lock(master(h).toAddress()).toHex()

async function mint(h: Harness, outputs: ReturnType<typeof itemOutput | typeof tokenOutput>[], expected = h.active.identityKey) {
  const enriched = await enrichIdentityIssuance(h.runtime, { description: 'Issue', outputs }, expected)
  const created = await appCreateAction(h.active, enriched)
  const done = (await finishIdentityIssuance(h.runtime, enriched, created)) as { txid: string; tx: number[] }
  const beef = Beef.fromBinary(done.tx)
  state.retained.set(done.txid, beef)
  return { enriched, done, beef, tx: beef.findTxid(done.txid)!.tx! }
}

async function statusOf(h: Harness, txid: string): Promise<string | undefined> {
  const { actions } = await h.active.wallet.listActions({ labels: [], limit: 1000 })
  return actions.find((a) => a.txid === txid)?.status
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  state.values.clear()
  state.retained.clear()
  state.toolbox.clear()
  state.provider.clear()
  resetIssuerAttributionForTests()
  resetIssuerIdentitiesForTests()
  resetTokenGenesisForTests()
  resetTokenLineageForTests()
  vi.mocked(registerSignedSend).mockClear()
})

/** Payee's device: none of the sender's bytes, packages or verdicts. */
function forgetSenderDevice() {
  state.values.clear()
  state.retained.clear()
  resetIssuerAttributionForTests()
  resetIssuerIdentitiesForTests()
  resetTokenGenesisForTests()
  resetTokenLineageForTests()
}

async function mintAndTransferToken(h: Harness) {
  const minted = await mint(h, [tokenOutput(walletLock(h))])
  const vout = minted.tx.outputs.findIndex((o) => decodeTokenOutput(o.lockingScript)?.role === 'deploy')
  const tokenId = `${minted.done.txid}_${vout}`
  const transfer = new Transaction()
  transfer.addInput({ sourceTransaction: minted.tx, sourceOutputIndex: vout, unlockingScript: Script.fromHex('') })
  transfer.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({
      amount: 1000n,
      tokenId,
      rest: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
    }),
  })
  const senderBeef = minted.beef.clone()
  senderBeef.mergeTransaction(transfer)
  const subject = new Beef()
  subject.mergeRawTx(transfer.toBinary())
  return { tokenId, tip: `${transfer.id('hex')}_0`, transferTxid: transfer.id('hex'), senderBeef, subject }
}

describe('identity issuance against a real toolbox wallet', () => {
  it('publishes a BAP identity as 0-sat records: a B:// image, then the root-declared key and its profile', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    expect(identity).toMatchObject({
      bapId: bapIdFor(master(h)),
      rootAddress: bapKey(master(h), 0).toAddress(),
      name: 'Studio',
      description: 'Awards',
    })
    expect(identity.keys.map((k) => [k.seq, k.address])).toEqual([[1, bapKey(master(h), 1).toAddress()]])
    expect(identity.image).toEqual(PNG_1PX)
    const txids = vi.mocked(registerSignedSend).mock.calls.map(([args]) => args.txid)
    expect(txids).toEqual([identity.imageTxid, identity.alias.txid])
    expect(vi.mocked(registerSignedSend).mock.calls.every(([args]) => args.flow === 'identity_publish')).toBe(true)
    const records = await h.active.wallet.listOutputs({ basket: BAP_BASKET, includeTags: true })
    expect(records.outputs.map((o) => o.satoshis)).toEqual([0, 0, 0])
    expect((await h.active.wallet.listOutputs({ basket: '1sat' })).outputs).toEqual([])
    const { publicKey } = await h.active.wallet.getPublicKey({
      protocolID: [1, 'sigma'],
      keyID: 'identity-0',
      counterparty: 'self',
    })
    expect(bapIdForAddress(PublicKey.fromString(publicKey).toAddress())).toBe(identity.bapId)
    const ids = await h.active.wallet.listOutputs({
      basket: BAP_BASKET,
      tags: ['type:id'],
      includeCustomInstructions: true,
    })
    expect(ids.outputs.map((o) => JSON.parse(o.customInstructions!))).toEqual([
      { protocolID: [1, 'sigma'], keyID: 'identity-1' },
    ])
    await h.sendWaiting()
    expect(h.posted.flat()).toEqual(expect.arrayContaining(txids))
    for (const txid of txids) expect(await statusOf(h, txid!)).toMatch(BROADCAST)
    expect(displayIssuerIdentity(h.runtime, { issuer: h.active.identityKey })?.bapId).toBe(identity.bapId)
  })

  it('a profile update re-signs only the ALIAS and reuses the published image', async () => {
    const h = await fundedWallet()
    const first = await publish(h)
    vi.mocked(registerSignedSend).mockClear()
    const updated = await approveAndPublish(h, profileRequest(h.active.identityKey, { name: 'Studio II', description: '' }))
    expect(vi.mocked(registerSignedSend).mock.calls.map(([args]) => args.txid)).toEqual([updated.alias.txid])
    expect(updated).toMatchObject({ bapId: first.bapId, name: 'Studio II', imageTxid: first.imageTxid })
    expect(updated.keys).toEqual(first.keys)
  })

  it('quotes every record and its fee ceiling, signs nothing until approved, then pays within it', async () => {
    const h = await fundedWallet()
    const plan = await planIdentityPublish(h.runtime, profileRequest(h.active.identityKey))
    expect(plan).toMatchObject({
      kind: 'publish',
      bapId: bapIdFor(master(h)),
      signer: 'wallet',
      name: 'Studio',
      image: { status: 'new', bytes: PNG_1PX.bytes.length, contentType: PNG_1PX.contentType },
      signingKey: { seq: 1, publicKey: signingKey(h) },
      retiredKey: null,
    })
    expect(plan.transactions.map((tx) => [tx.purpose, tx.outputs.map((o) => o.description)])).toEqual([
      ['image', ['Identity image']],
      ['publish', ['BAP ID', 'BAP ALIAS']],
    ])
    expect(plan.feeSats).toBeGreaterThan(0)
    expect(plan.maxFeeSats).toBeGreaterThan(plan.feeSats)
    expect(registerSignedSend).not.toHaveBeenCalled()
    expect((await h.active.wallet.listOutputs({ basket: BAP_BASKET })).outputs).toEqual([])
    expect(await spendable(h)).toBe(FUNDING)

    await publishIdentityPlan(h.runtime, profileRequest(h.active.identityKey), plan)
    const paid = FUNDING - (await spendable(h))
    expect(paid).toBeGreaterThan(0)
    expect(paid).toBeLessThanOrEqual(plan.feeSats)
  })

  it('asks for payment approval and signs nothing when it is declined', async () => {
    const h = await fundedWallet()
    const request = profileRequest(h.active.identityKey)
    const plan = await planIdentityPublish(h.runtime, request)
    vi.mocked(approveWalletPayment).mockRejectedValueOnce(new Error('declined'))
    await expect(publishIdentityPlan(h.runtime, request, plan)).rejects.toThrow('declined')
    expect(approveWalletPayment).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Publish identity', amountSats: plan.feeSats }),
    )
    expect(registerSignedSend).not.toHaveBeenCalled()
    expect(await spendable(h)).toBe(FUNDING)
  })

  it('refuses a plan that moved since review before staging anything', async () => {
    const h = await fundedWallet()
    const request = profileRequest(h.active.identityKey)
    const plan = await planIdentityPublish(h.runtime, request)
    const renamed = profileRequest(h.active.identityKey, { name: 'Studio X', description: 'Awards' })
    await expect(publishIdentityPlan(h.runtime, renamed, plan)).rejects.toMatchObject({ reason: 'plan-changed' })
    expect(registerSignedSend).not.toHaveBeenCalled()
    expect(await spendable(h)).toBe(FUNDING)

    await publish(h)
    const update = profileRequest(h.active.identityKey, { name: 'Studio II', description: '' })
    const stale = await planIdentityPublish(h.runtime, update)
    expect(stale).toMatchObject({ kind: 'update', image: { status: 'reused' } })
    await rotate(h)
    vi.mocked(registerSignedSend).mockClear()
    const refused = publishIdentityPlan(h.runtime, update, stale)
    await expect(refused).rejects.toBeInstanceOf(IdentityPublishRefused)
    await expect(refused).rejects.toMatchObject({ reason: 'plan-changed' })
    expect(registerSignedSend).not.toHaveBeenCalled()
  })

  it('aborts a staged record over its approved fee ceiling unsigned, and frees the change', async () => {
    const h = await fundedWallet()
    const request = profileRequest(h.active.identityKey)
    const plan = await planIdentityPublish(h.runtime, request)
    const createAction = h.active.wallet.createAction.bind(h.active.wallet)
    const padding = new Script().writeOpCode(0x00).writeOpCode(0x6a).writeBin(new Array(40_000).fill(1)).toHex()
    vi.spyOn(h.active.wallet, 'createAction').mockImplementation((args) =>
      createAction({
        ...args,
        outputs: [...(args.outputs ?? []), { lockingScript: padding, satoshis: 0, outputDescription: 'padding' }],
      }),
    )
    await expect(publishIdentityPlan(h.runtime, request, plan)).rejects.toMatchObject({ reason: 'fee-over-plan' })
    expect(registerSignedSend).not.toHaveBeenCalled()
    expect(await spendable(h)).toBe(FUNDING)
  })

  it('refuses to issue before an identity is published', async () => {
    const h = await fundedWallet()
    await expect(
      enrichIdentityIssuance(h.runtime, { description: 'Issue award', outputs: [itemOutput(walletLock(h))] }, h.active.identityKey),
    ).rejects.toThrow(/Publish your issuer identity/)
    expect(await spendable(h)).toBe(FUNDING)
  })

  it('mints an item and a token signed by the current BAP key, and sends the anchor with them', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    await h.sendWaiting()
    h.posted.length = 0
    const { enriched, done, beef, tx } = await mint(h, [itemOutput(walletLock(h)), tokenOutput(walletLock(h))])
    const anchorTxid = enriched.options!.sendWith![0]!
    expect(tx.inputs[0]!.sourceTXID).toBe(anchorTxid)
    expect(beef.findTxid(anchorTxid)?.tx).toBeTruthy()
    for (const vout of [0, 1]) {
      expect(verifySigmaIssuer(tx, vout, signingKey(h))).toBe(true)
      expect(verifySigmaIssuer(tx, vout, h.active.identityKey)).toBe(false)
      expect(issuerMetadataFromScript(tx.outputs[vout]!.lockingScript.toHex())).toEqual({
        issuer: signingKey(h),
        bapId: identity.bapId,
      })
    }
    expect(h.posted).toEqual([])
    await h.sendWaiting()
    expect(h.posted.flat()).toEqual(expect.arrayContaining([anchorTxid, done.txid]))
    expect(await statusOf(h, anchorTxid)).toMatch(BROADCAST)
    expect(await statusOf(h, done.txid)).toMatch(BROADCAST)
    const items = await h.active.wallet.listOutputs({ basket: '1sat' })
    expect(items.outputs.map((o) => o.outpoint)).toEqual([`${done.txid}.0`])
  })

  it("signs with an imported master key's BAP key while the wallet funds the mint", async () => {
    const h = await fundedWallet()
    const issuer = PrivateKey.fromRandom()
    const id = importIssuerPrivateKey(h.runtime, issuer.toHex())
    const identity = await publish(h, id)
    expect(identity.bapId).toBe(bapIdFor(issuer))
    expect((await h.active.wallet.listOutputs({ basket: BAP_BASKET })).outputs).toEqual([])
    const held = await h.active.wallet.listOutputs({ basket: IMPORTED_BAP_BASKET, includeCustomInstructions: true })
    expect(held.outputs.map((o) => [o.satoshis, o.customInstructions ?? null])).toEqual([
      [0, null],
      [0, null],
      [0, null],
    ])
    selectPublicIdentity(h.runtime, id)
    const { tx } = await mint(h, [itemOutput(walletLock(h))], id)
    expect(verifySigmaIssuer(tx, 0, bapKey(issuer, 1).toPublicKey().toString())).toBe(true)
    expect(verifySigmaIssuer(tx, 0, h.active.identityKey)).toBe(false)
    expect(issuerMetadataFromScript(tx.outputs[0]!.lockingScript.toHex()).bapId).toBe(identity.bapId)
    expect(await spendable(h)).toBeLessThan(FUNDING)
  })

  it('returns every satoshi when the mint fails before broadcast', async () => {
    const h = await fundedWallet()
    await publish(h)
    await h.sendWaiting()
    h.posted.length = 0
    const before = await spendable(h)
    const enriched = await enrichIdentityIssuance(h.runtime, { description: 'Issue award', outputs: [itemOutput(walletLock(h))] }, h.active.identityKey)
    const anchorTxid = enriched.options!.sendWith![0]!
    const created = await appCreateAction(h.active, enriched)
    expect(await spendable(h)).toBeLessThan(FUNDING)
    await releaseIdentityIssuance(h.runtime, enriched, created)
    await h.sendWaiting()
    expect(h.posted).toEqual([])
    expect([undefined, 'failed']).toContain(await statusOf(h, anchorTxid))
    expect(await spendable(h)).toBe(before)
    expect((await h.active.wallet.listOutputs({ basket: '1sat' })).outputs).toEqual([])
  })

  it('a key rotation keeps one shelf: assets from both keys sit under the BAP ID, a copied claim apart', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const before = await mint(h, [itemOutput(walletLock(h)), tokenOutput(walletLock(h))])
    const rotated = await rotate(h)
    expect(rotated.keys.map((k) => k.seq)).toEqual([1, 2])
    expect(rotated).toMatchObject({ bapId: identity.bapId, name: 'Studio', imageTxid: identity.imageTxid })
    expect(issuanceSigner(h.runtime).identityKey).toBe(signingKey(h, 2))
    const after = await mint(h, [itemOutput(walletLock(h))])
    expect(verifySigmaIssuer(after.tx, 0, signingKey(h, 2))).toBe(true)

    const itemScript = before.tx.outputs[0]!.lockingScript.toHex()
    const tokenScript = before.tx.outputs[1]!.lockingScript.toHex()
    const laterScript = after.tx.outputs[0]!.lockingScript.toHex()
    const copy = new Transaction()
    copy.addInput({ sourceTXID: '22'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
    const claimScript = appendIssuerMetadata(itemOutput(walletLock(h)).lockingScript, signingKey(h, 2), identity.bapId)
    copy.addOutput({ satoshis: 1, lockingScript: Script.fromHex(claimScript) })
    const copyBeef = new Beef()
    copyBeef.mergeTransaction(copy)
    state.retained.set(copy.id('hex'), copyBeef)

    const shelves = groupCollectables(
      [
        shelfItem(`${before.done.txid}.0`, itemScript),
        shelfItem(`${after.done.txid}.0`, laterScript),
        shelfItem(`${copy.id('hex')}.0`, claimScript),
      ],
      [shelfToken(`${before.done.txid}.1`, tokenScript)],
      (asset) => displayIssuerAttribution(h.runtime, asset),
    ).issuers
    const verified = shelves.find((s) => s.key === `issuer:bap:${identity.bapId}`)
    const claim = shelves.find((s) => s.key === `issuer:claim:${signingKey(h, 2)}`)
    expect(shelves).toHaveLength(2)
    expect(verified).toMatchObject({
      issuerAttested: true,
      label: 'Studio',
      icon: issuerIdentityImageDataUrl(rotated.image!),
      bapId: identity.bapId,
    })
    expect(verified?.items.map((i) => i.outpoint).sort()).toEqual([`${before.done.txid}.0`, `${after.done.txid}.0`].sort())
    expect(verified?.tokens.map((t) => t.outpoint)).toEqual([`${before.done.txid}.1`])
    expect(claim?.issuerAttested).toBe(false)
    expect(claim?.icon).toBeUndefined()
    expect(claim?.label).not.toBe('Studio')
  })

  it('continues a chain the earlier ID-panel compose published instead of declaring a second one', async () => {
    const h = await fundedWallet()
    const bapId = bapIdFor(master(h))
    const legacy = await h.active.wallet.createAction({
      description: 'BAP identity creation with profile',
      labels: ['handcash-bap', 'bap-identity'],
      outputs: [
        {
          lockingScript: bapIdScript({ bapId, address: bapKey(master(h), 1).toAddress(), signer: bapKey(master(h), 0) }),
          satoshis: 1,
          outputDescription: 'BAP ID',
          basket: BAP_BASKET,
          tags: ['type:id', `bapId:${bapId}`, 'seq:1'],
        },
        {
          lockingScript: bapAliasScript({
            bapId,
            profile: { '@type': 'Person', name: 'Old studio', image: 'https://example.com/a.png' },
            signer: bapKey(master(h), 1),
          }),
          satoshis: 1,
          outputDescription: 'BAP ALIAS',
          basket: BAP_BASKET,
          tags: ['type:alias', `bapId:${bapId}`, 'publishedAt:1'],
        },
      ],
      options: { acceptDelayedBroadcast: true, randomizeOutputs: false },
    })
    expect(await syncHeldIssuerIdentities(h.runtime)).toBe(1)
    expect(issuerIdentityFor('main', bapId)).toMatchObject({ name: 'Old studio', keys: [{ seq: 1, txid: legacy.txid }] })
    expect(issuerIdentityFor('main', bapId)?.image).toBeUndefined()
    vi.mocked(registerSignedSend).mockClear()
    const identity = await publish(h)
    expect(identity.keys).toEqual([expect.objectContaining({ seq: 1, txid: legacy.txid })])
    expect(identity.name).toBe('Studio')
    expect(identity.image).toEqual(PNG_1PX)
    expect(vi.mocked(registerSignedSend)).toHaveBeenCalledTimes(2)
  })

  it('follows a rotation a 1Sat app wrote into `bap`, so issuance and the next rotation continue it', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const bapId = identity.bapId
    const foreign = await h.active.wallet.createAction({
      description: 'BAP key rotation',
      outputs: [
        {
          lockingScript: bapIdScript({ bapId, address: bapKey(master(h), 2).toAddress(), signer: bapKey(master(h), 1) }),
          satoshis: 0,
          outputDescription: 'BAP ID',
          basket: BAP_BASKET,
          tags: ['type:id', `bapId:${bapId}`, 'seq:2'],
          customInstructions: JSON.stringify({ protocolID: [1, 'sigma'], keyID: 'identity-2' }),
        },
      ],
      options: { acceptDelayedBroadcast: true, randomizeOutputs: false },
    })
    // 1Sat's rotateIdentity relinquishes the ID outputs it replaced.
    await h.active.wallet.relinquishOutput({ basket: BAP_BASKET, output: `${identity.keys[0]!.txid}.0` })
    expect(issuanceSigner(h.runtime).identityKey).toBe(signingKey(h, 1))

    expect(await syncHeldIssuerIdentities(h.runtime, h.active.identityKey)).toBe(1)
    expect(await syncHeldIssuerIdentities(h.runtime, h.active.identityKey)).toBe(0)
    const synced = issuerIdentityFor('main', bapId)!
    expect(synced.keys.map((k) => k.txid)).toEqual([identity.keys[0]!.txid, foreign.txid])
    expect(synced).toMatchObject({ name: 'Studio', imageTxid: identity.imageTxid })
    expect(issuanceSigner(h.runtime).identityKey).toBe(signingKey(h, 2))

    const rotated = await rotate(h)
    expect(rotated.keys.map((k) => k.seq)).toEqual([1, 2, 3])
    expect(rotated.keys[1]!.txid).toBe(foreign.txid)
    expect(issuanceSigner(h.runtime).identityKey).toBe(signingKey(h, 3))
  })

  it('delivers the identity package once beside the item, and the receiver stores and resolves it', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const { done } = await mint(h, [itemOutput(walletLock(h))])
    const packages = identityPackagesForDelivery('main', { itemOrigin: `${done.txid}_0` })
    expect(packages.map((pkg) => pkg.bapId)).toEqual([identity.bapId])

    state.values.clear()
    resetIssuerIdentitiesForTests()
    expect(issuerIdentityFor('main', identity.bapId)).toBeNull()
    expect(await rememberDeliveredIdentities('main', packages, null)).toBe(1)
    expect(displayIssuerIdentity(h.runtime, { issuer: signingKey(h), bapId: identity.bapId, origin: `${done.txid}_0` })).toMatchObject({
      bapId: identity.bapId,
      name: 'Studio',
    })
  })

  it('attests a received token from the lineage it arrived with and shelves it under the BAP ID', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const { tokenId, tip, transferTxid, senderBeef, subject } = await mintAndTransferToken(h)
    const lineage = tokenLineageFromBeef(senderBeef, transferTxid, tokenId)
    expect(lineage).not.toBeNull()
    expect(Beef.fromBinary(lineage!).findTxid(transferTxid)).toBeUndefined()
    const packages = identityPackagesForDelivery('main', { tokenId })
    expect(packages.map((pkg) => pkg.bapId)).toEqual([identity.bapId])

    forgetSenderDevice()
    const issuer = signingKey(h)
    expect(recordProvenTokenTips(subject, [tip], tokenId)).toBeNull()
    expect(tokenIssuerAttested({ outpoint: tip, tokenId, issuer })).toBe(false)

    const proof = withTokenLineage(subject, lineage)
    expect(recordProvenTokenTips(proof, [tip], tokenId)).toBe(tokenId)
    expect(await retainTokenGenesis(proof, tokenId.split('_')[0]!, null)).toBe(true)
    expect(tokenIssuerAttested({ outpoint: tip, tokenId, issuer })).toBe(true)
    expect(tokenIssuerAttested({ outpoint: tip, tokenId, issuer: h.active.identityKey })).toBe(false)
    expect(tokenIssuerAttested({ outpoint: `${'33'.repeat(32)}_0`, tokenId, issuer })).toBe(false)

    expect(await rememberDeliveredIdentities('main', packages, null)).toBe(1)
    const token: FungibleToken = {
      tokenId,
      sym: 'TEST',
      amt: '1000',
      dec: 0,
      utxoCount: 1,
      outpoint: tip,
      spendKind: 'plain',
      issuer,
      bapId: retainedIssuerMetadata(tokenId)?.bapId,
      issuerAttested: tokenIssuerAttested({ outpoint: tip, tokenId, issuer }),
    }
    const shelves = groupCollectables([], [token], (asset) => displayIssuerAttribution(h.runtime, asset)).issuers
    expect(shelves).toHaveLength(1)
    expect(shelves[0]).toMatchObject({ key: `issuer:bap:${identity.bapId}`, label: 'Studio', issuerAttested: true })
    expect(shelves[0]!.tokens.map((t) => t.outpoint)).toEqual([tip])
  })

  it('keeps a self-minted token attested after its mint ages out of the BEEF cache', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const minted = await mint(h, [tokenOutput(walletLock(h))])
    const vout = minted.tx.outputs.findIndex((o) => decodeTokenOutput(o.lockingScript)?.role === 'deploy')
    const tokenId = `${minted.done.txid}_${vout}`
    const issuer = signingKey(h)
    expect(tokenIssuerAttested({ outpoint: tokenId, tokenId, issuer })).toBe(true)

    state.retained.clear()
    resetIssuerAttributionForTests()
    expect(tokenIssuerAttested({ outpoint: tokenId, tokenId, issuer })).toBe(false)
    expect(await proveHeldTokenTip(h.active, tokenId, tokenId)).toEqual({ kind: 'refused', reason: 'no-genesis' })

    state.toolbox.set(minted.done.txid, minted.beef)
    expect(await proveHeldTokenTip(h.active, tokenId, tokenId)).toEqual({ kind: 'bound', source: 'verdict' })
    state.toolbox.clear()
    resetIssuerAttributionForTests()
    expect(tokenIssuerAttested({ outpoint: tokenId, tokenId, issuer })).toBe(true)
    expect(retainedIssuerMetadata(tokenId)?.bapId).toBe(identity.bapId)
    const otherScript = tokenOutput(walletLock(h)).lockingScript
    expect(tokenIssuerAttested({ outpoint: tokenId, tokenId, issuer, lockingScript: otherScript })).toBe(false)
  })

  it('binds a tip filed before lineage was recorded from local bytes alone', async () => {
    const h = await fundedWallet()
    await publish(h)
    const { tokenId, tip, transferTxid, senderBeef } = await mintAndTransferToken(h)
    forgetSenderDevice()
    expect(await proveHeldTokenTip(h.active, tip, tokenId)).toEqual({ kind: 'refused', reason: 'no-tip-body' })
    expect(await proveHeldTokenTip(h.active, tip, tokenId)).toEqual({ kind: 'refused', reason: 'retry-later' })
    resetTokenLineageForTests()
    state.retained.set(transferTxid, senderBeef)
    expect(await proveHeldTokenTip(h.active, tip, tokenId)).toEqual({ kind: 'bound', source: 'local' })
    state.retained.clear()
    resetIssuerAttributionForTests()
    expect(tokenIssuerAttested({ outpoint: tip, tokenId, issuer: signingKey(h) })).toBe(true)
  })

  it('binds a tip received before lineage existed from bodies fetched by txid, then names its issuer and BAP ID', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const { tokenId, tip, transferTxid, senderBeef, subject } = await mintAndTransferToken(h)
    forgetSenderDevice()
    state.retained.set(transferTxid, subject)
    const tips = [tip]
    expect(tokenAttestationGap({ tokenId, tipOutpoints: tips })).toBe('no-genesis')

    for (const entry of senderBeef.txs) {
      if (!entry.tx || entry.txid === transferTxid) continue
      const body = new Beef()
      body.mergeRawTx(entry.tx.toBinary())
      state.provider.set(entry.txid, body)
    }
    expect(await proveHeldTokenTip(h.active, tip, tokenId)).toEqual({ kind: 'bound', source: 'fetched' })
    state.retained.clear()
    state.provider.clear()
    resetIssuerAttributionForTests()

    expect(tokenAttestationGap({ tokenId, tipOutpoints: tips })).toBe('attested')
    expect(retainedIssuerMetadata(tokenId)).toMatchObject({ issuer: signingKey(h), bapId: identity.bapId })
    expect(tokenIssuerAttested({ outpoint: tip, tokenId, issuer: signingKey(h) })).toBe(true)
    expect(tokenAttestationGap({ tokenId, tipOutpoints: [`${'33'.repeat(32)}_0`] })).toBe('unbound')
  })
})

describe('token attestation gap names the step a held deploy lacks', () => {
  const claimed = PrivateKey.fromRandom().toPublicKey().toString()
  const fundTxid = '22'.repeat(32)
  const deployScript = () => tokenOutput(new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()).lockingScript

  function retainDeploy(lockingScript: string): string {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(lockingScript) })
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    state.retained.set(tx.id('hex'), beef)
    return `${tx.id('hex')}_0`
  }

  it('a deploy with neither issuer tape nor Sigma stands on a remittance claim only', () => {
    const tokenId = retainDeploy(deployScript())
    expect(tokenAttestationGap({ tokenId, issuer: claimed, tipOutpoints: [tokenId] })).toBe('remittance-only')
    expect(tokenAttestationGap({ tokenId, tipOutpoints: [tokenId] })).toBe('unsigned-mint')
  })

  it('a deploy whose tape names an issuer it carries no Sigma for is unsigned', () => {
    const tokenId = retainDeploy(appendIssuerMetadata(deployScript(), claimed))
    expect(tokenAttestationGap({ tokenId, tipOutpoints: [tokenId] })).toBe('unsigned')
  })

  it('a deploy Sigma-signed by another key does not attest the claimed issuer', () => {
    const signer = PrivateKey.fromRandom()
    const tokenId = retainDeploy(
      sigmaSignDeployLockingScript({ lockingScriptHex: deployScript(), fundTxid, fundVout: 0, identityKeyHex: signer.toHex() }),
    )
    expect(tokenAttestationGap({ tokenId, issuer: claimed, tipOutpoints: [tokenId] })).toBe('unsigned')
    expect(
      tokenAttestationGap({ tokenId, issuer: signer.toPublicKey().toString(), tipOutpoints: [tokenId] }),
    ).toBe('attested')
  })
})
