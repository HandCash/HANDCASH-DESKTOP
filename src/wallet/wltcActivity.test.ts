import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("./durableStorage", () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value);
    return true;
  },
}));
vi.mock("./spendAnnounce", () => ({ announceSpendCompleted: vi.fn() }));

import {
  activityEntryTitle,
  activityNetworkLabel,
  activityTokenAmountDisplay,
  clearAppActivity,
  isEventActivity,
  isTokenActivity,
  listRecentActivity,
  recordAppActivity,
  upgradeActivityRows,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
  type ActivityItem,
} from "./appActivity";

const ASSET = "ab".repeat(20);
const TX = "cd".repeat(32);
const wltc = (amt: string): ActivityItem => ({
  name: "wLTC",
  origin: ASSET,
  tokenId: ASSET,
  amt,
  dec: 8,
  backedBy: "ltc",
});

function row(partial: Partial<ActivityEntry>): ActivityEntry {
  return { id: "1", origin: WALLET_ACTIVITY_ORIGIN, kind: "earned", sats: 0, at: 1, method: "receive-token", ...partial };
}

function only(): ActivityEntry {
  const rows = listRecentActivity();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("wLTC and BNT activity rows follow the token row standard", () => {
  beforeEach(() => {
    store.clear();
    clearAppActivity();
  });

  it("names a deposit in Litecoin and signs its amount like a receive", () => {
    const deposit = row({ method: "wltc-credit", item: wltc("839066") });
    expect(isTokenActivity(deposit)).toBe(true);
    expect(isEventActivity(deposit)).toBe(false);
    expect(activityEntryTitle(deposit)).toBe("Deposited 0.00839066 LTC");
    expect(activityTokenAmountDisplay(deposit)).toBe("+0.00839066");
  });

  it("names a withdrawal by the LTC paid and signs it like a send", () => {
    const withdrawal = row({ kind: "spent", method: "wltc-withdraw", item: wltc("200000") });
    expect(activityEntryTitle(withdrawal)).toBe("Withdrew 0.002 LTC");
    expect(activityTokenAmountDisplay(withdrawal)).toBe("−0.002");
  });

  it("names Litecoin as the network of every Litecoin row, and nothing for BSV rows", () => {
    const ltc: ActivityItem = { name: "LTC", origin: "ltc", amt: "1000", dec: 8, backedBy: "ltc" };
    expect(activityNetworkLabel(row({ method: "ltc-receive", item: ltc }))).toBe("On Litecoin");
    expect(activityNetworkLabel(row({ kind: "spent", method: "ltc-send", item: ltc }))).toBe("On Litecoin");
    expect(activityNetworkLabel(row({ method: "wltc-credit", item: wltc("1000") }))).toBe("On Litecoin");
    expect(activityNetworkLabel(row({ method: "payment", sats: 5000 }))).toBeNull();
    expect(activityNetworkLabel(row({ method: "receive-token", item: { ...wltc("1"), backedBy: undefined } }))).toBeNull();
  });

  it("reads native Litecoin rows as LTC quantities", () => {
    const ltc: ActivityItem = { name: "LTC", origin: "ltc", amt: "839066", dec: 8, backedBy: "ltc" };
    expect(isTokenActivity(row({ method: "ltc-receive", item: ltc }))).toBe(true);
    expect(activityEntryTitle(row({ method: "ltc-receive", item: ltc }))).toBe("Received 0.00839066 LTC");
    expect(activityEntryTitle(row({ kind: "spent", method: "ltc-send", item: ltc }))).toBe("Sent 0.00839066 LTC");
  });

  it("hides an earlier build's wLTC token rows: Litecoin is held natively, so they stand for no value", () => {
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "earned", sats: 0, method: "mint-token", txid: TX, item: wltc("839066") });
    expect(listRecentActivity()).toEqual([]);
  });

  it("reads BNT sends, receives, mints and burns in whole units with the symbol", () => {
    const item = wltc("100000");
    expect(activityEntryTitle(row({ kind: "spent", method: "send-token", item }))).toBe("Sent 0.001 wLTC");
    expect(activityEntryTitle(row({ method: "receive-token", item }))).toBe("Received 0.001 wLTC");
    expect(activityEntryTitle(row({ method: "mint-token", item }))).toBe("Minted 0.001 wLTC");
    expect(activityEntryTitle(row({ kind: "spent", method: "burn-token", item }))).toBe("Burned 0.001 wLTC");
    expect(activityTokenAmountDisplay(row({ kind: "spent", method: "send-token", item }))).toBe("−0.001");
    expect(activityTokenAmountDisplay(row({ method: "receive-token", item }))).toBe("+0.001");
  });

  it("never shows raw base units", () => {
    const title = activityEntryTitle(row({ kind: "spent", method: "send-token", item: wltc("100000") }));
    expect(title).not.toMatch(/100000|100,000/);
  });

  it("keeps the Litecoin backing on the stored item", () => {
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "earned", sats: 0, method: "wltc-credit", txid: TX, item: wltc("839066") });
    expect(only().item).toMatchObject({ backedBy: "ltc", tokenId: ASSET, amt: "839066", dec: 8 });
  });

  it("drops a backing claim it does not know", () => {
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: "earned",
      sats: 0,
      method: "receive-token",
      txid: TX,
      item: { ...wltc("1"), backedBy: "eth" as "ltc" },
    });
    expect(only().item?.backedBy).toBeUndefined();
  });

  it("is one row per withdrawal: the burn and the withdrawal on one transaction collapse", () => {
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "spent", sats: 0, method: "burn-token", txid: TX, item: wltc("200600") });
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "spent", sats: 0, method: "wltc-withdraw", txid: TX, item: wltc("200000") });
    const withdrawal = only();
    expect(withdrawal.method).toBe("wltc-withdraw");
    expect(activityEntryTitle(withdrawal)).toBe("Withdrew 0.002 LTC");
  });

  it("is one row per deposit: the mint and the credit on one transaction collapse", () => {
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "earned", sats: 0, method: "mint-token", txid: TX, item: { ...wltc("839066"), backedBy: undefined } });
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "earned", sats: 0, method: "wltc-credit", txid: TX, item: wltc("839066") });
    const deposit = only();
    expect(deposit.method).toBe("wltc-credit");
    expect(deposit.item?.backedBy).toBe("ltc");
    expect(activityEntryTitle(deposit)).toBe("Deposited 0.00839066 LTC");
  });

  it("never lists a burial as its own row; it is the deposit row's state", () => {
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "event", sats: 0, method: "wltc-proven", note: "0.00839066 wLTC can move", txid: TX });
    expect(listRecentActivity()).toEqual([]);
  });

  it("records a peer's transfer with the sender for the row's avatar", () => {
    const from = `02${"11".repeat(32)}`;
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "earned", sats: 0, method: "receive-token", txid: TX, item: { ...wltc("100000"), backedBy: undefined }, from });
    expect(only().from).toBe(from);
  });

  it("upgrades a stored legacy row in place: same id, same time, now a token row", () => {
    recordAppActivity({ origin: WALLET_ACTIVITY_ORIGIN, kind: "event", sats: 0, method: "bnt-transfer", note: "Sent 100000 wLTC (BNT)", txid: TX });
    const before = only();
    const changed = upgradeActivityRows((entry) =>
      entry.method === "bnt-transfer"
        ? { origin: entry.origin, kind: "spent", sats: 0, method: "send-token", txid: entry.txid, note: "Sent 100000 wLTC", item: { name: "wLTC", origin: `bnt:${TX}`, amt: "100000", dec: 8 } }
        : null
    );
    expect(changed).toBe(1);
    const after = only();
    expect(after.id).toBe(before.id);
    expect(after.at).toBe(before.at);
    expect(activityEntryTitle(after)).toBe("Sent 0.001 wLTC");
    expect(activityTokenAmountDisplay(after)).toBe("−0.001");
    expect(upgradeActivityRows(() => null)).toBe(0);
  });

  it("keeps a BNT item a named collectable row, not a token", () => {
    const robot = row({ method: "receive-collectable", item: { name: "Robot", origin: ASSET } });
    expect(isTokenActivity(robot)).toBe(false);
    expect(activityEntryTitle(robot)).toBe("Received Robot");
  });
});
