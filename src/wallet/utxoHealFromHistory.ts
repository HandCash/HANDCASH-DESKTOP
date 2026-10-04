/**
 * Reconcile local toolbox UTXOs from Activity + live/failed toolbox rows.
 * Do not scrape the app-log ring — that is 800+ lines of support noise, not a
 * UTXO index. Checkpoint remembers already-healed txids so we do not re-probe
 * them. Auto/checkpoint passes are silent; manual writes Activity only when
 * sats move or the pass fails.
 *
 * A pass is pinned to the `WalletRuntime` it started on. Every step after an
 * await re-asserts that runtime is still current and aborts otherwise, and
 * the checkpoint is keyed by the pinned account — never the ambient one. This
 * is the fundamental multi-wallet rule: work that spans awaits may only touch
 * the account it captured (hc-a580a, 2026-09-27: a manual heal begun on one
 * vault account finished on the next and rehid/reclaimed its coins).
 */
import {
  collectActivityTxids,
  recordWalletEvent,
  UTXO_HEAL_METHOD,
  WALLET_ACTIVITY_ORIGIN,
} from "./appActivity";
import {
  hasArcadeSubmitContacts,
  txHadArcadeSubmitContact,
} from "./arcadeSubmitGuard";
import { runChangeHeal, type ChangeHealStats } from "./chainedChangeHeal";
import { fileUnstoredSendTips } from "./unstoredSendTips";
import { logDiag, snapshotWalletBalance } from "./diagnosticLog";
import { txExistsOnChain } from "./legacyScan";
import { bumpBalanceAfterHeal} from "./session";
import type { Chain } from "./vault";
import { releaseSpendAttemptFunds } from "./spendAttempt";
import {
  listSignedChequeTxids,
  signedChequeAtomic,
} from "./signedChequeArchive";
import {
  keepChangeOfSignedTx,
  listFailedLocalTxids,
  localTxRecorded,
  listPendingLocalChangeTxids,
  reconcileKnownUtxosByEvidence,
  reclaimOutputsSealedByDeadTxs,
  pinBroadcastLocalTx,
  restoreOnChainLocalTx,
  restoreFailedLocalTxsKnownOnChain,
  sealSpentInputsOfSignedTx,
  rehideInputsOfLiveLocalTxs,
  type UtxoEvidenceHealResult,
} from "./staleOutputRelease";
import {
  appendHealCheckpointBatch,
  healCheckpointFresh,
  HEAL_TXID_BATCH_SIZE,
  readHealCheckpoint,
  txidsMissingFromCheckpoint,
  writeHealCheckpoint,
  type UtxoHealCheckpointSource,
} from "./utxoHealCheckpoint";
import {
  accountKeyScopeFor,
  type BoundAccountKeyScope,
} from "./accountLocalKeys";
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  requireWalletRuntime,
  runtimeIsCurrent,
  type WalletRuntime,
  type WalletRuntimeId,
} from "./walletRuntime";

/**
 * The account a heal pass is pinned to. `guard()` throws `AbortError` once the
 * runtime is no longer current; call it after every await so no step can act
 * on a wallet the pass did not start on.
 */
type HealOwner = {
  runtime: WalletRuntime;
  scope: BoundAccountKeyScope;
  guard: () => void;
};

function pinHealOwner(runtime: WalletRuntime): HealOwner {
  return {
    runtime,
    scope: accountKeyScopeFor(runtime.instance),
    guard: () => assertRuntimeCurrent(runtime),
  };
}

export function isHealAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Heal depth per runtime — another account's pass is not this account's. */
const healDepthByRuntime = new Map<WalletRuntimeId, number>();

const emptyEvidence = (): UtxoEvidenceHealResult => ({
  checked: 0,
  hiddenSpent: 0,
  restoredUnspent: 0,
  quarantined: 0,
  unknown: 0,
  spentOutpoints: [],
  restoredOutpoints: [],
  quarantinedOutpoints: [],
});

/** True while a UTXO heal pass for the *current* account holds chain ingest. */
export function isUtxoHealRunning(): boolean {
  const runtime = getWalletRuntime();
  if (!runtime) return false;
  return (healDepthByRuntime.get(runtime.runtimeId) ?? 0) > 0;
}

export type UtxoHealBalanceSnapshot = {
  spendable: number;
  pendingChange: number;
  displayed: number;
};

export type UtxoHealPassOpts = {
  source: UtxoHealCheckpointSource;
  /** Manual Settings heal — always runs, may write Activity. */
  force?: boolean;
};

export type UtxoHealFromHistoryResult = {
  skipped: boolean;
  activityRows: number;
  archivedRows: number;
  txidsChecked: number;
  txidsOnChain: number;
  changeKept: number;
  evidence: UtxoEvidenceHealResult;
  heal: ChangeHealStats;
  recoveredSats: number;
  balanceBefore: UtxoHealBalanceSnapshot | null;
  balanceAfter: UtxoHealBalanceSnapshot | null;
};

function toBalanceSnapshot(
  snap: Awaited<ReturnType<typeof snapshotWalletBalance>>
): UtxoHealBalanceSnapshot | null {
  if (snap.spendable == null || snap.displayed == null) return null;
  return {
    spendable: snap.spendable,
    pendingChange: snap.pendingChange ?? snap.displayed - snap.spendable,
    displayed: snap.displayed,
  };
}

function mergeHealStats(
  a: ChangeHealStats,
  b: ChangeHealStats
): ChangeHealStats {
  return {
    restored: a.restored + b.restored,
    scriptsLocal: a.scriptsLocal + b.scriptsLocal,
    scriptsChain: a.scriptsChain + b.scriptsChain,
    pendingPromoted: a.pendingPromoted + b.pendingPromoted,
    reclaimed: a.reclaimed + b.reclaimed,
    // Refusals are a running state, not a tally: the later pass is the truth.
    unscripted: b.unscripted,
  };
}

export function formatUtxoHealResult(
  result: UtxoHealFromHistoryResult
): string {
  if (result.skipped) return "Balance heal is current";
  if (
    result.evidence.hiddenSpent > 0 ||
    result.evidence.restoredUnspent > 0 ||
    result.evidence.quarantined > 0
  ) {
    return `Removed ${result.evidence.hiddenSpent} spent, restored ${result.evidence.restoredUnspent} unspent, quarantined ${result.evidence.quarantined} output(s)`;
  }
  if (result.recoveredSats > 0) {
    return `Recovered ${result.recoveredSats.toLocaleString()} sats`;
  }
  if (result.heal.pendingPromoted > 0 || result.heal.restored > 0) {
    return "Promoted stuck change";
  }
  if (result.txidsChecked > 0) {
    return `Checked ${result.txidsChecked} txid(s) — nothing to heal`;
  }
  return "Nothing to heal";
}

function collectCandidateTxids(): {
  txids: Set<string>;
  activity: ReturnType<typeof collectActivityTxids>;
} {
  const activity = collectActivityTxids();
  const txids = new Set(listSignedChequeTxids());
  return { txids, activity };
}

function orderTxidsForHeal(args: {
  missing: string[];
  pendingLive: string[];
  failed: string[];
  activity: Iterable<string>;
  includeActivity: boolean;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (txid: string) => {
    const id = txid.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const txid of args.pendingLive) push(txid);
  for (const txid of args.failed) push(txid);
  for (const txid of args.missing) push(txid);
  if (args.includeActivity) {
    for (const txid of args.activity) push(txid);
  }
  return out;
}

async function healShouldYieldToSpend(
  _opts: UtxoHealPassOpts,
  owner: HealOwner
): Promise<boolean> {
  // Account changed: nothing here may run on the next wallet.
  owner.guard();
  // A user-requested repair must not report "done" after checking zero rows.
  // It already owns the chain-ingest region; new spends queue behind this pass.
  if (_opts.source === "manual") return false;
  // Manual heal used to refuse yield and held chainIngest for minutes while
  // burns/sends timed out ("Wallet is busy · spend waiting"). Checkpoint +
  // auto resume cover the rest of the txid list after the spend finishes.
  const { shouldYieldChainIngestToSpend, getSpendPriorityDepth } = await import(
    "./walletCoordinator"
  );
  return shouldYieldChainIngestToSpend() || getSpendPriorityDepth() > 0;
}

async function runPendingChangeHeal(
  balanceBefore: UtxoHealBalanceSnapshot | null,
  opts: UtxoHealPassOpts,
  owner: HealOwner
): Promise<ChangeHealStats> {
  const empty: ChangeHealStats = {
    restored: 0,
    scriptsLocal: 0,
    scriptsChain: 0,
    pendingPromoted: 0,
    reclaimed: 0,
    unscripted: 0,
  };
  if (await healShouldYieldToSpend(opts, owner)) return empty;

  // Rehide before spendGate reclaim — abort-reserved sibling sends left inputs
  // spendable; reclaim without rehide re-inflates Pay.
  try {
    await rehideInputsOfLiveLocalTxs();
  } catch (err) {
    if (isHealAbort(err)) throw err;
    console.warn("[utxo-heal] rehide before spendGate skipped", err);
  }
  owner.guard();

  let heal = await runChangeHeal({ path: "spendGate" });
  if (await healShouldYieldToSpend(opts, owner)) return heal;

  const pending = balanceBefore?.pendingChange ?? 0;
  // A change row with no locking script is counted in neither balance bucket,
  // so `pendingChange === 0` is exactly what a wallet looks like when every
  // coin it owns is waiting on a script rebuild. Bailing out here left a phone
  // with 40 script-less rows — its whole confirmed balance — reading zero
  // forever, because `chainingScriptHeal` is the only path that refetches the
  // creating raw tx. Escalate on the refusal count, not on pending credit.
  if (pending <= 0 && heal.unscripted === 0) return heal;
  // spendGate already paged unspendable change. Extra restore / script-sweep
  // passes are only for leftover pending credit — not a second copy of the
  // same 200-row scan (hc-a580a: 21s + 20s restoreLiveSpendableOutputs).
  if (pending > 0 && heal.pendingPromoted === 0 && heal.restored === 0) {
    heal = mergeHealStats(
      heal,
      await runChangeHeal({ path: "spendGatePartialRetry" })
    );
    if (await healShouldYieldToSpend(opts, owner)) return heal;
  }
  heal = mergeHealStats(
    heal,
    await runChangeHeal({ path: "chainingScriptHeal" })
  );
  owner.guard();
  return heal;
}

async function processTxidBatch(
  batch: string[],
  chain: Chain | undefined,
  failed: Set<string>,
  owner: HealOwner
): Promise<{ changeKept: number; txidsOnChain: number; processed: string[] }> {
  let changeKept = 0;
  let txidsOnChain = 0;
  const processed: string[] = [];
  for (const txid of batch) {
    // One txid = several storage writes. Re-check the account before each.
    owner.guard();
    processed.push(txid);
    const atomic = signedChequeAtomic(txid);
    if (!atomic?.length) {
      // Durable pressure evicts old templates, but an Arcade-pinned send is
      // still this wallet's spend: its change must not stay app-held just
      // because the retry body aged out of the archive.
      if (txHadArcadeSubmitContact(txid)) {
        await pinBroadcastLocalTx(txid);
        changeKept += await keepChangeOfSignedTx(txid);
      }
      continue;
    }
    if (chain) {
      const onChain = await txExistsOnChain(txid, chain).catch(() => null);
      owner.guard();
      if (onChain === false) {
        // Absence is not cancellation. The signed template stays sealed and
        // retains its change. Re-queue miner propagation from the archive.
        if (failed.has(txid)) {
          if (!txHadArcadeSubmitContact(txid)) continue;
          await pinBroadcastLocalTx(txid, atomic);
        } else {
          const { enqueuePendingMinerSubmit } = await import(
            "./pendingMinerOutbox"
          );
          enqueuePendingMinerSubmit(txid, atomic);
        }
      }
      if (onChain === true) {
        txidsOnChain += 1;
        if (failed.has(txid)) await restoreOnChainLocalTx(txid);
      }
    }
    await sealSpentInputsOfSignedTx(txid, atomic);
    owner.guard();
    if ((await localTxRecorded(txid)) === false) {
      owner.guard();
      fileUnstoredSendTips(txid, atomic, owner.runtime.instance.address);
    }
    // The archived template is the body that created this change — heal can
    // rebuild a script-less row from it instead of refusing the coin.
    changeKept += await keepChangeOfSignedTx(txid, undefined, true, atomic);
  }
  return { changeKept, txidsOnChain, processed };
}

async function runHealCore(
  orderedTxids: string[],
  balanceBefore: UtxoHealBalanceSnapshot | null,
  failed: Set<string>,
  opts: UtxoHealPassOpts,
  owner: HealOwner
): Promise<{
  changeKept: number;
  txidsOnChain: number;
  evidence: UtxoEvidenceHealResult;
  heal: ChangeHealStats;
  balanceAfter: UtxoHealBalanceSnapshot | null;
  recoveredSats: number;
  txidsChecked: number;
}> {
  if (await healShouldYieldToSpend(opts, owner)) {
    logDiag("utxo-heal", "info", "yield-to-spend", { phase: "before-release" });
    bumpBalanceAfterHeal();
    const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance());
    return {
      changeKept: 0,
      txidsOnChain: 0,
      evidence: emptyEvidence(),
      heal: {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
        unscripted: 0,
      },
      balanceAfter,
      recoveredSats: 0,
      txidsChecked: 0,
    };
  }

  // This repair can hold toolbox storage while it reviews old unsigned rows.
  // Never start it after a send has raised priority: the payment owns the next
  // storage turn, and the checkpoint scheduler will resume this heal afterward.
  // Do not cancel a user's in-progress send merely because they opened Heal.
  // Automatic cleanup may release abandoned UI attempts; explicit evidence
  // repair only reconciles durable wallet state.
  if (opts.source !== "manual") await releaseSpendAttemptFunds();

  if (await healShouldYieldToSpend(opts, owner)) {
    logDiag("utxo-heal", "info", "yield-to-spend", { phase: "after-release" });
    bumpBalanceAfterHeal();
    const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance());
    return {
      changeKept: 0,
      txidsOnChain: 0,
      evidence: emptyEvidence(),
      heal: {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
        unscripted: 0,
      },
      balanceAfter,
      recoveredSats: 0,
      txidsChecked: 0,
    };
  }

  const chain = owner.runtime.instance.chain;
  let changeKept = 0;
  let txidsOnChain = 0;
  let txidsChecked = 0;
  const allProcessed: string[] = [];
  const runAllBatches = opts.force || opts.source === "manual";
  let heal: ChangeHealStats = {
    restored: 0,
    scriptsLocal: 0,
    scriptsChain: 0,
    pendingPromoted: 0,
    reclaimed: 0,
    unscripted: 0,
  };
  let evidence = emptyEvidence();

  // Recover the two or three signed transactions named by the checkpoint
  // before auditing years of output history. On hc-a580a the old order spent
  // 195 seconds probing 873 rows before it reached the missing change.
  for (let offset = 0; offset < orderedTxids.length; ) {
    if (await healShouldYieldToSpend(opts, owner)) {
      logDiag("utxo-heal", "info", "yield-to-spend", {
        checked: txidsChecked,
        remaining: orderedTxids.length - offset,
      });
      break;
    }
    const batch = orderedTxids.slice(offset, offset + HEAL_TXID_BATCH_SIZE);
    if (batch.length === 0) break;
    offset += batch.length;

    const batchResult = await processTxidBatch(batch, chain, failed, owner);
    changeKept += batchResult.changeKept;
    txidsOnChain += batchResult.txidsOnChain;
    txidsChecked += batchResult.processed.length;
    allProcessed.push(...batchResult.processed);

    owner.guard();
    bumpBalanceAfterHeal();
    const mid = toBalanceSnapshot(await snapshotWalletBalance());
    owner.guard();
    appendHealCheckpointBatch(
      batchResult.processed,
      {
        pendingChangeAfter: mid?.pendingChange ?? 0,
        recoveredSats:
          balanceBefore && mid
            ? Math.max(0, mid.spendable - balanceBefore.spendable)
            : 0,
        source: opts.source,
      },
      owner.scope
    );

    if (!runAllBatches) break;
  }

  const fastBalance = toBalanceSnapshot(await snapshotWalletBalance());
  owner.guard();
  const recoveredCurrentBalance =
    (balanceBefore?.spendable ?? 0) === 0 &&
    (fastBalance?.spendable ?? 0) > 0;

  if (recoveredCurrentBalance) {
    logDiag("utxo-heal", "info", "fast-recovery", {
      spendable: fastBalance?.spendable ?? 0,
      txidsChecked,
      changeKept,
    });
  } else {
    heal = await runPendingChangeHeal(balanceBefore, opts, owner);
    await restoreFailedLocalTxsKnownOnChain();
    owner.guard();

    // Deliberately outside runPendingChangeHeal: that pass returns early when
    // pendingChange is 0, and a coin sealed by a written-off tx is stranded
    // *because* its change stopped counting.
    try {
      heal = mergeHealStats(heal, {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        // Reclaim does not run a restore, so it cannot change the refusal
        // count — carry the last one rather than reporting a clean slate.
        unscripted: heal.unscripted,
        reclaimed: await reclaimOutputsSealedByDeadTxs({
          forSpendChain: opts.source === "manual",
        }),
      });
    } catch (err) {
      if (isHealAbort(err)) throw err;
      console.warn("[utxo-heal] dead-sealer reclaim skipped", err);
    }
    owner.guard();

    evidence = await reconcileKnownUtxosByEvidence({
      forManualHeal: opts.source === "manual",
      // A manual button must finish promptly. Background reconciliation can
      // continue paging old history; this pass checks both sides of the current
      // output set without turning Settings into a multi-minute lock.
      ...(opts.source === "manual" ? { maxOutputs: 48 } : {}),
    });
    owner.guard();
  }

  // Change whose toolbox row a restore or wipe removed has no row to reclaim;
  // only its echoed derivation can bring it back.
  if (opts.source === "manual") {
    try {
      const { recoverEchoedChange } = await import("./reimportDerivedChange");
      await recoverEchoedChange(owner.runtime.instance);
    } catch (err) {
      if (isHealAbort(err)) throw err;
      console.warn("[utxo-heal] echo recovery skipped", err);
    }
    owner.guard();
  }

  if (
    (balanceBefore?.pendingChange ?? 0) > 0 &&
    !(await healShouldYieldToSpend(opts, owner))
  ) {
    heal = mergeHealStats(
      heal,
      await runChangeHeal({ path: "spendGatePartialRetry" })
    );
  }

  // The toolbox set is now authoritative. Re-listing updates Collectables and
  // settles pending item Activity against the held inventory. History itself
  // remains append-only.
  if (
    opts.source === "manual" ||
    evidence.hiddenSpent > 0 ||
    evidence.restoredUnspent > 0
  ) {
    try {
      const { reconcilePendingItemActivityWithSpentOutpoints } = await import(
        "./appActivity"
      );
      reconcilePendingItemActivityWithSpentOutpoints(evidence.spentOutpoints);
      const { relistCollectablesAfterLocalStateReplace } = await import(
        "./collectables"
      );
      await relistCollectablesAfterLocalStateReplace();
    } catch (err) {
      if (isHealAbort(err)) throw err;
      console.warn(
        "[utxo-heal] collectable/activity projection refresh skipped",
        err
      );
    }
  }

  owner.guard();
  bumpBalanceAfterHeal();
  const balanceAfter = toBalanceSnapshot(await snapshotWalletBalance());
  owner.guard();
  const recoveredSats =
    balanceBefore && balanceAfter
      ? Math.max(0, balanceAfter.spendable - balanceBefore.spendable)
      : 0;

  writeHealCheckpoint(
    {
      at: Date.now(),
      txids: [
        ...new Set([
          ...(readHealCheckpoint(owner.scope)?.txids ?? []),
          ...allProcessed,
        ]),
      ],
      recoveredSats,
      pendingChangeAfter: balanceAfter?.pendingChange ?? 0,
      source: opts.source,
    },
    owner.scope
  );

  return {
    changeKept,
    txidsOnChain,
    evidence,
    heal,
    balanceAfter,
    recoveredSats,
    txidsChecked,
  };
}

/**
 * One heal pass. Signed cheque templates are the candidate set; Activity is
 * only a display count. The checkpoint is a skip list of already-healed txids.
 */
export async function runUtxoHealPass(
  opts: UtxoHealPassOpts
): Promise<UtxoHealFromHistoryResult> {
  // Pin the account first. Everything below is this runtime's, or aborts.
  const owner = pinHealOwner(requireWalletRuntime());
  const { txids, activity } = collectCandidateTxids();
  const balanceBefore = toBalanceSnapshot(await snapshotWalletBalance());
  owner.guard();
  const missing = txidsMissingFromCheckpoint(txids, owner.scope);
  const pendingChange = balanceBefore?.pendingChange ?? 0;
  const checkpointed = new Set(
    (readHealCheckpoint(owner.scope)?.txids ?? []).map((t) => t.toLowerCase())
  );
  const allFailed = (await listFailedLocalTxids()).filter((id) => txids.has(id));
  owner.guard();
  const includeActivity = opts.force === true || opts.source === "manual";
  const failedTxids = includeActivity
    ? allFailed
    : allFailed.filter((id) => !checkpointed.has(id));
  // Arcade-pinned `nosend` change counts as neither spendable nor pendingChange,
  // so `pendingChange` alone cannot tell us the pending scan is pointless.
  const maybePendingChange = pendingChange > 0 || hasArcadeSubmitContacts();

  const shouldSkip =
    !includeActivity &&
    healCheckpointFresh(undefined, undefined, owner.scope) &&
    missing.length === 0 &&
    !maybePendingChange &&
    failedTxids.length === 0;

  if (shouldSkip) {
    const cp = readHealCheckpoint(owner.scope);
    return {
      skipped: true,
      activityRows: activity.total,
      archivedRows: activity.archived,
      txidsChecked: cp?.txids.length ?? 0,
      txidsOnChain: 0,
      changeKept: 0,
      evidence: emptyEvidence(),
      heal: {
        restored: 0,
        scriptsLocal: 0,
        scriptsChain: 0,
        pendingPromoted: 0,
        reclaimed: 0,
        unscripted: 0,
      },
      recoveredSats: 0,
      balanceBefore,
      balanceAfter: balanceBefore,
    };
  }

  const txidList = orderTxidsForHeal({
    missing,
    pendingLive: maybePendingChange
      ? (await listPendingLocalChangeTxids()).filter((id) => txids.has(id))
      : [],
    failed: failedTxids,
    activity: txids,
    includeActivity,
  });
  owner.guard();

  logDiag("utxo-heal", "info", "start", {
    source: opts.source,
    force: opts.force === true,
    txids: txidList.length,
    missing: missing.length,
    pendingChange,
    failed: failedTxids.length,
    batchSize: HEAL_TXID_BATCH_SIZE,
  });

  const { runChainIngest } = await import("./walletCoordinator");
  owner.guard();
  const depthKey = owner.runtime.runtimeId;
  return runChainIngest(async () => {
    owner.guard();
    healDepthByRuntime.set(depthKey, (healDepthByRuntime.get(depthKey) ?? 0) + 1);
    try {
      const core = await runHealCore(
        txidList,
        balanceBefore,
        new Set(failedTxids),
        opts,
        owner
      );
      owner.guard();
      const pendingChangeAfter = core.balanceAfter?.pendingChange ?? 0;

      const result: UtxoHealFromHistoryResult = {
        skipped: false,
        activityRows: activity.total,
        archivedRows: activity.archived,
        txidsChecked: core.txidsChecked,
        txidsOnChain: core.txidsOnChain,
        changeKept: core.changeKept,
        evidence: core.evidence,
        heal: core.heal,
        recoveredSats: core.recoveredSats,
        balanceBefore,
        balanceAfter: core.balanceAfter,
      };

      if (
        opts.source === "manual" &&
        (core.recoveredSats > 0 ||
          pendingChangeAfter > 0 ||
          core.evidence.hiddenSpent > 0 ||
          core.evidence.restoredUnspent > 0)
      ) {
        recordWalletEvent({
          origin: WALLET_ACTIVITY_ORIGIN,
          method: UTXO_HEAL_METHOD,
          sats: core.recoveredSats,
          note:
            core.recoveredSats > 0
              ? `Recovered ${core.recoveredSats.toLocaleString()} sats`
              : formatUtxoHealResult(result),
          status: "complete",
        });
      }

      logDiag("utxo-heal", "info", "done", {
        source: opts.source,
        txidsChecked: result.txidsChecked,
        outputsChecked: result.evidence.checked,
        spentRemoved: result.evidence.hiddenSpent,
        unspentRecovered: result.evidence.restoredUnspent,
        recoveredSats: core.recoveredSats,
        pendingChangeAfter,
      });

      return result;
    } catch (err) {
      if (isHealAbort(err) || !runtimeIsCurrent(owner.runtime)) {
        // The account changed under this pass. Nothing was written past the
        // last guard, and Activity belongs to the wallet that is now current
        // — not to a repair it never asked for.
        logDiag("utxo-heal", "info", "aborted", {
          source: opts.source,
          reason: "account-changed",
        });
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      if (opts.source === "manual") {
        recordWalletEvent({
          origin: WALLET_ACTIVITY_ORIGIN,
          method: UTXO_HEAL_METHOD,
          note: "Balance heal failed",
          status: "failed",
          failureReason: reason,
        });
      }
      logDiag("utxo-heal", "warn", "failed", { source: opts.source, reason });
      throw err;
    } finally {
      const depth = (healDepthByRuntime.get(depthKey) ?? 1) - 1;
      if (depth <= 0) healDepthByRuntime.delete(depthKey);
      else healDepthByRuntime.set(depthKey, depth);
    }
  });
}

/** Settings → Wallet health manual heal, deduped per runtime. */
const manualHealFlightByRuntime = new Map<
  WalletRuntimeId,
  Promise<UtxoHealFromHistoryResult>
>();

export async function healUtxoFromActivityHistory(): Promise<UtxoHealFromHistoryResult> {
  const runtimeId = requireWalletRuntime().runtimeId;
  const inFlight = manualHealFlightByRuntime.get(runtimeId);
  if (inFlight) return inFlight;
  const flight = runUtxoHealPass({ source: "manual", force: true }).finally(
    () => {
      manualHealFlightByRuntime.delete(runtimeId);
    }
  );
  manualHealFlightByRuntime.set(runtimeId, flight);
  return flight;
}

/**
 * Auto UTXO heal is Settings-only. Background checkpoint used to take
 * `runChainIngest` (merkle proofs, 13+ activity txids) and block sends /
 * Collect listOutputs. Callers may still invoke this; it does nothing.
 */
export function scheduleHealCheckpointIfDue(
  _reason: UtxoHealCheckpointSource
): void {
  return;
}
