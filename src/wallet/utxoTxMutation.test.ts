import { describe, expect, it } from "vitest";
import { chooseSpentCoinMutation, isNamedSpenderTxid } from "./utxoTxMutation";

const TX = "aa".repeat(32);

describe("utxoTxMutation", () => {
  it("names a complete spender txid and rejects empty overlays", () => {
    expect(isNamedSpenderTxid(TX)).toBe(true);
    expect(isNamedSpenderTxid("")).toBe(false);
    expect(isNamedSpenderTxid(null)).toBe(false);
  });

  it("keeps a live local cheque instead of editing the coin", () => {
    expect(
      chooseSpentCoinMutation({
        spendable: true,
        namedSpenderTxid: null,
        hasLocalSpenderRow: false,
        blockedByLocalSpend: true,
        itemTransferPending: false,
      })
    ).toBe("keep");
  });

  it("adopts a named spender rather than poking the UTXO directly", () => {
    expect(
      chooseSpentCoinMutation({
        spendable: true,
        namedSpenderTxid: TX,
        hasLocalSpenderRow: false,
        blockedByLocalSpend: false,
        itemTransferPending: false,
      })
    ).toBe("adopt-spend");
  });

  it("quarantines a spent coin until the spender transaction can be inserted", () => {
    expect(
      chooseSpentCoinMutation({
        spendable: true,
        namedSpenderTxid: null,
        hasLocalSpenderRow: false,
        blockedByLocalSpend: false,
        itemTransferPending: false,
      })
    ).toBe("quarantine");
  });
});
