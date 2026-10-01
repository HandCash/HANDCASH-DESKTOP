import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
import type { WalletRuntime } from './walletRuntime'

const state = vi.hoisted(() => ({
  active: null as unknown,
  values: new Map<string, string>(),
  retained: new Map<string, unknown>(),
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
}))
vi.mock('./beefCache', () => ({
  rememberBeefBinary: vi.fn(),
  hydrateInputBeef: async (_active: unknown, beef: Beef) => beef.toBinary(),
  buildMergedInputBeef: vi.fn(),
  peekSessionBeef: (txid: string) => state.retained.get(txid) ?? null,
}))

import { withImmediateAppBroadcast } from './appCreateAction'
import {
  enrichIdentityIssuance,
  finishIdentityIssuance,
  releaseIdentityIssuance,
} from './identityIssuance'
import { groupCollectables } from './collectableGroups'
import type { Collectable } from './collectables'
import { resetIssuerAttributionForTests, retainedIssuerMetadata, retainedScriptIs, retainedSignedBy } from './issuerAttribution'
import { appendIssuerMetadata, issuerMetadataFromScript } from './issuerMetadata'
import { importIssuerPrivateKey, saveWalletPublicIdentity, selectPublicIdentity } from './publicIdentities'
import { encodeBsv21Binary } from './token/decode162'
import { verifySigmaIssuer } from './token/issuer'
import type { FungibleToken } from './token/types'

const fields = { displayName: 'Studio', icon: 'https://example.test/studio.png', description: '' }
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
  const { issuer, issuerProfile } = retainedIssuerMetadata(outpoint) ?? {}
  return {
    issuer,
    issuerProfile,
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

async function statusOf(h: Harness, txid: string): Promise<string | undefined> {
  const { actions } = await h.active.wallet.listActions({ labels: [], limit: 1000 })
  return actions.find((a) => a.txid === txid)?.status
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  state.values.clear()
  state.retained.clear()
  resetIssuerAttributionForTests()
})

describe('identity issuance against a real toolbox wallet', () => {
  it('mints an item and a token signed by the wallet issuer, and sends the anchor with them', async () => {
    const h = await fundedWallet()
    saveWalletPublicIdentity(h.runtime, fields)
    const lock = new P2PKH().lock(PrivateKey.fromHex(h.active.rootKeyHex).toAddress()).toHex()
    const request = { description: 'Issue award and token', outputs: [itemOutput(lock), tokenOutput(lock)] }

    const enriched = await enrichIdentityIssuance(h.runtime, request, h.active.identityKey)
    const anchorTxid = enriched.options!.sendWith![0]!
    expect(await statusOf(h, anchorTxid)).toBe('nosend')

    const created = await appCreateAction(h.active, enriched)
    expect((created as { signableTransaction?: unknown }).signableTransaction).toBeTruthy()
    const done = (await finishIdentityIssuance(h.runtime, enriched, created)) as { txid: string; tx: number[] }

    const beef = Beef.fromBinary(done.tx)
    const mint = beef.findTxid(done.txid)!.tx!
    expect(mint.inputs[0]!.sourceTXID).toBe(anchorTxid)
    expect(beef.findTxid(anchorTxid)?.tx).toBeTruthy()
    for (const vout of [0, 1]) {
      expect(verifySigmaIssuer(mint, vout, h.active.identityKey)).toBe(true)
      const metadata = issuerMetadataFromScript(mint.outputs[vout]!.lockingScript.toHex())
      expect(metadata.issuer).toBe(h.active.identityKey)
      expect(metadata.issuerProfile?.displayName).toBe('Studio')
    }
    expect(h.posted).toEqual([])
    await h.sendWaiting()
    expect(h.posted.flat()).toEqual(expect.arrayContaining([anchorTxid, done.txid]))
    expect(await statusOf(h, anchorTxid)).toMatch(BROADCAST)
    expect(await statusOf(h, done.txid)).toMatch(BROADCAST)
    const items = await h.active.wallet.listOutputs({ basket: '1sat' })
    expect(items.outputs.map((o) => o.outpoint)).toEqual([`${done.txid}.0`])
  })

  it('signs with an imported issuer key while the wallet funds the mint', async () => {
    const h = await fundedWallet()
    const issuer = PrivateKey.fromRandom()
    const id = importIssuerPrivateKey(h.runtime, issuer.toHex(), fields)
    selectPublicIdentity(h.runtime, id)
    const lock = new P2PKH().lock(PrivateKey.fromHex(h.active.rootKeyHex).toAddress()).toHex()

    const enriched = await enrichIdentityIssuance(h.runtime, { description: 'Issue award', outputs: [itemOutput(lock)] }, id)
    const created = await appCreateAction(h.active, enriched)
    const done = (await finishIdentityIssuance(h.runtime, enriched, created)) as { txid: string; tx: number[] }
    const mint = Beef.fromBinary(done.tx).findTxid(done.txid)!.tx!
    expect(verifySigmaIssuer(mint, 0, id)).toBe(true)
    expect(verifySigmaIssuer(mint, 0, h.active.identityKey)).toBe(false)
    expect(await spendable(h)).toBeLessThan(FUNDING)
  })

  it('returns every satoshi when the mint fails before broadcast', async () => {
    const h = await fundedWallet()
    saveWalletPublicIdentity(h.runtime, fields)
    const lock = new P2PKH().lock(PrivateKey.fromHex(h.active.rootKeyHex).toAddress()).toHex()
    expect(await spendable(h)).toBe(FUNDING)

    const enriched = await enrichIdentityIssuance(h.runtime, { description: 'Issue award', outputs: [itemOutput(lock)] }, h.active.identityKey)
    const anchorTxid = enriched.options!.sendWith![0]!
    const created = await appCreateAction(h.active, enriched)
    expect(await spendable(h)).toBeLessThan(FUNDING)

    await releaseIdentityIssuance(h.runtime, enriched, created)
    await h.sendWaiting()
    expect(h.posted).toEqual([])
    expect([undefined, 'failed']).toContain(await statusOf(h, anchorTxid))
    expect(await spendable(h)).toBe(FUNDING)
    expect((await h.active.wallet.listOutputs({ basket: '1sat' })).outputs).toEqual([])
  })

  it('shelves the minted item and token under the verified issuer, and a copied claim apart', async () => {
    const h = await fundedWallet()
    saveWalletPublicIdentity(h.runtime, fields)
    const lock = new P2PKH().lock(PrivateKey.fromHex(h.active.rootKeyHex).toAddress()).toHex()
    const request = { description: 'Issue award and token', outputs: [itemOutput(lock), tokenOutput(lock)] }
    const enriched = await enrichIdentityIssuance(h.runtime, request, h.active.identityKey)
    const created = await appCreateAction(h.active, enriched)
    const done = (await finishIdentityIssuance(h.runtime, enriched, created)) as { txid: string; tx: number[] }
    const beef = Beef.fromBinary(done.tx)
    state.retained.set(done.txid, beef)
    const mint = beef.findTxid(done.txid)!.tx!
    const itemScript = mint.outputs[0]!.lockingScript.toHex()
    const tokenScript = mint.outputs[1]!.lockingScript.toHex()
    const profile = issuerMetadataFromScript(itemScript).issuerProfile!

    const copy = new Transaction()
    copy.addInput({ sourceTXID: '22'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
    const claimScript = appendIssuerMetadata(itemOutput(lock).lockingScript, h.active.identityKey, profile)
    copy.addOutput({ satoshis: 1, lockingScript: Script.fromHex(claimScript) })
    const copyBeef = new Beef()
    copyBeef.mergeTransaction(copy)
    state.retained.set(copy.id('hex'), copyBeef)

    const shelves = groupCollectables(
      [shelfItem(`${done.txid}.0`, itemScript), shelfItem(`${copy.id('hex')}.0`, claimScript)],
      [shelfToken(`${done.txid}.1`, tokenScript)],
    ).issuers
    const verified = shelves.find((s) => s.key === `issuer:pubkey:${h.active.identityKey}`)
    const claim = shelves.find((s) => s.key === `issuer:claim:${h.active.identityKey}`)
    expect(shelves).toHaveLength(2)
    expect(verified).toMatchObject({ issuerAttested: true, label: 'Studio', icon: fields.icon })
    expect(verified?.tokens.map((t) => t.outpoint)).toEqual([`${done.txid}.1`])
    expect(verified?.items.map((i) => i.outpoint)).toEqual([`${done.txid}.0`])
    expect(claim?.issuerAttested).toBe(false)
    expect(claim?.icon).toBeUndefined()
    expect(claim?.label).not.toBe('Studio')
  })
})
