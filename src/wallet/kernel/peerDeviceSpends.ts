/**
 * What another install of this key has spent, judged from its history snapshot.
 *
 * Only this key can spend these coins, so the ledger is exact on one install.
 * A second install is the one spender it cannot see. Its BRC-39 upload names
 * every transaction it signed; a signed, not-failed transaction this device
 * does not know that consumes a coin still spendable here is a spend of that
 * coin — whether or not an explorer has seen it yet.
 *
 * Transactions this device already holds are left to its own ledger, whatever
 * the snapshot says about them: a stale copy of our own history must never
 * re-hide coins a failed send handed back.
 */

export type SnapshotTx = { txid: string; status: string; inputs: readonly string[] }

export type PeerSpend = { outpoint: string; spender: string }

/** Statuses under which a snapshot transaction consumed nothing. */
const SPENDS_NOTHING: ReadonlySet<string> = new Set(['failed', 'unsigned'])

/** Spenders worth asking the local ledger about: they touch a coin spendable here. */
export function peerSpendCandidates(
  txs: readonly SnapshotTx[],
  spendableHere: ReadonlySet<string>,
): PeerSpend[] {
  const out: PeerSpend[] = []
  const claimed = new Set<string>()
  for (const tx of txs) {
    if (SPENDS_NOTHING.has(tx.status)) continue
    for (const outpoint of tx.inputs) {
      if (!spendableHere.has(outpoint) || claimed.has(outpoint)) continue
      claimed.add(outpoint)
      out.push({ outpoint, spender: tx.txid })
    }
  }
  return out
}

export type PeerSpendPlan = {
  /** Coins to retire here, each under the other install's spender. */
  spends: PeerSpend[]
  /** Recorded spenders the snapshot now shows failed: their coins are no longer claimed. */
  withdrawn: string[]
}

export function planPeerSpends(args: {
  txs: readonly SnapshotTx[]
  candidates: readonly PeerSpend[]
  knownHere: ReadonlySet<string>
  recordedSpenders: ReadonlySet<string>
}): PeerSpendPlan {
  const failed = new Set(
    args.txs.filter((tx) => tx.status === 'failed').map((tx) => tx.txid),
  )
  return {
    spends: args.candidates.filter((c) => !args.knownHere.has(c.spender)),
    withdrawn: [...args.recordedSpenders].filter((txid) => failed.has(txid)),
  }
}
