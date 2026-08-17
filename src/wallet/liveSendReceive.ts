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
 *   HANDCASH_LIVE_ROUNDS=10 HANDCASH_LIVE_PINGPONG=1 npm run test:live-tx
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

export type LiveHop = {
  round: number
  direction: 'alice→bob' | 'bob→alice'
  txid: string
  sendMs: number
  ingestMs: number
  accepted: boolean
}

export type LiveSendReceiveResult = {
  /** @deprecated prefer `hops` — kept for older one-way runs */
  rounds: Array<{
    txid: string
    sendMs: number
    ingestMs: number
    accepted: boolean
  }>
  hops: LiveHop[]
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

function summarizeBottlenecks(hops: LiveHop[], log: LogFn): void {
  if (hops.length === 0) return
  const send = hops.map((h) => h.sendMs)
  const ingest = hops.map((h) => h.ingestMs)
  const total = hops.map((h) => h.sendMs + h.ingestMs)
  const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
  const maxOf = (xs: number[]) => Math.max(...xs)
  const minOf = (xs: number[]) => Math.min(...xs)
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b)
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
    return s[i]!
  }
  const a2b = hops.filter((h) => h.direction === 'alice→bob')
  const b2a = hops.filter((h) => h.direction === 'bob→alice')
  const meanSend = (xs: LiveHop[]) =>
    xs.length ? mean(xs.map((h) => h.sendMs)) : 0
  const meanIngest = (xs: LiveHop[]) =>
    xs.length ? mean(xs.map((h) => h.ingestMs)) : 0

  log('[live-tx bottleneck]')
  log(
    `  hops=${hops.length}  total=${total.reduce((a, b) => a + b, 0)}ms  ` +
      `send mean/p50/p95/max=${mean(send)}/${pct(send, 50)}/${pct(send, 95)}/${maxOf(send)}ms  ` +
      `ingest mean/p50/p95/max=${mean(ingest)}/${pct(ingest, 50)}/${pct(ingest, 95)}/${maxOf(ingest)}ms`,
  )
  log(
    `  hop total mean/p50/p95/max=${mean(total)}/${pct(total, 50)}/${pct(total, 95)}/${maxOf(total)}ms  ` +
      `min=${minOf(total)}ms`,
  )
  if (a2b.length && b2a.length) {
    log(
      `  alice→bob send/ingest mean=${meanSend(a2b)}/${meanIngest(a2b)}ms  ` +
        `bob→alice send/ingest mean=${meanSend(b2a)}/${meanIngest(b2a)}ms`,
    )
  }
  const slowest = [...hops].sort((a, b) => b.sendMs + b.ingestMs - (a.sendMs + a.ingestMs))[0]!
  log(
    `  slowest hop: round ${slowest.round} ${slowest.direction} ` +
      `send=${slowest.sendMs}ms ingest=${slowest.ingestMs}ms tx=${slowest.txid.slice(0, 12)}…`,
  )
  const sendShare = Math.round(
    (100 * send.reduce((a, b) => a + b, 0)) / Math.max(1, total.reduce((a, b) => a + b, 0)),
  )
  log(
    `  time share: send=${sendShare}% ingest=${100 - sendShare}%  ` +
      `(broadcast/createAction+remit vs tip-hint internalize)`,
  )
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
  liveLog(
    originMs,
    log,
    `bob identity=${bobPub.identityKey.slice(0, 16)}… pingpong=${env.pingpong} rounds=${env.rounds}`,
  )

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
    const aliceWallet = await phase(originMs, log, phases, 'boot-alice', () =>
      bootWallet({
        rootKeyHex: keys.alice.rootKeyHex,
        handle: keys.alice.handle,
        chain: keys.chain,
      }),
    )
    const bobWallet = await phase(originMs, log, phases, 'boot-bob', () =>
      bootWallet({
        rootKeyHex: keys.bob.rootKeyHex,
        handle: keys.bob.handle,
        chain: keys.chain,
      }),
    )
    alice = aliceWallet
    bob = bobWallet
    setActiveWallet(aliceWallet)
    liveLog(
      originMs,
      log,
      `alice address=${aliceWallet.address} identity=${aliceWallet.identityKey.slice(0, 16)}…`,
    )

    const refreshAsDashboard = async () => {
      setActiveWallet(aliceWallet)
      const sats = await refreshFromChain({
        forceReview: true,
        announceReceive: false,
      })
      const spendableNow = sats ?? (await fetchBalanceSats(aliceWallet.wallet).catch(() => 0))
      liveLog(originMs, log, `refreshFromChain spendable=${spendableNow}`)
      return spendableNow
    }

    let spendable = await fetchBalanceSats(aliceWallet.wallet).catch(() => 0)
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
          `After Refresh, Alice spendable is ${spendable} (need ${need}). Send ≥${need} sats to ${aliceWallet.address}`,
        )
      })
    }

    const aliceBefore = await fetchBalanceSats(aliceWallet.wallet)
    liveLog(originMs, log, `alice spendable ${aliceBefore} sats`)

    const hops: LiveHop[] = []

    const runHop = async (
      round: number,
      direction: LiveHop['direction'],
      payer: ActiveWallet,
      payee: ActiveWallet,
    ): Promise<LiveHop> => {
      const label = `r${round}-${direction === 'alice→bob' ? 'a2b' : 'b2a'}`
      setActiveWallet(payer)
      const sendStarted = nowMs()
      const sent = await phase(originMs, log, phases, `${label}-broadcast`, () =>
        sendBrc29ToIdentityKey({
          payeeIdentityKey: payee.identityKey,
          satoshis: env.sats,
          description: `headless live-tx ${label}`,
        }),
      )
      const sendMs = nowMs() - sendStarted
      liveLog(
        originMs,
        log,
        `${label} txid=${sent.txid} peerDelivered=${String(sent.peerDelivered)} self=${String(sent.selfReceived)} send=${sendMs}ms`,
      )

      setActiveWallet(payee)
      const ingestStarted = nowMs()
      const received = await phase(originMs, log, phases, `${label}-ingest`, () =>
        ingestPaymentsFromTipHints([
          {
            txid: sent.txid,
            senderIdentityKey: payer.identityKey,
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
        `${label} ingest imported=${received.imported} accepted=${accepted} balance=${received.balanceSats} ingest=${ingestMs}ms`,
      )
      if (!accepted) {
        throw new Error(`Payee did not internalize ${sent.txid} (${direction})`)
      }
      return { round, direction, txid: sent.txid, sendMs, ingestMs, accepted }
    }

    for (let i = 0; i < env.rounds; i += 1) {
      const round = i + 1
      if (env.pingpong) {
        hops.push(await runHop(round, 'alice→bob', aliceWallet, bobWallet))
        hops.push(await runHop(round, 'bob→alice', bobWallet, aliceWallet))
      } else {
        hops.push(await runHop(round, 'alice→bob', aliceWallet, bobWallet))
      }
    }

    setActiveWallet(aliceWallet)
    const aliceBalanceAfter = await fetchBalanceSats(aliceWallet.wallet)
    setActiveWallet(bobWallet)
    const bobBalanceAfter = await fetchBalanceSats(bobWallet.wallet)

    liveLog(
      originMs,
      log,
      `summary alice=${aliceBalanceAfter} bob=${bobBalanceAfter} hops=${hops
        .map(
          (h) =>
            `r${h.round}/${h.direction} ${h.txid.slice(0, 8)}… send=${h.sendMs}ms ingest=${h.ingestMs}ms`,
        )
        .join(' | ')}`,
    )
    summarizeBottlenecks(hops, log)

    return {
      rounds: hops.map(({ txid, sendMs, ingestMs, accepted }) => ({
        txid,
        sendMs,
        ingestMs,
        accepted,
      })),
      hops,
      phases,
      aliceAddress: aliceWallet.address,
      aliceIdentityKey: aliceWallet.identityKey,
      bobIdentityKey: bobWallet.identityKey,
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
