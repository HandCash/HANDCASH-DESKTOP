import { Beef, LockingScript, P2PKH, PrivateKey, ProtoWallet, Random, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bntHolderPublicKey } from './keys'
import { bntHeldLock, readBnt } from './script'
import ltcDeposit from '../ltc/fixtures/deposit.json'
import { setLtcAnchorForTest } from '../ltc/headers'
import { fromHex, ltcTxid, parseLtcTx, reversed, serializeLtcTxNoWitness, toHex } from '../ltc/litecoin'

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

/** Every install's transactions: the spend probe reads them as the chain. */
const installTxs: Array<Map<string, Transaction>> = []

/** One install: its own toolbox rows, transactions and BNT chain store; nothing comes from a chain. */
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

  const keys = new ProtoWallet(root)
  const wallet = {
    getPublicKey: (args: Parameters<ProtoWallet['getPublicKey']>[0]) => keys.getPublicKey(args),
    createSignature: (args: Parameters<ProtoWallet['createSignature']>[0]) => keys.createSignature(args),
    async createAction(args: { inputs?: Array<{ outpoint: string }>; outputs: Pending['outputs']; inputBEEF?: number[] }) {
      const tx = new Transaction()
      const inputs = (args.inputs ?? []).map((i) => i.outpoint)
      const supplied = args.inputBEEF ? Beef.fromBinary(args.inputBEEF) : new Beef()
      for (const outpoint of inputs) {
        const row = rows.find((r) => r.outpoint === outpoint)
        const [txid, vout] = outpoint.split('.')
        // An output this wallet never filed (an open mint) is spendable from inputBEEF alone.
        if (row ? !row.spendable : !supplied.findTxid(txid!)?.tx) throw new Error(`unknown input ${outpoint}`)
        // The engine builds the signable transaction from inputBEEF alone for inputs it does not sign.
        const source = supplied.findTxid(txid!)?.tx
        if (!source) throw new Error('Every signableTransaction input must have a sourceTransaction')
        tx.addInput({ sourceTransaction: source, sourceOutputIndex: Number(vout), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
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
  const chain = {
    txs: new Map<string, string>(),
    valid: new Set<string>(),
    deploys: new Map<string, { assetId: string; txid: string; vout: number }>(),
    backing: new Map<string, unknown>(),
    deposits: new Map<string, string>(),
  }
  installTxs.push(txs)
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
vi.mock('../createActionInputFate', () => ({
  probeOutpointSpends: async (outpoints: string[]) => {
    const answers = new Map<string, { kind: 'spent'; spender: string } | { kind: 'unspent' }>()
    for (const outpoint of outpoints) {
      const [txid, vout] = outpoint.split('.')
      let spender: string | null = null
      for (const txs of installTxs) {
        for (const [id, tx] of txs) {
          if (tx.inputs.some((i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === Number(vout))) spender = id
        }
      }
      answers.set(outpoint, spender ? { kind: 'spent', spender } : { kind: 'unspent' })
    }
    return answers
  },
}))
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
  putBntTx: async (tx: Transaction) => void current.chain.txs.set(String(tx.id('hex')), tx.toHexEF()),
  getBntTx: async (txid: string) => {
    const ef = current.chain.txs.get(txid)
    return ef ? Transaction.fromHexEF(ef) : null
  },
  isBntValidatedSync: (txid: string, assetId: string) => current.chain.valid.has(`${txid}:${assetId}`),
  isBntValidated: async (txid: string, assetId: string) => current.chain.valid.has(`${txid}:${assetId}`),
  markBntValidated: async (txids: string[], assetId: string) => {
    for (const txid of txids) current.chain.valid.add(`${txid}:${assetId}`)
  },
  putBntDeployRecord: async (r: { assetId: string; txid: string; vout: number }) => void current.chain.deploys.set(r.assetId, r),
  getBntDeployRecord: async (assetId: string) => current.chain.deploys.get(assetId) ?? null,
  putBntBacking: async (txid: string, proof: unknown, deposit: string) => {
    current.chain.backing.set(txid, proof)
    current.chain.deposits.set(deposit, txid)
  },
  hasBntBackingSync: (txid: string) => current.chain.backing.has(txid),
  getBntBacking: async (txid: string) => current.chain.backing.get(txid) ?? null,
  getBntDepositIssuance: async (deposit: string) => current.chain.deposits.get(deposit) ?? null,
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

const { issueBntAsset, mintBntAsset, transferBntAsset, preflightBntTransfer, burnBntUnits, burnBntAsset, preflightBntBurn, BNT_BURN_HOLDER, listBntAssets, serveBntBox, proveBntBacking, adoptSignedBntAction, BntRefusal } = await import('./wallet')
const { readBntState, writeBntState } = await import('./state')

const alice = makeInstall()
const bob = makeInstall()
const carol = makeInstall()
const mallory = makeInstall()

function as<T>(install: Install, run: () => Promise<T>): Promise<T> {
  current = install
  return run()
}

async function balanceOf(install: Install, assetId: string): Promise<string | undefined> {
  return as(install, async () => (await listBntAssets()).assets.find((a) => a.assetId === assetId)?.balance)
}

const boxOf = (install: Install) => boxes.get(install.identityKey) ?? []

describe('open BNT wallet', () => {
  beforeEach(() => {
    registered.length = 0
    setLtcAnchorForTest({ check: async () => ({ kind: 'buried' }) })
  })

  it('issues a token into bntft and an item into bntnft, issuer coin first', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'OAK', supply: '1000', dec: 2 }))
    expect(token.basket).toBe('bntft')
    expect(token.assetId).toMatch(/^[0-9a-f]{40}$/)
    expect(registered).toHaveLength(2)
    expect(registered[1]).toBe(token.txid)
    const deployRow = alice.rows.find((r) => r.outpoint === `${token.txid}.0`)!
    expect(deployRow.basket).toBe('bntft')
    expect(deployRow.tags).toEqual(expect.arrayContaining(['bnt', 'bntft:deploy', 'amt:1000', 'sym:OAK', `creator:${alice.identityKey}`]))
    expect(await balanceOf(alice, token.assetId)).toBe('1000')

    const item = await as(alice, () => issueBntAsset({ kind: 'item', name: 'Lantern', content: { mediaType: 'text/plain', base64: Utils.toBase64(Utils.toArray('hi', 'utf8')) } }))
    expect(item.basket).toBe('bntnft')
    expect(registered).toHaveLength(3)
    const listed = await as(alice, () => listBntAssets())
    expect(listed.assets.find((a) => a.assetId === item.assetId)).toMatchObject({ kind: 'item', name: 'Lantern', balance: '1' })
  })

  it('refuses bad issue arguments before anything is staged', async () => {
    const tries: Array<[Parameters<typeof issueBntAsset>[0], string]> = [
      [{ kind: 'token', supply: '5' }, 'bad-asset-args'],
      [{ kind: 'item', name: 'Two', supply: '2' }, 'bad-asset-args'],
      [{ kind: 'token', sym: 'X', supply: '0' }, 'bad-asset-args'],
      [{ kind: 'token', sym: 'X', supply: '5', mode: 'countersign' }, 'unsupported-mode'],
      [{ kind: 'token', sym: 'X', supply: '5', content: { mediaType: 'text/plain', base64: 'aGk=' } }, 'bad-asset-args'],
      [{ kind: 'item', name: 'Lost', collection: 'ab'.repeat(20) }, 'not-held'],
    ]
    for (const [args, reason] of tries) {
      const before = registered.length
      await expect(as(alice, () => issueBntAsset(args))).rejects.toMatchObject({ reason })
      expect(registered.length - before).toBeLessThanOrEqual(1)
    }
    await expect(as(alice, () => issueBntAsset({ kind: 'token', supply: '5' }))).rejects.toBeInstanceOf(BntRefusal)
  })

  it('mints a collection item by spending and returning the collection authority', async () => {
    const col = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'COL', supply: '1', auth: true }))
    const item = await as(alice, () => issueBntAsset({ kind: 'item', name: 'Member', collection: col.assetId }))
    const assets = (await as(alice, () => listBntAssets())).assets
    expect(assets.find((a) => a.assetId === item.assetId)).toMatchObject({ collection: col.assetId, balance: '1' })
    expect(assets.find((a) => a.assetId === col.assetId)).toMatchObject({ authority: true, balance: '1' })
    const memberRow = alice.rows.find((r) => r.outpoint === `${item.txid}.0`)!
    expect(memberRow.tags).toContain(`collection:${col.assetId}`)
  })

  it('mints a capped token up to its cap and a fixed one never', async () => {
    const fixed = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'FIX', supply: '10' }))
    await expect(as(alice, () => mintBntAsset({ assetId: fixed.assetId, amount: '1' }))).rejects.toMatchObject({ reason: 'fixed-supply' })
    expect((await as(alice, () => listBntAssets())).assets.find((a) => a.assetId === fixed.assetId)?.supply).toEqual({ policy: 'fixed' })

    const cap = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'CAP', supply: '60', max: '100' }))
    const minted = await as(alice, () => mintBntAsset({ assetId: cap.assetId, amount: '30' }))
    expect(minted).toMatchObject({ amount: '30', issued: { units: '90', members: '0' } })
    await expect(as(alice, () => mintBntAsset({ assetId: cap.assetId, amount: '11' }))).rejects.toMatchObject({ reason: 'over-cap' })
    await as(alice, () => mintBntAsset({ assetId: cap.assetId, amount: '10' }))
    const listed = (await as(alice, () => listBntAssets())).assets.find((a) => a.assetId === cap.assetId)
    expect(listed).toMatchObject({ balance: '100', supply: { policy: 'capped', max: '100', issued: { units: '100', members: '0' } } })

    const dave = makeInstall()
    const sent = await as(alice, () => transferBntAsset({ assetId: cap.assetId, recipient: dave.identityKey, amount: '100' }))
    expect(sent.delivered).toBe(true)
    await as(dave, () => serveBntBox({ force: true }))
    expect(await balanceOf(dave, cap.assetId)).toBe('100')
    expect((await as(dave, () => listBntAssets())).assets.find((a) => a.assetId === cap.assetId)?.supply).toEqual({ policy: 'capped', max: '100' })
  })

  it('opens a mint anyone can use, a fixed amount at a time, until every mint is taken', async () => {
    const share = (from: Install, to: Install) => from.txs.forEach((tx, id) => to.txs.set(id, tx))
    const rune = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'RUNE', supply: '10', openMint: { count: 2, amount: '50' } }))
    expect(rune.mint).toMatch(/^[0-9a-f]{64}\.0$/)
    expect(await balanceOf(alice, rune.assetId)).toBe('10')
    await expect(as(alice, () => issueBntAsset({ kind: 'token', sym: 'BAD', supply: '1', max: '5', openMint: { count: 2, amount: '1' } }))).rejects.toMatchObject({ reason: 'bad-asset-args' })

    const dave = makeInstall()
    share(alice, dave)
    await expect(as(dave, () => mintBntAsset({ assetId: rune.assetId, deploy: `${rune.txid}_0`, tip: rune.mint, amount: '51' }))).rejects.toMatchObject({ reason: 'bad-asset-args' })
    const first = await as(dave, () => mintBntAsset({ assetId: rune.assetId, deploy: `${rune.txid}_0`, tip: rune.mint }))
    expect(first).toMatchObject({ amount: '50', remaining: 1 })
    expect(await balanceOf(dave, rune.assetId)).toBe('50')

    share(dave, alice)
    const second = await as(alice, () => mintBntAsset({ assetId: rune.assetId }))
    expect(second).toMatchObject({ amount: '50', remaining: 0 })
    expect(await balanceOf(alice, rune.assetId)).toBe('60')
    expect(alice.txs.get(second.txid)!.outputs.some((o) => readBnt(o.lockingScript)?.form === 'mint')).toBe(false)

    share(alice, dave)
    await expect(as(dave, () => mintBntAsset({ assetId: rune.assetId }))).rejects.toMatchObject({ reason: 'minted-out' })
    const erin = makeInstall()
    const sent = await as(dave, () => transferBntAsset({ assetId: rune.assetId, recipient: erin.identityKey, amount: '50' }))
    expect(sent.delivered).toBe(true)
    await as(erin, () => serveBntBox({ force: true }))
    expect(await balanceOf(erin, rune.assetId)).toBe('50')
  })

  it('burns units to a holder nobody signs for and keeps the change and authority', async () => {
    const erin = makeInstall()
    const token = await as(erin, () => issueBntAsset({ kind: 'token', sym: 'BRN', supply: '50', auth: true }))
    await as(erin, () => mintBntAsset({ assetId: token.assetId, amount: '25' }))
    const burnHolder = PrivateKey.fromRandom().toPublicKey().toString()
    const burned = await as(erin, () => burnBntUnits({ assetId: token.assetId, amount: 30n, holder: burnHolder, memo: 'wltc-redeem test' }))
    const listed = (await as(erin, () => listBntAssets())).assets.find((a) => a.assetId === token.assetId)
    expect(listed).toMatchObject({ balance: '45', authority: true })
    const tx = erin.txs.get(burned.txid)!
    const read = readBnt(tx.outputs[0]!.lockingScript)
    expect(read).toMatchObject({ form: 'held', amount: 30n, clause: { mode: 'open', holder: burnHolder } })
    expect(tx.outputs[1]!.lockingScript.toHex()).toBe(`006a10${Utils.toHex(Utils.toArray('wltc-redeem test', 'utf8'))}`)
    expect(erin.rows.some((r) => r.outpoint === `${burned.txid}.0`)).toBe(false)
    await expect(as(erin, () => burnBntUnits({ assetId: token.assetId, amount: 46n, holder: burnHolder, memo: 'x' }))).rejects.toMatchObject({ reason: 'insufficient' })
  })

  it('burns a holder\'s units and items to the NUMS key, whole items only', async () => {
    const erin = makeInstall()
    const token = await as(erin, () => issueBntAsset({ kind: 'token', sym: 'BRN', supply: '50' }))
    const burned = await as(erin, () => burnBntAsset({ assetId: token.assetId, amount: '20' }))
    expect(readBnt(erin.txs.get(burned.txid)!.outputs[0]!.lockingScript)).toMatchObject({ form: 'held', amount: 20n, clause: { mode: 'open', holder: BNT_BURN_HOLDER } })
    expect((await as(erin, () => listBntAssets())).assets.find((a) => a.assetId === token.assetId)?.balance).toBe('30')

    const item = await as(erin, () => issueBntAsset({ kind: 'item', name: 'Relic' }))
    await expect(as(erin, () => preflightBntBurn({ assetId: item.assetId, amount: '2' }))).rejects.toMatchObject({ reason: 'bad-asset-args' })
    const gone = await as(erin, () => burnBntAsset({ assetId: item.assetId }))
    expect(readBnt(erin.txs.get(gone.txid)!.outputs[0]!.lockingScript)).toMatchObject({ form: 'held', amount: 1n, clause: { holder: BNT_BURN_HOLDER } })
    expect((await as(erin, () => listBntAssets())).assets.some((a) => a.assetId === item.assetId && a.balance !== '0')).toBe(false)
    await expect(as(erin, () => burnBntAsset({ assetId: item.assetId }))).rejects.toMatchObject({ reason: 'insufficient' })
  })

  it('refuses supply caps that cannot hold, before anything is staged', async () => {
    for (const args of [
      { kind: 'token', sym: 'X', supply: '11', max: '10' },
      { kind: 'token', sym: 'X', supply: '1', max: '10', auth: false },
      { kind: 'item', name: 'X', size: '3' },
      { kind: 'token', sym: 'X', supply: '1', size: '0' },
    ]) {
      await expect(as(alice, () => issueBntAsset(args))).rejects.toMatchObject({ reason: 'bad-asset-args' })
    }
  })

  it('stops a capped collection at its size', async () => {
    const col = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'ED', supply: '1', size: '2' }))
    await as(alice, () => issueBntAsset({ kind: 'item', name: 'One', collection: col.assetId }))
    await as(alice, () => issueBntAsset({ kind: 'item', name: 'Two', collection: col.assetId }))
    await expect(as(alice, () => issueBntAsset({ kind: 'item', name: 'Three', collection: col.assetId }))).rejects.toMatchObject({ reason: 'over-cap' })
    expect((await as(alice, () => listBntAssets())).assets.find((a) => a.assetId === col.assetId)?.supply).toEqual({
      policy: 'capped',
      size: '2',
      issued: { units: '1', members: '2' },
    })
  })

  it('sends to a peer who validates from the package alone and files into bntft', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'ELM', supply: '100' }))
    const sent = await as(alice, () => transferBntAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '30' }))
    expect(sent.delivered).toBe(true)
    expect(await balanceOf(alice, token.assetId)).toBe('70')
    expect(boxOf(bob)).toHaveLength(1)
    expect(bob.chain.txs.size).toBe(0)
    await as(bob, () => serveBntBox({ force: true }))
    expect(boxOf(bob)).toHaveLength(0)
    expect(await balanceOf(bob, token.assetId)).toBe('30')
    const filed = bob.rows.find((r) => r.outpoint === `${sent.txid}.0`)!
    expect(filed.basket).toBe('bntft')
    expect(filed.tags).toEqual(expect.arrayContaining(['bnt', `bntft:${token.assetId}`, 'amt:30']))

    const back = await as(bob, () => transferBntAsset({ assetId: token.assetId, recipient: alice.identityKey, amount: '12' }))
    await as(alice, () => serveBntBox({ force: true }))
    expect(await balanceOf(alice, token.assetId)).toBe('82')
    expect(await balanceOf(bob, token.assetId)).toBe('18')
    expect(alice.rows.some((r) => r.outpoint === `${back.txid}.0` && r.basket === 'bntft')).toBe(true)
  })

  it('moves an item whole into the recipient bntnft', async () => {
    const item = await as(alice, () => issueBntAsset({ kind: 'item', name: 'Compass' }))
    await expect(as(alice, () => transferBntAsset({ assetId: item.assetId, recipient: bob.identityKey, amount: '2' }))).rejects.toMatchObject({ reason: 'bad-asset-args' })
    const sent = await as(alice, () => transferBntAsset({ assetId: item.assetId, recipient: bob.identityKey }))
    await as(bob, () => serveBntBox({ force: true }))
    expect(bob.rows.find((r) => r.outpoint === `${sent.txid}.0`)?.basket).toBe('bntnft')
    expect(await balanceOf(alice, item.assetId)).toBeUndefined()
    expect(await balanceOf(bob, item.assetId)).toBe('1')
  })

  it('asks the sender for history a package left out, then files', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'ASH', supply: '50' }))
    const first = await as(alice, () => transferBntAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '5' }))
    const state = await as(alice, async () => readBntState())
    state.frontier[carol.identityKey] = { [token.assetId]: [first.txid, token.txid] }
    await as(alice, async () => writeBntState(state))
    const second = await as(alice, () => transferBntAsset({ assetId: token.assetId, recipient: carol.identityKey, amount: '7' }))
    await as(carol, () => serveBntBox({ force: true }))
    expect(await balanceOf(carol, token.assetId)).toBeUndefined()
    expect(boxOf(carol)).toHaveLength(1)
    expect(boxOf(alice).map((m) => JSON.parse(m.plaintext).t)).toContain('need')
    await as(alice, () => serveBntBox({ force: true }))
    await as(carol, () => serveBntBox({ force: true }))
    await as(carol, () => serveBntBox({ force: true }))
    expect(await balanceOf(carol, token.assetId)).toBe('7')
    expect(carol.rows.some((r) => r.outpoint === `${second.txid}.0`)).toBe(true)
    expect(boxOf(carol)).toHaveLength(0)
  })

  it('refuses a conjured output, a forged sender and a deploy credit, and acknowledges them', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'FIR', supply: '10' }))
    const sent = await as(alice, () => transferBntAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '1' }))
    const genuine = JSON.parse(boxOf(bob).at(-1)!.plaintext)
    boxes.set(bob.identityKey, [])

    // Mallory writes 1,000,000 units for Bob out of thin air.
    const prefix = 'p'
    const suffix = 's'
    const holder = bntHolderPublicKey(mallory.root, bob.identityKey, prefix, suffix)
    const forged = new Transaction()
    const funding = new Transaction()
    funding.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    funding.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(mallory.address) })
    forged.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(mallory.root), sequence: 0xffffffff })
    forged.addOutput({ satoshis: 1, lockingScript: bntHeldLock({ assetId: token.assetId, amount: 1_000_000n, clause: { mode: 'open', holder } }) })
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
    await as(bob, () => serveBntBox({ force: true }))
    expect(boxOf(bob)).toHaveLength(0)
    expect(await balanceOf(bob, token.assetId)).toBeUndefined()
    expect(bob.rows.some((r) => r.outpoint.startsWith(String(forged.id('hex'))))).toBe(false)
    expect(bob.rows.some((r) => r.outpoint === `${sent.txid}.0`)).toBe(false)
  })

  it('never lists or spends a row whose (txid, asset) this device did not validate', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'YEW', supply: '9' }))
    const deployRow = alice.rows.find((r) => r.outpoint === `${token.txid}.0`)!
    alice.chain.valid.delete(`${token.txid}:${token.assetId}`)
    expect(await balanceOf(alice, token.assetId)).toBeUndefined()
    await expect(as(alice, () => transferBntAsset({ assetId: token.assetId, recipient: bob.identityKey, amount: '1' }))).rejects.toMatchObject({ reason: 'insufficient' })
    alice.chain.valid.add(`${token.txid}:${token.assetId}`)
    deployRow.customInstructions = JSON.stringify({ derivationPrefix: 'x', derivationSuffix: 'y', senderIdentityKey: alice.identityKey })
    expect(await balanceOf(alice, token.assetId)).toBeUndefined()
  })

  it('adopts a deploy and a mint signed but never committed, and lists them again', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'ASH', supply: '5', auth: true }))
    const minted = await as(alice, () => mintBntAsset({ assetId: token.assetId, amount: '3' }))
    for (const txid of [token.txid, minted.txid]) {
      alice.chain.txs.delete(txid)
      alice.chain.valid.delete(`${txid}:${token.assetId}`)
    }
    alice.chain.deploys.delete(token.assetId)
    expect(await balanceOf(alice, token.assetId)).toBeUndefined()
    registered.length = 0
    await as(alice, () => adoptSignedBntAction(token.txid))
    await as(alice, () => adoptSignedBntAction(minted.txid))
    expect(registered).toEqual([token.txid, minted.txid])
    expect(await balanceOf(alice, token.assetId)).toBe('8')
    await as(alice, () => adoptSignedBntAction(minted.txid))
    expect(registered).toHaveLength(2)
  })

  it('queues a delivery the box refuses and retries it from the outbox', async () => {
    const token = await as(alice, () => issueBntAsset({ kind: 'token', sym: 'BOX', supply: '4' }))
    const transport = await import('../messageTransport')
    const send = vi.spyOn(transport, 'sendSealedToPeerBox').mockRejectedValueOnce(new Error('box down'))
    const sent = await as(alice, () => transferBntAsset({ assetId: token.assetId, recipient: carol.identityKey, amount: '4' }))
    expect(sent.delivered).toBe(false)
    const queued = await as(alice, async () => Object.values(readBntState().outbox))
    expect(queued).toHaveLength(1)
    const state = await as(alice, async () => readBntState())
    for (const entry of Object.values(state.outbox)) entry.nextAt = 0
    await as(alice, async () => writeBntState(state))
    await as(alice, () => serveBntBox({ force: true }))
    expect(await as(alice, async () => Object.keys(readBntState().outbox))).toHaveLength(0)
    await as(carol, () => serveBntBox({ force: true }))
    expect(await balanceOf(carol, token.assetId)).toBe('4')
    send.mockRestore()
  })

  it('credits backed units at once and moves them only once their deposit is proven', async () => {
    const reserve = toHex(parseLtcTx(fromHex(ltcDeposit.hex)).outputs[ltcDeposit.vout]!.script)
    const deposit = { txid: ltcDeposit.txid, vout: ltcDeposit.vout }
    const proof = { tx: ltcDeposit.hex, path: ltcDeposit.proof.merkle, pos: ltcDeposit.proof.pos, height: ltcDeposit.height, header: ltcDeposit.headers[0]! }
    const secondTx = parseLtcTx(fromHex(ltcDeposit.hex))
    secondTx.outputs[1] = { ...secondTx.outputs[0]!, value: 1n }
    const second = { txid: ltcTxid(secondTx), vout: 0 }
    const soleTxHeader = fromHex(ltcDeposit.headers[0]!)
    soleTxHeader.set(reversed(fromHex(second.txid)), 36)
    const secondProof = { tx: toHex(serializeLtcTxNoWitness(secondTx)), path: [], pos: 0, height: ltcDeposit.height + 1, header: toHex(soleTxHeader) }
    const frank = makeInstall()
    const gina = makeInstall()
    const token = await as(frank, () =>
      issueBntAsset({ kind: 'token', sym: 'wLTC', supply: '1000', dec: 8, auth: true }, { backing: { deposit, bk: { chain: 'ltc', reserve } } }),
    )
    const listed = async () => (await as(frank, () => listBntAssets())).assets.find((a) => a.assetId === token.assetId)
    expect(await listed()).toMatchObject({ balance: '1000', locked: '1000', backedBy: 'ltc' })
    await expect(as(frank, () => transferBntAsset({ assetId: token.assetId, recipient: frank.identityKey, amount: '10' }))).rejects.toMatchObject({ reason: 'insufficient' })
    await expect(as(frank, () => mintBntAsset({ assetId: token.assetId, amount: '5' }, { backing: { deposit } }))).rejects.toMatchObject({ reason: 'awaiting-backing' })
    await expect(as(frank, () => mintBntAsset({ assetId: token.assetId, amount: '5' }))).rejects.toMatchObject({ reason: 'bad-asset-args' })

    setLtcAnchorForTest({ check: async () => ({ kind: 'shallow', confirmations: 5 }) })
    await expect(as(frank, () => proveBntBacking(token.assetId, token.txid, proof))).rejects.toThrow(/shallow/)
    setLtcAnchorForTest({ check: async () => ({ kind: 'buried' }) })
    await as(frank, () => proveBntBacking(token.assetId, token.txid, proof))
    expect((await listed())?.locked).toBeUndefined()

    await expect(as(frank, () => mintBntAsset({ assetId: token.assetId, amount: '500' }, { backing: { deposit } }))).rejects.toMatchObject({ reason: 'bad-asset-args' })
    const minted = await as(frank, () => mintBntAsset({ assetId: token.assetId, amount: '500' }, { backing: { deposit: second } }))
    expect(await listed()).toMatchObject({ balance: '1500', locked: '500' })
    await expect(as(frank, () => transferBntAsset({ assetId: token.assetId, recipient: frank.identityKey, amount: '1001' }))).rejects.toMatchObject({ reason: 'insufficient' })

    await expect(as(frank, () => proveBntBacking(token.assetId, minted.txid, proof))).rejects.toThrow(/does not check/)
    await as(frank, () => proveBntBacking(token.assetId, minted.txid, secondProof))
    expect((await listed())?.locked).toBeUndefined()
    await as(frank, () => transferBntAsset({ assetId: token.assetId, recipient: frank.identityKey, amount: '1100' }))
    expect(await balanceOf(frank, token.assetId)).toBe('1500')
  })

  it('never lets a backed token leave its issuer: anyone else would hold a claim only the issuer can pay', async () => {
    const reserve = toHex(parseLtcTx(fromHex(ltcDeposit.hex)).outputs[ltcDeposit.vout]!.script)
    const deposit = { txid: ltcDeposit.txid, vout: ltcDeposit.vout }
    const proof = { tx: ltcDeposit.hex, path: ltcDeposit.proof.merkle, pos: ltcDeposit.proof.pos, height: ltcDeposit.height, header: ltcDeposit.headers[0]! }
    const frank = makeInstall()
    const gina = makeInstall()
    const token = await as(frank, () =>
      issueBntAsset({ kind: 'token', sym: 'wLTC', supply: '1000', dec: 8, auth: true }, { backing: { deposit, bk: { chain: 'ltc', reserve } } }),
    )
    setLtcAnchorForTest({ check: async () => ({ kind: 'buried' }) })
    await as(frank, () => proveBntBacking(token.assetId, token.txid, proof))
    await expect(as(frank, () => preflightBntTransfer({ assetId: token.assetId, recipient: gina.identityKey, amount: '1' }))).rejects.toMatchObject({ reason: 'custodial' })
    await expect(as(frank, () => transferBntAsset({ assetId: token.assetId, recipient: gina.identityKey, amount: '1' }))).rejects.toMatchObject({ reason: 'custodial' })
    expect(await balanceOf(frank, token.assetId)).toBe('1000')
    expect(await balanceOf(gina, token.assetId)).toBeUndefined()
  })
})
