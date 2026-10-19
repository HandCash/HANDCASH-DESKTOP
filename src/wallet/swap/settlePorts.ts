import { appendCustody, type SwapLockRecipe } from '../custodyJournal'
import type { ActiveWallet } from '../session'
import { getWalletRuntime } from '../walletRuntime'
import type { SelfRemittance } from './legChains'
import type { FeeLockReport } from './feeClaim'
import { parseSettleMessage, SWAP_SETTLE_BOX, type SettleMessage } from './settle'

/** What settlement touches outside its own record: the open account, the custody journal and box `swap-settle`. */

export function requireActiveWallet(): ActiveWallet {
  const active = getWalletRuntime()?.instance ?? null
  if (!active) throw new Error('Wallet locked')
  return active
}

const ownerOf = (active: ActiveWallet) => ({ identityKey: active.identityKey, accountIndex: active.accountIndex ?? 0, chain: active.chain })
const custodyOp = (outpoint: string) => outpoint.replace(':', '.')

function append(active: ActiveWallet, entries: unknown[], what: string): void {
  const { ok } = appendCustody(ownerOf(active), entries)
  if (!ok) throw new Error(`The custody journal refused ${what}.`)
}

/** Write-ahead of a BSV claim or refund: the BRC-29 self-payment it lands in. */
export function journalBsvSelfPayment(active: ActiveWallet, outpoint: string, sats: bigint, remittance: SelfRemittance): void {
  append(active, [{ k: 'out', op: custodyOp(outpoint), sats: Number(sats), r: { p: 'wallet payment', prefix: remittance.derivationPrefix, suffix: remittance.derivationSuffix } }], `the recipe of ${outpoint}`)
}

/** A swap lock this wallet can spend (its own, refundable; or the counterparty's, claimable): recoverable from the seed and these terms. */
export function journalSwapLock(active: ActiveWallet, outpoint: string, units: bigint, recipe: Omit<SwapLockRecipe, 'p'>): void {
  append(active, [{ k: 'out', op: custodyOp(outpoint), sats: Number(units), r: { p: 'swap lock', ...recipe } }], `the swap lock ${outpoint}`)
}

/** The chain showed the lock spent. */
export function journalSwapLockSpent(active: ActiveWallet, outpoint: string): void {
  append(active, [{ k: 'spent', op: custodyOp(outpoint) }], `the spend of ${outpoint}`)
}

/**
 * A BSV lock that can never be mined: the landing watch retired it, and the
 * chain holds another transaction spending one of its coins. Only that
 * positive fact counts; silence, a 404 or an unreachable explorer never does.
 */
export async function bsvLockProvenUnsent(active: ActiveWallet, txid: string, beef: string | undefined): Promise<boolean> {
  const { txIsArcadeRejected } = await import('../arcadeSubmitGuard')
  if (!txIsArcadeRejected(txid)) return false
  const { inputOutpointsForSignedTx } = await import('../signedTxInputs')
  const inputs = await inputOutpointsForSignedTx(txid, beef ? Array.from(atob(beef), (c) => c.charCodeAt(0)) : undefined)
  if (inputs.length === 0) return false
  const { probeOutpointSpends } = await import('../createActionInputFate')
  const { txExistsOnChain } = await import('../legacyScan')
  const probes = await probeOutpointSpends(inputs, txid, active.chain)
  for (const probe of probes.values()) {
    if (probe.kind !== 'spent' || probe.spender.toLowerCase() === txid.toLowerCase()) continue
    if ((await txExistsOnChain(probe.spender, active.chain).catch(() => null)) === true) return true
  }
  return false
}

export async function sendSettle(active: ActiveWallet, to: string, message: SettleMessage): Promise<void> {
  const { sendSealedToPeerBox } = await import('../messageTransport')
  await sendSealedToPeerBox(active.rootKeyHex, to, SWAP_SETTLE_BOX, JSON.stringify(message))
}

export type SettleInbound = { messageId: string; sender: string; message: SettleMessage | null }

/** Box `swap-settle`, each message opened from its sender; null when the host did not answer. */
export async function readSettleBox(active: ActiveWallet): Promise<SettleInbound[] | null> {
  const { listSealedOwnBox } = await import('../messageTransport')
  const listed = await listSealedOwnBox(active.rootKeyHex, SWAP_SETTLE_BOX)
  if (!listed) return null
  return listed
    .filter((m) => m.messageId)
    .map((m) => ({ messageId: m.messageId, sender: m.sender.toLowerCase(), message: m.plaintext ? parseSettleMessage(m.plaintext) : null }))
}

export async function ackSettleBox(active: ActiveWallet, ids: string[]): Promise<void> {
  if (!ids.length) return
  const { acknowledgeOwnBox } = await import('../messageTransport')
  await acknowledgeOwnBox(active.rootKeyHex, SWAP_SETTLE_BOX, ids)
}

/**
 * Tell HandCash's fee claimer about a fee output (BRC-CLOUD `/v1/swap-fees`).
 * True once the claimer took it or refused it for good; false to try again.
 * Never gates the swap: an unreported fee output returns to its payer.
 */
export async function reportFeeLock(report: FeeLockReport): Promise<boolean> {
  const { PUBLIC_BRC_CLOUD_ORIGIN } = await import('../walletConfig')
  const res = await fetch(`${PUBLIC_BRC_CLOUD_ORIGIN}/v1/swap-fees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.ok) return true
  if (res.status === 400) {
    console.warn(`[swap-settle] fee claimer refused the report: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    return true
  }
  return false
}
