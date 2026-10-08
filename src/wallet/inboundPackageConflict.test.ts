import { describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import {
  findPackageConflict,
  knownPackageConflict,
  packageConflictFor,
  resetPackageConflictsForTests,
  unminedPackageInputs,
} from './inboundPackageConflict'
import type { OutpointSpendProbe } from './createActionInputFate'

const FUNDING = 'aa'.repeat(32)
const CONSOLIDATION = 'd65f31d0'.padEnd(64, '0')
const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

/** Sender change (unmined) → payment, both riding the package as raw txs. */
function deadPayment(): { atomic: number[]; parent: Transaction; child: Transaction } {
  const parent = new Transaction()
  parent.addInput({ sourceTXID: FUNDING, sourceOutputIndex: 3, unlockingScript: new Script() })
  parent.addOutput({ lockingScript: lock, satoshis: 6000 })
  const child = new Transaction()
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new Script() })
  child.addOutput({ lockingScript: lock, satoshis: 5435 })
  const beef = new Beef()
  beef.mergeTransaction(child)
  return { atomic: Array.from(beef.toBinaryAtomic(child.id('hex'))), parent, child }
}

function probeFrom(answers: Record<string, OutpointSpendProbe>) {
  return vi.fn(async (outpoints: string[]) => {
    const out = new Map<string, OutpointSpendProbe>()
    for (const o of outpoints) out.set(o, answers[o] ?? { kind: 'unknown' })
    return out
  })
}

describe('inbound package double-spend probe', () => {
  it('asks about every input of every unmined transaction, the subject first', () => {
    const { atomic, parent, child } = deadPayment()
    const inputs = unminedPackageInputs(atomic, child.id('hex'))
    expect(inputs?.outpoints).toEqual([`${parent.id('hex')}.0`, `${FUNDING}.3`])
  })

  it('names a coin an outside transaction spent, even one an ancestor spends', async () => {
    const { atomic, child } = deadPayment()
    const probe = probeFrom({ [`${FUNDING}.3`]: { kind: 'spent', spender: CONSOLIDATION } })
    await expect(findPackageConflict(atomic, child.id('hex'), 'main', probe)).resolves.toEqual({
      outpoint: `${FUNDING}.3`,
      spender: CONSOLIDATION,
    })
  })

  it('does not count the package spending its own coins as a conflict', async () => {
    const { atomic, parent, child } = deadPayment()
    const probe = probeFrom({
      [`${parent.id('hex')}.0`]: { kind: 'spent', spender: child.id('hex') },
      [`${FUNDING}.3`]: { kind: 'spent', spender: parent.id('hex') },
    })
    await expect(findPackageConflict(atomic, child.id('hex'), 'main', probe)).resolves.toBeNull()
  })

  it('reads silence as no conflict', async () => {
    const { atomic, child } = deadPayment()
    await expect(findPackageConflict(atomic, child.id('hex'), 'main', probeFrom({}))).resolves.toBeNull()
  })

  it('refuses a package that does not carry the subject', () => {
    const { atomic } = deadPayment()
    expect(unminedPackageInputs(atomic, 'bb'.repeat(32))).toBeNull()
  })

  it('remembers nothing it has not proven', async () => {
    resetPackageConflictsForTests()
    const { atomic, child } = deadPayment()
    expect(knownPackageConflict(child.id('hex'))).toBeNull()
    // No network in tests: the real probe answers unknown, which is clean.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    try {
      await expect(packageConflictFor(child.id('hex'), atomic, 'main')).resolves.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(knownPackageConflict(child.id('hex'))).toBeNull()
  })
})
