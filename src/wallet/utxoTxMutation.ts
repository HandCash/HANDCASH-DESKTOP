/**
 * UTXO mutations are transaction-shaped, not row edits.
 *
 * Cloud learned this the hard way: flipping Mongo UnspentOutput rows without
 * inserting/reverting a BlockchainTransaction created competing spends. The
 * device wallet keeps the same invariant locally:
 *
 * - revert a local signed tx (inputs free, its outputs retired)
 * - restore a local signed tx the chain actually has
 * - adopt a named spender (hide inputs as spentBy that txid)
 * - quarantine when spent but the spender body is unknown
 * - expire a draft reservation that never became a signed tx
 *
 * Direct `spendable` flips are the apply step of one of these edits, never a
 * third path.
 */

export type UtxoTxMutation =
  | { kind: "revert-local"; txid: string }
  | { kind: "restore-local"; txid: string }
  | { kind: "adopt-spend"; outpoints: string[]; spentBy: string }
  | { kind: "quarantine"; outpoints: string[] }
  | { kind: "expire-reservation"; outpoint: string };

export function isNamedSpenderTxid(value: string | null | undefined): boolean {
  const id = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(id);
}

/**
 * How a proven-spent coin may change local state.
 *
 * A live local cheque or pending item send is already the spending
 * transaction — do not invent a second one. A named spender can be adopted.
 * Everything else is quarantine until that body exists.
 */
export function chooseSpentCoinMutation(args: {
  spendable: boolean;
  namedSpenderTxid: string | null;
  hasLocalSpenderRow: boolean;
  blockedByLocalSpend: boolean;
  itemTransferPending: boolean;
}):
  | Extract<UtxoTxMutation, { kind: "adopt-spend" | "quarantine" }>["kind"]
  | "keep" {
  if (args.blockedByLocalSpend || args.itemTransferPending) return "keep";
  const hasSpender =
    args.hasLocalSpenderRow || isNamedSpenderTxid(args.namedSpenderTxid);
  if (!args.spendable && hasSpender) return "keep";
  if (hasSpender) return "adopt-spend";
  if (!args.spendable) return "keep";
  return "quarantine";
}
