import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { appMachine, type WalletProfile } from './appMachine'

const primary: WalletProfile = {
  handle: 'brandon',
  identityKey: `02${'1'.repeat(64)}`,
  address: '1Primary',
  chain: 'main',
}

const secondary: WalletProfile = {
  handle: 'brandon',
  identityKey: `03${'2'.repeat(64)}`,
  address: '1Secondary',
  chain: 'main',
}

describe('app wallet-account projection', () => {
  it('hides the prior balance until the selected runtime answers', () => {
    const actor = createActor(appMachine).start()
    actor.send({ type: 'BOOTSTRAPPED', hasVault: true, version: 'test' })
    actor.send({ type: 'UNLOCKED', profile: primary, balanceSats: 12_345 })

    actor.send({ type: 'ACCOUNT_SWITCH_STARTED', profile: secondary })
    expect(actor.getSnapshot().context).toMatchObject({
      profile: secondary,
      balanceSats: 0,
      balancePending: true,
    })

    actor.send({
      type: 'ACCOUNT_SWITCHED',
      profile: secondary,
      balanceSats: 678,
    })
    expect(actor.getSnapshot().context).toMatchObject({
      profile: secondary,
      balanceSats: 678,
      balancePending: false,
    })
  })

  it('leaves sending when an account switch starts', () => {
    const actor = createActor(appMachine).start()
    actor.send({ type: 'BOOTSTRAPPED', hasVault: true, version: 'test' })
    actor.send({ type: 'UNLOCKED', profile: primary, balanceSats: 12_345 })
    actor.send({ type: 'OPEN_SEND' })

    actor.send({ type: 'ACCOUNT_SWITCH_STARTED', profile: secondary })

    expect(actor.getSnapshot().matches('ready')).toBe(true)
    expect(actor.getSnapshot().context.balancePending).toBe(true)
  })
})
