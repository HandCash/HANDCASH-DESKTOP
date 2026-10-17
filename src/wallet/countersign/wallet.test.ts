import { Beef, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pubkeyHashHex, readCountersigned } from './script'
import { holderPrivateKey } from './holderKeys'
import { resolveCountersignTransfer } from './resolve'

const durable = new Map<string, string>()
const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString()
const address = root.toAddress()

type Row = {
  outpoint: string
  satoshis: number
  lockingScript: string
  basket: string
  tags: string[]
  customInstructions?: string
  spendable: boolean
}

const txs = new Map<string, Transaction>()
const rows: Row[] = []
const registered: string[] = []

function fundingTx(sats: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: txs.size, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ satoshis: sats, lockingScript: new P2PKH().lock(address) })
  txs.set(String(tx.id('hex')), tx)
  return tx
}

const wallet = {
  async createAction(args: {
    outputs: Array<{ lockingScript: string; satoshis: number; basket?: string; tags?: string[]; customInstructions?: string }>
  }) {
    const funding = fundingTx(100_000)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(root),
      sequence: 0xffffffff,
    })
    for (const out of args.outputs) tx.addOutput({ satoshis: out.satoshis, lockingScript: LockingScript.fromHex(out.lockingScript) })
    const spent = args.outputs.reduce((sum, out) => sum + out.satoshis, 0)
    tx.addOutput({ satoshis: 100_000 - spent - 500, lockingScript: new P2PKH().lock(address) })
    await tx.sign()
    const txid = String(tx.id('hex'))
    txs.set(txid, tx)
    args.outputs.forEach((out, vout) => {
      if (!out.basket) return
      rows.push({
        outpoint: `${txid}.${vout}`,
        satoshis: out.satoshis,
        lockingScript: out.lockingScript,
        basket: out.basket,
        tags: out.tags ?? [],
        customInstructions: out.customInstructions,
        spendable: true,
      })
    })
    return { txid, tx: tx.toAtomicBEEF() }
  },
  async listOutputs(args: { basket: string }) {
    return { outputs: rows.filter((r) => r.basket === args.basket && r.spendable), totalOutputs: 0 }
  },
  async internalizeAction(args: {
    tx: number[]
    outputs: Array<{ outputIndex: number; insertionRemittance: { basket: string; tags: string[]; customInstructions?: string } }>
  }) {
    const beef = Beef.fromBinary(args.tx)
    const tx = beef.findAtomicTransaction(beef.atomicTxid!)!
    const txid = String(tx.id('hex'))
    txs.set(txid, tx)
    for (const out of args.outputs) {
      rows.push({
        outpoint: `${txid}.${out.outputIndex}`,
        satoshis: tx.outputs[out.outputIndex]!.satoshis!,
        lockingScript: tx.outputs[out.outputIndex]!.lockingScript.toHex(),
        basket: out.insertionRemittance.basket,
        tags: out.insertionRemittance.tags,
        customInstructions: out.insertionRemittance.customInstructions,
        spendable: true,
      })
    }
    return { accepted: true }
  },
  async relinquishOutput(args: { basket: string; output: string }) {
    for (const row of rows) if (row.basket === args.basket && row.outpoint === args.output) row.spendable = false
    return { relinquished: true }
  },
}

const active = { wallet, rootKeyHex: root.toHex(), identityKey, address, chain: 'main' }

vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: active }) }))
vi.mock('../spendGuard', () => ({ runExclusiveSpend: (fn: () => Promise<unknown>) => fn() }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => null }))
vi.mock('../accountLocalKeys', () => ({ accountLocalKey: (key: string) => `acct:${key}` }))
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => (durable.set(key, value), true),
}))
vi.mock('../appActivity', () => ({ recordAppActivity: () => {}, WALLET_ACTIVITY_ORIGIN: 'handcash' }))
vi.mock('../deviceSync', () => ({ scheduleHistoryBackupPush: () => {} }))
vi.mock('../peerIngestHelpers', () => ({ withRestoredInternalizeStatus: (_: string, run: () => Promise<unknown>) => run() }))
vi.mock('../signedSendLifecycle', () => ({
  registerSignedSend: async (args: { txid: string }) => (registered.push(args.txid), args),
  propagateSignedSend: async () => ({}),
  startSignedSendPropagation: () => {},
}))
vi.mock('../beefCache', () => ({
  getLocalBeefForTxid: async (_: unknown, txid: string) => {
    const tx = txs.get(txid)
    if (!tx) return null
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return beef
  },
  getBeefForTxidCached: async () => {
    throw new Error('offline')
  },
  rememberBeefTree: () => {},
  atomicBeefForSubject: (binary: number[] | undefined) => binary,
}))

type Box = { messageId: string; sender: string; plaintext: string }
const sent: Array<{ to: string; wire: { t: string } & Record<string, unknown> }> = []
const inbox: Box[] = []
/** A remote cosigner's reply to what this wallet sends it; null stays silent. */
let peer: (to: string, wire: { t: string } & Record<string, unknown>) => Promise<object | null> = async () => null

vi.mock('../messageTransport', () => ({
  MESSAGEBOX_BODY_MAX: 240_000,
  sendSealedToPeerBox: async (_root: string, to: string, _box: string, plaintext: string) => {
    const wire = JSON.parse(plaintext)
    sent.push({ to, wire })
    const reply = await peer(to, wire)
    if (reply) inbox.push({ messageId: `m${inbox.length}-${Math.random()}`, sender: to, plaintext: JSON.stringify(reply) })
  },
  listSealedOwnBox: async () => [...inbox],
  acknowledgeOwnBox: async (_root: string, _box: string, ids: string[]) => {
    for (const id of ids) {
      const at = inbox.findIndex((m) => m.messageId === id)
      if (at >= 0) inbox.splice(at, 1)
    }
  },
}))
vi.mock('./beaconSource', () => ({
  whatsOnChainBeaconSource: () => ({
    spentBy: async () => null,
    tx: async (txid: string) => txs.get(txid) ?? null,
    blockTime: async () => null,
    tipTime: async () => null,
  }),
}))

const {
  issueCountersignedAsset,
  transferCountersignedAsset,
  listCountersignedHoldings,
  listCountersignedAssets,
  retireCountersignedAsset,
  releaseCountersignedAsset,
  serveCountersignBox,
} = await import('./wallet')
const { readCountersignState, writeCountersignState, deployMap } = await import('./store')
const { COUNTERSIGN_SCOPE, inputScriptValid, readCountersigned: readOutput, requestIdOf, signInput, sourceOutputOf } =
  await import('./script')

const custodians = {
  threshold: 1,
  keys: [PrivateKey.fromRandom().toPublicKey().toString(), PrivateKey.fromRandom().toPublicKey().toString()],
}

describe('countersigned wallet flows (issuer is the local acceptor)', () => {
  beforeEach(() => {
    durable.clear()
    rows.length = 0
    registered.length = 0
  })

  it('refuses an issue that names no custodians, or custodians only the issuer can meet', async () => {
    await expect(issueCountersignedAsset({ kind: 'token', sym: 'NONE', supply: '1' })).rejects.toMatchObject({
      code: 'release-required',
    })
    await expect(
      issueCountersignedAsset({
        kind: 'token',
        sym: 'MINE',
        supply: '1',
        release: { threshold: 2, keys: [custodians.keys[0]!, identityKey] },
      }),
    ).rejects.toMatchObject({ code: 'release-issuer-only' })
    expect(registered).toHaveLength(0)
  })

  it('records issuer-only custody when the issuer explicitly keeps the release key', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'SELF', supply: '3', release: 'self' })
    expect(issued.releaseCustody).toBe('issuer-only')
    expect(issued.release.threshold).toBe(1)
  })

  it('issues a token, then transfers part of it with the issuer countersignature', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'GOLD', supply: '100', release: custodians })
    expect(issued.kind).toBe('token')
    expect(issued.releaseCustody).toBe('independent')
    expect(issued.acceptor).toBe(identityKey)
    const recipient = PrivateKey.fromRandom().toPublicKey().toString()

    const sent = await transferCountersignedAsset({ assetId: issued.assetId, amount: '40', recipient })
    expect(sent.acceptedBy).toBe('local')
    const tx = txs.get(sent.txid)!
    const resolved = resolveCountersignTransfer(tx, deployMap(readCountersignState()))
    expect(resolved.ok).toBe(true)
    expect(readCountersigned(tx.outputs[0]!.lockingScript.toHex())?.amount).toBe(40n)

    const held = await listCountersignedHoldings(active as never, issued.assetId)
    expect(held.map((h) => h.amount)).toEqual([60n])
    expect(registered).toContain(sent.txid)

    const acceptor = readCountersignState().acceptor[issued.assetId]!
    expect(acceptor.spent[issued.assetId]).toBe(sent.requestId)
    expect(acceptor.accepted).toContain(`${sent.txid}_1`)
    const { assets } = await listCountersignedAssets()
    expect(assets).toEqual([expect.objectContaining({ assetId: issued.assetId, held: '60', issuer: true })])
  })

  it('holds under p color children and delivers the remittance the recipient derives from', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'OAK', supply: '10', release: custodians })
    const deployLock = readCountersigned(rows.find((r) => r.outpoint === issued.assetId.replace('_', '.'))!.lockingScript)!
    expect(deployLock.holderPkhHex).not.toBe(pubkeyHashHex(identityKey))
    const recipientKey = PrivateKey.fromRandom()
    const recipient = recipientKey.toPublicKey().toString()
    sent.length = 0

    const transfer = await transferCountersignedAsset({ assetId: issued.assetId, amount: '4', recipient })
    const tx = txs.get(transfer.txid)!
    const payee = readCountersigned(tx.outputs[0]!.lockingScript.toHex())!
    const change = readCountersigned(tx.outputs[1]!.lockingScript.toHex())!
    expect(payee.holderPkhHex).not.toBe(pubkeyHashHex(recipient))
    expect(change.holderPkhHex).not.toBe(pubkeyHashHex(identityKey))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const delivery = sent.find((s) => s.to === recipient && s.wire.t === 'transfer')!.wire as {
      senderIdentityKey: string
      outputs: Array<{ vout: number; derivationPrefix: string; derivationSuffix: string }>
    }
    expect(delivery.senderIdentityKey).toBe(identityKey)
    expect(delivery.outputs.map((o) => o.vout)).toEqual([0])
    const derived = holderPrivateKey(recipientKey, issued.assetId, { ...delivery.outputs[0]!, senderIdentityKey: identityKey })
    expect(pubkeyHashHex(derived.toPublicKey().toString())).toBe(payee.holderPkhHex)

    const held = await listCountersignedHoldings(active as never, issued.assetId)
    expect(held.map((h) => [h.outpoint, h.amount])).toEqual([[`${transfer.txid}.1`, 6n]])
    const again = await transferCountersignedAsset({ assetId: issued.assetId, amount: '6', recipient })
    expect(again.acceptedBy).toBe('local')
  })

  it('issues an item and moves it to the issuer again under acceptance', async () => {
    const issued = await issueCountersignedAsset({
      kind: 'item',
      name: 'Deed #1',
      release: custodians,
      content: { mediaType: 'text/plain', base64: btoa('deed') },
    })
    expect(issued.supply).toBe('1')
    const sent = await transferCountersignedAsset({ assetId: issued.assetId, recipient: identityKey })
    expect(sent.amount).toBe('1')
    const held = await listCountersignedHoldings(active as never, issued.assetId)
    expect(held).toHaveLength(1)
    expect(held[0]!.outpoint).toBe(`${sent.txid}.0`)
  })

  it('refuses to send more than is held, before anything is signed', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'TIN', supply: '5', release: custodians })
    const before = registered.length
    await expect(
      transferCountersignedAsset({ assetId: issued.assetId, amount: '6', recipient: identityKey }),
    ).rejects.toMatchObject({ code: 'insufficient' })
    expect(registered.length).toBe(before)
  })
})

describe('countersigned wallet flows (2 of 3 cosigners)', () => {
  const keyB = PrivateKey.fromRandom()
  const keyC = PrivateKey.fromRandom()
  const cosigners = { threshold: 2, keys: [identityKey, keyB.toPublicKey().toString(), keyC.toPublicKey().toString()] }
  const keyOf = (pub: string) => [keyB, keyC].find((k) => k.toPublicKey().toString() === pub)!

  const cosign = (to: string, wire: Record<string, unknown>) => {
    const ef = Utils.toArray(String(wire.ef), 'base64')
    const tx = Transaction.fromEF(ef)
    const assetVins = tx.inputs.flatMap((_, vin) => (readOutput(sourceOutputOf(tx, vin)!.lockingScript) ? [vin] : []))
    return {
      v: 1,
      t: 'cosigned',
      token: wire.token,
      request: requestIdOf(ef),
      signatures: assetVins.map((vin) => Utils.toHex(signInput(tx, vin, keyOf(to), COUNTERSIGN_SCOPE))),
    }
  }
  const refuseAs = async (to: string, wire: Record<string, unknown>, reason: string) => {
    const request = requestIdOf(Utils.toArray(String(wire.ef), 'base64'))
    const { signature } = await new ProtoWallet(keyOf(to)).createSignature({
      data: Utils.toArray(`countersign\nv1\nrefused\n${String(wire.token)}\n${request}\n${reason}`, 'utf8'),
      protocolID: [2, 'countersign decision'],
      keyID: '1',
      counterparty: 'anyone',
    })
    return { v: 1, t: 'refused', token: wire.token, request, reason, signature: Utils.toHex(signature) }
  }

  beforeEach(() => {
    durable.clear()
    rows.length = 0
    registered.length = 0
    sent.length = 0
    inbox.length = 0
    peer = async () => null
  })

  it('refuses a split quorum or one without the issuer before anything is signed', async () => {
    await expect(
      issueCountersignedAsset({ kind: 'token', sym: 'SPLIT', supply: '1', release: custodians, cosigners: { ...cosigners, threshold: 1 } }),
    ).rejects.toMatchObject({ code: 'cosigners-split' })
    await expect(
      issueCountersignedAsset({
        kind: 'token',
        sym: 'AWAY',
        supply: '1',
        release: custodians,
        cosigners: { threshold: 2, keys: cosigners.keys.slice(1) },
      }),
    ).rejects.toMatchObject({ code: 'cosigners-without-issuer' })
    expect(registered).toHaveLength(0)
  })

  it('invites the other cosigners, then sends with its own and one other countersignature', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'QRM', supply: '10', release: custodians, cosigners })
    expect(issued.cosigners).toEqual(cosigners)
    expect(sent.filter((s) => s.wire.t === 'join').map((s) => s.to)).toEqual(cosigners.keys.slice(1))
    expect(readCountersignState().acceptor[issued.assetId]?.shared).toBe(true)

    peer = async (to, wire) => (wire.t === 'request' && to === cosigners.keys[1] ? cosign(to, wire) : null)
    const recipient = PrivateKey.fromRandom().toPublicKey().toString()
    const result = await transferCountersignedAsset({ assetId: issued.assetId, amount: '4', recipient })
    expect(result.acceptedBy).toBe('quorum')
    expect(registered).toContain(result.txid)
    const outgoing = readCountersignState().outgoing[result.requestId]!
    expect(outgoing.state).toBe('accepted')
    expect(Object.keys(outgoing.countersigs ?? {}).sort()).toEqual([identityKey, cosigners.keys[1]].sort())
    // The holder funded the request, so every cosigner signed the same transaction.
    expect(Transaction.fromEF(Utils.toArray(outgoing.efHex, 'hex')).inputs.length).toBeGreaterThan(1)
    // Change is filed only after the transfer resolves, every countersigned input script-checked.
    const held = await listCountersignedHoldings(active as never, issued.assetId)
    expect(held.map((h) => h.amount)).toEqual([6n])
  })

  it('a quorum the cosigners refuse sends nothing, frees its own reservation, and a new attempt goes through', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'NAY', supply: '3', release: custodians, cosigners })
    peer = async (to, wire) => (wire.t === 'request' ? refuseAs(to, wire, 'policy') : null)
    const recipient = PrivateKey.fromRandom().toPublicKey().toString()
    const before = registered.length
    await expect(transferCountersignedAsset({ assetId: issued.assetId, amount: '1', recipient })).rejects.toMatchObject({
      code: 'acceptor-refused',
      acceptorReason: 'policy',
    })
    // Only the fee-coin batch went out; no transfer did.
    expect(registered.slice(before).every((id) => rows.some((r) => r.outpoint.startsWith(id) && r.basket === 'countersign-fee'))).toBe(true)
    const record = readCountersignState().acceptor[issued.assetId]!
    expect(record.spent[issued.assetId]).toBeUndefined()

    peer = async (to, wire) => (wire.t === 'request' && to === cosigners.keys[2] ? cosign(to, wire) : null)
    const retry = await transferCountersignedAsset({ assetId: issued.assetId, amount: '1', recipient })
    expect(retry.acceptedBy).toBe('quorum')
    expect(readCountersignState().acceptor[issued.assetId]!.spent[issued.assetId]).toBe(retry.requestId)
  })

  it('a cosigner retiring withdraws without a transaction; it cannot release a live shared asset', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'BYE', supply: '1', release: 'self', cosigners })
    await expect(releaseCountersignedAsset({ assetId: issued.assetId })).rejects.toMatchObject({ code: 'asset-live' })
    const before = registered.length
    const ended = await retireCountersignedAsset({ assetId: issued.assetId })
    expect(ended).toEqual({ assetId: issued.assetId, txid: null, phase: 'ended' })
    expect(registered.length).toBe(before)
    expect(readCountersignState().acceptor[issued.assetId]!.ended).toBe('retired')
    const { assets } = await listCountersignedAssets()
    expect(assets[0]).toMatchObject({ cosigners, phase: 'ended' })
  })

  it('refreshes the beacon once another cosigner signs its proposal', async () => {
    const issued = await issueCountersignedAsset({ kind: 'token', sym: 'BCN', supply: '1', release: custodians, cosigners })
    const state = readCountersignState()
    state.acceptor[issued.assetId]!.beaconAt = 0
    writeCountersignState(state)
    peer = async (to, wire) => {
      if (wire.t !== 'beacon-sign' || to !== cosigners.keys[2]) return null
      const ef = Utils.toArray(String(wire.ef), 'base64')
      const tx = Transaction.fromEF(ef)
      return { v: 1, t: 'beacon-signed', token: wire.token, proposal: requestIdOf(ef), signature: Utils.toHex(signInput(tx, 0, keyC, COUNTERSIGN_SCOPE)) }
    }
    await serveCountersignBox({ force: true })
    expect(sent.filter((s) => s.wire.t === 'beacon-sign').map((s) => s.to).sort()).toEqual(cosigners.keys.slice(1).sort())
    expect(readCountersignState().acceptor[issued.assetId]!.beaconProposal).toBeDefined()
    await serveCountersignBox({ force: true })
    const record = readCountersignState().acceptor[issued.assetId]!
    expect(record.beaconProposal).toBeUndefined()
    expect(record.beacon).not.toBe(`${issued.txid}_1`)
    const refresh = Transaction.fromHex(record.beaconTxHex!)
    refresh.inputs[0]!.sourceTransaction = txs.get(issued.txid)!
    expect(refresh.inputs[0]!.unlockingScript!.chunks).toHaveLength(4)
    expect(inputScriptValid(refresh, 0)).toBe(true)
    expect(registered).toContain(record.beacon.slice(0, 64))
  })
})
