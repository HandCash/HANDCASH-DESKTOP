import { Hash, Utils } from '@bsv/sdk'
import { peekSessionBeef } from './beefCache'
import { issuerMetadataFromScript } from './issuerMetadata'
import { retainedTokenGenesis } from './token/genesisStore'
import { sigmaSignerIs, verifiedSigmaSigner, type SigmaSigner } from './token/issuer'

export type RetainedIssuer = { issuer?: string; bapId?: string }

type Entry = RetainedIssuer & {
  scriptHash: string
  scriptLength: number
  /** Last listed script that matched; a refresh compares it instead of rehashing an inscription. */
  matched?: string
  /** The script carries a Sigma marker, whether or not it verifies. */
  sigma: boolean
  signer: SigmaSigner | null
  minedHeight?: number
  heightCheckedAt?: number
}

/**
 * Issuer metadata and Sigma verdicts for outputs of locally retained
 * transactions.
 *
 * A session BEEF read parses the whole package, ancestry included, and an
 * origin script can be the full inscribed image. Listing runs per tip on every
 * refresh, so each outpoint is parsed and its Sigma verified once: a txid's
 * outputs never change. Nothing is remembered until the transaction is held.
 */
const MAX_ENTRIES = 2048
/** An unmined origin rereads its BEEF for a proof at most this often. */
const HEIGHT_RECHECK_MS = 60_000
const SIGMA_MARKER = '5349474d41'
const entries = new Map<string, Entry>()

function outpointKey(outpoint: string): { key: string; txid: string; vout: number } | null {
  const match = outpoint.trim().match(/^([0-9a-f]{64})[._](\d+)$/i)
  if (!match) return null
  const txid = match[1]!.toLowerCase()
  const vout = Number(match[2])
  if (!Number.isSafeInteger(vout)) return null
  return { key: `${txid}.${vout}`, txid, vout }
}

function retainedEntry(txid: string) {
  try {
    const session = peekSessionBeef(txid)
    const beef = session?.findTxid(txid)?.tx ? session : retainedTokenGenesis(txid)
    const entry = beef?.findTxid(txid)
    if (!beef || !entry?.tx) return null
    const minedHeight =
      entry.bumpIndex === undefined ? undefined : beef.bumps[entry.bumpIndex]?.blockHeight
    return { tx: entry.tx, minedHeight }
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
  const retained = retainedEntry(at.txid)
  const script = retained?.tx.outputs[at.vout]?.lockingScript.toHex()
  if (!retained || !script) return null
  const metadata = issuerMetadataFromScript(script)
  const sigma = script.toLowerCase().includes(SIGMA_MARKER)
  return remember(at.key, {
    ...(metadata.issuer ? { issuer: metadata.issuer } : {}),
    ...(metadata.bapId ? { bapId: metadata.bapId } : {}),
    ...(retained.minedHeight !== undefined
      ? { minedHeight: retained.minedHeight }
      : { heightCheckedAt: Date.now() }),
    scriptHash: hashScript(script),
    scriptLength: script.length,
    sigma,
    signer: sigma ? verifiedSigmaSigner(retained.tx, at.vout) : null,
  })
}

/** Issuer tape on a retained output; null until its transaction is held. */
export function retainedIssuerMetadata(outpoint: string): RetainedIssuer | null {
  const entry = entryFor(outpoint)
  if (!entry) return null
  return {
    ...(entry.issuer ? { issuer: entry.issuer } : {}),
    ...(entry.bapId ? { bapId: entry.bapId } : {}),
  }
}

/** Block height of a retained output's transaction, once its BEEF carries the proof. */
export function retainedMinedHeight(outpoint: string): number | undefined {
  const entry = entryFor(outpoint)
  const at = outpointKey(outpoint)
  if (!entry || !at) return undefined
  const now = Date.now()
  if (entry.minedHeight === undefined && now - (entry.heightCheckedAt ?? 0) >= HEIGHT_RECHECK_MS) {
    entry.heightCheckedAt = now
    const minedHeight = retainedEntry(at.txid)?.minedHeight
    if (minedHeight !== undefined) entry.minedHeight = minedHeight
  }
  return entry.minedHeight
}

/** The retained output's locking script is exactly `scriptHex`. */
export function retainedScriptIs(outpoint: string, scriptHex: string | undefined): boolean {
  if (!scriptHex) return false
  const entry = entryFor(outpoint)
  if (!entry) return false
  if (entry.matched === scriptHex) return true
  if (scriptHex.length !== entry.scriptLength || entry.scriptHash !== hashScript(scriptHex)) return false
  entry.matched = scriptHex
  return true
}

/** Sigma on the retained output verifies for `issuer`, bound to its funding input. */
export function retainedSignedBy(outpoint: string, issuer: string): boolean {
  const entry = entryFor(outpoint)
  return !!entry && sigmaSignerIs(entry.signer, issuer)
}

/** The retained output carries a Sigma, valid or not; false until its transaction is held. */
export function retainedCarriesSigma(outpoint: string): boolean {
  return entryFor(outpoint)?.sigma ?? false
}

export function resetIssuerAttributionForTests(): void {
  entries.clear()
}
