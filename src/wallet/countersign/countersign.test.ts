import { LockingScript, OP, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { decodeCountersignPayload, encodeCountersignPayload, MIN_SILENCE_SECONDS } from './payload'
import {
  checkAcceptRequest,
  readCountersignDeploy,
  resolveCountersignTransfer,
  type CountersignDeploy,
} from './resolve'
import {
  beaconLock,
  contentLock,
  COUNTERSIGN_SCOPE,
  countersignDeployLock,
  countersignedLock,
  countersignedUnlock,
  HOLDER_SCOPE,
  holderSignatureValid,
  holderUnlock,
  inputScriptValid,
  pubkeyHashHex,
  readCountersigned,
  readCountersignClause,
  requestIdOf,
  signInput,
  type CountersignKeySets,
} from './script'

const issuer = PrivateKey.fromRandom()
const successors = [PrivateKey.fromRandom(), PrivateKey.fromRandom()]
const holder = PrivateKey.fromRandom()
const recipient = PrivateKey.fromRandom()
const pub = (key: PrivateKey) => key.toPublicKey().toString()
const pkh = (key: PrivateKey) => pubkeyHashHex(pub(key))
const sets: CountersignKeySets = {
  issuer: { threshold: 1, keys: [pub(issuer)] },
  successor: { threshold: 2, keys: successors.map(pub) },
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
  tx.addOutput({ lockingScript: beaconLock(sets.issuer), satoshis: 1 })
  if (kind === 'item') tx.addOutput({ lockingScript: contentLock([1, 2, 3]), satoshis: 0 })
  return tx
}

function feeCoin(key = issuer) {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 300 })
  return tx
}

/** Holder signs ALL|ANYONECANPAY, then the issuer adds a fee coin and countersigns. */
function transfer(parent: Transaction, vout: number, outputs: Array<{ to: PrivateKey; amount: bigint }>, assetId: string, countersigner = issuer) {
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
  const countersig = signInput(tx, 0, countersigner, COUNTERSIGN_SCOPE)
  tx.inputs[0]!.unlockingScript = countersignedUnlock({
    countersignatures: [countersig],
    branch: 'issuer',
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
  it('parses only the canonical clause and refuses a successor in the issuer set', () => {
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
        sets: { issuer: sets.issuer, successor: { threshold: 1, keys: [pub(issuer)] } },
      }),
    ).toThrow(/successor/)
  })

  it('reads a deploy body: supply, payload, beacon', () => {
    const tx = deployTx('token', 1000n)
    const deploy = readCountersignDeploy(tx)
    expect(deploy).toMatchObject({ kind: 'token', supply: '1000', assetId: `${tx.id('hex')}_0` })
    const broken = deployTx('token', 1000n)
    broken.outputs[1] = { lockingScript: beaconLock({ threshold: 1, keys: [pub(holder)] }), satoshis: 1 }
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
    const stranger = transfer(deploy, 0, [{ to: recipient, amount: 100n }], assetId, PrivateKey.fromRandom()).tx
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
