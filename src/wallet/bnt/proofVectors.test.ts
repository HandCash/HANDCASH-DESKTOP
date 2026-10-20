import { writeFileSync } from 'node:fs'
import { LockingScript, OP, PrivateKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { encodeDagCbor, type CborValue } from '../dagCbor'
import { signInput } from '../txInputs'
import { bntIssuerPrivateKey } from './keys'
import { decodeBntPayload, encodeBntPayload, type BntDeployFields } from './payload'
import {
  BNT_HOLDER_SCOPE,
  BNT_ISSUER_SCOPE,
  bntAssetId,
  bntAuthorityLock,
  bntDeployLock,
  bntHeldLock,
  bntOpenUnlock,
  p2pkLock,
  readBnt,
  type BntClause,
  type BntIssued,
} from './script'
import { readBntDeploy, walkBnt } from './validity'

/**
 * Vectors for the BRC-255 proof step (BNT-PROOF): transactions built and
 * judged by this wallet's own rules, which the Rust step must reproduce.
 * Set BNT_PROOF_VECTORS to a file path to write them.
 */

const seeded = (n: number) => PrivateKey.fromString((BigInt(n) + 0x1000n).toString(16).padStart(64, '0'), 'hex')
const pub = (key: PrivateKey) => key.toPublicKey().toString()
const identity = seeded(1)
const issuerKey = bntIssuerPrivateKey(identity)
const alice = seeded(2)
const bob = seeded(3)
const stranger = seeded(4)
const BURN = '0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const funding = (() => {
  const tx = new Transaction()
  for (let i = 0; i < 64; i++) tx.addOutput({ lockingScript: new Script().writeOpCode(OP.OP_TRUE) as LockingScript, satoshis: 1000 })
  return tx
})()
let fundingIndex = 0

function coinFor(key: PrivateKey): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: fundingIndex++, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: p2pkLock(pub(key)), satoshis: 500 })
  return tx
}

const open = (holder: PrivateKey | string): BntClause => ({ mode: 'open', holder: typeof holder === 'string' ? holder : pub(holder) })
const token: BntDeployFields = { mode: 'open', kind: 'token', iss: [pub(identity)], m: 1, sym: 'BNT', dec: 0 }
const held = (assetId: string, amount: bigint, holder: PrivateKey | string) => bntHeldLock({ assetId, amount, clause: open(holder) })
const authority = (assetId: string, holder: PrivateKey, issued?: BntIssued) =>
  bntAuthorityLock({ assetId, clause: open(holder), ...(issued ? { issued } : {}) })

function deployTx(supply: bigint, fields: BntDeployFields = token, signer: PrivateKey = issuerKey): Transaction {
  const coin = coinFor(signer)
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: bntDeployLock({ supply, payload: encodeBntPayload(fields), clause: open(alice) }), satoshis: 1 })
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, signer, BNT_ISSUER_SCOPE))
  return tx
}

type Spend = { tx: Transaction; vout: number; holder?: PrivateKey }

/** Spend `inputs` into `outputs`; an input without a holder spends a funding coin. */
function spend(inputs: Spend[], outputs: LockingScript[]): Transaction {
  const tx = new Transaction()
  for (const input of inputs) {
    tx.addInput({ sourceTransaction: input.tx, sourceOutputIndex: input.vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  for (const script of outputs) tx.addOutput({ lockingScript: script, satoshis: 1 })
  inputs.forEach((input, vin) => {
    if (input.holder) tx.inputs[vin]!.unlockingScript = bntOpenUnlock(signInput(tx, vin, input.holder, BNT_HOLDER_SCOPE))
  })
  return tx
}

const idOf = (tx: Transaction) => String(tx.id('hex'))
const assetOf = (deploy: Transaction, vout = 0) => bntAssetId(idOf(deploy), vout)

type Scenario = {
  name: string
  txs: Record<string, string>
  order: string[]
  expect: Array<{ txid: string; asset: string; valid: boolean; deployOk: boolean }>
}

/** Every transaction behind `tips`, parents first. */
function ancestry(tips: Transaction[]): Transaction[] {
  const seen = new Map<string, Transaction>()
  const visit = (tx: Transaction) => {
    if (seen.has(idOf(tx))) return
    for (const input of tx.inputs) if (input.sourceTransaction) visit(input.sourceTransaction)
    seen.set(idOf(tx), tx)
  }
  tips.forEach(visit)
  return [...seen.values()]
}

async function scenario(name: string, deploys: Array<{ tx: Transaction; vout?: number }>, tips: Transaction[]): Promise<Scenario> {
  const all = ancestry([...tips, ...deploys.map((d) => d.tx)])
  const byId = new Map(all.map((tx) => [idOf(tx), tx]))
  const expected: Scenario['expect'] = []
  for (const { tx: deployTx, vout = 0 } of deploys) {
    const asset = assetOf(deployTx, vout)
    const read = readBntDeploy(deployTx, vout)
    for (const tx of all) {
      if (idOf(tx) === idOf(deployTx)) continue
      let valid = false
      if (read.ok) {
        const walk = await walkBnt(idOf(tx), read.deploy, async (id) => byId.get(id) ?? null, () => false)
        valid = walk.ok
      }
      expected.push({ txid: idOf(tx), asset, valid, deployOk: read.ok })
    }
  }
  return { name, txs: Object.fromEntries(all.map((tx) => [idOf(tx), tx.toHex()])), order: all.map(idOf), expect: expected }
}

/** Deterministic pseudo-random numbers, so the vectors are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mutations(hex: string, rand: () => number, count: number): string[] {
  const bytes = Utils.toArray(hex, 'hex')
  const out = [hex]
  for (let i = 0; i < count; i++) {
    const copy = [...bytes]
    const kind = Math.floor(rand() * 4)
    const at = Math.floor(rand() * copy.length)
    if (kind === 0) copy[at] = Math.floor(rand() * 256)
    else if (kind === 1) copy[at] = copy[at]! ^ (1 << Math.floor(rand() * 8))
    else if (kind === 2) copy.splice(at, 1)
    else copy.splice(at, 0, Math.floor(rand() * 256))
    out.push(Utils.toHex(copy))
  }
  return out
}

const big = (n: bigint | undefined) => (n == null ? null : n.toString())

function scriptSummary(hex: string) {
  const read = readBnt(hex)
  if (!read) return null
  const mode = read.clause.mode
  if (read.form === 'deploy') return { form: 'deploy', mode, supply: read.supply.toString(), payload: Utils.toHex([...read.payload]) }
  if (read.form === 'held') return { form: 'held', mode, asset: read.assetId, amount: read.amount.toString() }
  return { form: 'authority', mode, asset: read.assetId, units: big(read.issued?.units), members: big(read.issued?.members) }
}

function payloadSummary(hex: string) {
  const fields = decodeBntPayload(Uint8Array.from(Utils.toArray(hex, 'hex')))
  if (!fields) return null
  return {
    open: fields.mode === 'open',
    item: fields.kind === 'item',
    auth: fields.auth === true,
    max: big(fields.max),
    size: big(fields.size),
    col: fields.col ?? null,
    backed: fields.bk != null,
  }
}

const cbor = (entries: Array<[string, CborValue]>) => Utils.toHex(encodeDagCbor(new Map(entries)))
const keyBytes = (key: PrivateKey) => Uint8Array.from(Utils.toArray(pub(key), 'hex'))
const float64 = (n: number) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, n)
  return Utils.toHex([0xfb, ...new Uint8Array(view.buffer)])
}

/** Payloads at the edges of the DAG-CBOR and field rules. */
function edgePayloads(): string[] {
  const iss = keyBytes(identity)
  const base: Array<[string, CborValue]> = [['v', 1], ['iss', iss], ['mode', 'open']]
  const with_ = (...extra: Array<[string, CborValue]>) => cbor([...base, ...extra])
  const enc = (value: CborValue) => Utils.toHex(encodeDagCbor(value))
  /** A map from already-encoded values, keys in DAG-CBOR order. */
  const rawMap = (entries: Array<[string, string]>) =>
    (0xa0 + entries.length).toString(16) +
    [...entries]
      .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => enc(key) + value)
      .join('')
  const rawBase: Array<[string, string]> = [['v', '01'], ['iss', enc(iss)], ['mode', enc('open')]]
  const raw = (...extra: Array<[string, string]>) => rawMap([...rawBase.filter(([k]) => !extra.some(([e]) => e === k)), ...extra])
  return [
    with_(),
    with_(['kind', 'item'], ['col', new Uint8Array(20).fill(7)], ['c', new Uint8Array([1])], ['ctype', 'text/plain']),
    with_(['kind', 'item'], ['dec', 0]),
    with_(['auth', true], ['max', (1n << 64n) - 1n], ['size', 3]),
    with_(['auth', true], ['max', 0]),
    with_(['max', 10]),
    with_(['name', ' \u3000\ufeff']),
    with_(['name', 'x'.repeat(256)]),
    with_(['name', 'x'.repeat(257)]),
    with_(['name', '\u{1F600}'.repeat(128)]),
    with_(['name', '\u{1F600}'.repeat(129)]),
    with_(['name', 'see A1+.-://x']),
    with_(['name', 'see 1+.-://x']),
    with_(['sym', 'Ʃ']),
    with_(['crit', ['sym', 'name']]),
    with_(['crit', ['shiny']]),
    with_(['zz-unknown', 5]),
    with_(['bk', ['ltc', new Uint8Array([0x51])]]),
    with_(['bk', ['ltc', new Uint8Array([0x51])]], ['auth', true], ['crit', ['bk']]),
    with_(['dec', 19]),
    with_(['m', 2]),
    cbor([['v', 1], ['iss', [iss, keyBytes(alice), keyBytes(bob)]], ['m', 2], ['mode', 'open']]),
    cbor([['v', 1], ['iss', [iss, keyBytes(alice)]], ['m', 1], ['mode', 'open']]),
    cbor([['v', 1], ['iss', [iss]], ['mode', 'open']]),
    cbor([['v', 2], ['iss', iss], ['mode', 'open']]),
    cbor([['v', 1], ['iss', iss], ['mode', 'countersign'], ['bcn', new Uint8Array(36)], ['rel', new Uint8Array(20)], ['sil', 604_800]]),
    cbor([['v', 1], ['iss', iss], ['mode', 'countersign'], ['bcn', new Uint8Array(36)], ['rel', new Uint8Array(20)], ['sil', 604_799]]),
    cbor([['k', 1], ['v', 1], ['iss', iss], ['bcn', new Uint8Array(36)], ['sil', 604_800], ['mode', 'countersign'], ['relk', [keyBytes(bob)]]]),
    raw(),
    // v as the float 1.0, which a JavaScript reader takes as the number 1
    raw(['v', float64(1)]),
    raw(['v', float64(1.5)]),
    raw(['dec', float64(-0)]),
    raw(['dec', float64(2 ** 53)]),
    raw(['max', enc(1n << 60n)], ['auth', 'f5']),
    // max as a negative integer
    raw(['max', '20'], ['auth', 'f5']),
    // null counts as absent for kind and auth, but not for m or sym
    raw(['kind', 'f6']),
    raw(['auth', 'f6']),
    raw(['m', 'f6']),
    raw(['sym', 'f6']),
    raw(['v', '1801']),
    raw(['v', '1901']),
    // an indefinite-length text
    raw(['sym', '7f6141ff']),
    // a tag-42 link under an unknown key, and one that is not a link
    raw(['zz', `d82a${enc(new Uint8Array([0, 1]))}`]),
    raw(['zz', `d82a${enc(new Uint8Array([1, 1]))}`]),
    raw(['zz', `d82b${enc(new Uint8Array([0, 1]))}`]),
    raw(['zz', 'f7']),
    // a leading byte-order mark on a text value is dropped
    raw(['name', `67efbbbf${Utils.toHex(Utils.toArray('Name', 'utf8'))}`]),
    raw(['name', '62c328']),
    `${raw()}00`,
    raw().slice(0, -2),
  ]
}

describe('BRC-255 proof step vectors', () => {
  it('builds scenarios, scripts and payloads and judges them with the wallet rules', async () => {
    const scenarios: Scenario[] = []

    {
      const d = deployTx(100n)
      const a = assetOf(d)
      const t1 = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 60n, bob), held(a, 40n, alice)])
      const t2 = spend([{ tx: t1, vout: 0, holder: bob }, { tx: t1, vout: 1, holder: alice }], [held(a, 100n, bob)])
      const t3 = spend([{ tx: t2, vout: 0, holder: bob }], [held(a, 30n, BURN), held(a, 70n, alice)])
      scenarios.push(await scenario('split, merge and burn', [{ tx: d }], [t3]))
    }
    {
      const d = deployTx(100n)
      const a = assetOf(d)
      const inflate = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 101n, bob)])
      const child = spend([{ tx: inflate, vout: 0, holder: bob }], [held(a, 101n, alice)])
      const conjured = spend([{ tx: funding, vout: fundingIndex++ }], [held(a, 50n, alice)])
      const ok = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 60n, bob), held(a, 40n, alice)])
      const mixed = spend([{ tx: ok, vout: 0, holder: bob }, { tx: conjured, vout: 0, holder: alice }], [held(a, 110n, bob)])
      scenarios.push(await scenario('inflation, conjuring and their children', [{ tx: d }], [child, mixed]))
    }
    {
      const d = deployTx(10n)
      const a = assetOf(d)
      const foreign = bntHeldLock({
        assetId: a,
        amount: 10n,
        clause: { mode: 'countersign', holder: pub(bob), issuer: { m: 1, keys: [pub(bob)] }, release: { kind: 'hash', rel: '00'.repeat(20) } },
      })
      const t1 = spend([{ tx: d, vout: 0, holder: alice }], [foreign])
      const t2 = spend([{ tx: t1, vout: 0 }], [held(a, 10n, alice)])
      const noAuth = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 10n, bob), authority(a, alice)])
      const poor = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 9n, bob)])
      const sats = new Transaction()
      sats.addInput({ sourceTransaction: d, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      sats.addOutput({ lockingScript: held(a, 10n, bob), satoshis: 0 })
      sats.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(sats, 0, alice, BNT_HOLDER_SCOPE))
      scenarios.push(await scenario('closure, minting and satoshis', [{ tx: d }], [t2, noAuth, poor, sats]))
    }
    {
      const d = deployTx(10n, { ...token, auth: true })
      const a = assetOf(d)
      const m1 = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 25n, bob), authority(a, alice)])
      const m2 = spend([{ tx: m1, vout: 1, holder: alice }], [held(a, 5n, bob), authority(a, alice)])
      const t = spend([{ tx: m1, vout: 0, holder: bob }, { tx: m2, vout: 0, holder: bob }], [held(a, 30n, alice)])
      const twoOut = spend([{ tx: m2, vout: 1, holder: alice }], [authority(a, alice), authority(a, bob)])
      const twoIn = spend([{ tx: twoOut, vout: 0, holder: alice }, { tx: twoOut, vout: 1, holder: bob }], [authority(a, alice)])
      const shrink = spend([{ tx: m1, vout: 1, holder: alice }, { tx: m1, vout: 0, holder: bob }], [held(a, 20n, bob), authority(a, alice)])
      scenarios.push(await scenario('open minting', [{ tx: d }], [t, twoIn, shrink]))
    }
    {
      const capped = (max?: bigint, size?: bigint): BntDeployFields => ({ ...token, auth: true, ...(max != null ? { max } : {}), ...(size != null ? { size } : {}) })
      const d = deployTx(60n, capped(100n))
      const a = assetOf(d)
      const ok = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 100n, alice), authority(a, alice, { units: 100n, members: 0n })])
      const over = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 101n, alice), authority(a, alice, { units: 101n, members: 0n })])
      const lie = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 90n, alice), authority(a, alice, { units: 60n, members: 0n })])
      const omitted = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 60n, alice), authority(a, alice)])
      const closing = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 100n, bob)])
      const closingOver = spend([{ tx: d, vout: 0, holder: alice }], [held(a, 101n, bob)])
      const c = deployTx(10n, capped(30n))
      const ca = assetOf(c)
      const c1 = spend([{ tx: c, vout: 0, holder: alice }], [held(ca, 20n, bob), authority(ca, alice, { units: 20n, members: 0n })])
      const c2 = spend([{ tx: c1, vout: 1, holder: alice }], [held(ca, 10n, bob), authority(ca, alice, { units: 30n, members: 0n })])
      const c3 = spend([{ tx: c2, vout: 1, holder: alice }], [held(ca, 1n, bob), authority(ca, alice, { units: 31n, members: 0n })])
      const c4 = spend([{ tx: c2, vout: 1, holder: alice }, { tx: c2, vout: 0, holder: bob }], [held(ca, 10n, bob), authority(ca, alice, { units: 30n, members: 0n })])
      const o = deployTx(10n, { ...token, auth: true })
      const invented = spend([{ tx: o, vout: 0, holder: alice }], [held(assetOf(o), 10n, alice), authority(assetOf(o), alice, { units: 10n, members: 0n })])
      scenarios.push(
        await scenario('capped supply', [{ tx: d }, { tx: c }, { tx: o }], [ok, over, lie, omitted, closing, closingOver, c3, c4, invented]),
      )
    }
    {
      const c = deployTx(1n, { ...token, auth: true, size: 2n })
      const ca = assetOf(c)
      const members = (from: Spend, names: string[], issued: BntIssued) => {
        const coin = coinFor(issuerKey)
        const tx = new Transaction()
        tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
        tx.addInput({ sourceTransaction: from.tx, sourceOutputIndex: from.vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
        for (const name of names) {
          const item: BntDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name, col: ca }
          tx.addOutput({ lockingScript: bntDeployLock({ supply: 1n, payload: encodeBntPayload(item), clause: open(alice) }), satoshis: 1 })
        }
        tx.addOutput({ lockingScript: authority(ca, alice, issued), satoshis: 1 })
        tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, issuerKey, BNT_ISSUER_SCOPE))
        tx.inputs[1]!.unlockingScript = bntOpenUnlock(signInput(tx, 1, alice, BNT_HOLDER_SCOPE))
        return tx
      }
      const first = spend([{ tx: c, vout: 0, holder: alice }], [held(ca, 1n, bob), authority(ca, alice, { units: 1n, members: 0n })])
      const one = members({ tx: first, vout: 1, holder: alice }, ['Member 1'], { units: 1n, members: 1n })
      const two = members({ tx: one, vout: 1, holder: alice }, ['Member 2'], { units: 1n, members: 2n })
      const three = members({ tx: two, vout: 1, holder: alice }, ['Member 3'], { units: 1n, members: 3n })
      const batch = members({ tx: first, vout: 1, holder: alice }, ['A', 'B', 'C'], { units: 1n, members: 3n })
      const understated = members({ tx: first, vout: 1, holder: alice }, ['A'], { units: 1n, members: 0n })
      const item = spend([{ tx: one, vout: 0, holder: alice }], [held(bntAssetId(idOf(one), 0), 1n, bob)])
      scenarios.push(
        await scenario('collections and items', [{ tx: c }, { tx: one, vout: 0 }, { tx: two, vout: 0 }], [three, batch, understated, item]),
      )
    }
    {
      const x = deployTx(100n)
      const y = deployTx(50n, { ...token, sym: 'Y' })
      const xa = assetOf(x)
      const ya = assetOf(y)
      const both = spend([{ tx: x, vout: 0, holder: alice }, { tx: y, vout: 0, holder: alice }], [held(xa, 100n, bob), held(ya, 51n, bob)])
      const xOnly = spend([{ tx: both, vout: 0, holder: bob }], [held(xa, 100n, alice)])
      const yOnly = spend([{ tx: both, vout: 1, holder: bob }], [held(ya, 51n, alice)])
      scenarios.push(await scenario('two assets in one transaction', [{ tx: x }, { tx: y }], [xOnly, yOnly]))
    }
    {
      const forged = deployTx(100n, token, stranger)
      const t = spend([{ tx: forged, vout: 0, holder: alice }], [held(assetOf(forged), 100n, bob)])
      scenarios.push(await scenario('a deploy the issuer did not sign', [{ tx: forged }], [t]))
    }

    const rand = prng(255)
    const scriptBases = [
      bntDeployLock({ supply: 21_000_000n, payload: encodeBntPayload(token), clause: open(alice) }),
      bntDeployLock({ supply: 1n, payload: encodeBntPayload({ ...token, name: 'x'.repeat(120) }), clause: open(alice) }),
      held('ab'.repeat(20), 7n, alice),
      held('ab'.repeat(20), 128n, alice),
      held('ab'.repeat(20), (1n << 64n) - 1n, alice),
      authority('cd'.repeat(20), alice),
      authority('cd'.repeat(20), alice, { units: 300n, members: 0n }),
      bntHeldLock({ assetId: 'ef'.repeat(20), amount: 5n, clause: { mode: 'countersign', holder: pub(alice), issuer: { m: 1, keys: [pub(bob)] }, release: { kind: 'hash', rel: '11'.repeat(20) } } }),
      bntHeldLock({
        assetId: 'ef'.repeat(20),
        amount: 5n,
        clause: { mode: 'countersign', holder: pub(alice), issuer: { m: 2, keys: [pub(bob), pub(identity), pub(stranger)] }, release: { kind: 'keys', k: 1, keys: [pub(alice)] } },
      }),
    ].map((s) => s.toHex())
    const scripts = scriptBases.flatMap((hex) => mutations(hex, rand, 150)).map((hex) => ({ hex, read: scriptSummary(hex) }))

    const payloadBases = [
      encodeBntPayload(token),
      encodeBntPayload({ ...token, auth: true, max: 1000n, size: 5n, name: 'Capped', icon: { mediaType: 'image/png', bytes: new Uint8Array(40).fill(9) } }),
      encodeBntPayload({ mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Member', col: 'ab'.repeat(20), ctype: 'text/plain', c: new Uint8Array([104, 105]) }),
    ].map((b) => Utils.toHex(b))
    const payloads = [...payloadBases.flatMap((hex) => mutations(hex, rand, 300)), ...edgePayloads()].map((hex) => ({
      hex,
      fields: payloadSummary(hex),
    }))

    expect(scenarios.flatMap((s) => s.expect).some((e) => e.valid)).toBe(true)
    expect(scenarios.flatMap((s) => s.expect).some((e) => !e.valid && e.deployOk)).toBe(true)
    expect(scripts.filter((s) => s.read).length).toBeGreaterThan(scriptBases.length)
    expect(payloads.filter((p) => p.fields).length).toBeGreaterThan(payloadBases.length)

    const path = process.env.BNT_PROOF_VECTORS
    if (path) writeFileSync(path, `${JSON.stringify({ scenarios, scripts, payloads }, null, 1)}\n`)
  })
})
