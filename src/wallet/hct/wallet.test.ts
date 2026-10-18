import { Beef, LockingScript, P2PKH, PrivateKey, Random, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hctHolderPublicKey } from './keys'
import { hctHeldLock } from './script'

type Row = {
  outpoint: string
  satoshis: number
  lockingScript: string
  basket: string
  tags: string[]
  customInstructions?: string
  spendable: boolean
}

type Pending = { tx: Transaction; outputs: Array<{ basket?: string; tags?: string[]; customInstructions?: string; lockingScript: string; satoshis: number }>; inputs: string[] }

/** One install: its own toolbox rows, transactions and HCT chain store; nothing comes from a chain. */
function makeInstall() {
  const root = PrivateKey.fromRandom()
  const identityKey = root.toPublicKey().toString()
  const address = root.toAddress()
  const txs = new Map<string, Transaction>()
  const rows: Row[] = []
  const pending = new Map<string, Pending>()
  let funded = 0

  const fundingTx = () => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: Utils.toHex(Random(32)), sourceOutputIndex: funded++, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    tx.addOutput({ satoshis: 100_000, lockingScript: new P2PKH().lock(address) })
    txs.set(String(tx.id('hex')), tx)
    return tx
  }

  const fileOutputs = (tx: Transaction, outputs: Pending['outputs']) => {
    const txid = String(tx.id('hex'))
    txs.set(txid, tx)
    outputs.forEach((out, vout) => {
      if (!out.basket) return
      rows.push({ outpoint: `${txid}.${vout}`, satoshis: out.satoshis, lockingScript: out.lockingScript, basket: out.basket, tags: out.tags ?? [], customInstructions: out.customInstructions, spendable: true })
    })
  }

  const wallet = {
    async createAction(args: { inputs?: Array<{ outpoint: string }>; outputs: Pending['outputs'] }) {
      const tx = new Transaction()
      const inputs = (args.inputs ?? []).map((i) => i.outpoint)
      for (const outpoint of inputs) {
        const row = rows.find((r) => r.outpoint === outpoint && r.spendable)
        if (!row) throw new Error(`unknown input ${outpoint}`)
        const [txid, vout] = outpoint.split('.')
        tx.addInput({ sourceTransaction: txs.get(txid!)!, sourceOutputIndex: Number(vout), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      }
      const funding = fundingTx()
      tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), unlockingScriptTemplate: new P2PKH().unlock(root), sequence: 0xffffffff })
      for (const out of args.outputs) tx.addOutput({ satoshis: out.satoshis, lockingScript: LockingScript.fromHex(out.lockingScript) })
      const spent = args.outputs.reduce((sum, out) => sum + out.satoshis, 0)
      tx.addOutput({ satoshis: 100_000 - spent - 500, lockingScript: new P2PKH().lock(address) })
      if (inputs.length === 0) {
        await tx.sign()
        fileOutputs(tx, args.outputs)
        return { txid: String(tx.id('hex')), tx: tx.toAtomicBEEF() }
      }
      const reference = Utils.toBase64(Random(16))
      pending.set(reference, { tx, outputs: args.outputs, inputs })
      const beef = new Beef()
      beef.mergeTransaction(tx)
      return { signableTransaction: { reference, tx: beef.toBinary() } }
    },
    async signAction(args: { reference: string; spends: Record<number, { unlockingScript: string }> }) {
      const staged = pending.get(args.reference)
      if (!staged) throw new Error('unknown reference')
      pending.delete(args.reference)
      for (const [vin, spend] of Object.entries(args.spends)) staged.tx.inputs[Number(vin)]!.unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
      await staged.tx.sign()
      for (const row of rows) if (staged.inputs.includes(row.outpoint)) row.spendable = false
      fileOutputs(staged.tx, staged.outputs)
      return { txid: String(staged.tx.id('hex')), tx: staged.tx.toAtomicBEEF() }
    },
    async abortAction(args: { reference: string }) {
      pending.delete(args.reference)
      return { aborted: true }
    },
    async listOutputs(args: { basket: string }) {
      return { outputs: rows.filter((r) => r.basket === args.basket && r.spendable), totalOutputs: 0 }
    },
    async internalizeAction(args: { tx: number[]; outputs: Array<{ outputIndex: number; insertionRemittance: { basket: string; tags: string[]; customInstructions?: string } }> }) {
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
    async relinquishOutput() {
      return { relinquished: true }
    },
  }
  const chain = { txs: new Map<string, string>(), valid: new Set<string>(), deploys: new Map<string, { assetId: string; txid: string; vout: number }>() }
  return { root, identityKey, address, txs, rows, chain, active: { wallet, rootKeyHex: root.toHex(), identityKey, address, chain: 'main', txs } }
}

type Install = ReturnType<typeof makeInstall>
let current: Install
const durable = new Map<string, string>()
const registered: string[] = []
const boxes = new Map<string, Array<{ messageId: string; sender: string; plaintext: string }>>()
let nextMessage = 0

vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: current.active }) }))
vi.mock('../spendGuard', () => ({ runExclusiveSpend: (fn: () => Promise<unknown>) => fn() }))
vi.mock('../vaultAccountHolding', () => ({ activeAccountSpendRefusal: () => null }))
vi.mock('../accountLocalKeys', () => ({ accountLocalKey: (key: string) => `${current.identityKey}:${key}` }))
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
  getLocalBeefForTxid: async (active: { txs: Map<string, Transaction> }, txid: string) => {
    const tx = active.txs.get(txid)
    if (!tx) return null
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return beef
  },
  getBeefForTxidCached: async () => {
    throw new Error('offline')
  },
  rememberBeefTree: () => {},
  atomicBeefForSubject: (binary: number[] | undefined, txid: string) => {
    if (!binary?.length) return undefined
    const beef = Beef.fromBinary(binary)
    return beef.findTxid(txid)?.tx ? Array.from(beef.toBinaryAtomic(txid)) : undefined
  },
}))
vi.mock('./store', () => ({
  putHctTx: async (tx: Transaction) => void current.chain.txs.set(String(tx.id('hex')), tx.toHexEF()),
  getHctTx: async (txid: string) => {
    const ef = current.chain.txs.get(txid)
    return ef ? Transaction.fromHexEF(ef) : null
  },
  isHctValidatedSync: (txid: string, assetId: string) => current.chain.valid.has(`${txid}:${assetId}`),
  isHctValidated: async (txid: string, assetId: string) => current.chain.valid.has(`${txid}:${assetId}`),
  markHctValidated: async (txids: string[], assetId: string) => {
    for (const txid of txids) current.chain.valid.add(`${txid}:${assetId}`)
  },
  putHctDeployRecord: async (r: { assetId: string; txid: string; vout: number }) => void current.chain.deploys.set(r.assetId, r),
  getHctDeployRecord: async (assetId: string) => current.chain.deploys.get(assetId) ?? null,
}))
vi.mock('../messageTransport', () => ({
  sendSealedToPeerBox: async (rootKeyHex: string, to: string, _box: string, plaintext: string) => {
    const sender = PrivateKey.fromHex(rootKeyHex).toPublicKey().toString()
    const list = boxes.get(to) ?? []
    list.push({ messageId: `m${nextMessage++}`, sender, plaintext })
    boxes.set(to, list)
  },
  listSealedOwnBox: async (rootKeyHex: string) => [...(boxes.get(PrivateKey.fromHex(rootKeyHex).toPublicKey().toString()) ?? [])],
  acknowledgeOwnBox: async (rootKeyHex: string, _box: string, ids: string[]) => {
    const own = PrivateKey.fromHex(rootKeyHex).toPublicKey().toString()
    boxes.set(own, (boxes.get(own) ?? []).filter((m) => !ids.includes(m.messageId)))
  },
}))

const { issueHctAsset, transferHctAsset, listHctAssets, serveHctBox, HctRefusal } = await import('./wallet')
const { readHctState, writeHctState } = await import('./state')

const alice = makeInstall()
const bob = makeInstall()
const carol = makeInstall()
const mallory = makeInstall()

function as<T>(install: Install, run: () => Promise<T>): Promise<T> {
  current = install
  return run()
}

async function balanceOf(install: Install, assetId: string): Promise<string | undefined> {
  return as(install, async () => (await listHctAssets()).assets.find((a) => a.assetId === assetId)?.balance)
}

const boxOf = (install: Install) => boxes.get(install.identityKey) ?? []

describe('open HCT wallet', () => {
  beforeEach(() => {
    registered.length = 0
  })

  it('issues a token into p2pft and an item into p2pnft, issuer coin first', async () => {
    const token = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'OAK', supply: '1000', dec: 2 }))
    expect(token.basket).toBe('p2pft')
    expect(token.assetId).toMatch(/^[0-9a-f]{40}$/)
    expect(registered).toHaveLength(2)
    expect(registered[1]).toBe(token.txid)
    const deployRow = alice.rows.find((r) => r.outpoint === `${token.txid}.0`)!
    expect(deployRow.basket).toBe('p2pft')
    expect(deployRow.tags).toEqual(expect.arrayContaining(['hct', 'p2pft:deploy', 'amt:1000', 'sym:OAK', `creator:${alice.identityKey}`]))
    expect(await balanceOf(alice, token.assetId)).toBe('1000')

    const item = await as(alice, () => issueHctAsset({ kind: 'item', name: 'Lantern', content: { mediaType: 'text/plain', base64: Utils.toBase64(Utils.toArray('hi', 'utf8')) } }))
    expect(item.basket).toBe('p2pnft')
    expect(registered).toHaveLength(3)
    const listed = await as(alice, () => listHctAssets())
    expect(listed.assets.find((a) => a.assetId === item.assetId)).toMatchObject({ kind: 'item', name: 'Lantern', balance: '1' })
  })

  it('refuses bad issue arguments before anything is staged', async () => {
    const tries: Array<[Parameters<typeof issueHctAsset>[0], string]> = [
      [{ kind: 'token', supply: '5' }, 'bad-asset-args'],
      [{ kind: 'item', name: 'Two', supply: '2' }, 'bad-asset-args'],
      [{ kind: 'token', sym: 'X', supply: '0' }, 'bad-asset-args'],
      [{ kind: 'token', sym: 'X', supply: '5', mode: 'countersign' }, 'unsupported-mode'],
      [{ kind: 'token', sym: 'X', supply: '5', content: { mediaType: 'text/plain', base64: 'aGk=' } }, 'bad-asset-args'],
      [{ kind: 'item', name: 'Lost', collection: 'ab'.repeat(20) }, 'not-held'],
    ]
    for (const [args, reason] of tries) {
      const before = registered.length
      await expect(as(alice, () => issueHctAsset(args))).rejects.toMatchObject({ reason })
      expect(registered.length - before).toBeLessThanOrEqual(1)
    }
    await expect(as(alice, () => issueHctAsset({ kind: 'token', supply: '5' }))).rejects.toBeInstanceOf(HctRefusal)
  })

  it('mints a collection item by spending and returning the collection authority', async () => {
    const col = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'COL', supply: '1', auth: true }))
    const item = await as(alice, () => issueHctAsset({ kind: 'item', name: 'Member', collection: col.assetId }))
    const assets = (await as(alice, () => listHctAssets())).assets
    expect(assets.find((a) => a.assetId === item.assetId)).toMatchObject({ collection: col.assetId, balance: '1' })
    expect(assets.find((a) => a.assetId === col.assetId)).toMatchObject({ authority: true, balance: '1' })
    const memberRow = alice.rows.find((r) => r.outpoint === `${item.txid}.0`)!
    expect(memberRow.tags).toContain(`collection:${col.assetId}`)
  })

  it('sends to a peer who validates from the package alone and files into p2pft', async () => {
    const token = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'ELM', supply: '100' }))
    const sent = await as(alice, () => transferHctAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '30' }))
    expect(sent.delivered).toBe(true)
    expect(await balanceOf(alice, token.assetId)).toBe('70')
    expect(boxOf(bob)).toHaveLength(1)
    expect(bob.chain.txs.size).toBe(0)
    await as(bob, () => serveHctBox({ force: true }))
    expect(boxOf(bob)).toHaveLength(0)
    expect(await balanceOf(bob, token.assetId)).toBe('30')
    const filed = bob.rows.find((r) => r.outpoint === `${sent.txid}.0`)!
    expect(filed.basket).toBe('p2pft')
    expect(filed.tags).toEqual(expect.arrayContaining(['hct', `p2pft:${token.assetId}`, 'amt:30']))

    const back = await as(bob, () => transferHctAsset({ assetId: token.assetId, recipient: alice.identityKey, amount: '12' }))
    await as(alice, () => serveHctBox({ force: true }))
    expect(await balanceOf(alice, token.assetId)).toBe('82')
    expect(await balanceOf(bob, token.assetId)).toBe('18')
    expect(alice.rows.some((r) => r.outpoint === `${back.txid}.0` && r.basket === 'p2pft')).toBe(true)
  })

  it('moves an item whole into the recipient p2pnft', async () => {
    const item = await as(alice, () => issueHctAsset({ kind: 'item', name: 'Compass' }))
    await expect(as(alice, () => transferHctAsset({ assetId: item.assetId, recipient: bob.identityKey, amount: '2' }))).rejects.toMatchObject({ reason: 'bad-asset-args' })
    const sent = await as(alice, () => transferHctAsset({ assetId: item.assetId, recipient: bob.identityKey }))
    await as(bob, () => serveHctBox({ force: true }))
    expect(bob.rows.find((r) => r.outpoint === `${sent.txid}.0`)?.basket).toBe('p2pnft')
    expect(await balanceOf(alice, item.assetId)).toBeUndefined()
    expect(await balanceOf(bob, item.assetId)).toBe('1')
  })

  it('asks the sender for history a package left out, then files', async () => {
    const token = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'ASH', supply: '50' }))
    const first = await as(alice, () => transferHctAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '5' }))
    const state = await as(alice, async () => readHctState())
    state.frontier[carol.identityKey] = { [token.assetId]: [first.txid, token.txid] }
    await as(alice, async () => writeHctState(state))
    const second = await as(alice, () => transferHctAsset({ assetId: token.assetId, recipient: carol.identityKey, amount: '7' }))
    await as(carol, () => serveHctBox({ force: true }))
    expect(await balanceOf(carol, token.assetId)).toBeUndefined()
    expect(boxOf(carol)).toHaveLength(1)
    expect(boxOf(alice).map((m) => JSON.parse(m.plaintext).t)).toContain('need')
    await as(alice, () => serveHctBox({ force: true }))
    await as(carol, () => serveHctBox({ force: true }))
    await as(carol, () => serveHctBox({ force: true }))
    expect(await balanceOf(carol, token.assetId)).toBe('7')
    expect(carol.rows.some((r) => r.outpoint === `${second.txid}.0`)).toBe(true)
    expect(boxOf(carol)).toHaveLength(0)
  })

  it('refuses a conjured output, a forged sender and a deploy credit, and acknowledges them', async () => {
    const token = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'FIR', supply: '10' }))
    const sent = await as(alice, () => transferHctAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '1' }))
    const genuine = JSON.parse(boxOf(bob).at(-1)!.plaintext)
    boxes.set(bob.identityKey, [])

    // Mallory writes 1,000,000 units for Bob out of thin air.
    const prefix = 'p'
    const suffix = 's'
    const holder = hctHolderPublicKey(mallory.root, bob.identityKey, prefix, suffix)
    const forged = new Transaction()
    const funding = new Transaction()
    funding.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    funding.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(mallory.address) })
    forged.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(mallory.root), sequence: 0xffffffff })
    forged.addOutput({ satoshis: 1, lockingScript: hctHeldLock({ assetId: token.assetId, amount: 1_000_000n, clause: { mode: 'open', holder } }) })
    await forged.sign()
    const conjured = {
      v: 1,
      t: 'transfer',
      asset: token.assetId,
      deploy: genuine.deploy,
      senderIdentityKey: mallory.identityKey,
      outputs: [{ vout: 0, derivationPrefix: prefix, derivationSuffix: suffix }],
      proof: { v: 1, subject: String(forged.id('hex')), txs: [forged.toHexEF()], deploys: genuine.proof.deploys },
    }
    const push = (sender: string, wire: object) =>
      boxes.set(bob.identityKey, [...boxOf(bob), { messageId: `m${nextMessage++}`, sender, plaintext: JSON.stringify(wire) }])
    push(mallory.identityKey, conjured)
    // Mallory replays Alice's genuine package under her own box identity.
    push(mallory.identityKey, genuine)
    // A deploy is never credited by a transfer.
    push(alice.identityKey, { ...genuine, proof: { ...genuine.proof, subject: token.txid, txs: genuine.proof.deploys } })
    await as(bob, () => serveHctBox({ force: true }))
    expect(boxOf(bob)).toHaveLength(0)
    expect(await balanceOf(bob, token.assetId)).toBeUndefined()
    expect(bob.rows.some((r) => r.outpoint.startsWith(String(forged.id('hex'))))).toBe(false)
    expect(bob.rows.some((r) => r.outpoint === `${sent.txid}.0`)).toBe(false)
  })

  it('never lists or spends a row whose (txid, asset) this device did not validate', async () => {
    const token = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'YEW', supply: '9' }))
    const deployRow = alice.rows.find((r) => r.outpoint === `${token.txid}.0`)!
    alice.chain.valid.delete(`${token.txid}:${token.assetId}`)
    expect(await balanceOf(alice, token.assetId)).toBeUndefined()
    await expect(as(alice, () => transferHctAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '1' }))).rejects.toMatchObject({ reason: 'insufficient' })
    alice.chain.valid.add(`${token.txid}:${token.assetId}`)
    deployRow.customInstructions = JSON.stringify({ derivationPrefix: 'x', derivationSuffix: 'y', senderIdentityKey: alice.identityKey })
    expect(await balanceOf(alice, token.assetId)).toBeUndefined()
  })

  it('queues a delivery the box refuses and retries it from the outbox', async () => {
    const token = await as(alice, () => issueHctAsset({ kind: 'token', sym: 'BOX', supply: '4' }))
    const transport = await import('../messageTransport')
    const send = vi.spyOn(transport, 'sendSealedToPeerBox').mockRejectedValueOnce(new Error('box down'))
    const sent = await as(alice, () => transferHctAsset({ assetId: token.assetId, recipient: carol.identityKey, amount: '4' }))
    expect(sent.delivered).toBe(false)
    const queued = await as(alice, async () => Object.values(readHctState().outbox))
    expect(queued).toHaveLength(1)
    const state = await as(alice, async () => readHctState())
    for (const entry of Object.values(state.outbox)) entry.nextAt = 0
    await as(alice, async () => writeHctState(state))
    await as(alice, () => serveHctBox({ force: true }))
    expect(await as(alice, async () => Object.keys(readHctState().outbox))).toHaveLength(0)
    await as(carol, () => serveHctBox({ force: true }))
    expect(await balanceOf(carol, token.assetId)).toBe('4')
    send.mockRestore()
  })
})
