import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const walletRoot = resolve(import.meta.dirname)

const outboundModules = [
  'sendPayment.ts',
  'sendBrc29Payment.ts',
  'token/send.ts',
  'collectables.ts',
  'burn.ts',
  'token/burn.ts',
  'marketListing.ts',
  'marketSettlement.ts',
  'appSignedCheque.ts',
] as const

const lifecycleOnlyModules = outboundModules.filter(
  (path) => path !== 'sendBrc29Payment.ts',
)

function source(path: string): string {
  return readFileSync(resolve(walletRoot, path), 'utf8')
}

describe('signed send lifecycle adherence', () => {
  it.each(outboundModules)(
    '%s registers every signed cheque with the shared lifecycle',
    (path) => {
      expect(source(path)).toContain('registerSignedSend')
    },
  )

  it.each(lifecycleOnlyModules)(
    '%s does not reimplement sealing or miner submission',
    (path) => {
      const text = source(path)
      expect(text).not.toContain('sealSpentInputsOfSignedTx(')
      expect(text).not.toContain('submitAtomicBeefToMiners(')
      expect(text).not.toContain('broadcastAtomicBeef(')
    },
  )

  it('keeps the low-level transaction relationship in one module', () => {
    const text = source('signedSendLifecycle.ts')
    expect(text).toContain('sealSpentInputsOfSignedTx(')
    expect(text).toContain('archiveSignedCheque(')
    expect(text).toContain('enqueuePendingMinerSubmit(')
    expect(text).toContain('submitAtomicBeefToMiners(')
    expect(text).toContain('tryFinalizeDualLayerTx(')
    // Signing is the irreversible wallet boundary. Auxiliary persistence
    // pressure may degrade retry durability, never abandon or unseal a cheque.
    expect(text).not.toContain('releaseSealedInputsOfUnsentTx(')
    expect(text).not.toContain('could not be queued for propagation')
    expect(text).not.toContain('could not be archived')
  })

  it('puts app createAction and signAction on the same cheque funnel', () => {
    expect(source('brc100Handler.ts')).toContain('funnelAppSignedCheque(')
    expect(source('appSignedCheque.ts')).toContain('registerSignedSend')
  })
})
