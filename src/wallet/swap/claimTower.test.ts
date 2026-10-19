import { PrivateKey } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { fromHex, ltcTxid, toHex, type LtcTx } from "../ltc/litecoin";
import type { SwapAsset } from "./assets";
import {
  claimLanding,
  claimTicketId,
  fillClaim,
  judgeClaimTicket,
  parseClaimTicket,
  presignClaim,
  type ClaimTicket,
} from "./claimTower";
import type { FeeChainReader } from "./feeClaim";
import { htlcScript, htlcTxBytes, sha256, signHtlcSpend, type HtlcCoin } from "./htlc";

const maker = PrivateKey.fromString("11".repeat(32), "hex");
const taker = PrivateKey.fromString("22".repeat(32), "hex");
const secret = fromHex("ab".repeat(32));
const hash = toHex(sha256(secret));
const NOW_S = 1_800_000_000;
const payTo = fromHex("76a914" + "00".repeat(20) + "88ac");

/** A lock on `chain` that `claimer` takes with the secret and `refunder` takes back at `locktime`. */
function lock(chain: SwapAsset, claimer: PrivateKey, refunder: PrivateKey, locktime: number, txid: string): HtlcCoin {
  const script = htlcScript(chain, {
    hash: fromHex(hash),
    claimPub: fromHex(claimer.toPublicKey().toString()),
    refundPub: fromHex(refunder.toPublicKey().toString()),
    locktime,
  });
  return { txid, vout: 0, amount: 1_000_000n, script };
}

/** The maker's lock (taker claims it) on `watch`, the taker's lock (maker claims it) on `claimOn`. */
function swap(watch: SwapAsset, claimOn: SwapAsset) {
  const makerLock = lock(watch, taker, maker, NOW_S + 48 * 3600, "aa".repeat(32));
  const takerLock = lock(claimOn, maker, taker, NOW_S + 72 * 3600, "bb".repeat(32));
  const template = presignClaim(claimOn, { coin: takerLock, to: payTo, key: maker, feeRate: 8 });
  const ticket: ClaimTicket = {
    v: 1,
    watch: { chain: watch, txid: makerLock.txid, vout: 0, script: toHex(makerLock.script) },
    hash,
    claim: { ...template, script: toHex(takerLock.script) },
    until: NOW_S + 72 * 3600,
  };
  return { makerLock, takerLock, template, ticket };
}

function reader(chain: SwapAsset, spenders: Record<string, LtcTx> = {}): FeeChainReader {
  return {
    txHex: async () => null,
    spenderHex: async (o) => {
      const tx = spenders[`${o.txid}:${o.vout}`];
      return tx ? htlcTxBytes(chain, tx).hex : null;
    },
    broadcast: async () => {},
    feeRate: async () => 2,
  };
}

describe("presigned claims", () => {
  it.each([
    ["ltc", "segwit"],
    ["btc", "segwit"],
    ["bsv", "legacy"],
    ["doge", "legacy"],
    ["bch", "legacy"],
  ] as const)("fills %s (%s) into the exact claim signed with the secret", (chain) => {
    const { takerLock, template } = swap(chain === "bsv" ? "ltc" : "bsv", chain);
    const direct = signHtlcSpend(chain, { coins: [takerLock], to: payTo, key: maker, path: { kind: "claim", preimage: secret }, feeRate: 8 });
    const filled = fillClaim(template, secret, hash);
    expect(filled.hex).toBe(direct.hex);
    expect(filled.txid).toBe(direct.txid);
    expect(filled.value).toBe(direct.tx.outputs[0]!.value);
    expect(template.hex).not.toContain(toHex(secret));
  });

  it("refuses a secret that does not open the swap", () => {
    const { template } = swap("bsv", "ltc");
    expect(() => fillClaim(template, fromHex("cd".repeat(32)), hash)).toThrow(/does not open/);
  });

  it("refuses a template that does not leave the secret out", () => {
    const { template } = swap("bsv", "ltc");
    const filled = fillClaim(template, secret, hash);
    expect(() => fillClaim({ ...template, hex: filled.hex }, secret, hash)).toThrow(/leave the secret out/);
  });
});

describe("claim tickets", () => {
  it("takes what a maker sends and refuses the rest", () => {
    const { ticket } = swap("bsv", "ltc");
    expect(parseClaimTicket(ticket, NOW_S)).toEqual(ticket);
    expect(claimTicketId(ticket)).toMatch(new RegExp(`^bsv:${"aa".repeat(32)}:0:[0-9a-f]{16}$`));
    const other = lock("ltc", maker, taker, NOW_S + 72 * 3600, "bb".repeat(32));
    expect(parseClaimTicket({ ...ticket, hash: "cd".repeat(32) }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, claim: { ...ticket.claim, script: toHex(other.script).replace(hash, "ef".repeat(32)) } }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, v: 2 }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, claim: { ...ticket.claim, chain: "bsv" } }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, until: NOW_S + 30 * 24 * 3600 }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, claim: { ...ticket.claim, secretAt: ticket.claim.secretAt + 1 } }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, claim: { ...ticket.claim, hex: "00".repeat(3000) } }, NOW_S)).toBeNull();
    expect(parseClaimTicket({ ...ticket, hash: "zz" }, NOW_S)).toBeNull();
  });
});

describe("judgeClaimTicket", () => {
  it("waits while the maker's lock is unspent", async () => {
    const { ticket } = swap("bsv", "ltc");
    expect(await judgeClaimTicket(ticket, reader("bsv"))).toEqual({ kind: "waiting" });
  });

  it("fills the maker's claim from the taker's claim", async () => {
    const { makerLock, takerLock, ticket } = swap("bsv", "ltc");
    const takerClaim = signHtlcSpend("bsv", { coins: [makerLock], to: payTo, key: taker, path: { kind: "claim", preimage: secret }, feeRate: 0.1 }).tx;
    const verdict = await judgeClaimTicket(ticket, reader("bsv", { [`${makerLock.txid}:0`]: takerClaim }));
    const direct = signHtlcSpend("ltc", { coins: [takerLock], to: payTo, key: maker, path: { kind: "claim", preimage: secret }, feeRate: 8 });
    expect(verdict).toEqual({ kind: "claim", hex: direct.hex, txid: direct.txid });
  });

  it("calls a ticket void when the maker took its lock back", async () => {
    const { makerLock, ticket } = swap("ltc", "bsv");
    const refund = signHtlcSpend("ltc", { coins: [makerLock], to: payTo, key: maker, path: { kind: "refund", locktime: NOW_S + 48 * 3600 }, feeRate: 2 }).tx;
    expect(await judgeClaimTicket(ticket, reader("ltc", { [`${makerLock.txid}:0`]: refund }))).toEqual({ kind: "void", txid: ltcTxid(refund) });
  });
});

describe("claimLanding", () => {
  it("tells the maker's claim from the taker's refund", async () => {
    const { takerLock, ticket } = swap("bsv", "ltc");
    const key = `${takerLock.txid}:0`;
    expect(await claimLanding(ticket, reader("ltc"))).toEqual({ kind: "unspent" });
    const claimed = fillClaim(ticket.claim, secret, hash);
    const claimTx = signHtlcSpend("ltc", { coins: [takerLock], to: payTo, key: maker, path: { kind: "claim", preimage: secret }, feeRate: 8 }).tx;
    expect(await claimLanding(ticket, reader("ltc", { [key]: claimTx }))).toEqual({ kind: "claimed", txid: claimed.txid });
    const refund = signHtlcSpend("ltc", { coins: [takerLock], to: payTo, key: taker, path: { kind: "refund", locktime: NOW_S + 72 * 3600 }, feeRate: 2 }).tx;
    expect(await claimLanding(ticket, reader("ltc", { [key]: refund }))).toEqual({ kind: "lost", txid: ltcTxid(refund) });
  });
});
