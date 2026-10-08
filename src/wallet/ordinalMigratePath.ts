/**
 * Explicit "may this address output be migrated as a collectable?" vocabulary.
 *
 * The ordinal indexer lists **every** unspent output an address holds, not just
 * inscriptions: a Yours wallet branch returns its cash outputs alongside its
 * ordinals. Migrating one of those as if it were a 1-sat tip signs with the
 * wrong sighash amount (`The top stack element must be truthy after script
 * evaluation`) and, had it verified, would have moved cash through the
 * collectable path.
 *
 * Same tagged-union shape as `chooseLegacySweepPath` / `ItemSettlePath`: a
 * boolean `satoshis === 1` test in the migrate loop is not enough, because the
 * lock must also be spendable by the phrase key. Listed (OrdLock) and other
 * covenant tips are refused rather than signed and retried forever.
 *
 * Only assets this wallet holds natively may migrate. The migrate output is a
 * bare 1-sat P2PKH in basket `1sat`, which is exactly what a transferred
 * ordinal is — and exactly what destroys a token or a RUN jig. Those stay on
 * the source address, refused by name.
 */
import { parseOrdEnvelope, hasOrdEnvelope } from './ordinalOwnership'
import { decodeBsv21Binary } from './token/decode162'

/** BSV-20 and BSV-21 inscriptions share this content type (`token/types` BSV21_MIME). */
const TOKEN_MIME = 'application/bsv-20'

export type OrdinalMigrateSkipReason =
  /** Cash or any other non-1-sat output the indexer returned for the address. */
  | 'notOneSat'
  /** 1 sat, but not locked to the phrase key — listed or foreign. */
  | 'foreignLock'
  /** Source output could not be read from the tip BEEF. */
  | 'unreadable'
  /** BSV-20 / BSV-21 token: a bare P2PKH output would burn it. */
  | 'token'
  /** RUN jig: only a RUN transaction may spend it. */
  | 'runJig'
  /** Carries the phrase key's P2PKH inside a larger contract (Sigil, STAS, …). */
  | 'covenant'
  /** The input check found the tip already spent by another transaction. */
  | 'spentElsewhere'

export type OrdinalMigratePath =
  | { path: 'migrate'; satoshis: number }
  | { path: 'skip'; reason: OrdinalMigrateSkipReason }

export type OrdinalSourceOutput = {
  satoshis?: number | null
  /** Locking script hex of the source output. */
  lockingScriptHex?: string | null
  /** Set when the source transaction's RUN marker claims this output. */
  runJig?: boolean
}

const ORD_ENVELOPE_START = '0063036f7264'

function isWholeOrdEnvelope(hex: string): boolean {
  return hex.startsWith(ORD_ENVELOPE_START) && hex.endsWith('68') && hasOrdEnvelope(hex)
}

/**
 * Where the key's P2PKH sits in the tip script, and what surrounds it.
 *
 * A collectable is the P2PKH alone, an inscription envelope before or after
 * it, and optionally trailing `OP_RETURN` data (Sigma, MAP). Anything else
 * wrapped around the P2PKH is a contract with spending rules of its own.
 */
function tipScriptShape(lock: string, p2pkh: string): 'collectable' | 'covenant' | 'foreign' {
  let at = lock.indexOf(p2pkh)
  while (at >= 0 && at % 2 !== 0) at = lock.indexOf(p2pkh, at + 1)
  if (at < 0) return 'foreign'
  const before = lock.slice(0, at)
  const after = lock.slice(at + p2pkh.length)
  const beforeOk = before === '' || isWholeOrdEnvelope(before)
  const afterOk =
    after === '' ||
    after.startsWith('6a') ||
    (after.startsWith(ORD_ENVELOPE_START) && hasOrdEnvelope(after))
  return beforeOk && afterOk ? 'collectable' : 'covenant'
}

function isTokenScript(lock: string): boolean {
  const contentType = parseOrdEnvelope(lock)?.contentType?.trim().toLowerCase() ?? ''
  if (contentType.startsWith(TOKEN_MIME)) return true
  return decodeBsv21Binary(lock) != null
}

/**
 * Decide once, from the source transaction itself rather than the indexer.
 *
 * `expectedP2pkhHex` is the bare P2PKH lock of the key that will sign. A tip is
 * almost never *only* that: real ordinals append an inscription envelope, and
 * Yours tips append an `OP_RETURN` Sigma signature, so the P2PKH occurs as a
 * fragment of a longer script. Requiring equality here would refuse every real
 * collectable, so the test is the shape around that fragment — a tip whose
 * script does not carry our key's P2PKH at all cannot be unlocked by this key
 * however often it is retried, and is refused by name instead.
 */
export function chooseOrdinalMigratePath(
  output: OrdinalSourceOutput | null | undefined,
  expectedP2pkhHex: string,
): OrdinalMigratePath {
  if (!output) return { path: 'skip', reason: 'unreadable' }

  const satoshis = Number(output.satoshis ?? 0)
  const lock = (output.lockingScriptHex ?? '').trim().toLowerCase()
  const expected = expectedP2pkhHex.trim().toLowerCase()
  if (!lock || !expected) return { path: 'skip', reason: 'unreadable' }
  if (!Number.isFinite(satoshis) || satoshis <= 0) {
    return { path: 'skip', reason: 'unreadable' }
  }
  if (satoshis !== 1) return { path: 'skip', reason: 'notOneSat' }
  if (output.runJig) return { path: 'skip', reason: 'runJig' }
  if (isTokenScript(lock)) return { path: 'skip', reason: 'token' }
  const shape = tipScriptShape(lock, expected)
  if (shape === 'foreign') return { path: 'skip', reason: 'foreignLock' }
  if (shape === 'covenant') return { path: 'skip', reason: 'covenant' }
  return { path: 'migrate', satoshis }
}

export function describeOrdinalMigrateSkip(reason: OrdinalMigrateSkipReason): string {
  switch (reason) {
    case 'notOneSat':
      return 'not a 1-sat collectable (cash output)'
    case 'foreignLock':
      return 'not locked to this phrase key (listed or covenant tip)'
    case 'unreadable':
      return 'source output could not be read'
    case 'token':
      return 'a token — moving it as a collectable would burn it'
    case 'runJig':
      return 'a RUN jig — only a RUN transaction can move it'
    case 'covenant':
      return 'held in a contract (Sigil, STAS or similar) this wallet cannot move'
    case 'spentElsewhere':
      return 'already moved — another transaction spent it'
  }
}
