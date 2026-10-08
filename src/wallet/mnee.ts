import { Beef, LockingScript, P2PKH, Transaction, Utils, type PrivateKey } from '@bsv/sdk'
import { appendAppLog } from './appLog'
import { buildLegacyInputBeef } from './legacyBeef'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import { markOneSatImported } from './oneSatImportGuard'
import { stampBrc164Id } from './itemAccess'
import {
  MNEE_COLLECTION_ID,
  MNEE_DECIMALS,
  MNEE_SYMBOL,
  MNEE_TAG,
  MNEE_TOKEN_ID,
  formatMnee,
  isMneeTokenId,
  mneeOutputScriptHex,
  parseMneeTip,
} from './mneeTip'
import type { ActiveWallet } from './session'

/**
 * MNEE — the USD stablecoin issued as a cosigned BSV-21 token.
 *
 * Every MNEE output is `ord envelope ‖ OWNER P2PKH CHECKSIGVERIFY ‖ <approver>
 * CHECKSIG`: the owner signs, MNEE's cosigner adds its signature and
 * broadcasts. A plain item move cannot spend it, so MNEE never takes the item
 * or token sweep path — it moves only through MNEE's transfer API, and the
 * owner's signature commits to every input and output before it leaves.
 *
 * Pure vocabulary (ids, script parsing) lives in `mneeTip.ts`.
 *
 * Accepted MNEE is filed in basket `1sat` (Collect), tagged `mnee`, until the
 * wallet has a cosigned send path; Tokens leaves tagged rows alone.
 */

const MNEE_API = 'https://proxy-api.mnee.net'
/** The production token the official MNEE SDK (`@mnee/ts-sdk`) ships for public use. */
const MNEE_PUBLIC_TOKEN = '92982ec1c0975f31979da515d46bae9f'
const REQUEST_TIMEOUT_MS = 20_000
const UTXO_PAGE = 250
const MAX_INPUTS_PER_TX = 40
const TICKET_POLL_MS = 2_000
const TICKET_TIMEOUT_MS = 90_000

type FetchLike = typeof fetch

export type MneeFeeTier = { min: number; max: number; fee: number }

export type MneeConfig = {
  approver: string
  feeAddress: string
  tokenId: string
  decimals: number
  fees: MneeFeeTier[]
}

function url(path: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ auth_token: MNEE_PUBLIC_TOKEN, ...query })
  return `${MNEE_API}${path}?${params.toString()}`
}

function isAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const { prefix, data } = Utils.fromBase58Check(value)
    return (prefix as number[])[0] === 0 && (data as number[]).length === 20
  } catch {
    return false
  }
}

/** The cosigner's published terms; null unless every field is what a transfer needs. */
export function parseMneeConfig(raw: unknown): MneeConfig | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const approver = typeof r.approver === 'string' ? r.approver.trim().toLowerCase() : ''
  if (!/^0[23][0-9a-f]{64}$/.test(approver)) return null
  if (!isAddress(r.feeAddress)) return null
  if (typeof r.tokenId !== 'string' || !isMneeTokenId(r.tokenId)) return null
  if (r.decimals !== MNEE_DECIMALS) return null
  if (!Array.isArray(r.fees)) return null
  const fees: MneeFeeTier[] = []
  for (const tier of r.fees as Array<Record<string, unknown>>) {
    const { min, max, fee } = tier ?? {}
    if (![min, max, fee].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return null
    fees.push({ min: min as number, max: max as number, fee: fee as number })
  }
  if (fees.length === 0) return null
  return { approver, feeAddress: r.feeAddress, tokenId: MNEE_TOKEN_ID, decimals: MNEE_DECIMALS, fees }
}

export async function fetchMneeConfig(fetchImpl: FetchLike = fetch): Promise<MneeConfig> {
  const res = await fetchImpl(url('/v1/config'), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`MNEE config ${res.status}`)
  const config = parseMneeConfig(await res.json())
  if (!config) throw new Error('MNEE config did not match the MNEE token')
  return config
}

/**
 * Split a whole balance into what arrives and the cosigner's fee. The fee
 * tier is chosen by the amount sent, so it is settled by fixed point; where
 * tiers disagree the larger fee is paid. Null when nothing would arrive.
 */
export function mneeSweepSplit(total: bigint, fees: readonly MneeFeeTier[]): { amount: bigint; fee: bigint } | null {
  const feeFor = (amount: bigint) => {
    const tier = fees.find((f) => amount >= BigInt(f.min) && amount <= BigInt(f.max))
    return tier ? BigInt(tier.fee) : null
  }
  let fee = feeFor(total)
  if (fee == null) return null
  for (let i = 0; i < 8; i += 1) {
    const amount = total - fee
    if (amount <= 0n) return null
    const next = feeFor(amount)
    if (next == null) return null
    if (next <= fee) return { amount, fee }
    fee = next
  }
  return null
}

type MneeUtxoRow = { txid: string; vout: number; amt: bigint; owner: string }

/** Unspent MNEE the cosigner's index holds for `addresses`. */
export async function fetchMneeUtxos(addresses: readonly string[], fetchImpl: FetchLike = fetch): Promise<MneeUtxoRow[]> {
  const out: MneeUtxoRow[] = []
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100)
    for (let page = 1; page <= 40; page += 1) {
      const res = await fetchImpl(url('/v2/utxos', { page: String(page), size: String(UTXO_PAGE), order: 'asc' }), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`MNEE utxos ${res.status}`)
      const rows = (await res.json()) as unknown
      if (!Array.isArray(rows)) break
      for (const row of rows as Array<Record<string, unknown>>) {
        const bsv21 = ((row.data ?? {}) as { bsv21?: Record<string, unknown> }).bsv21 ?? {}
        const txid = typeof row.txid === 'string' ? row.txid.toLowerCase() : ''
        const vout = Number(row.vout)
        const owner = Array.isArray(row.owners) && typeof row.owners[0] === 'string' ? row.owners[0] : ''
        if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) continue
        if (String(bsv21.op ?? '').toLowerCase() !== 'transfer') continue
        if (typeof bsv21.id === 'string' && !isMneeTokenId(bsv21.id)) continue
        if (!Number.isSafeInteger(bsv21.amt) || (bsv21.amt as number) <= 0) continue
        out.push({ txid, vout, amt: BigInt(bsv21.amt as number), owner })
      }
      if (rows.length < UTXO_PAGE) break
    }
  }
  return out
}

/** MNEE base units per address — display only; a sweep re-reads every script. */
export async function readMneeBalances(
  addresses: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, bigint>> {
  const wanted = new Set(addresses)
  const balances = new Map<string, bigint>()
  for (const row of await fetchMneeUtxos(addresses, fetchImpl)) {
    if (!wanted.has(row.owner)) continue
    balances.set(row.owner, (balances.get(row.owner) ?? 0n) + row.amt)
  }
  return balances
}

export type MneeSpendable = { txid: string; vout: number; amt: bigint; sourceTransaction: Transaction }

export type MneeTipDecision =
  | { kind: 'spend'; tip: MneeSpendable }
  | { kind: 'hold'; reason: 'unreadable' | 'foreign' | 'cosigner' | 'amount' }

/** Decide one listed tip from its real source output. */
export function chooseMneeTip(args: {
  row: { txid: string; vout: number; amt: bigint }
  sourceTransaction: Transaction | null
  ownerHash: string
  approver: string
}): MneeTipDecision {
  const output = args.sourceTransaction?.outputs[args.row.vout]
  if (!args.sourceTransaction || !output || output.satoshis !== 1) return { kind: 'hold', reason: 'unreadable' }
  const tip = parseMneeTip(output.lockingScript.toHex())
  if (!tip) return { kind: 'hold', reason: 'unreadable' }
  if (tip.ownerHash !== args.ownerHash) return { kind: 'hold', reason: 'foreign' }
  if (tip.approver !== args.approver) return { kind: 'hold', reason: 'cosigner' }
  if (tip.amt !== args.row.amt) return { kind: 'hold', reason: 'amount' }
  return {
    kind: 'spend',
    tip: { txid: args.row.txid, vout: args.row.vout, amt: tip.amt, sourceTransaction: args.sourceTransaction },
  }
}

/**
 * The owner-signed half of an MNEE transfer: every tip in, the balance less
 * the fee to `recipient`, the fee to the cosigner. SIGHASH_ALL — the cosigner
 * can add its signature and nothing else.
 */
export async function buildMneeSweep(args: {
  key: PrivateKey
  tips: readonly MneeSpendable[]
  recipient: string
  config: MneeConfig
}): Promise<{ tx: Transaction; amount: bigint; fee: bigint }> {
  const total = args.tips.reduce((sum, tip) => sum + tip.amt, 0n)
  const split = mneeSweepSplit(total, args.config.fees)
  if (!split) throw new Error('MNEE balance is below the cosigner fee')
  const tx = new Transaction()
  for (const tip of args.tips) {
    tx.addInput({
      sourceTransaction: tip.sourceTransaction,
      sourceOutputIndex: tip.vout,
      unlockingScriptTemplate: new P2PKH().unlock(args.key),
      sequence: 0xffffffff,
    })
  }
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(mneeOutputScriptHex(args.recipient, split.amount, args.config.approver)),
  })
  if (split.fee > 0n) {
    tx.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(mneeOutputScriptHex(args.config.feeAddress, split.fee, args.config.approver)),
    })
  }
  await tx.sign()
  return { tx, amount: split.amount, fee: split.fee }
}

/**
 * The cosigned transaction is ours only if it spends exactly our inputs and
 * pays exactly our outputs; the cosigner may add signatures, nothing else.
 */
export function cosignedMatches(signed: Transaction, cosigned: Transaction): boolean {
  if (signed.inputs.length !== cosigned.inputs.length) return false
  if (signed.outputs.length !== cosigned.outputs.length) return false
  for (let i = 0; i < signed.inputs.length; i += 1) {
    const a = signed.inputs[i]!
    const b = cosigned.inputs[i]!
    const aTxid = a.sourceTXID ?? a.sourceTransaction?.id('hex')
    if (aTxid !== b.sourceTXID || a.sourceOutputIndex !== b.sourceOutputIndex) return false
  }
  for (let i = 0; i < signed.outputs.length; i += 1) {
    const a = signed.outputs[i]!
    const b = cosigned.outputs[i]!
    if (a.satoshis !== b.satoshis || a.lockingScript.toHex() !== b.lockingScript.toHex()) return false
  }
  return true
}

export type MneeTicket = { status: string; txid: string | null; txHex: string | null; errors: string | null }

async function submitMneeTransfer(tx: Transaction, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(url('/v2/transfer'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawtx: Utils.toBase64(tx.toBinary()) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = (await res.text()).trim()
  if (!res.ok) throw new Error(`MNEE cosigner refused: ${body.slice(0, 200) || res.status}`)
  if (!body) throw new Error('MNEE cosigner returned no ticket')
  return body.replace(/^"|"$/g, '')
}

async function readTicket(ticketId: string, fetchImpl: FetchLike): Promise<MneeTicket> {
  const res = await fetchImpl(url('/v2/ticket', { ticketID: ticketId }), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`MNEE ticket ${res.status}`)
  const r = (await res.json()) as Record<string, unknown>
  return {
    status: String(r.status ?? '').toUpperCase(),
    txid: typeof r.tx_id === 'string' && /^[0-9a-f]{64}$/i.test(r.tx_id) ? r.tx_id.toLowerCase() : null,
    txHex: typeof r.tx_hex === 'string' && r.tx_hex ? r.tx_hex : null,
    errors: typeof r.errors === 'string' && r.errors ? r.errors : null,
  }
}

async function awaitTicket(ticketId: string, fetchImpl: FetchLike, sleep: (ms: number) => Promise<void>): Promise<MneeTicket> {
  const deadline = Date.now() + TICKET_TIMEOUT_MS
  for (;;) {
    const ticket = await readTicket(ticketId, fetchImpl).catch(() => null)
    if (ticket?.status === 'FAILED') return ticket
    if (ticket && (ticket.status === 'SUCCESS' || ticket.status === 'MINED') && ticket.txid) return ticket
    if (Date.now() >= deadline) {
      return ticket ?? { status: 'UNKNOWN', txid: null, txHex: null, errors: null }
    }
    await sleep(TICKET_POLL_MS)
  }
}

export type MneeHold = 'unreadable' | 'foreign' | 'cosigner' | 'amount'

export type MneeSweepResult =
  | {
      kind: 'moved'
      amount: bigint
      fee: bigint
      txid: string
      /** False when a card waits for Refresh instead of being filed now. */
      filed: boolean
      held: Partial<Record<MneeHold, number>>
      /** A later batch that did not move, when an earlier one did. */
      unfinished: string | null
    }
  | { kind: 'empty'; held: Partial<Record<MneeHold, number>> }
  | { kind: 'refused'; reason: 'chain' | 'belowFee'; message: string }
  | { kind: 'failed'; stage: 'config' | 'read' | 'cosigner' | 'ticket'; message: string }

/**
 * Move every MNEE output held by an imported key to this wallet's address
 * through MNEE's cosigner, then file it in Collect.
 */
export async function sweepMneeFromKey(args: {
  active: ActiveWallet
  key: PrivateKey
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}): Promise<MneeSweepResult> {
  const { active, key } = args
  const fetchImpl = args.fetchImpl ?? fetch
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if (active.chain !== 'main') {
    return { kind: 'refused', reason: 'chain', message: 'MNEE moves on mainnet only.' }
  }
  const startedAt = Date.now()
  const address = key.toPublicKey().toAddress()
  const ownerHash = key.toPublicKey().toHash('hex') as string

  let config: MneeConfig
  try {
    config = await fetchMneeConfig(fetchImpl)
  } catch (err) {
    return { kind: 'failed', stage: 'config', message: messageOf(err) }
  }

  let rows: MneeUtxoRow[]
  try {
    rows = (await fetchMneeUtxos([address], fetchImpl)).filter((r) => r.owner === address)
  } catch (err) {
    return { kind: 'failed', stage: 'read', message: messageOf(err) }
  }
  const held: Partial<Record<MneeHold, number>> = {}
  if (rows.length === 0) return { kind: 'empty', held }

  const built = await buildLegacyInputBeef(
    active.services,
    rows.map((r) => `${r.txid}.${r.vout}`),
    { concurrency: 6 },
  )
  const inputBeef = built.beef.length > 0 ? Beef.fromBinary(built.beef) : null
  const tips: MneeSpendable[] = []
  for (const row of rows) {
    const decision = chooseMneeTip({
      row,
      sourceTransaction: inputBeef?.findTxid(row.txid)?.tx ?? null,
      ownerHash,
      approver: config.approver,
    })
    if (decision.kind === 'hold') held[decision.reason] = (held[decision.reason] ?? 0) + 1
    else tips.push(decision.tip)
  }
  if (tips.length === 0) return { kind: 'empty', held }

  let moved = 0n
  let fees = 0n
  let lastTxid = ''
  let filedAll = true
  let unfinished: string | null = null
  for (let i = 0; i < tips.length; i += MAX_INPUTS_PER_TX) {
    const group = tips.slice(i, i + MAX_INPUTS_PER_TX)
    let signed: Awaited<ReturnType<typeof buildMneeSweep>>
    try {
      signed = await buildMneeSweep({ key, tips: group, recipient: active.address, config })
    } catch (err) {
      if (moved === 0n) return { kind: 'refused', reason: 'belowFee', message: messageOf(err) }
      unfinished = messageOf(err)
      break
    }
    let ticketId: string
    try {
      ticketId = await submitMneeTransfer(signed.tx, fetchImpl)
    } catch (err) {
      appendAppLog('warn', `[mnee] sweep refused by cosigner: ${messageOf(err)}`)
      if (moved === 0n) return { kind: 'failed', stage: 'cosigner', message: messageOf(err) }
      unfinished = messageOf(err)
      break
    }
    const ticket = await awaitTicket(ticketId, fetchImpl, sleep)
    if (ticket.status === 'FAILED' || !ticket.txid) {
      const message = ticket.errors ?? `MNEE ticket ${ticketId} ${ticket.status.toLowerCase()}`
      appendAppLog('warn', `[mnee] sweep ticket ${ticketId} ${ticket.status}: ${message}`)
      if (moved === 0n) return { kind: 'failed', stage: 'ticket', message }
      unfinished = message
      break
    }
    moved += signed.amount
    fees += signed.fee
    lastTxid = ticket.txid
    appendAppLog(
      'info',
      `[mnee] sweep moved amt=${signed.amount} fee=${signed.fee} inputs=${group.length} txid=${ticket.txid} done ${Date.now() - startedAt}ms`,
    )
    const filed = await fileInCollect({
      active,
      signed: signed.tx,
      ticket,
      inputBeef: Array.from(built.beef),
      amount: signed.amount,
    })
    filedAll &&= filed
  }
  return { kind: 'moved', amount: moved, fee: fees, txid: lastTxid, filed: filedAll, held, unfinished }
}

/**
 * File the received output in basket `1sat`. The transaction is already on
 * its way through MNEE, so a refusal here only defers the card to Refresh.
 */
async function fileInCollect(args: {
  active: ActiveWallet
  signed: Transaction
  ticket: MneeTicket
  inputBeef: number[]
  amount: bigint
}): Promise<boolean> {
  const { active, ticket } = args
  try {
    let hex = ticket.txHex
    if (!hex) {
      const raw = (await active.services.getRawTx(ticket.txid!)).rawTx
      hex = raw ? Utils.toHex(raw) : null
    }
    if (!hex) throw new Error('cosigned transaction unavailable')
    const cosigned = Transaction.fromHex(hex)
    if (cosigned.id('hex') !== ticket.txid) throw new Error('ticket transaction does not hash to its txid')
    if (!cosignedMatches(args.signed, cosigned)) throw new Error('cosigner changed the transaction')
    const beef = Beef.fromBinary(args.inputBeef)
    beef.mergeTransaction(cosigned)
    const atomic = beef.toBinaryAtomic(ticket.txid!)
    const origin = `${ticket.txid}_0`
    const name = `${formatMnee(args.amount)} ${MNEE_SYMBOL}`
    await active.wallet.internalizeAction({
      tx: atomic,
      description: 'Receive MNEE',
      labels: ['1sat', MNEE_TAG, 'legacy-import'],
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: '1sat',
            tags: stampBrc164Id([
              'ordinal',
              MNEE_TAG,
              `origin:${ticket.txid}.0`,
              `name:${name.slice(0, 80)}`,
              `app:${MNEE_SYMBOL.toLowerCase()}`,
              `collection:${MNEE_COLLECTION_ID}`,
            ]),
            customInstructions: buildInternalizeCustomInstructions({
              origin,
              name,
              app: MNEE_SYMBOL,
              collectionId: MNEE_COLLECTION_ID,
            }),
          },
        },
      ],
      seekPermission: false,
    })
    markOneSatImported([`${ticket.txid}.0`])
    return true
  } catch (err) {
    appendAppLog('warn', `[mnee] filed later — ${ticket.txid}: ${messageOf(err)}`)
    return false
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
