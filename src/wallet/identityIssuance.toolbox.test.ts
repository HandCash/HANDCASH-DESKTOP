import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { Beef, MerklePath, P2PKH, PrivateKey, PublicKey, Script, Transaction, Utils } from '@bsv/sdk'
import { SetupClient } from '@handcash/wallet-engine'
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
import { persistNoSendActions } from './toolboxActionBatch'
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
  displayIssuerProfile,
  importIssuerPrivateKey,
  issuanceSigner,
  saveIdentityProfile,
  selectPublicIdentity,
} from './publicIdentities'
import { identityProfileFor, resetIdentityProfilesForTests } from './identityProfiles'
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
import { sigmaSignLockingScript, verifySigmaIssuer } from './sigmaIssuer'

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
  persistNoSendActions(setup.wallet)
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

/** An item as an earlier draft of BRC-247 stamped it: BAP key `seq` signs `issuer <its key> bapId <id>`. */
function earlierBapStamp(h: Harness, seq: number, bapId: string): { outpoint: string; script: string } {
  const signer = bapKey(master(h), seq)
  const tape =
    appendIssuerMetadata(itemOutput(walletLock(h)).lockingScript, signer.toPublicKey().toString()) +
    new Script().writeBin(Utils.toArray('bapId', 'utf8')).writeBin(Utils.toArray(bapId, 'utf8')).toHex()
  const fundTxid = '44'.repeat(32)
  const script = sigmaSignLockingScript({ lockingScriptHex: tape, fundTxid, fundVout: 0, identityKeyHex: signer.toHex() })
  const tx = new Transaction()
  tx.addInput({ sourceTXID: fundTxid, sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(script) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  state.retained.set(tx.id('hex'), beef)
  return { outpoint: `${tx.id('hex')}.0`, script }
}

async function mint(h: Harness, outputs: ReturnType<typeof itemOutput>[], expected = h.active.identityKey) {
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
  resetIdentityProfilesForTests()
  vi.mocked(registerSignedSend).mockClear()
})

/** Payee's device: none of the sender's bytes, packages or verdicts. */
function forgetSenderDevice() {
  state.values.clear()
  state.retained.clear()
  resetIssuerAttributionForTests()
  resetIssuerIdentitiesForTests()
}


describe('identity issuance against a real toolbox wallet', () => {
  it('publishes a BAP profile as 0-sat records: a B:// image, the root-declared key and its profile, then the link to the identity key', async () => {
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
    expect(identity.links).toEqual([{ identityKey: h.active.identityKey, txid: txids[2] }])
    expect(txids).toEqual([identity.imageTxid, identity.alias.txid, identity.links[0]!.txid])
    expect(vi.mocked(registerSignedSend).mock.calls.every(([args]) => args.flow === 'identity_publish')).toBe(true)
    const records = await h.active.wallet.listOutputs({ basket: BAP_BASKET, includeTags: true })
    expect(records.outputs.map((o) => o.satoshis)).toEqual([0, 0, 0, 0])
    expect(records.outputs.filter((o) => o.tags?.includes('type:link'))).toHaveLength(1)
    expect((await h.active.wallet.listOutputs({ basket: 'sigma' })).outputs).toEqual([])
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
    expect(displayIssuerProfile(h.runtime, { issuer: h.active.identityKey })).toMatchObject({
      id: identity.bapId,
      source: 'bap',
      bap: { bapId: identity.bapId },
    })
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
      ['link', ['Identity link']],
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

  it('takes the reviewed plan as the approval and opens no second wallet prompt', async () => {
    const h = await fundedWallet()
    const request = profileRequest(h.active.identityKey)
    const plan = await planIdentityPublish(h.runtime, request)
    await publishIdentityPlan(h.runtime, request, plan)
    expect(approveWalletPayment).not.toHaveBeenCalled()
    expect(registerSignedSend).toHaveBeenCalled()
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

  it('signs with the identity key before any profile is published', async () => {
    const h = await fundedWallet()
    const { tx } = await mint(h, [itemOutput(walletLock(h))])
    expect(verifySigmaIssuer(tx, 0, h.active.identityKey)).toBe(true)
    expect(issuerMetadataFromScript(tx.outputs[0]!.lockingScript.toHex())).toEqual({ issuer: h.active.identityKey })
  })

  it('mints when the anchor package carries an unproven body whose parents are absent', async () => {
    const h = await fundedWallet()
    const createAction = h.active.wallet.createAction.bind(h.active.wallet)
    vi.spyOn(h.active.wallet, 'createAction').mockImplementation(async (args) => {
      const result = await createAction(args)
      if (args.description !== 'Sigma issuer anchor' || !result.tx) return result
      const beef = Beef.fromBinary(result.tx)
      for (const btx of beef.txs) {
        if (btx.tx?.merklePath) btx.tx.merklePath = undefined
      }
      beef.bumps.length = 0
      return { ...result, tx: Array.from(beef.toBinaryAtomic(result.txid!)) }
    })
    const { tx } = await mint(h, [itemOutput(walletLock(h))])
    expect(verifySigmaIssuer(tx, 0, h.active.identityKey)).toBe(true)
  })

  it('mints an item signed by the identity key, never a BAP key, and sends the anchor with it', async () => {
    const h = await fundedWallet()
    await publish(h)
    await h.sendWaiting()
    h.posted.length = 0
    const { enriched, done, beef, tx } = await mint(h, [itemOutput(walletLock(h))])
    const anchorTxid = enriched.inputs![0]!.outpoint.split('.')[0]!
    expect(tx.inputs[0]!.sourceTXID).toBe(anchorTxid)
    expect(beef.findTxid(anchorTxid)?.tx).toBeTruthy()
    expect(verifySigmaIssuer(tx, 0, h.active.identityKey)).toBe(true)
    expect(verifySigmaIssuer(tx, 0, signingKey(h))).toBe(false)
    expect(issuerMetadataFromScript(tx.outputs[0]!.lockingScript.toHex())).toEqual({ issuer: h.active.identityKey })
    expect(h.posted).toEqual([])
    await h.sendWaiting()
    expect(h.posted.flat()).toEqual(expect.arrayContaining([anchorTxid, done.txid]))
    expect(await statusOf(h, anchorTxid)).toMatch(BROADCAST)
    expect(await statusOf(h, done.txid)).toMatch(BROADCAST)
    const items = await h.active.wallet.listOutputs({ basket: '1sat' })
    expect(items.outputs.map((o) => o.outpoint)).toEqual([`${done.txid}.0`])
  })

  it('signs with an imported identity key while the wallet funds the mint', async () => {
    const h = await fundedWallet()
    const issuer = PrivateKey.fromRandom()
    const id = importIssuerPrivateKey(h.runtime, issuer.toHex())
    const identity = await publish(h, id)
    expect(identity.bapId).toBe(bapIdFor(issuer))
    expect(identity.links.map((link) => link.identityKey)).toEqual([id])
    expect((await h.active.wallet.listOutputs({ basket: BAP_BASKET })).outputs).toEqual([])
    const held = await h.active.wallet.listOutputs({ basket: IMPORTED_BAP_BASKET, includeCustomInstructions: true })
    expect(held.outputs.map((o) => [o.satoshis, o.customInstructions ?? null])).toEqual([
      [0, null],
      [0, null],
      [0, null],
      [0, null],
    ])
    selectPublicIdentity(h.runtime, id)
    const { tx } = await mint(h, [itemOutput(walletLock(h))], id)
    expect(verifySigmaIssuer(tx, 0, id)).toBe(true)
    expect(verifySigmaIssuer(tx, 0, bapKey(issuer, 1).toPublicKey().toString())).toBe(false)
    expect(verifySigmaIssuer(tx, 0, h.active.identityKey)).toBe(false)
    expect(issuerMetadataFromScript(tx.outputs[0]!.lockingScript.toHex())).toEqual({ issuer: id })
    expect(await spendable(h)).toBeLessThan(FUNDING)
  })

  it('returns every satoshi when the mint fails before broadcast', async () => {
    const h = await fundedWallet()
    await publish(h)
    await h.sendWaiting()
    h.posted.length = 0
    const before = await spendable(h)
    const enriched = await enrichIdentityIssuance(h.runtime, { description: 'Issue award', outputs: [itemOutput(walletLock(h))] }, h.active.identityKey)
    const anchorTxid = enriched.inputs![0]!.outpoint.split('.')[0]!
    const created = await appCreateAction(h.active, enriched)
    expect(await spendable(h)).toBeLessThan(FUNDING)
    await releaseIdentityIssuance(h.runtime, enriched, created)
    await h.sendWaiting()
    expect(h.posted).toEqual([])
    expect([undefined, 'failed']).toContain(await statusOf(h, anchorTxid))
    expect(await spendable(h)).toBe(before)
    expect((await h.active.wallet.listOutputs({ basket: '1sat' })).outputs).toEqual([])
  })

  it('one shelf per identity key: mints across a rotation and an earlier-draft BAP stamp sit together, a copied claim apart', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const before = await mint(h, [itemOutput(walletLock(h))])
    const earlier = earlierBapStamp(h, 1, identity.bapId)
    vi.mocked(registerSignedSend).mockClear()
    const rotated = await rotate(h)
    expect(rotated.keys.map((k) => k.seq)).toEqual([1, 2])
    expect(rotated).toMatchObject({ bapId: identity.bapId, name: 'Studio', imageTxid: identity.imageTxid })
    expect(rotated.links).toEqual(identity.links)
    expect(registerSignedSend).toHaveBeenCalledTimes(1)
    expect(issuanceSigner(h.runtime).identityKey).toBe(h.active.identityKey)
    const after = await mint(h, [itemOutput(walletLock(h))])
    expect(verifySigmaIssuer(after.tx, 0, h.active.identityKey)).toBe(true)

    const itemScript = before.tx.outputs[0]!.lockingScript.toHex()
    const laterScript = after.tx.outputs[0]!.lockingScript.toHex()
    const copy = new Transaction()
    copy.addInput({ sourceTXID: '22'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
    const claimScript = appendIssuerMetadata(itemOutput(walletLock(h)).lockingScript, h.active.identityKey)
    copy.addOutput({ satoshis: 1, lockingScript: Script.fromHex(claimScript) })
    const copyBeef = new Beef()
    copyBeef.mergeTransaction(copy)
    state.retained.set(copy.id('hex'), copyBeef)

    const shelves = groupCollectables(
      [
        shelfItem(`${before.done.txid}.0`, itemScript),
        shelfItem(`${after.done.txid}.0`, laterScript),
        shelfItem(earlier.outpoint, earlier.script),
        shelfItem(`${copy.id('hex')}.0`, claimScript),
      ],
      (asset) => displayIssuerAttribution(h.runtime, asset),
    ).issuers
    const verified = shelves.find((s) => s.key === `issuer:pubkey:${h.active.identityKey}`)
    const claim = shelves.find((s) => s.key === `issuer:claim:${h.active.identityKey}`)
    expect(shelves).toHaveLength(2)
    expect(verified).toMatchObject({
      issuerAttested: true,
      label: 'Studio',
      icon: issuerIdentityImageDataUrl(rotated.image!),
      profile: { id: identity.bapId, state: 'verified' },
    })
    expect(verified?.items.map((i) => i.outpoint).sort()).toEqual(
      [`${before.done.txid}.0`, `${after.done.txid}.0`, earlier.outpoint].sort(),
    )
    expect(claim?.issuerAttested).toBe(false)
    expect(claim?.icon).toBeUndefined()
    expect(claim?.label).not.toBe('Studio')
  })

  it('links a profile published before identity links existed, once', async () => {
    const h = await fundedWallet()
    const bapId = bapIdFor(master(h))
    await h.active.wallet.createAction({
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
          lockingScript: bapAliasScript({ bapId, profile: { '@type': 'Person', name: 'Old studio' }, signer: bapKey(master(h), 1) }),
          satoshis: 1,
          outputDescription: 'BAP ALIAS',
          basket: BAP_BASKET,
          tags: ['type:alias', `bapId:${bapId}`, 'publishedAt:1'],
        },
      ],
      options: { acceptDelayedBroadcast: true, randomizeOutputs: false },
    })
    expect(await syncHeldIssuerIdentities(h.runtime)).toBe(1)
    expect(issuerIdentityFor('main', bapId)?.links).toEqual([])
    const request: IdentityPublishRequest = { kind: 'link', identityKey: h.active.identityKey }
    const plan = await planIdentityPublish(h.runtime, request)
    expect(plan.kind).toBe('link')
    expect(plan.transactions.map((tx) => [tx.purpose, tx.outputs.map((o) => o.description)])).toEqual([
      ['link', ['Identity link']],
    ])
    vi.mocked(registerSignedSend).mockClear()
    const linked = await publishIdentityPlan(h.runtime, request, plan)
    expect(registerSignedSend).toHaveBeenCalledTimes(1)
    expect(linked).toMatchObject({ name: 'Old studio', links: [{ identityKey: h.active.identityKey }] })
    await expect(planIdentityPublish(h.runtime, request)).rejects.toMatchObject({ reason: 'already-linked' })
    await h.sendWaiting()
    expect(await statusOf(h, linked.links[0]!.txid)).toMatch(BROADCAST)
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
    expect(identity.links.map((link) => link.identityKey)).toEqual([h.active.identityKey])
    expect(vi.mocked(registerSignedSend)).toHaveBeenCalledTimes(3)
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
    expect(issuanceSigner(h.runtime).priorKeys).toEqual([signingKey(h, 1)])

    expect(await syncHeldIssuerIdentities(h.runtime, h.active.identityKey)).toBe(1)
    expect(await syncHeldIssuerIdentities(h.runtime, h.active.identityKey)).toBe(0)
    const synced = issuerIdentityFor('main', bapId)!
    expect(synced.keys.map((k) => k.txid)).toEqual([identity.keys[0]!.txid, foreign.txid])
    expect(synced).toMatchObject({ name: 'Studio', imageTxid: identity.imageTxid, links: identity.links })
    expect(issuanceSigner(h.runtime)).toMatchObject({
      identityKey: h.active.identityKey,
      priorKeys: [signingKey(h, 1), signingKey(h, 2)],
    })

    const rotated = await rotate(h)
    expect(rotated.keys.map((k) => k.seq)).toEqual([1, 2, 3])
    expect(rotated.keys[1]!.txid).toBe(foreign.txid)
    expect(issuanceSigner(h.runtime).priorKeys).toEqual([signingKey(h, 1), signingKey(h, 2), signingKey(h, 3)])
  })

  it('delivers the identity key with its linked profile once beside the item, and the receiver stores and resolves it', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const { done } = await mint(h, [itemOutput(walletLock(h))])
    const packages = identityPackagesForDelivery('main', { itemOrigin: `${done.txid}_0` })
    expect(packages).toEqual([
      { v: 2, identityKey: h.active.identityKey, bap: expect.objectContaining({ bapId: identity.bapId }) },
    ])

    state.values.clear()
    resetIssuerIdentitiesForTests()
    expect(issuerIdentityFor('main', identity.bapId)).toBeNull()
    expect(displayIssuerProfile(h.runtime, { issuer: h.active.identityKey, origin: `${done.txid}_0` })).toBeNull()
    expect(await rememberDeliveredIdentities('main', packages, null)).toBe(1)
    expect(displayIssuerProfile(h.runtime, { issuer: h.active.identityKey, origin: `${done.txid}_0` })).toMatchObject({
      id: identity.bapId,
      bap: { bapId: identity.bapId },
      name: 'Studio',
    })
  })

  it("delivers the identity key's own profile beside the item; the receiver names the issuer by key, not by BAP", async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    await saveIdentityProfile(h.runtime, h.active.identityKey, { name: 'Studio Key', description: '' }, PNG_1PX)
    const { done } = await mint(h, [itemOutput(walletLock(h))])
    const packages = identityPackagesForDelivery('main', { itemOrigin: `${done.txid}_0` })
    expect(packages).toEqual([
      expect.objectContaining({
        v: 2,
        identityKey: h.active.identityKey,
        certificates: [expect.anything()],
        bap: expect.objectContaining({ bapId: identity.bapId }),
      }),
    ])

    state.values.clear()
    resetIssuerIdentitiesForTests()
    resetIdentityProfilesForTests()
    expect(await rememberDeliveredIdentities('main', packages, null)).toBe(1)
    expect(identityProfileFor('main', h.active.identityKey)).toMatchObject({ name: 'Studio Key', image: PNG_1PX })
    expect(displayIssuerProfile(h.runtime, { issuer: h.active.identityKey, origin: `${done.txid}_0` })).toMatchObject({
      id: h.active.identityKey,
      source: 'identity-key',
      name: 'Studio Key',
      bap: { bapId: identity.bapId },
    })
  })

  it('delivers an earlier-draft BAP stamp with its profile, and the receiver shelves it under the linked identity key', async () => {
    const h = await fundedWallet()
    const identity = await publish(h)
    const earlier = earlierBapStamp(h, 1, identity.bapId)
    const packages = identityPackagesForDelivery('main', { itemOrigin: earlier.outpoint.replace('.', '_') })
    expect(packages).toEqual([expect.objectContaining({ bapId: identity.bapId })])

    state.values.clear()
    resetIssuerIdentitiesForTests()
    expect(await rememberDeliveredIdentities('main', packages, null)).toBe(1)
    const shelves = groupCollectables([shelfItem(earlier.outpoint, earlier.script)], (asset) =>
      displayIssuerAttribution(h.runtime, asset),
    ).issuers
    expect(shelves.map((s) => [s.key, s.label])).toEqual([[`issuer:pubkey:${h.active.identityKey}`, 'Studio']])
  })
})
