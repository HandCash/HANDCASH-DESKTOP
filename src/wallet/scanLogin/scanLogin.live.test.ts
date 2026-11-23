/**
 * Deployed mailbox protocol check; no real wallet, funds, credentials or account.
 * This does NOT verify native installation/runtime startup: the test acknowledges.
 *
 * HANDCASH_LIVE_PAIRING=1 npx vitest run --config vitest.live.config.ts src/wallet/scanLogin/scanLogin.live.test.ts
 */
import { PrivateKey } from '@bsv/sdk'
import { expect, it } from 'vitest'
import { helloScanLogin, confirmPairingCode, sendScanLoginVault } from './approver'
import { startScanLoginSession, subscribeScanLoginSession, endScanLoginSession, type ScanLoginEvent } from './receiver'
import { runScanLoginRelay } from './relay'

it.skipIf(process.env.HANDCASH_LIVE_PAIRING !== '1')('pairs through the deployed Worker with complete request proofs and a bound receipt', async () => {
  // Headless DOM uses browser-relative URLs; resolve them to the real test target.
  const fetchImpl: typeof fetch = (input, init) => fetch(
    new URL(String(input), 'https://brc-cloud.bcryderman.workers.dev'),
    { ...init, signal: AbortSignal.timeout(10_000) },
  )
  const payload = startScanLoginSession({ urls: [], label: 'Synthetic receiver' })
  let code = ''
  let received: Extract<ScanLoginEvent, { type: 'vault' }> | undefined
  const off = subscribeScanLoginSession((event) => {
    if (event.type === 'connected') code = event.code
    if (event.type === 'vault') received = event
  })
  const stop = runScanLoginRelay({ fetchImpl, pollMs: 300 })
  try {
    const conn = await helloScanLogin(payload, { label: 'Synthetic approver', fetchImpl, relayMs: 15_000 })
    expect(conn.url).toBe('relay')
    expect(code).toMatch(/^\d{6}$/)
    await expect(confirmPairingCode(conn, code === '000000' ? '111111' : '000000', fetchImpl))
      .rejects.toMatchObject({ reason: 'wrong', attemptsLeft: 2 })
    await confirmPairingCode(conn, code, fetchImpl)
    let completed = false
    const sending = sendScanLoginVault(conn, {
      v: 1,
      kind: 'handcash-brc250-vault',
      master: { derivation: 'brc-42', keyHex: PrivateKey.fromRandom().toHex() },
      enrollment: null,
      accounts: { version: 1 },
      sentAt: Date.now(),
    }, fetchImpl).then(() => { completed = true })
    // Observe rejection immediately, even if waiting for a slow Worker fails.
    const outcome = sending.then(() => null, (error: unknown) => error)
    try {
      await expect.poll(() => received != null, { timeout: 15_000 }).toBe(true)
      expect(completed).toBe(false)
      await received!.acknowledge()
      expect(await outcome).toBeNull()
      expect(completed).toBe(true)
    } finally {
      received?.fail()
    }
  } finally {
    stop()
    off()
    endScanLoginSession()
  }
}, 60_000)
