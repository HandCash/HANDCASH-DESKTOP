import { LockingScript, OP, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { beaconPhase, readBeaconChain, type BeaconChainSource } from './beacon'
import { chooseCountersignTransferPath } from './path'
import { decodeCountersignPayload, encodeCountersignPayload, MIN_SILENCE_SECONDS } from './payload'
import {
  checkAcceptRequest,
  readCountersignDeploy,
  resolveCountersignTransfer,
  type CountersignDeploy,
} from './resolve'
import {
  beaconLock,
  beaconUnlock,
  contentLock,
  COUNTERSIGN_SCOPE,
  countersignDeployLock,
  countersignedLock,
  countersignedUnlock,
  disclosedReleaseKeys,
  HOLDER_SCOPE,
  holderSignatureValid,
  holderUnlock,
  inputScriptValid,
  pubkeyHashHex,
  readCountersigned,
  readBeaconMarker,
  readCountersignClause,
  releaseDisclosureLock,
  requestIdOf,
  retireMarkerLock,
  signInput,
  unlockBranch,
  type CountersignKeySets,
} from './script'

const issuer = PrivateKey.fromRandom()
const releaseKeys = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()]
const holder = PrivateKey.fromRandom()
const recipient = PrivateKey.fromRandom()
const pub = (key: PrivateKey) => key.toPublicKey().toString()
const pkh = (key: PrivateKey) => pubkeyHashHex(pub(key))
const sets: CountersignKeySets = {
  issuer: { threshold: 1, keys: [pub(issuer)] },
  release: { threshold: 2, keys: releaseKeys.map(pub) },
}
const funding = (() => {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new Script().writeOpCode(OP.OP_TRUE) as LockingScript, satoshis: 500 })
  return tx
})()

function deployTx(kind: 'token' | 'item', supply: bigint, holderKey = holder) {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({
    lockingScript: countersignDeployLock({
      supply,
      payload: encodeCountersignPayload(
        kind === 'item'
          ? { kind, sil: MIN_SILENCE_SECONDS, name: 'Robot', ctype: 'image/png' }
          : { kind, sil: MIN_SILENCE_SECONDS, sym: 'CST', dec: 0 },
      ),
      holderPkhHex: pkh(holderKey),
      sets,
    }),
    satoshis: 1,
  })
  tx.addOutput({ lockingScript: beaconLock(sets), satoshis: 1 })
  if (kind === 'item') tx.addOutput({ lockingScript: contentLock([1, 2, 3]), satoshis: 0 })
  return tx
}

function feeCoin(key = issuer) {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 300 })
  return tx
}

/** Holder signs ALL|ANYONECANPAY, then a fee coin is added and the transfer countersigned. */
function transfer(
  parent: Transaction,
  vout: number,
  outputs: Array<{ to: PrivateKey; amount: bigint }>,
  assetId: string,
  countersigners: PrivateKey[] = [issuer],
  branch: 'issuer' | 'release' = 'issuer',
) {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  for (const out of outputs) {
    tx.addOutput({ lockingScript: countersignedLock({ assetId, amount: out.amount, holderPkhHex: pkh(out.to), sets }), satoshis: 1 })
  }
  const holderSig = signInput(tx, 0, holder, HOLDER_SCOPE)
  tx.inputs[0]!.unlockingScript = holderUnlock(holderSig, pub(holder))
  const request = Transaction.fromEF(tx.toEF())
  const fee = feeCoin()
  tx.addInput({ sourceTransaction: fee, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.inputs[0]!.unlockingScript = countersignedUnlock({
    countersignatures: countersigners.map((key) => signInput(tx, 0, key, COUNTERSIGN_SCOPE)),
    branch,
    holderSignature: holderSig,
    holderPublicKey: holder.toPublicKey().encode(true) as number[],
  })
  return { tx, request }
}

describe('countersign payload', () => {
  it('round-trips a token and an item deploy', () => {
    const token = decodeCountersignPayload(Uint8Array.from(encodeCountersignPayload({ kind: 'token', sil: MIN_SILENCE_SECONDS, sym: 'CST', dec: 2 })))
    expect(token).toMatchObject({ kind: 'token', sym: 'CST', dec: 2, sil: MIN_SILENCE_SECONDS })
    const item = decodeCountersignPayload(Uint8Array.from(encodeCountersignPayload({ kind: 'item', sil: MIN_SILENCE_SECONDS, name: 'Robot', ctype: 'image/jpeg' })))
    expect(item).toMatchObject({ kind: 'item', name: 'Robot', ctype: 'image/jpeg' })
  })

  it('refuses a short silence period, decimals on an item and a URL', () => {
    expect(() => encodeCountersignPayload({ kind: 'token', sil: 60 })).toThrow()
    expect(() => encodeCountersignPayload({ kind: 'item', sil: MIN_SILENCE_SECONDS, dec: 1 })).toThrow()
    expect(decodeCountersignPayload(Uint8Array.from(encodeCountersignPayload({ kind: 'token', sil: MIN_SILENCE_SECONDS, sym: 'https://x' })))).toBeNull()
  })
})

describe('countersign clause', () => {
  it('parses only the canonical clause and refuses a release key in the issuer set', () => {
    const lock = countersignedLock({ assetId: `${'ab'.repeat(32)}_0`, amount: 7n, holderPkhHex: pkh(holder), sets })
    const read = readCountersigned(lock)
    expect(read).toMatchObject({ assetId: `${'ab'.repeat(32)}_0`, amount: 7n, holderPkhHex: pkh(holder) })
    expect(read!.sets).toEqual(sets)
    expect(readCountersignClause('76a9')).toBeNull()
    expect(() =>
      countersignedLock({
        assetId: `${'ab'.repeat(32)}_0`,
        amount: 1n,
        holderPkhHex: pkh(holder),
        sets: { issuer: sets.issuer, release: { threshold: 1, keys: [pub(issuer)] } },
      }),
    ).toThrow(/release key/)
  })

  it('reads a deploy body: supply, payload, beacon', () => {
    const tx = deployTx('token', 1000n)
    const deploy = readCountersignDeploy(tx)
    expect(deploy).toMatchObject({ kind: 'token', supply: '1000', assetId: `${tx.id('hex')}_0` })
    const broken = deployTx('token', 1000n)
    broken.outputs[1] = { lockingScript: beaconLock({ issuer: { threshold: 1, keys: [pub(holder)] }, release: sets.release }), satoshis: 1 }
    expect(readCountersignDeploy(broken)).toBeNull()
  })
})

describe('countersigned transfer', () => {
  const deploy = deployTx('token', 100n)
  const assetId = `${deploy.id('hex')}_0`
  const deploys = new Map<string, CountersignDeploy>([[assetId, readCountersignDeploy(deploy)!]])

  it('spends the deploy with the holder and issuer signatures, verifiable from EF alone', () => {
    const { tx } = transfer(deploy, 0, [{ to: recipient, amount: 60n }, { to: holder, amount: 40n }], assetId)
    const ef = Transaction.fromEF(tx.toEF())
    expect(inputScriptValid(ef, 0)).toBe(true)
    const resolved = resolveCountersignTransfer(ef, deploys, pkh(recipient))
    expect(resolved).toEqual({ ok: true, mine: [{ vout: 0, assetId, amount: 60n }], assetIds: [assetId] })
  })

  it('refuses a holder signature alone, a stranger countersigning, and a changed output', () => {
    const { tx, request } = transfer(deploy, 0, [{ to: recipient, amount: 100n }], assetId)
    expect(inputScriptValid(request, 0)).toBe(false)
    const stranger = transfer(deploy, 0, [{ to: recipient, amount: 100n }], assetId, [PrivateKey.fromRandom()]).tx
    expect(inputScriptValid(stranger, 0)).toBe(false)
    const changed = Transaction.fromEF(tx.toEF())
    changed.outputs[0]!.lockingScript = countersignedLock({ assetId, amount: 100n, holderPkhHex: pkh(holder), sets })
    expect(inputScriptValid(changed, 0)).toBe(false)
  })

  it('refuses minting more than was spent and an item written twice', () => {
    const { tx } = transfer(deploy, 0, [{ to: recipient, amount: 101n }], assetId)
    expect(resolveCountersignTransfer(Transaction.fromEF(tx.toEF()), deploys, pkh(recipient))).toMatchObject({ ok: false })
    const item = deployTx('item', 1n)
    const itemId = `${item.id('hex')}_0`
    const itemDeploys = new Map([[itemId, readCountersignDeploy(item)!]])
    const twice = transfer(item, 0, [{ to: recipient, amount: 1n }, { to: recipient, amount: 1n }], itemId).tx
    expect(resolveCountersignTransfer(Transaction.fromEF(twice.toEF()), itemDeploys, pkh(recipient))).toMatchObject({ ok: false })
  })

  it('never resolves a deploy paid straight to the recipient', () => {
    const forged = deployTx('item', 1n, recipient)
    const forgedTx = new Transaction()
    forgedTx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    forgedTx.addOutput({ lockingScript: countersignedLock({ assetId: `${forged.id('hex')}_0`, amount: 1n, holderPkhHex: pkh(recipient), sets }), satoshis: 1 })
    const known = new Map([[`${forged.id('hex')}_0`, readCountersignDeploy(forged)!]])
    expect(resolveCountersignTransfer(Transaction.fromEF(forgedTx.toEF()), known, pkh(recipient))).toMatchObject({ ok: false, reason: 'deploy' })
  })

  describe('acceptor checks', () => {
    const accepted = new Set([assetId])
    const base = (request: Transaction, overrides: Partial<Parameters<typeof checkAcceptRequest>[0]> = {}) =>
      checkAcceptRequest({
        tx: request,
        deploys,
        answersFor: () => true,
        accepted,
        reservedBy: () => undefined,
        requestId: requestIdOf(request.toEF()),
        recipients: [{ vout: 0, identityKey: pub(recipient) }],
        ...overrides,
      })

    it('accepts a signed request paying a named recipient and change back', () => {
      const { request } = transfer(deploy, 0, [{ to: recipient, amount: 70n }, { to: holder, amount: 30n }], assetId)
      expect(holderSignatureValid(request, 0, pkh(holder))).toBe(true)
      expect(base(request)).toEqual({ ok: true, assetIds: [assetId], inputs: [assetId] })
    })

    it('names each refusal', () => {
      const { request } = transfer(deploy, 0, [{ to: recipient, amount: 100n }], assetId)
      expect(base(request, { accepted: new Set() })).toMatchObject({ reason: 'unknown_input' })
      expect(base(request, { reservedBy: () => 'other' })).toMatchObject({ reason: 'spent' })
      expect(base(request, { answersFor: () => false })).toMatchObject({ reason: 'not_acceptor' })
      expect(base(request, { recipients: [{ vout: 0, identityKey: pub(PrivateKey.fromRandom()) }] })).toMatchObject({ reason: 'recipient' })
      expect(base(request, { frozen: () => true })).toMatchObject({ reason: 'frozen' })
      const unsigned = Transaction.fromEF(request.toEF())
      unsigned.inputs[0]!.unlockingScript = holderUnlock(signInput(unsigned, 0, holder, COUNTERSIGN_SCOPE), pub(holder))
      expect(base(unsigned)).toMatchObject({ reason: 'invalid' })
    })
  })
})

describe('beacon and release', () => {
  const deploy = deployTx('token', 100n)
  const assetId = `${deploy.id('hex')}_0`
  const deploys = new Map<string, CountersignDeploy>([[assetId, readCountersignDeploy(deploy)!]])

  function beaconSpend(outputs: Array<{ lockingScript: LockingScript; satoshis: number }>, keys: PrivateKey[], branch: 'issuer' | 'release', parent = deploy) {
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    for (const output of outputs) tx.addOutput(output)
    tx.addInput({ sourceTransaction: feeCoin(), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    tx.inputs[0]!.unlockingScript = beaconUnlock(keys.map((key) => signInput(tx, 0, key, COUNTERSIGN_SCOPE)), branch)
    return tx
  }
  const refresh = (parent = deploy) => beaconSpend([{ lockingScript: beaconLock(sets), satoshis: 1 }], [issuer], 'issuer', parent)
  const disclosed = [releaseKeys[2]!, releaseKeys[0]!]
  const release = (parent = deploy) =>
    beaconSpend([{ lockingScript: releaseDisclosureLock(assetId, disclosed), satoshis: 0 }], [releaseKeys[0]!, releaseKeys[2]!], 'release', parent)

  it('the issuer refreshes on its branch; release keys cannot use it, nor the issuer theirs', () => {
    expect(inputScriptValid(refresh(), 0)).toBe(true)
    expect(inputScriptValid(beaconSpend([{ lockingScript: beaconLock(sets), satoshis: 1 }], [releaseKeys[0]!], 'issuer'), 0)).toBe(false)
    expect(inputScriptValid(beaconSpend([], [issuer, releaseKeys[1]!], 'release'), 0)).toBe(false)
  })

  it('reads retire and release markers and checks the disclosed keys against the set', () => {
    expect(readBeaconMarker(retireMarkerLock(assetId))).toEqual({ kind: 'retire', assetId })
    const marker = readBeaconMarker(release().outputs[0]!.lockingScript!)
    expect(marker).toMatchObject({ kind: 'release', assetId })
    const keys = disclosedReleaseKeys(marker!.kind === 'release' ? marker!.keys : [], sets.release)
    expect(keys?.map(pub)).toEqual([pub(releaseKeys[0]!), pub(releaseKeys[2]!)])
    expect(disclosedReleaseKeys([releaseKeys[0]!.toHex()], sets.release)).toBeNull()
    expect(disclosedReleaseKeys([releaseKeys[0]!.toHex(), PrivateKey.fromRandom().toHex()], sets.release)).toBeNull()
    expect(disclosedReleaseKeys([releaseKeys[0]!.toHex(), releaseKeys[0]!.toHex()], sets.release)).toBeNull()
    expect(inputScriptValid(release(), 0)).toBe(true)
  })

  it('after release anyone countersigns with the disclosed keys, the holder still signs, and resolution is unchanged', () => {
    const keys = disclosedReleaseKeys(disclosed.map((k) => k.toHex()), sets.release)!
    const { tx } = transfer(deploy, 0, [{ to: recipient, amount: 100n }], assetId, keys, 'release')
    const ef = Transaction.fromEF(tx.toEF())
    expect(inputScriptValid(ef, 0)).toBe(true)
    expect(unlockBranch(ef.inputs[0]!.unlockingScript)).toBe('release')
    expect(unlockBranch(transfer(deploy, 0, [{ to: recipient, amount: 100n }], assetId).tx.inputs[0]!.unlockingScript)).toBe('issuer')
    expect(resolveCountersignTransfer(ef, deploys, pkh(recipient))).toMatchObject({ ok: true })
    const stranger = Transaction.fromEF(tx.toEF())
    stranger.inputs[0]!.unlockingScript = countersignedUnlock({
      countersignatures: keys.map((key) => signInput(stranger, 0, key, COUNTERSIGN_SCOPE)),
      branch: 'release',
      holderSignature: signInput(stranger, 0, recipient, HOLDER_SCOPE),
      holderPublicKey: recipient.toPublicKey().encode(true) as number[],
    })
    expect(inputScriptValid(stranger, 0)).toBe(false)
  })

  describe('phase', () => {
    const sil = MIN_SILENCE_SECONDS
    const step = (n: number, blockTime?: number) => ({ outpoint: `${String(n).padStart(64, '0')}_0`, ...(blockTime != null ? { blockTime } : {}) })

    it('is live while refreshes land inside the silence period', () => {
      expect(beaconPhase({ steps: [step(1, 0), step(2, sil / 2), step(3, sil)] }, sil + sil / 2, sil)).toEqual({ phase: 'live' })
    })

    it('lapses on a gap between mined beacons, permanently, and on a quiet tip', () => {
      expect(beaconPhase({ steps: [step(1, 0), step(2, sil + 1), step(3, sil + 2)] }, sil + 3, sil)).toMatchObject({ phase: 'ended', why: 'lapsed' })
      expect(beaconPhase({ steps: [step(1, 0)] }, sil + 1, sil)).toMatchObject({ phase: 'ended', why: 'lapsed' })
    })

    it('does not count a refresh still in the mempool', () => {
      expect(beaconPhase({ steps: [step(1, 0), step(2)] }, sil + 1, sil)).toMatchObject({ phase: 'ended', why: 'lapsed' })
      expect(beaconPhase({ steps: [step(1)] }, sil * 10, sil)).toEqual({ phase: 'live' })
    })

    it('ends on a retire and is released by a release', () => {
      expect(beaconPhase({ steps: [step(1, 0), { ...step(2, 10), retired: true }] }, 20, sil)).toMatchObject({ phase: 'ended', why: 'retired' })
      expect(beaconPhase({ steps: [step(1, 0)], release: { txid: 'ab'.repeat(32), keys: ['01'] } }, 20, sil)).toMatchObject({ phase: 'released' })
    })
  })

  it('follows the beacon chain spend by spend to the release', async () => {
    const r1 = refresh()
    const r1Spend = new Transaction()
    r1Spend.addInput({ sourceTransaction: r1, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    r1Spend.addOutput({ lockingScript: releaseDisclosureLock(assetId, disclosed), satoshis: 0 })
    const byTxid = new Map([r1, r1Spend].map((tx) => [String(tx.id('hex')), tx]))
    const spends = new Map([
      [`${deploy.id('hex')}_1`, String(r1.id('hex'))],
      [`${r1.id('hex')}_0`, String(r1Spend.id('hex'))],
    ])
    const source: BeaconChainSource = {
      spentBy: async (txid, vout) => spends.get(`${txid}_${vout}`) ?? null,
      tx: async (txid) => byTxid.get(txid) ?? null,
      blockTime: async () => 1_000,
      tipTime: async () => 2_000,
    }
    const view = await readBeaconChain({ assetId, sets, source })
    expect(view.steps.map((s) => s.outpoint)).toEqual([`${deploy.id('hex')}_1`, `${r1.id('hex')}_0`])
    expect(view.release?.txid).toBe(String(r1Spend.id('hex')))
    expect(beaconPhase(view, 2_000, MIN_SILENCE_SECONDS)).toMatchObject({ phase: 'released' })
  })

  it('a foreign disclosure ends the walk without a release', async () => {
    const bogus = new Transaction()
    bogus.addInput({ sourceTransaction: deploy, sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    bogus.addOutput({ lockingScript: releaseDisclosureLock(assetId, [PrivateKey.fromRandom(), PrivateKey.fromRandom()]), satoshis: 0 })
    const source: BeaconChainSource = {
      spentBy: async (txid) => (txid === String(deploy.id('hex')) ? String(bogus.id('hex')) : null),
      tx: async () => bogus,
      blockTime: async () => 1_000,
      tipTime: async () => 2_000,
    }
    const view = await readBeaconChain({ assetId, sets, source })
    expect(view.release).toBeUndefined()
  })

  it('routes a released asset to the holder and refuses an ended one', () => {
    const base = { deploy: deploys.get(assetId)!, identityKey: pub(holder), recipient: pub(recipient), amount: '5', held: 10n }
    expect(chooseCountersignTransferPath(base)).toMatchObject({ path: 'remote-acceptor' })
    expect(chooseCountersignTransferPath({ ...base, phase: { phase: 'released', txid: 'ab'.repeat(32), keys: ['01'] } })).toMatchObject({ path: 'released' })
    expect(chooseCountersignTransferPath({ ...base, phase: { phase: 'ended', why: 'lapsed', beacon: 'x' } })).toMatchObject({ path: 'refuse', reason: 'asset-ended' })
  })
})
