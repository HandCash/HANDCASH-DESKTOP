import { getActiveWallet } from './session'

/**
 * Submit signed Atomic BEEF to miners after createAction.
 *
 * Bitcoin here is peer-to-peer: counterparties hand each other a signed
 * transaction. That signed body is the cheque. Miners cash it when the
 * economic activity needs to land; they are not the send gate.
 *
 * Dependent hops chain UTXOs (parent *bodies* in the BEEF) so the next
 * signed spend does not wait on a miner ack — that is the latency window.
 * Arcade / postBeef is cashing + a reject oracle, not confirmation.
 *
 * A live cheque stays sealed until Arcade hard-rejects it or chain proof
 * shows a competing spend. Transport silence and unproven miner noise stay
 * queued. Proven rejects must rewrite Activity and locks as soon as they
 * exist so the failure is economic-zero, not a second spend of the same coins.
 */
import { Beef } from "@bsv/sdk";
import { type ActiveWallet } from "./session"
import {
  assertRuntimeAvailable,
  runtimeIsCurrent,
  type WalletRuntime,
} from "./walletRuntime";
import {
  accountKeyScopeFor,
  type BoundAccountKeyScope,
} from "./accountLocalKeys";
import {
  formatPostBeefFailure,
  isInvalidBeefTransport,
  summarizePostBeef,
  type PostBeefSummary,
  type PostBeefServiceResult,
} from "./postBeefResult";
import {
  onAlreadySpentSend,
  pinBroadcastLocalTx,
  releaseSealedInputsOfUnsentTx,
  restoreOnChainLocalTx,
} from "./staleOutputRelease";
import {
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
  postBeefResultsHitArcade,
  rememberArcadeSubmitContact,
  signedTxSpendConflictIsProven,
  txHadArcadeSubmitContact,
} from "./arcadeSubmitGuard";
import {
  enqueuePendingMinerSubmit,
  removePendingMinerSubmit,
  updatePendingMinerSubmitBody,
} from "./pendingMinerOutbox";
import {
  activeTransactionTrace,
  recordTransactionStage,
  type TransactionFlow,
} from "./transactionTelemetry";
import { normalizeTxid } from "./txid";
import { spendConflictIsProven } from "./spendVerdict";

/**
 * One local fate for a signed body. Callers must switch on `kind` — overlapping
 * booleans (`submitted` + `confirmed`) used to mean "Arcade accepted",
 * "transport failed", and "unproven conflict, seals released" at once.
 */
export type MinerSubmitResult =
  | {
      kind: "accepted";
      /** Subject + required ancestor *bodies* are in the BEEF (not merkle-final). */
      ancestryComplete: boolean;
      /** Keep the outbox until ancestor merkle proofs close. Arcade 202 is not that. */
      keepPropagating: boolean;
      summary?: PostBeefSummary;
    }
  | {
      kind: "queued";
      reason: "offline" | "transport" | "service-error" | "no-ack";
      summary?: PostBeefSummary;
    }
  | {
      kind: "unproven-conflict";
      summary: PostBeefSummary;
    }
  | {
      /**
       * The cheque may have left this process, but its retry body was not
       * durably stored. Keep inputs sealed and tell the user immediately.
       */
      kind: "untracked";
      reason: "outbox-write-failed";
      network:
        | "offline"
        | "transport"
        | "service-error"
        | "no-ack"
        | "accepted-needs-proofs"
        | "unproven-conflict";
      summary?: PostBeefSummary;
    };

/** Miner or Arcade accepted this body. Not the same as merkle-final. */
export function minerSubmitIsAccepted(result: MinerSubmitResult): boolean {
  return result.kind === "accepted";
}

/** Local SPV of this BEEF (unconfirmed parent bodies count). */
export function minerSubmitAncestryComplete(result: MinerSubmitResult): boolean {
  return result.kind === "accepted" && result.ancestryComplete;
}

/** Hard reject throws; every remaining kind still owns the sealed spend. */
export function minerSubmitKeepOutbox(result: MinerSubmitResult): boolean {
  return result.kind !== "accepted" || result.keepPropagating;
}

function untrackedMinerResult(
  network: Extract<MinerSubmitResult, { kind: "untracked" }>["network"],
  telemetry: SubmitTelemetry,
  summary?: PostBeefSummary
): MinerSubmitResult {
  recordTransactionStage("propagation_queued", {
    ...telemetry,
    blockerCode: "outbox_write_failed",
  });
  void import("./toast")
    .then(({ toastError }) =>
      toastError(
        "Send needs attention",
        "The signed transaction could not be saved for automatic retry. Keep this wallet open."
      )
    )
    .catch(() => undefined);
  return {
    kind: "untracked",
    reason: "outbox-write-failed",
    network,
    summary,
  };
}

type SubmitTelemetry = {
  traceId?: string;
  requestId?: string;
  flow?: TransactionFlow;
  retryCount?: number;
  txid: string;
};

type ArcadeHardRejectError = Error & { code: "ARCADE_HARD_REJECT" };

function arcadeHardRejectError(
  summary: PostBeefSummary
): ArcadeHardRejectError {
  const hard = new Error(
    formatPostBeefFailure(summary)
  ) as ArcadeHardRejectError;
  hard.code = "ARCADE_HARD_REJECT";
  return hard;
}

type AncestryIncompleteError = Error & { code: "BEEF_ANCESTRY_INCOMPLETE" };

function ancestryIncompleteError(
  summary: PostBeefSummary
): AncestryIncompleteError {
  const err = new Error(
    formatPostBeefFailure(summary, { ancestryIncomplete: true })
  ) as AncestryIncompleteError;
  err.code = "BEEF_ANCESTRY_INCOMPLETE";
  return err;
}

/**
 * MissingInputs on a BEEF we could not complete is a delivery defect, not proof
 * that an input left the wallet. Fail closed on the real reason so the tip stays
 * spendable and the caller can retry once the parent lands.
 */
async function failIfAncestryIncomplete(args: {
  id: string;
  atomic: number[];
  active: ActiveWallet;
  summary: PostBeefSummary;
  telemetry: SubmitTelemetry;
  proofsComplete: boolean;
}): Promise<void> {
  const { id, atomic, active, summary, telemetry } = args;
  if (args.proofsComplete || !summary.missingInputs) return;
  if (
    await signedTxSpendConflictIsProven({
      txid: id,
      atomic,
      chain: active.chain,
    })
  ) {
    return;
  }
  console.warn(
    "[minerSubmit] MissingInputs on incomplete BEEF — keeping the signed cheque",
    id.slice(0, 12),
    summary.detail
  );
  recordTransactionStage("propagation_queued", {
    ...telemetry,
    blockerCode: "beef_ancestry_incomplete",
  });
  throw ancestryIncompleteError(summary);
}

async function rememberGhostTxQuiet(txid: string): Promise<void> {
  try {
    const { rememberGhostTx } = await import("./ghostTxSuppress");
    rememberGhostTx(txid);
  } catch {
    /* optional */
  }
}

async function dropLocalSpendForArcadeReject(
  id: string,
  atomic: number[],
  telemetry: SubmitTelemetry,
  summary: PostBeefSummary,
  owner?: BoundAccountKeyScope,
): Promise<never> {
  console.warn(
    "[minerSubmit] Arcade hard-reject — dropping local spend",
    id.slice(0, 12),
    summary.detail
  );
  removePendingMinerSubmit(id, owner);
  recordTransactionStage("hard_rejected", {
    ...telemetry,
    blockerCode: summary.missingInputs
      ? "arcade_missing_inputs"
      : "arcade_reject",
  });
  await rememberGhostTxQuiet(id);
  await releaseSealedInputsOfUnsentTx(id, atomic);
  throw arcadeHardRejectError(summary);
}

async function applyArcadePostBeef(
  id: string,
  atomic: number[],
  rawResults: PostBeefServiceResult[],
  summary: PostBeefSummary,
  telemetry: SubmitTelemetry,
  active: ActiveWallet,
  proofsComplete: boolean,
  owner?: BoundAccountKeyScope,
  detached = false,
): Promise<PostBeefSummary> {
  const arcadeOk = postBeefResultsArcadeAccepted(rawResults);
  const arcadeHardReject = postBeefResultsArcadeHardReject(rawResults);
  // Pin ONLY on Arcade success — pinning on mere contact made missing-inputs
  // holds keep phantom pendingChange after an invalid-UTXO reject.
  if (arcadeOk) {
    rememberArcadeSubmitContact(id);
    console.info("[minerSubmit] Arcade accepted — tx pinned", id.slice(0, 12));
    if (!detached) {
      void import("./appActivity")
        .then(({ reviveFailedOutboundByTxid }) => reviveFailedOutboundByTxid(id))
        .catch(() => undefined);
    }
    // Arcade owns it now: leave app-held `nosend`, seal inputs, free change.
    // The body goes with it — a fresh `noSend` change row is often not
    // queryable by txid yet, and without a script it cannot be promoted.
    if (!detached) {
      void pinBroadcastLocalTx(id, atomic)
        .then((pinned) => {
          if (!pinned) {
            console.warn(
              "[minerSubmit] post-Arcade pin did not free change",
              id.slice(0, 12)
            );
          }
        })
        .catch((err) => {
          console.warn(
            "[minerSubmit] post-Arcade pin skipped",
            id.slice(0, 12),
            err
          );
        });
    }
    return summary.accepted ? summary : { ...summary, accepted: true };
  }
  if (arcadeHardReject) {
    if (detached) {
      console.info(
        "[minerSubmit] hard reject deferred to owner wallet",
        id.slice(0, 12),
      );
      return summary;
    }
    await failIfAncestryIncomplete({
      id,
      atomic,
      active,
      summary,
      telemetry,
      proofsComplete,
    });
    await dropLocalSpendForArcadeReject(id, atomic, telemetry, summary, owner);
  }
  if (postBeefResultsHitArcade(rawResults)) {
    console.info(
      "[minerSubmit] Arcade contacted (no accept/reject yet)",
      id.slice(0, 12)
    );
  }
  return summary;
}

async function resolveMinerConflict(args: {
  id: string;
  atomic: number[];
  active: ActiveWallet;
  summary: PostBeefSummary;
  telemetry: SubmitTelemetry;
  outboxDurable: boolean;
  owner?: BoundAccountKeyScope;
  detached?: boolean;
}): Promise<MinerSubmitResult> {
  const { id, atomic, active, summary, telemetry, outboxDurable, owner } = args;
  if (args.detached) {
    console.info(
      "[minerSubmit] conflict verdict deferred to owner wallet",
      id.slice(0, 12),
    );
    return outboxDurable
      ? { kind: "unproven-conflict", summary }
      : untrackedMinerResult("unproven-conflict", telemetry, summary);
  }
  const arcadePinned = txHadArcadeSubmitContact(id);
  const conflictReal = await spendConflictIsProven({
    intent: arcadePinned ? "arcadePinRemoval" : "postBeefGhostCheck",
    txid: id,
    atomic,
    chain: active.chain,
  });

  if (!conflictReal) {
    console.info(
      `[minerSubmit] unproven ${
        summary.missingInputs ? "missing-inputs" : "doubleSpend"
      } — keeping sealed cheque`,
      id.slice(0, 12),
      arcadePinned ? "arcade-pin" : "no-pin",
      summary.detail
    );
    return outboxDurable
      ? { kind: "unproven-conflict", summary }
      : untrackedMinerResult("unproven-conflict", telemetry, summary);
  }

  // Proven conflict — but only hide if OUR tx actually landed. Otherwise
  // miner noise emptied a phone wallet (119 sealed → spendable=0).
  const { txExistsOnChain } = await import("./legacyScan");
  const onChain = await txExistsOnChain(id, active.chain).catch(() => null);
  removePendingMinerSubmit(id, owner);
  recordTransactionStage("hard_rejected", {
    ...telemetry,
    blockerCode: summary.doubleSpend
      ? "provider_double_spend"
      : "provider_missing_inputs",
  });
  if (onChain === true) {
    console.warn(
      "[minerSubmit] hard reject — tx on chain, sealing inputs",
      id.slice(0, 12),
      summary.detail
    );
    await onAlreadySpentSend({ txid: id, atomic });
    throw new Error(formatPostBeefFailure(summary));
  }
  console.warn(
    "[minerSubmit] hard reject — releasing seal (tx not on chain)",
    id.slice(0, 12),
    summary.detail
  );
  await releaseSealedInputsOfUnsentTx(id, atomic);
  throw new Error(formatPostBeefFailure(summary));
}

/**
 * Hand signed BEEF to miners. Returns optimistic `submitted` on transport silence.
 * Throws only on invalid BEEF body or provable missing-inputs / double-spend.
 */
export async function submitAtomicBeefToMiners(
  txid: string,
  atomic: number[],
  opts?: {
    fromOutbox?: boolean;
    traceId?: string;
    requestId?: string;
    flow?: TransactionFlow;
    retryCount?: number;
    runtime?: WalletRuntime;
    owner?: BoundAccountKeyScope;
  }
): Promise<MinerSubmitResult> {
  const id = normalizeTxid(txid);
  if (!id || !atomic.length) {
    throw new Error(
      "Payment was signed but no transaction body was returned — try Send again."
    );
  }
  const trace = activeTransactionTrace();
  if (opts?.runtime) assertRuntimeAvailable(opts.runtime);
  const owner =
    opts?.owner ??
    (opts?.runtime ? accountKeyScopeFor(opts.runtime.instance) : undefined);
  const detached = !!opts?.runtime && !runtimeIsCurrent(opts.runtime);
  const recordStage = detached
    ? (_stage: Parameters<typeof recordTransactionStage>[0],
       _fields: Parameters<typeof recordTransactionStage>[1]) => undefined
    : recordTransactionStage;
  const telemetry: SubmitTelemetry = {
    traceId: opts?.traceId ?? trace?.traceId,
    requestId: opts?.requestId ?? trace?.requestId,
    flow: opts?.flow ?? trace?.flow,
    retryCount: opts?.retryCount,
    txid: id,
  };
  const outboxDurable =
    opts?.fromOutbox === true ||
    enqueuePendingMinerSubmit(id, atomic, { flow: opts?.flow, owner });
  recordStage("provider_attempt", telemetry);
  const active = opts?.runtime?.instance ?? getActiveWallet();
  if (!active?.services?.postBeef) {
    console.info(
      "[minerSubmit] offline — signed cheque queued",
      id.slice(0, 12)
    );
    recordStage("propagation_queued", {
      ...telemetry,
      blockerCode: "provider_offline",
    });
    return outboxDurable
      ? { kind: "queued", reason: "offline" }
      : untrackedMinerResult("offline", telemetry);
  }

  let beefBytes = atomic;
  // Miners answer MissingInputs both for a spent input and for a BEEF whose
  // ancestry we failed to supply. SPV of a chained send is the unconfirmed
  // parent *bodies this wallet signed* — merge those first. Merkle proofs for
  // those parents cannot exist yet; hydrating them from an indexer is futile.
  let ancestryComplete = false;
  let proofsComplete = false;
  try {
    const {
      classifyBeefAncestryGap,
      hydrateInputBeef,
      mergeLocalUnconfirmedAncestry,
    } = await import("./beefCache");
    const { proofKindFromBeefGap, maySelectAsInput } = await import(
      "./chainProofKind"
    );
    const applyGap = (
      next: "none" | "unconfirmed-parents" | "missing-bodies"
    ) => {
      const proof = proofKindFromBeefGap(next);
      ancestryComplete = maySelectAsInput(proof);
      proofsComplete = next === "none";
    };
    beefBytes = await mergeLocalUnconfirmedAncestry(active, atomic);
    let gap = classifyBeefAncestryGap(beefBytes);
    applyGap(gap);
    if (beefBytes !== atomic) updatePendingMinerSubmitBody(id, beefBytes, owner);
    if (gap === "unconfirmed-parents") {
      console.info(
        "[minerSubmit] posting chained unconfirmed ancestry",
        id.slice(0, 12)
      );
    } else if (gap === "missing-bodies") {
      const shaped = await Promise.race([
        hydrateInputBeef(active, Beef.fromBinary(beefBytes)),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 8_000)
        ),
      ]);
      if (shaped?.length) {
        beefBytes = shaped;
        gap = classifyBeefAncestryGap(shaped);
        applyGap(gap);
        updatePendingMinerSubmitBody(id, shaped, owner);
      } else {
        console.warn(
          "[minerSubmit] posting with incomplete ancestry — MissingInputs will not undo the cheque",
          id.slice(0, 12)
        );
      }
    }
  } catch (err) {
    console.warn(
      "[minerSubmit] ancestor hydrate skipped",
      id.slice(0, 12),
      err
    );
  }

  let summary: PostBeefSummary;
  let rawResults: PostBeefServiceResult[] | undefined;
  try {
    const results = await active.services.postBeef(Beef.fromBinary(beefBytes), [
      id,
    ]);
    rawResults = results as PostBeefServiceResult[];
    summary = summarizePostBeef(rawResults);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[minerSubmit] postBeef transport failed — signed cheque queued",
      id.slice(0, 12),
      msg
    );
    if (isInvalidBeefTransport(msg)) {
      if (detached) {
        console.info(
          "[minerSubmit] invalid body verdict deferred to owner wallet",
          id.slice(0, 12),
        );
        return outboxDurable
          ? { kind: "queued", reason: "transport" }
          : untrackedMinerResult("transport", telemetry);
      }
      removePendingMinerSubmit(id, owner);
      recordTransactionStage("hard_rejected", {
        ...telemetry,
        blockerCode: "invalid_beef",
      });
      await releaseSealedInputsOfUnsentTx(id, atomic);
      throw new Error(
        "Payment was signed but the transaction body is invalid — try Send again."
      );
    }
    recordStage("propagation_queued", {
      ...telemetry,
      blockerCode: "provider_transport",
    });
    return outboxDurable
      ? { kind: "queued", reason: "transport" }
      : untrackedMinerResult("transport", telemetry);
  }

  if (rawResults) {
    summary = await applyArcadePostBeef(
      id,
      atomic,
      rawResults,
      summary,
      telemetry,
      active,
      proofsComplete,
      owner,
      detached,
    );
  }

  if (summary.accepted) {
    recordStage("provider_accepted", telemetry);
    // Arcade 202 is not the chain. Keep posting until merkle proofs close.
    // Local SPV of unconfirmed parent bodies is still a valid cheque — that
    // is how we negate explorer latency.
    const keepPropagating = !proofsComplete;
    if (!keepPropagating) {
      removePendingMinerSubmit(id, owner);
      if (
        telemetry.flow !== "brc29" &&
        telemetry.flow !== "item_transfer" &&
        telemetry.flow !== "token_transfer"
      ) {
        recordStage("completed", telemetry);
      }
    }
    if (!detached && (!txHadArcadeSubmitContact(id) || keepPropagating)) {
      void restoreOnChainLocalTx(id).catch(() => {
        /* background */
      });
    }
    if (keepPropagating && !outboxDurable) {
      return untrackedMinerResult(
        "accepted-needs-proofs",
        telemetry,
        summary
      );
    }
    return {
      kind: "accepted",
      ancestryComplete,
      keepPropagating,
      summary,
    };
  }
  // Pure transport / endpoint failures are not proof of a spent input.
  if (summary.serviceOnlyErrors) {
    console.info(
      "[minerSubmit] no miner ack — signed cheque queued",
      id.slice(0, 12),
      summary.detail
    );
    recordStage("propagation_queued", {
      ...telemetry,
      blockerCode: "provider_service_error",
    });
    return outboxDurable
      ? { kind: "queued", reason: "service-error", summary }
      : untrackedMinerResult("service-error", telemetry, summary);
  }
  if (summary.missingInputs || summary.doubleSpend) {
    await failIfAncestryIncomplete({
      id,
      atomic,
      active,
      summary,
      telemetry,
      proofsComplete,
    });
    return resolveMinerConflict({
      id,
      atomic,
      active,
      summary,
      telemetry,
      outboxDurable,
      owner,
      detached,
    });
  }

  console.info(
    "[minerSubmit] no miner ack — signed cheque queued",
    id.slice(0, 12),
    summary.detail
  );
  recordStage("propagation_queued", {
    ...telemetry,
    blockerCode: "provider_no_ack",
  });
  return outboxDurable
    ? { kind: "queued", reason: "no-ack", summary }
    : untrackedMinerResult("no-ack", telemetry, summary);
}

/** Surface a hard miner reject after optimistic send success. */
export async function reportLateMinerSubmitFailure(args: {
  pendingId?: string;
  txid?: string;
  reason: unknown;
}): Promise<void> {
  const txid = normalizeTxid(args.txid);
  if (txid && txHadArcadeSubmitContact(txid)) {
    const active = getActiveWallet();
    if (active) {
      const proven = await signedTxSpendConflictIsProven({
        txid,
        chain: active.chain,
      });
      if (!proven) {
        console.info(
          "[minerSubmit] late failure ignored — Arcade submit still in flight",
          txid.slice(0, 12)
        );
        return;
      }
    }
  }
  const { noteOutboundSendBroadcastFailed, compactFailureLabel } = await import(
    "./appActivity"
  );
  const { toastError } = await import("./toast");
  if (txid) {
    const { getTxByTxid, markTxFailed } = await import("./txStore");
    const record = getTxByTxid(txid);
    if (record && record.status !== "FAILED_REJECTED") {
      markTxFailed(record.id, "ARC_REJECTED", compactFailureLabel(args.reason));
    }
  }
  if (!noteOutboundSendBroadcastFailed(args)) return;
  const label = compactFailureLabel(args.reason);
  toastError("Send issue", label);
}
