/**
 * One token card set beside the history that should explain it.
 *
 * A card is the sum of the tips the read projected, and they are not all the
 * same kind: a BRC-162 value lock is what send can spend, a legacy JSON tip is
 * read-only, and a continuing remittance row is a plain script whose amount
 * comes from metadata alone. History is this wallet's Activity for the token.
 * The ledger line puts the three next to each other so triage can say which
 * part of a balance the history does not account for.
 */
import type { ActivityEntry } from '../appActivity'
import type { Bsv21Utxo, FungibleToken } from './types'

export type TokenTipKind = 'brc162' | 'legacy-json' | 'remittance'

export type TokenLedger = {
  sym: string
  tokenId: string
  held: bigint
  byKind: Record<TokenTipKind, { amt: bigint; tips: number }>
  historyIn: bigint
  historyOut: bigint
  historyRows: number
  tips: Array<{ outpoint: string; amt: bigint; kind: TokenTipKind }>
}

const LEDGER_TIPS_SHOWN = 8

export function tokenTipKind(tip: Pick<Bsv21Utxo, 'encoding'>): TokenTipKind {
  if (tip.encoding === 'brc162') return 'brc162'
  if (tip.encoding === 'legacy-json') return 'legacy-json'
  return 'remittance'
}

function units(raw: string | undefined): bigint {
  return raw && /^\d+$/.test(raw.trim()) ? BigInt(raw.trim()) : 0n
}

export function tokenLedger(
  token: Pick<FungibleToken, 'tokenId' | 'tokenIds' | 'sym'>,
  tips: ReadonlyArray<Pick<Bsv21Utxo, 'outpoint' | 'amt' | 'encoding'>>,
  activity: readonly ActivityEntry[],
): TokenLedger {
  const byKind: TokenLedger['byKind'] = {
    brc162: { amt: 0n, tips: 0 },
    'legacy-json': { amt: 0n, tips: 0 },
    remittance: { amt: 0n, tips: 0 },
  }
  const shown: TokenLedger['tips'] = []
  let held = 0n
  for (const tip of tips) {
    const amt = units(tip.amt)
    const kind = tokenTipKind(tip)
    byKind[kind].amt += amt
    byKind[kind].tips += 1
    held += amt
    shown.push({ outpoint: tip.outpoint, amt, kind })
  }
  const ids = new Set(
    [token.tokenId, ...(token.tokenIds ?? [])].map((id) => id.trim().toLowerCase()),
  )
  let historyIn = 0n
  let historyOut = 0n
  let historyRows = 0
  for (const row of activity) {
    const id = row.item?.tokenId?.trim().toLowerCase()
    if (!id || !ids.has(id)) continue
    if (row.status === 'pending' || row.status === 'failed') continue
    if (row.kind === 'earned') {
      historyIn += units(row.item?.amt)
    } else {
      historyOut += units(row.burn?.destroyedAmount ?? row.item?.amt)
    }
    historyRows += 1
  }
  return {
    sym: token.sym,
    tokenId: token.tokenId,
    held,
    byKind,
    historyIn,
    historyOut,
    historyRows,
    tips: shown,
  }
}

/** `[bsv21] ledger …` — parsed by `scripts/triage-logs.mjs`; keep the shape. */
export function formatTokenLedger(ledger: TokenLedger): string {
  const sym = (ledger.sym.trim() || 'token').replace(/\s+/g, '_').slice(0, 24)
  const kind = (k: TokenTipKind) => `${k} ${ledger.byKind[k].amt}/${ledger.byKind[k].tips}`
  const tips = [...ledger.tips]
    .sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0))
    .slice(0, LEDGER_TIPS_SHOWN)
    .map((tip) => `${tip.outpoint.slice(0, 12)}…${tip.outpoint.slice(-2)}=${tip.amt}:${tip.kind}`)
  return (
    `[bsv21] ledger ${sym} ${ledger.tokenId.slice(0, 12)} holds ${ledger.held} in ${ledger.tips.length} tip(s) — ` +
    `${kind('brc162')}, ${kind('legacy-json')}, ${kind('remittance')}; ` +
    `history in ${ledger.historyIn} out ${ledger.historyOut} over ${ledger.historyRows} row(s)` +
    (tips.length ? `; tips ${tips.join(' ')}` : '')
  )
}
