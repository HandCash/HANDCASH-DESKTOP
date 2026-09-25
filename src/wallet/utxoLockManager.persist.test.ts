import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const writes: string[] = [];

vi.mock("./durableStorage", () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value);
    writes.push(key);
    return true;
  },
}));

import {
  __resetUtxoLocksForTests,
  flushUtxoLocks,
  getUtxoLock,
  hideUtxo,
  listUtxoLocks,
} from "./utxoLockManager";

const outpoint = (i: number) => `${"a".repeat(64)}.${i}`;

/**
 * Sealing a transaction's inputs writes the overlay once per coin. Each write
 * serializes every row and lands a synchronous `localStorage.setItem`, so a
 * bulk seal used to hold the main thread for seconds (lab phone hc-a580a).
 */
describe("utxo overlay durability", () => {
  beforeEach(() => {
    __resetUtxoLocksForTests();
    writes.length = 0;
  });

  it("costs one durable write no matter how many coins a task seals", async () => {
    for (let i = 0; i < 24; i++) {
      hideUtxo(outpoint(i), { spentBy: "b".repeat(64) });
    }
    expect(writes).toHaveLength(0);

    await Promise.resolve();

    expect(writes).toHaveLength(1);
    expect(listUtxoLocks()).toHaveLength(24);
  });

  it("reads the coin it just sealed without waiting for the write", () => {
    hideUtxo(outpoint(0), { spentBy: "b".repeat(64) });
    expect(getUtxoLock(outpoint(0))?.spendable).toBe(false);
  });

  it("lands the write before any awaited work resumes", async () => {
    hideUtxo(outpoint(1), { spentBy: "b".repeat(64) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(store.get([...store.keys()].at(-1)!)!)).toHaveLength(1);
  });

  it("flushes on demand for callers that may not survive the task", () => {
    hideUtxo(outpoint(2), { spentBy: "b".repeat(64) });
    flushUtxoLocks();
    expect(writes).toHaveLength(1);
  });
});
