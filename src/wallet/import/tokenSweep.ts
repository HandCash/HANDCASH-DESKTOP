import { Beef, P2PKH, type PrivateKey } from '@bsv/sdk'
import type { Chain } from '../vault'
import type { ActiveWallet } from '../session'
import { appendAppLog } from '../appLog'
import { buildLegacyInputBeef } from '../legacyBeef'
import { parseOrdEnvelope } from '../ordinalOwnership'
import { postForeignInputAction, type ForeignInput } from '../foreignInputAction'
import { runExclusiveSpend } from '../spendGuard'
import { isInsufficientFundsError } from '../insufficientFunds'
import { buildBsv21TransferLockingScript } from '../token/legacyInscribe'
import { detectCosignFromLockingScript } from '../token/tipKind'
import { sweepMneeFromKey, type MneeHold } from '../mnee'
import { MNEE_TOKEN_ID, isMneeTokenId } from '../mneeTip'
import { yieldToUi } from '../yieldToUi'
import { gorillaBase } from './discovery'
import { addHeld, type HeldTally, type ImportHoldReason, type TokenHolding } from './holdings'

/**
 * Move BSV-21 tokens from an imported key to this wallet's own address.
 *
 * A BSV-21 transfer is valid only if every token input is valid and the
 * outputs sum exactly to the inputs; one bad input burns the whole
 * transaction's tokens. So a tip moves only when the indexer marks it valid,
 * it is not listed, and its own script says the same id and amount. All tips
 * of one id merge into a single transfer output carrying the exact total —
 * no token change, nothing stranded. The output lands on this wallet's
 * address, where chain ingest imports it into basket `bsv21` through the same
 * path as any token received there.
 */

const MAX_TOKEN_INPUTS_PER_TX = 40
const ID_PAGE = 100

export type TokenTip = {
  outpoint: string
  txid: string
  vout: number
  amt: bigint
}

type IndexedTip = {
  txid: string
  vout: number
  satoshis: number
  amt: string
  status: number
  listing: boolean
  spend: string
}

export type TokenTipDecision =
  | { kind: 'move'; tip: TokenTip }
  | { kind: 'hold'; reason: ImportHoldReason }

/** Decide one indexed tip from its real locking script. */
export function chooseTokenTip(args: {
  indexed: IndexedTip
  tokenId: string
  lockingScriptHex: string | null
  satoshis: number | null
  spendLockHex: string
}): TokenTipDecision {
  const { indexed } = args
  if (indexed.listing) return { kind: 'hold', reason: 'listed' }
  if (indexed.status === 0) return { kind: 'hold', reason: 'tokenPending' }
  if (indexed.status !== 1) return { kind: 'hold', reason: 'tokenInvalid' }
  const hex = (args.lockingScriptHex ?? '').toLowerCase()
  if (!hex || args.satoshis !== 1) return { kind: 'hold', reason: 'tokenUnreadable' }
  if (detectCosignFromLockingScript(hex)) return { kind: 'hold', reason: 'cosigned' }
  const lock = args.spendLockHex.toLowerCase()
  if (!hex.startsWith(lock) && !hex.endsWith(lock)) return { kind: 'hold', reason: 'foreign' }
  const envelope = parseOrdEnvelope(hex)
  if (envelope?.contentType !== 'application/bsv-20') {
    return { kind: 'hold', reason: 'tokenUnreadable' }
  }
  let json: { p?: unknown; id?: unknown; amt?: unknown; op?: unknown }
  try {
    json = JSON.parse(new TextDecoder().decode(envelope.body)) as typeof json
  } catch {
    return { kind: 'hold', reason: 'tokenUnreadable' }
  }
  const amt = typeof json.amt === 'string' && /^\d+$/.test(json.amt) ? BigInt(json.amt) : null
  const scriptId = typeof json.id === 'string' ? json.id.toLowerCase().replace('.', '_') : null
  // A `deploy+mint` output names no id; its id is its own outpoint.
  const selfId = `${indexed.txid}_${indexed.vout}`.toLowerCase()
  const idMatches =
    scriptId === args.tokenId.toLowerCase() ||
    (json.op === 'deploy+mint' && selfId === args.tokenId.toLowerCase())
  if (json.p !== 'bsv-20' || !idMatches || amt == null || amt <= 0n) {
    return { kind: 'hold', reason: 'tokenUnreadable' }
  }
  if (amt.toString() !== String(indexed.amt)) return { kind: 'hold', reason: 'tokenUnreadable' }
  return {
    kind: 'move',
    tip: { outpoint: `${indexed.txid}.${indexed.vout}`, txid: indexed.txid, vout: indexed.vout, amt },
  }
}

async function fetchIndexedTips(address: string, tokenId: string, chain: Chain): Promise<IndexedTip[]> {
  const out: IndexedTip[] = []
  for (let offset = 0; offset < 10_000; offset += ID_PAGE) {
    const res = await fetch(
      `${gorillaBase(chain)}/api/bsv20/${encodeURIComponent(address)}/id/${encodeURIComponent(tokenId)}?limit=${ID_PAGE}&offset=${offset}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) throw new Error(`Token index ${res.status}`)
    const rows = (await res.json()) as unknown
    if (!Array.isArray(rows)) break
    for (const row of rows as Array<Record<string, unknown>>) {
      const txid = String(row.txid ?? '').toLowerCase()
      const vout = Number(row.vout)
      if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout)) continue
      if (typeof row.spend === 'string' && row.spend) continue
      out.push({
        txid,
        vout,
        satoshis: Number(row.satoshis ?? 0),
        amt: String(row.amt ?? '0'),
        status: Number(row.status ?? 0),
        listing: row.listing === true,
        spend: String(row.spend ?? ''),
      })
    }
    if (rows.length < ID_PAGE) break
  }
  return out
}

export type TokenSweepResult = {
  moved: Array<{ tokenId: string; amount: string; txid: string }>
  held: HeldTally
  failed: number
  /** `propagating`: the last transfer is signed but its change cannot fund the next one yet. */
  stopped: 'funds' | 'propagating' | null
  errors: string[]
}

const MNEE_HOLDS: Record<MneeHold, ImportHoldReason> = {
  unreadable: 'tokenUnreadable',
  amount: 'tokenUnreadable',
  foreign: 'foreign',
  cosigner: 'cosigned',
}

/** MNEE never takes the generic path: its cosigner moves it, `mnee.ts` files it. */
async function sweepMnee(active: ActiveWallet, spendKey: PrivateKey, result: TokenSweepResult): Promise<void> {
  const mnee = await sweepMneeFromKey({ active, key: spendKey })
  if (mnee.kind === 'moved' || mnee.kind === 'empty') {
    for (const [reason, count] of Object.entries(mnee.held) as Array<[MneeHold, number]>) {
      result.held = addHeld(result.held, MNEE_HOLDS[reason], count)
    }
  }
  switch (mnee.kind) {
    case 'moved':
      result.moved.push({ tokenId: MNEE_TOKEN_ID, amount: mnee.amount.toString(), txid: mnee.txid })
      if (mnee.unfinished) {
        result.failed += 1
        result.errors.push(`Some MNEE did not move: ${mnee.unfinished}`)
      }
      return
    case 'empty':
      return
    case 'refused':
      result.held = addHeld(result.held, mnee.reason === 'belowFee' ? 'dust' : 'cosigned')
      return
    case 'failed':
      result.failed += 1
      result.errors.push(`MNEE ${mnee.stage}: ${mnee.message}`)
      appendAppLog('warn', `[import] mnee sweep failed stage=${mnee.stage}: ${mnee.message}`)
      return
  }
}

/** Sweep every compatible BSV-21 balance held by one imported address. */
export async function sweepTokensFromAddress(args: {
  active: ActiveWallet
  spendKey: PrivateKey
  address: string
  tokens: TokenHolding[]
}): Promise<TokenSweepResult> {
  const { active, spendKey } = args
  const result: TokenSweepResult = { moved: [], held: {}, failed: 0, stopped: null, errors: [] }
  const spendLockHex = new P2PKH().lock(spendKey.toPublicKey().toAddress()).toHex()

  for (const token of args.tokens) {
    if (token.standard !== 'bsv21' || !token.id) {
      result.held = addHeld(result.held, 'bsv20v1')
      continue
    }
    if (isMneeTokenId(token.id)) {
      await sweepMnee(active, spendKey, result)
      continue
    }
    let indexed: IndexedTip[]
    try {
      indexed = await fetchIndexedTips(args.address, token.id, active.chain)
    } catch (err) {
      result.failed += 1
      result.errors.push(err instanceof Error ? err.message : String(err))
      continue
    }
    if (indexed.length === 0) continue
    const built = await buildLegacyInputBeef(
      active.services,
      indexed.map((tip) => `${tip.txid}.${tip.vout}`),
      { concurrency: 6 },
    )
    const beef = built.beef.length > 0 ? Beef.fromBinary(built.beef) : null
    const moving: Array<TokenTip & { input: ForeignInput }> = []
    for (const tip of indexed) {
      const sourceOut = beef?.findTxid(tip.txid)?.tx?.outputs[tip.vout] ?? null
      const decision = chooseTokenTip({
        indexed: tip,
        tokenId: token.id,
        lockingScriptHex: sourceOut?.lockingScript?.toHex() ?? null,
        satoshis: sourceOut?.satoshis ?? null,
        spendLockHex,
      })
      if (decision.kind === 'hold') {
        result.held = addHeld(result.held, decision.reason)
        continue
      }
      moving.push({
        ...decision.tip,
        input: {
          outpoint: decision.tip.outpoint,
          txid: decision.tip.txid,
          vout: decision.tip.vout,
          satoshis: 1,
          sourceLock: sourceOut!.lockingScript,
          description: 'sweep imported token',
        },
      })
    }

    for (let i = 0; i < moving.length; i += MAX_TOKEN_INPUTS_PER_TX) {
      const group = moving.slice(i, i + MAX_TOKEN_INPUTS_PER_TX)
      const total = group.reduce((sum, tip) => sum + tip.amt, 0n).toString()
      const { lockingScript } = buildBsv21TransferLockingScript({
        address: active.address,
        tokenId: token.id,
        amt: total,
        sym: token.sym,
        ...(token.icon ? { icon: token.icon } : {}),
        dec: token.dec,
      })
      await yieldToUi()
      try {
        const { txid, propagation } = await runExclusiveSpend(() =>
          postForeignInputAction({
            active,
            spendKey,
            inputBeef: built.beef,
            inputs: group.map((tip) => tip.input),
            // No basket: chain ingest imports it from this wallet's address
            // into `bsv21` with the same lineage checks as any received token.
            outputs: [
              {
                lockingScript,
                satoshis: 1,
                outputDescription: `Imported ${token.sym}`.slice(0, 50),
              },
            ],
            labels: ['bsv21', 'legacy-import'],
            description: `Sweep ${token.sym} from imported wallet`.slice(0, 50),
          }),
        )
        result.moved.push({ tokenId: token.id, amount: total, txid })
        appendAppLog(
          'info',
          `[import] token sweep ${token.id} amt=${total} inputs=${group.length} txid=${txid} ${propagation}`,
        )
        if (propagation === 'propagating') {
          result.stopped = 'propagating'
          return result
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (isInsufficientFundsError(err)) {
          result.stopped = 'funds'
          result.errors.push(reason)
          return result
        }
        result.failed += group.length
        result.errors.push(reason)
        appendAppLog('warn', `[import] token sweep ${token.id} failed: ${reason}`)
      }
    }
  }
  return result
}
