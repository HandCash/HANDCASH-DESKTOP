import { describe, expect, it } from 'vitest'
import {
  loadOrCreateLiveWallets,
  minDepositSats,
  parseLiveTxEnv,
  publicFromRoot,
} from './liveSendReceiveEnv'

const env = parseLiveTxEnv()

describe.skipIf(!env.enabled)('live send/receive (mainnet)', () => {
  it('prints a stable Alice deposit address', () => {
    const keys = loadOrCreateLiveWallets()
    const alice = publicFromRoot(keys.alice.rootKeyHex, keys.alice.handle, keys.chain)
    const need = minDepositSats(env)
    console.info(
      `\nFund this address (≥${need} sats):\n  ${alice.address}\nIdentity:\n  ${alice.identityKey}\n`,
    )
    expect(alice.address.length).toBeGreaterThan(20)
    expect(alice.identityKey).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it.skipIf(env.printOnly)(
    'broadcasts a BRC-29 payment and the payee internalizes it',
    async () => {
      const { runLiveSendReceive } = await import('./liveSendReceive')
      const result = await runLiveSendReceive({ env, log: console.info.bind(console) })
      expect(result.rounds.length).toBe(env.rounds)
      for (const round of result.rounds) {
        expect(round.txid).toMatch(/^[0-9a-f]{64}$/)
        expect(round.accepted).toBe(true)
        expect(round.sendMs).toBeGreaterThan(0)
        expect(round.ingestMs).toBeGreaterThan(0)
      }
      expect(result.bobBalanceAfter).toBeGreaterThanOrEqual(env.sats * env.rounds)
      console.info(
        '[live-tx phases]\n',
        result.phases.map((p) => `${p.name}: ${p.ms}ms${p.detail ? ` (${p.detail})` : ''}`).join('\n'),
      )
    },
    env.waitMs + 5 * 60_000,
  )
})
