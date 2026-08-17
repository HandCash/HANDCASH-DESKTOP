/**
 * Headless live send/receive — same production functions the UI calls.
 *
 * Unlock:     bootWallet
 * Refresh:    refreshFromChain({ forceReview: true })   (Dashboard)
 * Send:       sendBrc29ToIdentityKey                     (SendPanel)
 * Receive:    ingestPaymentsFromTipHints                 (Dashboard tip poll)
 *
 *   npm run test:live-tx:print
 *   npm run test:live-tx
 */
import {
  formatFundBanner,
  loadOrCreateLiveWallets,
  minDepositSats,
  parseLiveTxEnv,
  publicFromRoot,
  type LiveTxEnv,
} from './liveSendReceiveEnv'
import type { ActiveWallet } from './session'

export type LivePhase = { name: string; ms: number; detail?: string }

export type LiveSendReceiveResult = {
  rounds: Array<{
    txid: string
    sendMs: number
    ingestMs: number
    accepted: boolean
  }>
  phases: LivePhase[]
  aliceAddress: string
  aliceIdentityKey: string
  bobIdentityKey: string
  aliceBalanceAfter: number
  bobBalanceAfter: number
}

type LogFn = (line: string) => void

function nowMs(): number {
  return Date.now()
}

export function liveLog(originMs: number, log: LogFn, msg: string): string {
  const line = `[live-tx +${String(nowMs() - originMs).padStart(6, ' ')}ms] ${msg}`
  log(line)
  return line
}

async function phase<T>(
  originMs: number,
  log: LogFn,
  phases: LivePhase[],
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  liveLog(originMs, log, `begin ${name}`)
  const t0 = nowMs()
  try {
    const result = await work()
    const ms = nowMs() - t0
    phases.push({ name, ms })
    liveLog(originMs, log, `done  ${name}  ${ms}ms`)
    return result
  } catch (err) {
    const ms = nowMs() - t0
    const detail = err instanceof Error ? err.message : String(err)
    phases.push({ name, ms, detail })
    liveLog(originMs, log, `FAIL  ${name}  ${ms}ms  ${detail}`)
    throw err
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopWallet(wallet: ActiveWallet): void {
  try {
    wallet.monitor?.stopTasks?.()
  } catch {
    // optional
  }
}

export async function runLiveSendReceive(opts?: {
  env?: LiveTxEnv
  log?: LogFn
}): Promise<LiveSendReceiveResult> {
  const env = opts?.env ?? parseLiveTxEnv()
  const log = opts?.log ?? console.info.bind(console)
  const originMs = nowMs()
  const phases: LivePhase[] = []

  const keys = loadOrCreateLiveWallets()
  const alicePub = publicFromRoot(keys.alice.rootKeyHex, keys.alice.handle, keys.chain)
  const bobPub = publicFromRoot(keys.bob.rootKeyHex, keys.bob.handle, keys.chain)
  const need = minDepositSats(env)
  log(formatFundBanner(alicePub, need))
  liveLog(originMs, log, `bob identity=${bobPub.identityKey.slice(0, 16)}…`)

  const { setWalletConfigPrefs } = await import('./walletConfig')
  const { setHistoryBackupPrefs } = await import('./historyBackupPrefs')
  const { restoreLiveWalletState, dumpLiveWalletState } = await import('./liveIdbPersist')
  const restored = await restoreLiveWalletState()
  if (restored > 0) {
    liveLog(originMs, log, `restored ${restored} live wallet db(s) from disk`)
  }

  setWalletConfigPrefs({ mode: 'none', historyBaseUrl: '', configuredAt: Date.now() })
  setHistoryBackupPrefs({ baseUrl: '' })

  const { bootWallet, setActiveWallet, fetchBalanceSats } = await import('./session')
  const { refreshFromChain } = await import('./chainIngest')
  const { sendBrc29ToIdentityKey, ingestPaymentsFromTipHints } = await import(
    './sendBrc29Payment'
  )

  let alice: ActiveWallet | undefined
  let bob: ActiveWallet | undefined
  try {
  alice = await phase(originMs, log, phases, 'boot-alice', () =>
    bootWallet({
      rootKeyHex: keys.alice.rootKeyHex,
      handle: keys.alice.handle,
      chain: keys.chain,
    }),
  )
  bob = await phase(originMs, log, phases, 'boot-bob', () =>
    bootWallet({
      rootKeyHex: keys.bob.rootKeyHex,
      handle: keys.bob.handle,
      chain: keys.chain,
    }),
  )
  setActiveWallet(alice)
  liveLog(
    originMs,
    log,
    `alice address=${alice.address} identity=${alice.identityKey.slice(0, 16)}…`,
  )

  const refreshAsDashboard = async () => {
    setActiveWallet(alice)
    const sats = await refreshFromChain({
      forceReview: true,
      announceReceive: false,
    })
    const spendableNow = sats ?? (await fetchBalanceSats(alice.wallet).catch(() => 0))
    liveLog(originMs, log, `refreshFromChain spendable=${spendableNow}`)
    return spendableNow
  }

  let spendable = await fetchBalanceSats(alice.wallet).catch(() => 0)
  if (spendable >= need) {
    liveLog(originMs, log, `alice already funded from disk (${spendable} sats)`)
  }
  // Still Refresh once so a new P2PKH deposit is swept on top of restored change.
  spendable = await refreshAsDashboard()
  if (spendable < need) {
    const deadline = nowMs() + env.waitMs
    await phase(originMs, log, phases, 'refresh-until-funded', async () => {
      while (nowMs() < deadline) {
        spendable = await refreshAsDashboard()
        if (spendable >= need) return spendable
        const left = Math.max(0, deadline - nowMs())
        liveLog(
          originMs,
          log,
          `Refresh did not credit deposit yet — retry ${Math.ceil(left / 1000)}s left`,
        )
        await sleep(Math.min(8_000, Math.max(1_000, left)))
      }
      throw new Error(
        `After Refresh, Alice spendable is ${spendable} (need ${need}). Send ≥${need} sats to ${alice.address}`,
      )
    })
  }

  const aliceBefore = await fetchBalanceSats(alice.wallet)
  liveLog(originMs, log, `alice spendable ${aliceBefore} sats`)

  const rounds: LiveSendReceiveResult['rounds'] = []
  for (let i = 0; i < env.rounds; i += 1) {
    const label = env.rounds > 1 ? `round-${i + 1}` : 'send'
    setActiveWallet(alice)
    const sendStarted = nowMs()
    const sent = await phase(originMs, log, phases, `${label}-broadcast`, () =>
      sendBrc29ToIdentityKey({
        payeeIdentityKey: bob.identityKey,
        satoshis: env.sats,
        description: 'headless live-tx',
      }),
    )
    const sendMs = nowMs() - sendStarted
    liveLog(
      originMs,
      log,
      `${label} txid=${sent.txid} peerDelivered=${String(sent.peerDelivered)} self=${String(sent.selfReceived)}`,
    )

    setActiveWallet(bob)
    const ingestStarted = nowMs()
    const received = await phase(originMs, log, phases, `${label}-ingest`, () =>
      ingestPaymentsFromTipHints([
        {
          txid: sent.txid,
          senderIdentityKey: alice.identityKey,
          satoshis: env.sats,
          brc29: sent.remittance,
          tx: sent.atomicBeef,
        },
      ]),
    )
    const ingestMs = nowMs() - ingestStarted
    const accepted = received.importedTxids.includes(sent.txid.toLowerCase())
    liveLog(
      originMs,
      log,
      `${label} ingest imported=${received.imported} accepted=${accepted} bobBalance=${received.balanceSats}`,
    )
    rounds.push({ txid: sent.txid, sendMs, ingestMs, accepted })
    if (!accepted) {
      throw new Error(`Payee did not internalize ${sent.txid}`)
    }
  }

  setActiveWallet(alice)
  const aliceBalanceAfter = await fetchBalanceSats(alice.wallet)
  setActiveWallet(bob)
  const bobBalanceAfter = await fetchBalanceSats(bob.wallet)

  liveLog(
    originMs,
    log,
    `summary alice=${aliceBalanceAfter} bob=${bobBalanceAfter} rounds=${rounds
      .map((r) => `${r.txid.slice(0, 8)}… send=${r.sendMs}ms ingest=${r.ingestMs}ms`)
      .join(' | ')}`,
  )

  return {
    rounds,
    phases,
    aliceAddress: alice.address,
    aliceIdentityKey: alice.identityKey,
    bobIdentityKey: bob.identityKey,
    aliceBalanceAfter,
    bobBalanceAfter,
  }
  } finally {
    try {
      const saved = await dumpLiveWalletState()
      liveLog(originMs, log, `saved ${saved} live wallet db(s) to disk`)
    } catch (err) {
      liveLog(
        originMs,
        log,
        `save live wallet db failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (alice) stopWallet(alice)
    if (bob) stopWallet(bob)
  }
}
