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
 */

export type OrdinalMigrateSkipReason =
  /** Cash or any other non-1-sat output the indexer returned for the address. */
  | 'notOneSat'
  /** 1 sat, but not locked to the phrase key — listed, covenant, or foreign. */
  | 'foreignLock'
  /** Source output could not be read from the tip BEEF. */
  | 'unreadable'

export type OrdinalMigratePath =
  | { path: 'migrate'; satoshis: number }
  | { path: 'skip'; reason: OrdinalMigrateSkipReason }

export type OrdinalSourceOutput = {
  satoshis?: number | null
  /** Locking script hex of the source output. */
  lockingScriptHex?: string | null
}

/**
 * Decide once, from the source transaction itself rather than the indexer.
 *
 * `expectedP2pkhHex` is the bare P2PKH lock of the key that will sign. A tip is
 * almost never *only* that: real ordinals append an inscription envelope, and
 * Yours tips append an `OP_RETURN` Sigma signature, so the P2PKH occurs as a
 * fragment of a longer script. Requiring equality here would refuse every real
 * collectable, so the test is containment — a tip whose script does not carry
 * our key's P2PKH at all cannot be unlocked by this key however often it is
 * retried, and is refused by name instead.
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
  if (!lock.includes(expected)) return { path: 'skip', reason: 'foreignLock' }
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
  }
}
