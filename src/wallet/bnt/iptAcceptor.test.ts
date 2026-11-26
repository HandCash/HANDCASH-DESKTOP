import { PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createIptAcceptor } from './iptAcceptor'
import type { IptReservationEvent } from './iptReservations'
import { signInput } from '../txInputs'
import { BNT_HOLDER_SCOPE, bntHeldLock, bntOpenUnlock, p2pkLock, type BntRules } from './script'
import type { BntDeploy } from './validity'

vi.mock('./iptRecipients', () => ({ verifyIptRecipients: vi.fn(async () => ['verified-recipient']) }))

// Same proposal fixture as iptProposal.test.ts: one holder input under a singleton countersigned issuer.
function fixture() {
  const holder = PrivateKey.fromRandom()
  const issuer = PrivateKey.fromRandom()
  const rules: BntRules = { mode: 'countersign', issuer: { m: 1, keys: [issuer.toPublicKey().toString()] }, release: { kind: 'hash', rel: 'ab'.repeat(20) } }
  const assetId = 'cd'.repeat(20)
  const parent = new Transaction()
  parent.addInput({ sourceTXID: 'ef'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  parent.addOutput({ satoshis: 1, lockingScript: bntHeldLock({ assetId, amount: 10n, clause: { ...rules, holder: holder.toPublicKey().toString() } }) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ satoshis: 1, lockingScript: bntHeldLock({ assetId, amount: 10n, clause: { ...rules, holder: holder.toPublicKey().toString() } }) })
  const sign = () => {
    tx.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(tx, 0, holder, BNT_HOLDER_SCOPE))
    return tx.toEF()
  }
  const accepted = new Map([[`${parent.id('hex')}.0`, { satoshis: 1, lockingScript: parent.outputs[0]!.lockingScript.toHex() }]])
  const deploy = { assetId, rules } as BntDeploy
  return { sign, accepted, deploy, issuer }
}

function feeFixture() {
  const feeKey = PrivateKey.fromRandom()
  const fee = new Transaction()
  fee.addInput({ sourceTXID: '12'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  fee.addOutput({ satoshis: 500, lockingScript: p2pkLock(feeKey.toPublicKey().toString()) })
  return { feeKey, fee }
}

describe('IPT acceptor durability (BRC-253 §§6, 8)', () => {
  it('a restart with only the reservation returns pending and never signs again', async () => {
    const f = fixture()
    const { feeKey, fee } = feeFixture()
    const events: IptReservationEvent[] = []
    const fund = vi.fn(async () => ({
      fee: { tx: fee, vout: 0 }, minimumFee: 1,
      signIssuer: async (tx: Transaction, vin: number, scope: number) => signInput(tx, vin, f.issuer, scope),
      signFee: async (tx: Transaction, vin: number, scope: number) => bntOpenUnlock(signInput(tx, vin, feeKey, scope)),
    }))
    const host = {
      journal: { read: () => events, append: (event: IptReservationEvent) => { events.push(structuredClone(event)) } },
      wallet: {} as Parameters<typeof createIptAcceptor>[0]['wallet'],
      deploy: f.deploy, accepted: f.accepted, authorize: vi.fn(async () => {}), fund,
    }
    const request = { sender: 'authenticated-sender', ef: f.sign(), recipients: [] }
    // Simulate a crash after the reservation was journaled but before signing.
    await createIptAcceptor(host).accept(request)
    events.splice(1)
    expect(events.map((e) => e.t)).toEqual(['reserved'])
    fund.mockClear()
    const restarted = await createIptAcceptor(host).accept(request)
    expect(restarted.state).toBe('pending')
    expect(fund).not.toHaveBeenCalled()
  })

  it('a signed replay returns the same bytes without funding again', async () => {
    const f = fixture()
    const { feeKey, fee } = feeFixture()
    const events: IptReservationEvent[] = []
    const fund = vi.fn(async () => ({
      fee: { tx: fee, vout: 0 }, minimumFee: 1,
      signIssuer: async (tx: Transaction, vin: number, scope: number) => signInput(tx, vin, f.issuer, scope),
      signFee: async (tx: Transaction, vin: number, scope: number) => bntOpenUnlock(signInput(tx, vin, feeKey, scope)),
    }))
    const host = {
      journal: { read: () => events, append: (event: IptReservationEvent) => { events.push(structuredClone(event)) } },
      wallet: {} as Parameters<typeof createIptAcceptor>[0]['wallet'],
      deploy: f.deploy, accepted: f.accepted, authorize: vi.fn(async () => {}), fund,
    }
    const request = { sender: 'authenticated-sender', ef: f.sign(), recipients: [] }
    const first = await createIptAcceptor(host).accept(request)
    expect(first.state).toBe('signed')
    const replay = await createIptAcceptor(host).accept(request)
    expect(replay).toEqual(first)
    expect(fund).toHaveBeenCalledTimes(1)
  })

  it('an authorization refusal before reservation is not held', async () => {
    const f = fixture()
    const events: IptReservationEvent[] = []
    const fund = vi.fn()
    const host = {
      journal: { read: () => events, append: (event: IptReservationEvent) => { events.push(structuredClone(event)) } },
      wallet: {} as Parameters<typeof createIptAcceptor>[0]['wallet'],
      deploy: f.deploy, accepted: f.accepted,
      authorize: async () => { throw new Error('sender not allowed') },
      fund,
    }
    const request = { sender: 'authenticated-sender', ef: f.sign(), recipients: [] }
    await expect(createIptAcceptor(host).accept(request)).rejects.toMatchObject({ name: 'IptAcceptError', held: false, message: 'sender not allowed' })
    expect(events).toEqual([])
    expect(fund).not.toHaveBeenCalled()
  })

  it('a failed reservation write is held, so only the same request may finish it', async () => {
    const f = fixture()
    const fund = vi.fn()
    const host = {
      journal: { read: () => [], append: () => { throw new Error('disk failure') } },
      wallet: {} as Parameters<typeof createIptAcceptor>[0]['wallet'],
      deploy: f.deploy, accepted: f.accepted, authorize: vi.fn(async () => {}), fund,
    }
    const request = { sender: 'authenticated-sender', ef: f.sign(), recipients: [] }
    const acceptor = createIptAcceptor(host)
    await expect(acceptor.accept(request)).rejects.toMatchObject({ name: 'IptAcceptError', held: true })
    expect(fund).not.toHaveBeenCalled()
  })
})
