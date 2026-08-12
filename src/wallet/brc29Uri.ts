/**
 * BRC-29 settlement receipt URI — offline remittance beside the messagebox card.
 *
 * Distinct from BRC-125 `peerpay:` (a *request* to pay). Old wallets ignore this
 * scheme instead of accidentally sending another payment. New wallets claim via
 * `internalizeAction`.
 *
 *   brc29:<payeeIdentityKey>?txid=<64hex>&dp=<prefix>&ds=<suffix>&sender=<66hex>[&vout=0][&sats=n]
 */
import { PublicKey } from '@bsv/sdk'
import { isCompressedIdentityKeyHex } from './peerPayUri'

export type Brc29UriRemittance = {
  derivationPrefix: string
  derivationSuffix: string
  outputIndex?: number
}

export type Brc29SettlementUri = {
  payeeIdentityKey: string
  senderIdentityKey: string
  txid: string
  remittance: Brc29UriRemittance
  sats: number | null
}

const TXID_RE = /^[0-9a-f]{64}$/

export function looksLikeBrc29SettlementUri(raw: string): boolean {
  return /^brc29:/i.test(raw.trim())
}

export function buildBrc29SettlementUri(args: {
  payeeIdentityKey: string
  senderIdentityKey: string
  txid: string
  remittance: Brc29UriRemittance
  sats?: number | null
}): string {
  const payee = args.payeeIdentityKey.trim().toLowerCase()
  const sender = args.senderIdentityKey.trim().toLowerCase()
  const txid = args.txid.trim().toLowerCase()
  if (!isCompressedIdentityKeyHex(payee)) throw new Error('Invalid payee identity key')
  if (!isCompressedIdentityKeyHex(sender)) throw new Error('Invalid sender identity key')
  PublicKey.fromString(payee)
  PublicKey.fromString(sender)
  if (!TXID_RE.test(txid)) throw new Error('Invalid payment txid')
  const dp = args.remittance.derivationPrefix.trim()
  const ds = args.remittance.derivationSuffix.trim()
  if (!dp || !ds) throw new Error('Missing BRC-29 remittance')
  const vout =
    typeof args.remittance.outputIndex === 'number' &&
    Number.isInteger(args.remittance.outputIndex) &&
    args.remittance.outputIndex >= 0
      ? args.remittance.outputIndex
      : 0
  const params = new URLSearchParams()
  params.set('txid', txid)
  params.set('dp', dp)
  params.set('ds', ds)
  params.set('sender', sender)
  params.set('vout', String(vout))
  if (args.sats != null && Number.isFinite(args.sats) && Math.trunc(args.sats) > 0) {
    params.set('sats', String(Math.trunc(args.sats)))
  }
  return `brc29:${payee}?${params.toString()}`
}

export function parseBrc29SettlementUri(raw: string): Brc29SettlementUri {
  const trimmed = raw.trim()
  if (!/^brc29:/i.test(trimmed)) throw new Error('Not a BRC-29 settlement URI')
  const withoutScheme = trimmed.replace(/^brc29:/i, '')
  const q = withoutScheme.indexOf('?')
  const keyPart = (q >= 0 ? withoutScheme.slice(0, q) : withoutScheme).trim().toLowerCase()
  const query = q >= 0 ? withoutScheme.slice(q + 1) : ''
  if (!isCompressedIdentityKeyHex(keyPart)) throw new Error('Payee identity key is invalid')
  PublicKey.fromString(keyPart)

  let txid = ''
  let dp = ''
  let ds = ''
  let sender = ''
  let vout = 0
  let sats: number | null = null
  if (query) {
    const params = new URLSearchParams(query)
    txid = (params.get('txid') || '').trim().toLowerCase()
    dp = (params.get('dp') || '').trim()
    ds = (params.get('ds') || '').trim()
    sender = (params.get('sender') || '').trim().toLowerCase()
    const voutRaw = params.get('vout')
    if (voutRaw != null && voutRaw !== '') {
      const n = Number.parseInt(voutRaw, 10)
      if (!Number.isInteger(n) || n < 0) throw new Error('vout must be a non-negative integer')
      vout = n
    }
    const satsRaw = params.get('sats')
    if (satsRaw != null && satsRaw !== '') {
      if (!/^\d+$/.test(satsRaw)) throw new Error('sats must be a non-negative integer')
      const n = Number.parseInt(satsRaw, 10)
      sats = n > 0 ? n : null
    }
  }
  if (!TXID_RE.test(txid)) throw new Error('Settlement URI missing txid')
  if (!dp || !ds) throw new Error('Settlement URI missing remittance')
  if (!isCompressedIdentityKeyHex(sender)) throw new Error('Settlement URI missing sender')
  PublicKey.fromString(sender)

  return {
    payeeIdentityKey: keyPart,
    senderIdentityKey: sender,
    txid,
    remittance: {
      derivationPrefix: dp,
      derivationSuffix: ds,
      outputIndex: vout,
    },
    sats,
  }
}

export function tryParseBrc29SettlementUri(raw: string): Brc29SettlementUri | null {
  if (!looksLikeBrc29SettlementUri(raw)) return null
  try {
    return parseBrc29SettlementUri(raw)
  } catch {
    return null
  }
}
