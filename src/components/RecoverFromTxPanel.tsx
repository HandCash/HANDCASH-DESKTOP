import { Button, Field } from '@aeon-ui/react'
import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { recoverFromTx, type RecoverFromTxResult } from "../wallet/recoverFromTx";
import { playWalletSound } from "../wallet/soundService";
import { toastError, toastSuccess } from "../wallet/toast";
import { AsyncActionPrompt } from "./AsyncActionPrompt";

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function summary(r: RecoverFromTxResult): { title: string; body?: string } {
  const claimed = [
    r.tokens ? count(r.tokens, "token tip") : "",
    r.items ? count(r.items, "item") : "",
  ].filter(Boolean);
  if (claimed.length) return { title: `Recovered ${claimed.join(" and ")}` };
  if (r.ours === 0) {
    return {
      title: "Nothing here for this wallet",
      body: "No output of this transaction pays this wallet.",
    };
  }
  if (r.spent === r.ours) {
    return {
      title: "Already spent",
      body: "Everything this transaction paid this wallet has been spent since.",
    };
  }
  return {
    title: "Nothing new to recover",
    body: r.unrecognized
      ? `${count(r.unrecognized, "output")} could not be named as a token or item yet. Try again in a minute.`
      : "This wallet already holds what this transaction paid it.",
  };
}

/**
 * Recover from transaction: the sender's txid brings back token and item tips
 * a reinstall cannot rediscover from keys alone.
 */
export function RecoverFromTxPanel() {
  const action = useAsyncAction<"recover">();
  const [txid, setTxid] = useState("");
  const ready = /^[0-9a-f]{64}$/i.test(txid.trim());

  const recover = async () => {
    const done: { result?: RecoverFromTxResult } = {};
    const outcome = await action.run("recover", async () => {
      done.result = await recoverFromTx(txid);
    });
    if (!outcome.ok) {
      if (outcome.error) {
        playWalletSound("error");
        toastError("Recover failed", outcome.error);
      }
      return;
    }
    if (!done.result) return;
    const { title, body } = summary(done.result);
    playWalletSound("soft");
    toastSuccess(title, body);
    if (done.result.tokens || done.result.items) setTxid("");
  };

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="recover-from-tx"
      data-aeon-state={action.stateAttr}
    >
      <form
        className="settings-form settings-form-compact"
        data-aeon-part="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !action.busy) void recover();
        }}
      >
        <div className="confirm-password-copy">
          <p className="confirm-password-lede">
            Tokens received peer to peer live only on this device and in your
            history backup. If neither has them, ask the sender for the
            transaction id and paste it here.
          </p>
        </div>
        <Field.Root className="field">
          <Field.Label htmlFor="recover-txid">Transaction id</Field.Label>
          <Field.Control
            id="recover-txid"
            className="mono"
            value={txid}
            disabled={action.busy}
            onChange={(e) => setTxid(e.target.value.trim())}
            placeholder="64 hex characters"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </Field.Root>
        <div className="actions">
          <Button.Root variant="solid"
            type="submit"
            className="btn btn-primary"
            data-aeon-part="trigger"
            disabled={!ready || action.busy}
          >
            <Button.Label>{action.running("recover") ? "Recovering…" : "Recover"}</Button.Label>
          </Button.Root>
        </div>
      </form>
      <AsyncActionPrompt action={action} />
    </div>
  );
}
