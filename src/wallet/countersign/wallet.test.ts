import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readCountersigned } from './script'
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

const { issueCountersignedAsset, transferCountersignedAsset, listCountersignedHoldings, listCountersignedAssets } =
  await import('./wallet')
const { readCountersignState, deployMap } = await import('./store')

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
