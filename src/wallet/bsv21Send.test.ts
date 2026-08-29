import { Beef, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { decodeBsv21Binary, encodeBsv21Binary } from './bsv21Binary'
import { hasOrdEnvelope, parseOrdEnvelope } from './ordinalOwnership'
import {
  assertBsv21AmtConservation,
  buildBsv21SendOutputs,
  buildBsv21SendRemittance,
  buildBsv21SubjectBeef,
  buildBsv21ValueLock,
  planBsv21Send,
  tipFromBsv21Script,
} from './bsv21Send'

const PAYEE = PrivateKey.fromRandom().toAddress()
const CHANGE = PrivateKey.fromRandom().toAddress()
const P2PKH_REST = `76a914${'11'.repeat(20)}88ac`

function deployTx(amount: bigint): Transaction {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({
      amount,
      payload: { sym: 'GOLD', dec: 2 },
      rest: P2PKH_REST,
    }),
  })
  return tx
}

function tokenIdOf(tx: Transaction, vout = 0): string {
  return `${tx.id('hex')}_${vout}`
}

describe('bsv21Send conservation', () => {
  it('splits a 100-unit tip into payee 60 + 162 change 40', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    const plan = planBsv21Send({
      tokenId,
      amount: 60n,
      tips: [{ outpoint: `${'cd'.repeat(32)}_1`, tokenId, amt: 100n }],
    })
    expect(plan.payeeAmt).toBe(60n)
    expect(plan.changeAmt).toBe(40n)
    expect(plan.selectedSum).toBe(100n)
    assertBsv21AmtConservation(
      plan.selected.map((t) => t.amt),
      [plan.payeeAmt, plan.changeAmt],
    )

    const outputs = buildBsv21SendOutputs({
      tokenId,
      payeeAmt: plan.payeeAmt,
      changeAmt: plan.changeAmt,
      payeeAddress: PAYEE,
      changeAddress: CHANGE,
      sym: 'GOLD',
      dec: 2,
    })
    expect(outputs).toHaveLength(2)
    expect(outputs.map((o) => o.role)).toEqual(['payee', 'change'])
    expect(outputs.every((o) => o.satoshis === 1)).toBe(true)
    expect(outputs.every((o) => o.basket === 'bsv21')).toBe(true)

    for (const out of outputs) {
      expect(hasOrdEnvelope(out.lockingScript)).toBe(false)
      expect(parseOrdEnvelope(out.lockingScript)).toBeNull()
      const decoded = decodeBsv21Binary(out.lockingScript)
      expect(decoded).toMatchObject({
        role: 'value',
        tokenId,
        amount: BigInt(out.amt),
      })
      const ci = JSON.parse(out.customInstructions) as {
        p: string
        id: string
        amt: string
        op: string
      }
      expect(ci.p).toBe('bsv-20')
      expect(ci.id).toBe(tokenId)
      expect(ci.id).toContain('_')
      expect(ci.id).not.toContain('.')
      expect(ci.amt).toMatch(/^\d+$/)
      expect(ci.op).toBe('transfer')
      expect(out.tags).toContain('bsv21')
      expect(out.tags).toContain(`bsv21:${tokenId}`)
      expect(out.tags).toContain(`amt:${out.amt}`)
    }
    expect(outputs[0]!.amt).toBe('60')
    expect(outputs[1]!.amt).toBe('40')
  })

  it('omits change when the selected tip is exact', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    const plan = planBsv21Send({
      tokenId,
      amount: 100n,
      tips: [{ outpoint: `${'cd'.repeat(32)}_0`, tokenId, amt: 100n }],
    })
    expect(plan.changeAmt).toBe(0n)
    const outputs = buildBsv21SendOutputs({
      tokenId,
      payeeAmt: plan.payeeAmt,
      changeAmt: plan.changeAmt,
      payeeAddress: PAYEE,
      changeAddress: CHANGE,
    })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.role).toBe('payee')
    expect(decodeBsv21Binary(outputs[0]!.lockingScript)?.role).toBe('value')
  })

  it('refuses over-send', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    expect(() =>
      planBsv21Send({
        tokenId,
        amount: 101n,
        tips: [{ outpoint: `${'cd'.repeat(32)}_0`, tokenId, amt: 100n }],
      }),
    ).toThrow(/only 100/)
  })

  it('builds a 176 BEEF that proves payee and change', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const payeeLock = buildBsv21ValueLock({
      tokenId: id,
      amount: 60n,
      address: PAYEE,
    })
    const changeLock = buildBsv21ValueLock({
      tokenId: id,
      amount: 40n,
      address: CHANGE,
    })
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: deploy,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    spend.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({
      tokenId: id,
      amount: 60n,
      rest: decodeBsv21Binary(payeeLock)!.restScriptHex,
    }) })
    spend.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({
      tokenId: id,
      amount: 40n,
      rest: decodeBsv21Binary(changeLock)!.restScriptHex,
    }) })

    const { proofs } = buildBsv21SubjectBeef({
      parentBeef: new Beef(),
      subjectTx: spend,
    })
    expect(proofs).toHaveLength(2)
    expect(proofs[0]).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 60n,
      deployOutpoint: id,
      role: 'value',
    })
    expect(proofs[1]).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 40n,
      deployOutpoint: id,
    })
  })
})

describe('bsv21Send remittance', () => {
  it('uses underscore token id and decimal amt', () => {
    const tokenId = `${'ab'.repeat(32)}_7`
    const remit = buildBsv21SendRemittance({
      tokenId: tokenId.replace('_', '.'),
      amt: 60n,
      sym: 'GOLD',
      dec: 2,
    })
    const ci = JSON.parse(remit.customInstructions) as {
      id: string
      amt: string
      dec: string
    }
    expect(ci.id).toBe(tokenId)
    expect(ci.amt).toBe('60')
    expect(ci.dec).toBe('2')
    expect(remit.basket).toBe('bsv21')
    expect(remit.tags).toContain(`bsv21:${tokenId}`)
    expect(remit.tags).toContain('amt:60')
  })

  it('carries icon outpoint on 163 remittance', () => {
    const tokenId = `${'ab'.repeat(32)}_7`
    const icon = `${'cd'.repeat(32)}_1`
    const remit = buildBsv21SendRemittance({
      tokenId,
      amt: 60n,
      sym: 'GOLD',
      icon,
    })
    const ci = JSON.parse(remit.customInstructions) as { icon?: string }
    expect(ci.icon).toBe(icon)
    expect(remit.tags).toContain(`icon:${icon}`)
  })

  it('decodes a 162 listed script as a spendable tip', () => {
    const tokenId = `${'ab'.repeat(32)}_0`
    const script = buildBsv21ValueLock({
      tokenId,
      amount: 88n,
      address: PAYEE,
    })
    const tip = tipFromBsv21Script({
      outpoint: `${'cd'.repeat(32)}.3`,
      lockingScript: script,
      satoshis: 1,
    })
    expect(tip).toMatchObject({
      outpoint: `${'cd'.repeat(32)}_3`,
      tokenId,
      amt: 88n,
    })
    expect(
      tipFromBsv21Script({
        outpoint: `${'cd'.repeat(32)}_3`,
        lockingScript: P2PKH_REST,
        satoshis: 1,
      }),
    ).toBeNull()
  })
})
