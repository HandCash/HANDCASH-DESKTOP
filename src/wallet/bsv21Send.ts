/**
 * BRC-162 send planning — value outputs, BRC-163 remittance, 176 BEEF.
 *
 * New sends spend 162 value inputs and create 162 value outputs (payee +
 * change) with conservation. Change is another 162 value output — not an
 * ord leftover and not a bare 1sat. Remittance is basket `bsv21` with
 * underscore token id and decimal amt. Subject outputs carry a 176 BEEF.
 *
 * Does not emit application/1sat-ft+json or BRC-161 JSON inscriptions.
 */
import { Beef, type Transaction } from '@bsv/sdk'
import {
  BSV21_BASKET,
  buildBsv21CustomInstructions,
  bsv21Tags,
  normalizeTokenId,
} from './bsv21'
import {
  decodeBsv21Binary,
  encodeBsv21Binary,
  parseDisplayOutpoint,
} from './bsv21Binary'
import { prove, type Bsv21ProofResult } from './bsv21Prove'
import { stampBrc164Id } from './itemAccess'
import { p2pkhScriptHex } from './ordinalOwnership'
import { toUnderscoreOutpoint } from './outpointFormat'

const ONESAT_FT_MIME = 'application/1sat-ft+json'
const ONESAT_FT_MIME_HEX = [...new TextEncoder().encode(ONESAT_FT_MIME)]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')

function assertNoOnesatFtMime(scriptHex: string): void {
  if (scriptHex.toLowerCase().includes(ONESAT_FT_MIME_HEX)) {
    throw new Error('BSV-21 send refused to emit application/1sat-ft+json')
  }
}

export type Bsv21SendTip = {
  outpoint: string
  tokenId: string
  amt: bigint
  lockingScript?: string
  tags?: string[]
  customInstructions?: string
}

export type Bsv21SendPlan = {
  tokenId: string
  selected: Bsv21SendTip[]
  selectedSum: bigint
  payeeAmt: bigint
  changeAmt: bigint
}

export type Bsv21SendOutput = {
  role: 'payee' | 'change'
  lockingScript: string
  satoshis: 1
  basket: typeof BSV21_BASKET
  tags: string[]
  customInstructions: string
  outputDescription: string
  amt: string
}

export function assertBsv21AmtConservation(
  inputAmts: bigint[],
  outputAmts: bigint[],
): void {
  const input = inputAmts.reduce((a, b) => a + b, 0n)
  const output = outputAmts.reduce((a, b) => a + b, 0n)
  if (input !== output) {
    throw new Error(
      `Token amt not conserved (parents ${input} ≠ children ${output})`,
    )
  }
}

export function planBsv21Send(args: {
  tokenId: string
  tips: Bsv21SendTip[]
  amount: bigint
}): Bsv21SendPlan {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error(`Invalid BSV-21 token id: ${args.tokenId}`)
  if (args.amount <= 0n) throw new Error('Amount must be greater than zero')

  const usable = args.tips
    .filter((t) => normalizeTokenId(t.tokenId) === tokenId && t.amt > 0n)
    .sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0))

  const selected: Bsv21SendTip[] = []
  let selectedSum = 0n
  for (const tip of usable) {
    if (selectedSum >= args.amount) break
    selected.push(tip)
    selectedSum += tip.amt
  }
  if (selectedSum < args.amount) {
    throw new Error(`Need ${args.amount} units; only ${selectedSum} available`)
  }
  const changeAmt = selectedSum - args.amount
  assertBsv21AmtConservation(
    selected.map((t) => t.amt),
    changeAmt > 0n ? [args.amount, changeAmt] : [args.amount],
  )
  return {
    tokenId,
    selected,
    selectedSum,
    payeeAmt: args.amount,
    changeAmt,
  }
}

/** 162 value lock: BSV21 prefix + P2PKH rest. satoshis stay 1. */
export function buildBsv21ValueLock(args: {
  tokenId: string
  amount: bigint
  address: string
}): string {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error(`Invalid BSV-21 token id: ${args.tokenId}`)
  if (args.amount <= 0n) {
    throw new Error('BSV-21 send refuses amount 0 (authority)')
  }
  const hex = encodeBsv21Binary({
    tokenId,
    amount: args.amount,
    rest: p2pkhScriptHex(args.address),
  })
    .toHex()
    .toLowerCase()
  assertNoOnesatFtMime(hex)
  const decoded = decodeBsv21Binary(hex)
  if (!decoded || decoded.role !== 'value' || decoded.tokenId !== tokenId) {
    throw new Error('BSV-21 send produced a non-value lock')
  }
  if (decoded.amount !== args.amount) {
    throw new Error('BSV-21 send lock amount mismatch')
  }
  return hex
}

export function buildBsv21SendRemittance(args: {
  tokenId: string
  amt: bigint
  sym?: string
  dec?: number
  issuer?: string
}): { basket: typeof BSV21_BASKET; tags: string[]; customInstructions: string } {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error(`Invalid BSV-21 token id: ${args.tokenId}`)
  const amt = args.amt.toString()
  if (!/^\d+$/.test(amt) || args.amt <= 0n) {
    throw new Error('BRC-163 amt must be a positive decimal integer')
  }
  return {
    basket: BSV21_BASKET,
    tags: stampBrc164Id(
      bsv21Tags({
        tokenId,
        amt,
        sym: args.sym,
        issuer: args.issuer,
        op: 'transfer',
      }),
    ),
    customInstructions: buildBsv21CustomInstructions({
      tokenId,
      amt,
      op: 'transfer',
      sym: args.sym,
      dec: args.dec,
      issuer: args.issuer,
    }),
  }
}

export function buildBsv21SendOutputs(args: {
  tokenId: string
  payeeAmt: bigint
  changeAmt: bigint
  payeeAddress: string
  changeAddress: string
  sym?: string
  dec?: number
  issuer?: string
}): Bsv21SendOutput[] {
  const tokenId = normalizeTokenId(args.tokenId)
  if (!tokenId) throw new Error(`Invalid BSV-21 token id: ${args.tokenId}`)
  if (args.payeeAmt <= 0n) throw new Error('Payee amount must be greater than zero')
  if (args.changeAmt < 0n) throw new Error('Change amount cannot be negative')
  assertBsv21AmtConservation(
    [args.payeeAmt + args.changeAmt],
    args.changeAmt > 0n ? [args.payeeAmt, args.changeAmt] : [args.payeeAmt],
  )

  const payeeRemit = buildBsv21SendRemittance({
    tokenId,
    amt: args.payeeAmt,
    sym: args.sym,
    dec: args.dec,
    issuer: args.issuer,
  })
  const outputs: Bsv21SendOutput[] = [
    {
      role: 'payee',
      lockingScript: buildBsv21ValueLock({
        tokenId,
        amount: args.payeeAmt,
        address: args.payeeAddress,
      }),
      satoshis: 1,
      ...payeeRemit,
      outputDescription: 'BSV-21 value',
      amt: args.payeeAmt.toString(),
    },
  ]
  if (args.changeAmt > 0n) {
    const changeRemit = buildBsv21SendRemittance({
      tokenId,
      amt: args.changeAmt,
      sym: args.sym,
      dec: args.dec,
      issuer: args.issuer,
    })
    outputs.push({
      role: 'change',
      lockingScript: buildBsv21ValueLock({
        tokenId,
        amount: args.changeAmt,
        address: args.changeAddress,
      }),
      satoshis: 1,
      ...changeRemit,
      outputDescription: 'BSV-21 change',
      amt: args.changeAmt.toString(),
    })
  }
  for (const out of outputs) {
    assertNoOnesatFtMime(out.lockingScript)
    if (!decodeBsv21Binary(out.lockingScript)) {
      throw new Error('BSV-21 send output is not BRC-162 binary')
    }
  }
  return outputs
}

/**
 * Merge the signed subject tx onto its token-parent BEEF and prove each
 * 162 value output. Funding inputs may be absent.
 */
export function buildBsv21SubjectBeef(args: {
  parentBeef: Beef | number[] | Uint8Array
  subjectTx: Transaction
  subjectVouts?: number[]
}): { beef: Beef; proofs: Bsv21ProofResult[] } {
  const beef =
    args.parentBeef instanceof Beef
      ? args.parentBeef
      : Beef.fromBinary(args.parentBeef)
  beef.mergeTransaction(args.subjectTx)
  const txid = args.subjectTx.id('hex')
  const vouts =
    args.subjectVouts ??
    args.subjectTx.outputs
      .map((out, i) => (out && decodeBsv21Binary(out.lockingScript) ? i : -1))
      .filter((i) => i >= 0)
  const proofs = vouts.map((vout) => prove(`${txid}_${vout}`, beef))
  const failed = proofs.find((p) => !p.ok)
  if (failed && !failed.ok) {
    throw new Error(`BRC-176 prove failed: ${failed.reason}`)
  }
  return { beef, proofs }
}

export function tipFromBsv21Script(args: {
  outpoint: string
  lockingScript?: string
  satoshis?: number
  customInstructions?: string
  tags?: string[]
}): Bsv21SendTip | null {
  if (args.satoshis != null && args.satoshis !== 1) return null
  const op = toUnderscoreOutpoint(args.outpoint)
  const parsed = parseDisplayOutpoint(op)
  if (!parsed) return null

  const decoded = args.lockingScript
    ? decodeBsv21Binary(args.lockingScript)
    : null
  if (decoded) {
    if (decoded.amount <= 0n || decoded.role === 'authority') return null
    const tokenId =
      decoded.tokenId ??
      (decoded.role === 'deploy' ? op : null)
    if (!tokenId) return null
    return {
      outpoint: op,
      tokenId,
      amt: decoded.amount,
      lockingScript: args.lockingScript,
    }
  }
  return null
}
