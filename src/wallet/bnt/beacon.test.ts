import { LockingScript, MerklePath, OP, PrivateKey, Transaction, UnlockingScript, type ChainTracker } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { signInput, sourceTxidOf } from '../txInputs'
import { buildBeaconPackage, discoverBeaconChain, readBeaconPackage } from './beacon'
import { outpointBytes } from './payload'
import { checkIptHashRelease, checkIptRelease } from './release'
import { BNT_ISSUER_SCOPE, bntBeaconLock, hash160Hex, type BntRules } from './script'
import type { BntDeploy } from './validity'

const issuer = PrivateKey.fromRandom()
const members = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()]
const outsider = PrivateKey.fromRandom()
const secret = new Array(32).fill(7)
const height = 800_000
const sink = () => new LockingScript().writeOpCode(OP.OP_TRUE)

const keyRules: Extract<BntRules, { mode: 'countersign' }> = {
  mode: 'countersign',
  issuer: { m: 1, keys: [issuer.toPublicKey().toString()] },
  release: { kind: 'keys', k: 2, keys: members.map((key) => key.toPublicKey().toString()) },
}
const hashRules: Extract<BntRules, { mode: 'countersign' }> = {
  mode: 'countersign',
  issuer: { m: 1, keys: [issuer.toPublicKey().toString()] },
  release: { kind: 'hash', rel: hash160Hex(secret) },
}
const keyScript = bntBeaconLock(keyRules)

function deployFor(rules: Extract<BntRules, { mode: 'countersign' }>, bcn: string): BntDeploy {
  return { rules, fields: { mode: 'countersign', kind: 'token', iss: rules.issuer.keys, m: 1, bcn, sil: 604_800 } } as BntDeploy
}

function origin() {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: keyScript, satoshis: 1 })
  return tx
}

function refresh(parent: Transaction, outputs: LockingScript[] = [keyScript]): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  outputs.forEach((lockingScript) => tx.addOutput({ lockingScript, satoshis: 1 }))
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, issuer, BNT_ISSUER_SCOPE)).writeOpCode(OP.OP_1)
  return tx
}

/** Key-set release: OP_0 dummy, k signatures in set order, OP_0 branch, then the disclosure. */
function keyRelease(parent: Transaction, disclose: PrivateKey[], beacon = `${parent.id('hex')}_0`): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  const disclosure = new LockingScript().writeOpCode(OP.OP_0).writeOpCode(OP.OP_RETURN)
    .writeBin([0x69, 0x70, 0x74, 0x20, 0x72, 0x65, 0x6c, 0x65, 0x61, 0x73, 0x65])
    .writeBin(outpointBytes(beacon))
  for (const key of disclose) disclosure.writeBin(key.toArray('be', 32))
  tx.addOutput({ lockingScript: disclosure, satoshis: 0 })
  tx.addOutput({ lockingScript: sink(), satoshis: 1 })
  const signers = [members[0]!, members[1]!]
  const sigs = signers.map((key) => signInput(tx, 0, key, BNT_ISSUER_SCOPE))
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeOpCode(OP.OP_0).writeBin(sigs[0]!).writeBin(sigs[1]!).writeOpCode(OP.OP_0)
  return tx
}

function hashRelease(parent: Transaction): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript().writeBin(secret).writeOpCode(OP.OP_0), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: sink(), satoshis: 1 })
  return tx
}

function mined(tx: Transaction): ChainTracker {
  const id = String(tx.id('hex'))
  tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: 'cd'.repeat(32) }, { offset: 1, hash: id, txid: true }]])
  const root = tx.merklePath.computeRoot(id)
  return { isValidRootForHeight: async (r, h) => r === root && h === height, currentHeight: async () => height + 1 }
}

/** A chain source over known transactions, the way a real indexer answers. */
function world(...txs: Transaction[]) {
  const byId = new Map(txs.map((tx) => [String(tx.id('hex')).toLowerCase(), tx]))
  const spends = new Map<string, Transaction>()
  for (const tx of txs) tx.inputs.forEach((input, vin) => spends.set(`${sourceTxidOf(tx, vin)}_${input.sourceOutputIndex}`, tx))
  return {
    txOf: async (txid: string) => byId.get(txid) ?? null,
    spenderOf: async (outpoint: string) => spends.get(outpoint) ?? null,
  }
}

describe('BRC-253 §9 beacon discovery', () => {
  it('follows refreshes to a key-set release and accepts k valid disclosures', async () => {
    const first = origin()
    const next = refresh(first)
    const end = keyRelease(next, [members[0]!, members[2]!])
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const found = await discoverBeaconChain(deploy, world(first, next, end).txOf, world(first, next, end).spenderOf)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.chain.map((tx) => String(tx.id('hex')))).toEqual([first, next, end].map((tx) => String(tx.id('hex'))))
    const check = await checkIptRelease(deploy, found.chain, mined(end))
    expect(check).toMatchObject({ ok: true, keys: expect.arrayContaining([members[0]!, members[2]!].map((k) => k.toPublicKey().toString())) })
  })

  it('gives the same verdict after a restart from the persisted package', async () => {
    const first = origin()
    const next = refresh(first)
    const end = keyRelease(next, [members[0]!, members[1]!])
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const { txOf, spenderOf } = world(first, next, end)
    const tracker = mined(end)
    const built = buildBeaconPackage(`${first.id('hex')}_0`, [first, next, end])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const stored = JSON.parse(JSON.stringify(built.pkg))
    const read = readBeaconPackage(stored)
    expect(read).not.toBeNull()
    const again = await discoverBeaconChain(deploy, txOf, spenderOf)
    const fromPackage = read!.chain
    expect(await checkIptRelease(deploy, fromPackage, tracker)).toMatchObject({ ok: true })
    expect(again.ok).toBe(true)
  })

  it('reports an unavailable source, not a verdict, and recovers on retry', async () => {
    const first = origin()
    const next = refresh(first)
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const { txOf, spenderOf } = world(first, next)
    let calls = 0
    const flaky = async (outpoint: string) => {
      calls++
      if (calls === 1) throw new Error('offline')
      return spenderOf(outpoint)
    }
    const failed = await discoverBeaconChain(deploy, txOf, flaky)
    expect(failed).toMatchObject({ ok: false, unavailable: true })
    const retried = await discoverBeaconChain(deploy, txOf, spenderOf)
    expect(retried).toMatchObject({ ok: true })
    if (retried.ok) expect(retried.chain).toHaveLength(2)
  })

  it('treats an unspent beacon as live, never as released', async () => {
    const first = origin()
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const { txOf, spenderOf } = world(first)
    const found = await discoverBeaconChain(deploy, txOf, spenderOf)
    expect(found).toMatchObject({ ok: true })
    if (found.ok) expect(await checkIptRelease(deploy, found.chain, mined(first))).toMatchObject({ ok: false, missing: true })
  })

  it('refuses a source that answers with a transaction not spending the beacon', async () => {
    const first = origin()
    const unrelated = origin()
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const found = await discoverBeaconChain(deploy, async () => first, async () => unrelated)
    expect(found).toMatchObject({ ok: false, unavailable: false })
  })

  it('refuses a beacon transaction that does not hash to its txid', async () => {
    const first = origin()
    const other = refresh(origin())
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const found = await discoverBeaconChain(deploy, async () => other, async () => null)
    expect(found).toMatchObject({ ok: false, unavailable: false })
  })
})

describe('BRC-253 §9 release checks', () => {
  it('does not count a key-set release until it is mined', async () => {
    const first = origin()
    const next = refresh(first)
    const end = keyRelease(next, [members[0]!, members[1]!])
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const unmined = { isValidRootForHeight: async () => false, currentHeight: async () => height }
    expect(await checkIptRelease(deploy, [first, next, end], unmined)).toMatchObject({ ok: false, missing: true })
  })

  it('ignores disclosures outside the set or for another beacon, and needs k valid ones', async () => {
    const first = origin()
    const next = refresh(first)
    const deploy = deployFor(keyRules, `${first.id('hex')}_0`)
    const one = keyRelease(next, [members[0]!])
    expect(await checkIptRelease(deploy, [first, next, one], mined(one))).toMatchObject({ ok: false, missing: false })
    const outsiders = keyRelease(next, [members[0]!, outsider])
    expect(await checkIptRelease(deploy, [first, next, outsiders], mined(outsiders))).toMatchObject({ ok: false, missing: false })
    const elsewhere = keyRelease(next, [members[0]!, members[1]!], `${'ab'.repeat(32)}_0`)
    expect(await checkIptRelease(deploy, [first, next, elsewhere], mined(elsewhere))).toMatchObject({ ok: false, missing: false })
  })

  it('rejects a release under a deploy whose release keys differ', async () => {
    const first = origin()
    const next = refresh(first)
    const end = keyRelease(next, [members[0]!, members[1]!])
    const other = deployFor({ ...keyRules, release: { kind: 'keys', k: 2, keys: [outsider, members[1]!, members[2]!].map((k) => k.toPublicKey().toString()) } }, `${first.id('hex')}_0`)
    expect(await checkIptRelease(other, [first, next, end], mined(end))).toMatchObject({ ok: false, missing: false })
  })

  it('keeps hash releases on the hash path only', async () => {
    const first = new Transaction()
    first.addOutput({ lockingScript: bntBeaconLock(hashRules), satoshis: 1 })
    const deploy = deployFor(hashRules, `${first.id('hex')}_0`)
    const end = hashRelease(first)
    expect(await checkIptHashRelease(deploy, [first, end], mined(end))).toEqual({ ok: true, secret })
    const keyed = deployFor(keyRules, `${first.id('hex')}_0`)
    expect(await checkIptHashRelease(keyed, [first, end], mined(end))).toMatchObject({ ok: false, missing: false })
  })
})

describe('beacon package transport', () => {
  it('refuses a chain that does not fit instead of cutting it', () => {
    const first = origin()
    const next = refresh(first)
    const end = keyRelease(next, [members[0]!, members[1]!])
    expect(buildBeaconPackage(`${first.id('hex')}_0`, [first, next, end], 10)).toMatchObject({ ok: false })
    expect(buildBeaconPackage(`${first.id('hex')}_0`, [first, next, end])).toMatchObject({ ok: true })
    expect(buildBeaconPackage('nope', [first, next, end])).toMatchObject({ ok: false })
  })

  it('rejects malformed packages', () => {
    const first = origin()
    const built = buildBeaconPackage(`${first.id('hex')}_0`, [first, refresh(first)])
    if (!built.ok) throw new Error('fixture')
    expect(readBeaconPackage({ ...built.pkg, v: 2 })).toBeNull()
    expect(readBeaconPackage({ ...built.pkg, beacon: 'x' })).toBeNull()
    expect(readBeaconPackage({ ...built.pkg, chain: ['zz', ...built.pkg.chain.slice(1)] })).toBeNull()
    expect(readBeaconPackage({ ...built.pkg, chain: built.pkg.chain.slice(0, 1) })).toBeNull()
    expect(readBeaconPackage({ ...built.pkg, proofs: [] })).toBeNull()
    expect(readBeaconPackage({ ...built.pkg, proofs: ['zz', ''] })).toBeNull()
    expect(readBeaconPackage(built.pkg)).not.toBeNull()
  })
})
