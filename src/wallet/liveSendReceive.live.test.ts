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
    'broadcasts BRC-29 payments and the payee internalizes them',
    async () => {
      const { runLiveSendReceive } = await import('./liveSendReceive')
      const result = await runLiveSendReceive({ env, log: console.info.bind(console) })
      const expectedHops = env.pingpong ? env.rounds * 2 : env.rounds
      expect(result.hops.length).toBe(expectedHops)
      expect(result.rounds.length).toBe(expectedHops)
      for (const hop of result.hops) {
        expect(hop.txid).toMatch(/^[0-9a-f]{64}$/)
        expect(hop.accepted).toBe(true)
        expect(hop.sendMs).toBeGreaterThan(0)
        expect(hop.ingestMs).toBeGreaterThan(0)
      }
      if (!env.pingpong) {
        expect(result.bobBalanceAfter).toBeGreaterThanOrEqual(env.sats * env.rounds)
      }
      console.info(
        '[live-tx phases]\n',
        result.phases.map((p) => `${p.name}: ${p.ms}ms${p.detail ? ` (${p.detail})` : ''}`).join('\n'),
      )
    },
    env.waitMs + 5 * 60_000,
  )
})
