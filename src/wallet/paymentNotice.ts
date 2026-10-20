/**
 * BRC-29 payment notices — the payee's only way to find a payment.
 *
 * A BRC-29 payment locks to a key derived from a random prefix/suffix the
 * payee cannot regenerate, so until the notice (remittance) reaches their box
 * the coins are invisible to them. The obligation to deliver it is written
 * with the payment itself: the payment output's custom instructions carry
 * `notice: 'pending'` from `createAction`, and only a box or direct delivery
 * turns it to `'delivered'`. That row rides every BRC-39 backup and every
 * handover delta (an update moves its `updated_at`), so a restored device or a
 * new holder re-sends exactly the notices still owed and never one already
 * delivered. Outputs written before the field existed carry no notice and are
 * never re-sent.
 */
import type { StorageProvider } from '@handcash/wallet-engine'

export type PaymentNoticeState = 'pending' | 'delivered'

/**
 * Where the notice on one payment output stands. `untracked`: the wallet's
 * records name no notice for it — an output written before the field, or one a
 * History replace took away — so nothing proves it was delivered. `void`: the
 * payment failed, so no notice is owed.
 */
export type PaymentNoticeStatus = PaymentNoticeState | 'untracked' | 'void'

export type PaymentOutputInstructions = {
  derivationPrefix: string
  derivationSuffix: string
  payee: string
  notice?: PaymentNoticeState
  /** The payment was an intentional in-thread card, not a Send-panel notify. */
  chatRef?: true
}

export type PendingPaymentNotice = {
  txid: string
  vout: number
  satoshis: number
  payee: string
  derivationPrefix: string
  derivationSuffix: string
  chatRef: boolean
  createdAt: number
}

const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/i
const TXID = /^[0-9a-f]{64}$/
const PENDING_MARK = '"notice":"pending"'
/** A notice is owed only for a payment the network has or will have. */
const DELIVERABLE_STATUSES: ReadonlySet<string> = new Set(['completed', 'unproven', 'sending', 'unprocessed'])
/** A payment in this state never reaches the payee, so its notice is void. */
const VOID_STATUSES: ReadonlySet<string> = new Set(['failed'])

export function paymentOutputInstructions(fields: PaymentOutputInstructions): string {
  return JSON.stringify({
    derivationPrefix: fields.derivationPrefix,
    derivationSuffix: fields.derivationSuffix,
    payee: fields.payee,
    ...(fields.notice ? { notice: fields.notice } : {}),
    ...(fields.chatRef ? { chatRef: true } : {}),
  })
}

export function parsePaymentOutputInstructions(raw: unknown): PaymentOutputInstructions | null {
  if (typeof raw !== 'string' || !raw) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  // Asset rows (BNT, tokens) carry their own remittance; rewriting it as a payment notice would lose the asset.
  if ('asset' in parsed || 'kind' in parsed || 'form' in parsed) return null
  const { derivationPrefix, derivationSuffix, payee, notice, chatRef } = parsed
  if (typeof derivationPrefix !== 'string' || !derivationPrefix.trim()) return null
  if (typeof derivationSuffix !== 'string' || !derivationSuffix.trim()) return null
  if (typeof payee !== 'string' || !IDENTITY_KEY.test(payee)) return null
  if (notice !== undefined && notice !== 'pending' && notice !== 'delivered') return null
  return {
    derivationPrefix,
    derivationSuffix,
    payee,
    ...(notice ? { notice } : {}),
    ...(chatRef === true ? { chatRef: true as const } : {}),
  }
}

type NoticeOutputRow = {
  outputId: number
  transactionId: number
  txid?: string
  vout: number
  satoshis: number
  customInstructions?: string
  created_at?: Date | string
}

type NoticeStorage = {
  findUserByIdentityKey(identityKey: string): Promise<{ userId: number } | undefined>
  findOutputs(args: { partial: Record<string, unknown>; noScript?: boolean }): Promise<NoticeOutputRow[]>
  filterOutputs(
    args: { partial: Record<string, unknown>; noScript?: boolean },
    filtered: (row: NoticeOutputRow) => void,
  ): Promise<void>
  findTransactions(args: { partial: Record<string, unknown>; noRawTx?: boolean }): Promise<Array<{ status?: string }>>
  updateOutput(outputId: number, update: { customInstructions: string }): Promise<unknown>
}

export type NoticeWallet = {
  identityKey: string
  wallet: {
    storage: { runAsStorageProvider<T>(fn: (storage: StorageProvider) => Promise<T>): Promise<T> }
  }
}

function withStorage<T>(active: NoticeWallet, fn: (storage: NoticeStorage) => Promise<T>): Promise<T> {
  return active.wallet.storage.runAsStorageProvider((storage) => fn(storage as unknown as NoticeStorage))
}

function createdMs(at: NoticeOutputRow['created_at']): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(ms) ? ms : 0
}

async function noticeOutput(
  storage: NoticeStorage,
  identityKey: string,
  txid: string,
  vout: number,
): Promise<{ row: NoticeOutputRow; fields: PaymentOutputInstructions | null } | null> {
  const user = await storage.findUserByIdentityKey(identityKey)
  if (!user) return null
  const [row] = await storage.findOutputs({ partial: { userId: user.userId, txid, vout }, noScript: true })
  return row ? { row, fields: parsePaymentOutputInstructions(row.customInstructions) } : null
}

function validOutpoint(txid: string, vout: number): string | null {
  const id = txid.trim().toLowerCase()
  return TXID.test(id) && Number.isInteger(vout) && vout >= 0 ? id : null
}

/** Where the notice on `txid:vout` stands in this wallet's records. */
export async function paymentNoticeStatus(
  active: NoticeWallet,
  txid: string,
  vout: number,
): Promise<PaymentNoticeStatus> {
  const id = validOutpoint(txid, vout)
  if (!id) return 'untracked'
  return withStorage(active, async (storage) => {
    const found = await noticeOutput(storage, active.identityKey, id, vout)
    if (!found) return 'untracked'
    const [tx] = await storage.findTransactions({ partial: { transactionId: found.row.transactionId }, noRawTx: true })
    if (tx && VOID_STATUSES.has(String(tx.status ?? ''))) return 'void'
    return found.fields?.notice ?? 'untracked'
  })
}

/**
 * Turn the notice on `txid:vout` to delivered. True only when this call
 * changed a pending notice; a delivered, absent or pre-notice output is left
 * as it is.
 */
export async function markPaymentNoticeDelivered(
  active: NoticeWallet,
  txid: string,
  vout: number,
): Promise<boolean> {
  const id = validOutpoint(txid, vout)
  if (!id) return false
  return withStorage(active, async (storage) => {
    const found = await noticeOutput(storage, active.identityKey, id, vout)
    if (!found?.fields || found.fields.notice !== 'pending') return false
    await storage.updateOutput(found.row.outputId, {
      customInstructions: paymentOutputInstructions({ ...found.fields, notice: 'delivered' }),
    })
    return true
  })
}

/** Every notice this wallet still owes, oldest first. */
export async function listPendingPaymentNotices(active: NoticeWallet): Promise<PendingPaymentNotice[]> {
  return withStorage(active, async (storage) => {
    const user = await storage.findUserByIdentityKey(active.identityKey)
    if (!user) return []
    const candidates: Array<{ row: NoticeOutputRow; fields: PaymentOutputInstructions }> = []
    await storage.filterOutputs({ partial: { userId: user.userId }, noScript: true }, (row) => {
      if (!row.customInstructions?.includes(PENDING_MARK)) return
      const fields = parsePaymentOutputInstructions(row.customInstructions)
      if (fields?.notice !== 'pending') return
      if (fields.payee.toLowerCase() === active.identityKey.toLowerCase()) return
      candidates.push({ row, fields })
    })
    const owed: PendingPaymentNotice[] = []
    for (const { row, fields } of candidates) {
      const txid = row.txid?.trim().toLowerCase() ?? ''
      if (!TXID.test(txid)) continue
      const [tx] = await storage.findTransactions({ partial: { transactionId: row.transactionId }, noRawTx: true })
      if (!tx || !DELIVERABLE_STATUSES.has(String(tx.status ?? ''))) continue
      owed.push({
        txid,
        vout: row.vout,
        satoshis: row.satoshis,
        payee: fields.payee.toLowerCase(),
        derivationPrefix: fields.derivationPrefix,
        derivationSuffix: fields.derivationSuffix,
        chatRef: fields.chatRef === true,
        createdAt: createdMs(row.created_at),
      })
    }
    return owed.sort((a, b) => a.createdAt - b.createdAt)
  })
}
