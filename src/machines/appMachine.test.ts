import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { appMachine, type WalletProfile } from './appMachine'

const profile: WalletProfile = {
  handle: 'brandon',
  identityKey: `02${'1'.repeat(64)}`,
  address: '1Primary',
  chain: 'main',
}

function readyActor(balanceSats = 12_345) {
  const actor = createActor(appMachine).start()
  actor.send({ type: 'BOOTSTRAPPED', hasVault: true, version: 'test' })
  actor.send({ type: 'UNLOCKED', profile, balanceSats })
  return actor
}

describe('app session chart', () => {
  it('takes the balance a send reports while ready', () => {
    const actor = readyActor()
    actor.send({ type: 'FAIL', error: 'earlier' })

    actor.send({ type: 'SENT', balanceSats: 9_000 })

    expect(actor.getSnapshot().matches('ready')).toBe(true)
    expect(actor.getSnapshot().context).toMatchObject({
      balanceSats: 9_000,
      balancePending: false,
      error: null,
    })
  })

  it('clears a pending balance when a send reports one', () => {
    const actor = readyActor()
    actor.send({ type: 'ACCOUNT_SWITCH_STARTED', profile })
    expect(actor.getSnapshot().context.balancePending).toBe(true)

    actor.send({ type: 'SENT', balanceSats: 500 })

    expect(actor.getSnapshot().context).toMatchObject({ balanceSats: 500, balancePending: false })
  })

  it('has no sending state', () => {
    expect(Object.keys(appMachine.config.states ?? {})).toEqual([
      'boot',
      'onboarding',
      'locked',
      'ready',
      'failure',
    ])
  })

  describe('leaving failure on BOOTSTRAPPED, as boot does', () => {
    function failedActor() {
      const actor = createActor(appMachine).start()
      actor.send({ type: 'FAIL', error: 'boot broke' })
      expect(actor.getSnapshot().matches('failure')).toBe(true)
      return actor
    }

    it('goes to locked when there is a vault', () => {
      const actor = failedActor()
      actor.send({ type: 'BOOTSTRAPPED', hasVault: true, version: '2.0.0' })
      expect(actor.getSnapshot().matches('locked')).toBe(true)
      expect(actor.getSnapshot().context).toMatchObject({ version: '2.0.0', error: null })
    })

    it('goes to restore-only onboarding for orphaned wallet data', () => {
      const actor = failedActor()
      actor.send({ type: 'BOOTSTRAPPED', hasVault: false, version: '2.0.0', orphanedToolbox: true })
      expect(actor.getSnapshot().matches('onboarding')).toBe(true)
      expect(actor.getSnapshot().context.recoveryOnly).toBe(true)
      expect(actor.getSnapshot().context.error).toMatch(/missing unlock keys/)
    })

    it('goes to onboarding with no vault', () => {
      const actor = failedActor()
      actor.send({ type: 'BOOTSTRAPPED', hasVault: false, version: '2.0.0' })
      expect(actor.getSnapshot().matches('onboarding')).toBe(true)
      expect(actor.getSnapshot().context).toMatchObject({ recoveryOnly: false, error: null })
    })

    it('returns to boot on CLEAR_ERROR', () => {
      const actor = failedActor()
      actor.send({ type: 'CLEAR_ERROR' })
      expect(actor.getSnapshot().matches('boot')).toBe(true)
      expect(actor.getSnapshot().context.error).toBeNull()
    })
  })
})
