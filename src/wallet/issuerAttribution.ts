import { Hash, Utils } from '@bsv/sdk'
import { peekSessionBeef } from './beefCache'
import { issuerMetadataFromScript } from './issuerMetadata'
import type { PublicIdentityProfile } from './publicIdentityProfile'
import { verifySigmaIssuer } from './token/issuer'

export type RetainedIssuer = { issuer?: string; issuerProfile?: PublicIdentityProfile }

type Entry = RetainedIssuer & { scriptHash: string; signers: Map<string, boolean> }

/**
 * Issuer metadata and Sigma verdicts for outputs of locally retained
 * transactions.
 *
 * A session BEEF read parses the whole package, ancestry included, and an
 * origin script can be the full inscribed image. Listing runs per tip on every
 * refresh, so each outpoint is parsed and verified once: a txid's outputs never
 * change. Nothing is remembered until the transaction is actually held.
 */
const MAX_ENTRIES = 2048
const entries = new Map<string, Entry>()

function outpointKey(outpoint: string): { key: string; txid: string; vout: number } | null {
  const match = outpoint.trim().match(/^([0-9a-f]{64})[._](\d+)$/i)
  if (!match) return null
  const txid = match[1]!.toLowerCase()
  const vout = Number(match[2])
  if (!Number.isSafeInteger(vout)) return null
  return { key: `${txid}.${vout}`, txid, vout }
}

function retainedTx(txid: string) {
  try {
    return peekSessionBeef(txid)?.findTxid(txid)?.tx ?? null
  } catch {
    return null
  }
}

function hashScript(hex: string): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(hex.toLowerCase(), 'hex')))
}

function remember(key: string, entry: Entry): Entry {
  entries.delete(key)
  entries.set(key, entry)
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
  return entry
}

function entryFor(outpoint: string): Entry | null {
  const at = outpointKey(outpoint)
  if (!at) return null
  const hit = entries.get(at.key)
  if (hit) return remember(at.key, hit)
  const script = retainedTx(at.txid)?.outputs[at.vout]?.lockingScript.toHex()
  if (!script) return null
  const metadata = issuerMetadataFromScript(script)
  return remember(at.key, {
    ...(metadata.issuer ? { issuer: metadata.issuer } : {}),
    ...(metadata.issuerProfile ? { issuerProfile: metadata.issuerProfile } : {}),
    scriptHash: hashScript(script),
    signers: new Map(),
  })
}

/** Issuer tape on a retained output; null until its transaction is held. */
export function retainedIssuerMetadata(outpoint: string): RetainedIssuer | null {
  const entry = entryFor(outpoint)
  if (!entry) return null
  return {
    ...(entry.issuer ? { issuer: entry.issuer } : {}),
    ...(entry.issuerProfile ? { issuerProfile: entry.issuerProfile } : {}),
  }
}

/** The retained output's locking script is exactly `scriptHex`. */
export function retainedScriptIs(outpoint: string, scriptHex: string | undefined): boolean {
  if (!scriptHex) return false
  const entry = entryFor(outpoint)
  return !!entry && entry.scriptHash === hashScript(scriptHex)
}

/** Sigma on the retained output verifies for `issuer`, bound to its funding input. */
export function retainedSignedBy(outpoint: string, issuer: string): boolean {
  const entry = entryFor(outpoint)
  const at = outpointKey(outpoint)
  if (!entry || !at) return false
  const signer = issuer.trim().toLowerCase()
  const known = entry.signers.get(signer)
  if (known !== undefined) return known
  const tx = retainedTx(at.txid)
  if (!tx) return false
  const verdict = verifySigmaIssuer(tx, at.vout, signer)
  entry.signers.set(signer, verdict)
  return verdict
}

export function resetIssuerAttributionForTests(): void {
  entries.clear()
}
