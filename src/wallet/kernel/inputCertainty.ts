/**
 * May an app be told this txid? Only when every coin it spends is proven good.
 *
 * SPV proves a parent exists; it cannot prove a coin unspent. What this wallet
 * can know, per input:
 *
 * - `mined` parent (proven, txid-only, or absent from the BEEF): the coin is
 *   good when a Teranode node or the explorer says no tx spends it
 *   (`cleared`), dead when either names a spender or another install's history
 *   snapshot shows it spent, and unknown when neither answers.
 * - `chained` parent (an unmined tx riding the BEEF): the coin is good when the
 *   parent was itself signed from proven coins (`certified`) or a node accepted
 *   it (`landed`); dead when Arcade rejected the parent; unknown while it waits.
 *
 * Dead coins are retired and the payment signed again. Unknown coins are not
 * signed over: the payment is refused with a named reason and nothing is sent.
 */
export type CoinAnswer =
  | { kind: 'cleared' }
  | { kind: 'spent'; spender: string }
  | { kind: 'unknown' }

export type ParentStanding = 'certified' | 'landed' | 'rejected' | 'unlanded'

export type CertaintyInput =
  | { outpoint: string; origin: 'mined'; answer: CoinAnswer }
  | { outpoint: string; origin: 'chained'; parent: string; standing: ParentStanding }

/** `unreadable`: the signed body names no inputs this wallet can check. */
export type UncertainReason = 'explorer-silent' | 'parent-unlanded' | 'unreadable'

export type InputCertainty =
  | { kind: 'certain' }
  | {
      kind: 'retire'
      spends: Array<{ outpoint: string; spender: string }>
      deadParents: string[]
    }
  | { kind: 'uncertain'; reason: UncertainReason; outpoints: string[] }

export function judgeInputCertainty(inputs: CertaintyInput[]): InputCertainty {
  const spends: Array<{ outpoint: string; spender: string }> = []
  const deadParents = new Set<string>()
  const silent: string[] = []
  const unlanded: string[] = []
  for (const input of inputs) {
    if (input.origin === 'mined') {
      if (input.answer.kind === 'spent') {
        spends.push({ outpoint: input.outpoint, spender: input.answer.spender })
      } else if (input.answer.kind === 'unknown') {
        silent.push(input.outpoint)
      }
      continue
    }
    if (input.standing === 'rejected') deadParents.add(input.parent)
    else if (input.standing === 'unlanded') unlanded.push(input.outpoint)
  }
  if (spends.length > 0 || deadParents.size > 0) {
    return { kind: 'retire', spends, deadParents: [...deadParents] }
  }
  if (unlanded.length > 0) {
    return { kind: 'uncertain', reason: 'parent-unlanded', outpoints: [...unlanded, ...silent] }
  }
  if (silent.length > 0) {
    return { kind: 'uncertain', reason: 'explorer-silent', outpoints: silent }
  }
  return { kind: 'certain' }
}

/**
 * True when a dead coin is one the caller named in `inputs`. Signing again
 * cannot route around it — the action itself is stale.
 */
export function retireHitsNamedInput(
  verdict: Extract<InputCertainty, { kind: 'retire' }>,
  named: ReadonlySet<string>,
): boolean {
  if (named.size === 0) return false
  if (verdict.spends.some((s) => named.has(s.outpoint))) return true
  const dead = new Set(verdict.deadParents)
  for (const outpoint of named) {
    if (dead.has(outpoint.slice(0, 64))) return true
  }
  return false
}
