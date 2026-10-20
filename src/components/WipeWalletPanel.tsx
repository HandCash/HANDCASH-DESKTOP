import { Button, Field } from '@aeon-ui/react'
import { Checkbox } from "@aeon-ui/ui";
import { useMachine } from "@xstate/react";
import { useEffect, useState } from "react";
import { stateToAttr } from "@aeon-ui/core";
import { wipeMachine } from "../machines/wipeMachine";
import { StatusBanner } from "@aeon-ui/react";
import { wipeAllWalletData } from "../wallet/wipeWallet";
import {
  overrideWipeGate,
  syncHistoryBeforeWipe,
  wipeLossWarning,
  wipeRefusalMessage,
  type WipeHistoryGate,
} from "../wallet/wipeHistoryGate";
import { listBntAssets } from "../wallet/bnt/wallet";
import { playWalletSound } from "../wallet/soundService";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { AsyncActionPrompt } from "./AsyncActionPrompt";
import { ConfirmPasswordGate } from "./ConfirmPasswordGate";

const CONFIRM_WORD = "DELETE";

export function WipeWalletPanel() {
  const [snapshot, send] = useMachine(wipeMachine);
  const override = useAsyncAction<"override">();
  const stateAttr = stateToAttr(snapshot.value);
  const passwordReady = snapshot.context.unlocked;
  const canSubmit =
    passwordReady &&
    snapshot.context.acknowledged &&
    snapshot.context.confirmText.trim().toUpperCase() === CONFIRM_WORD;

  const busy = snapshot.matches("syncing") || snapshot.matches("wiping");
  const [tokensHeld, setTokensHeld] = useState(0);
  useEffect(() => {
    let live = true;
    listBntAssets()
      .then(({ assets }) => {
        if (live) setTokensHeld(assets.filter((asset) => asset.kind === "token").length);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const wipeWith = async (gate: WipeHistoryGate) => {
    try {
      await wipeAllWalletData(snapshot.context.password || null, gate);
      send({ type: "SUCCESS" });
      playWalletSound("soft");
      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: "FAIL", error: message });
      playWalletSound("error");
    }
  };

  const syncThenWipe = async () => {
    const check = await syncHistoryBeforeWipe();
    if (!check.ok) {
      send({
        type: "BLOCKED",
        reason: wipeRefusalMessage(check.refusal),
        refusal: check.refusal,
      });
      playWalletSound("error");
      return;
    }
    send({ type: "SYNCED", gate: check.gate });
    await wipeWith(check.gate);
  };

  const wipeAnyway = () => {
    const refusal = snapshot.context.refusal;
    if (!refusal) return;
    void override.run(
      "override",
      async () => {
        const gate = overrideWipeGate(refusal, tokensHeld);
        send({ type: "OVERRIDE", gate });
        await wipeWith(gate);
      },
      {
        confirm: {
          title: "Wipe without a backup?",
          body: wipeLossWarning(tokensHeld),
          confirmLabel: "Wipe anyway",
          danger: true,
        },
      }
    );
  };

  const submit = async () => {
    if (!canSubmit || !snapshot.matches("idle")) return;
    send({ type: "SUBMIT" });
    await syncThenWipe();
  };

  return (
    <div
      className="nav-section-body settings-detail settings-scroll"
      data-aeon-scope="wipe-wallet"
      data-aeon-state={stateAttr}
    >
      {!passwordReady ? (
        <ConfirmPasswordGate
          id="wipe-password"
          title="Wipe this device"
          lede="Removes the wallet from this device. Restoring needs a backup."
          actionLabel="Continue"
          onVerified={(password) => send({ type: "VERIFIED", password })}
        />
      ) : (
        <form
          className="settings-form settings-form-compact"
          data-aeon-part="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="confirm-password-copy">
            <h3 className="confirm-password-title">Final confirmation</h3>
            <p className="confirm-password-lede">
              This cannot be undone without a backup. Type {CONFIRM_WORD} to
              continue.
            </p>
          </div>

          <Checkbox.Root
            className="settings-check-label"
            checked={snapshot.context.acknowledged}
            disabled={busy}
            onCheckedChange={(acknowledged) =>
              send({ type: "TOGGLE_ACK", acknowledged })
            }
          >
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Checkbox.Label>
              I understand this cannot be undone without my backup.
            </Checkbox.Label>
            <Checkbox.HiddenInput />
          </Checkbox.Root>

          <Field.Root className="field">
            <Field.Label htmlFor="wipe-confirm">
              Type <strong>{CONFIRM_WORD}</strong>
            </Field.Label>
            <Field.Control
              id="wipe-confirm"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={snapshot.context.confirmText}
              disabled={busy}
              autoFocus
              onChange={(e) =>
                send({ type: "CHANGE_CONFIRM", confirmText: e.target.value })
              }
            />
          </Field.Root>

          {snapshot.matches("blocked") ? (
            <StatusBanner.Root tone="danger" status="blocked">
              <StatusBanner.Copy>
                <StatusBanner.Title>History not synced</StatusBanner.Title>
                <StatusBanner.Body>
                  {snapshot.context.error} {wipeLossWarning(tokensHeld)}
                </StatusBanner.Body>
              </StatusBanner.Copy>
            </StatusBanner.Root>
          ) : null}

          {snapshot.matches("failure") && (
            <p className="error" role="alert">
              {snapshot.context.error || "Wipe failed"}
            </p>
          )}

          {snapshot.matches("blocked") ? (
            <div className="actions">
              <Button.Root variant="solid"
                className="btn btn-primary"
                disabled={override.busy}
                onClick={() => {
                  send({ type: "RETRY" });
                  void syncThenWipe();
                }}
              >
                <Button.Label>Sync and wipe</Button.Label>
              </Button.Root>
              <Button.Root variant="solid"
                className="btn btn-danger"
                data-aeon-part="override"
                disabled={override.busy}
                onClick={wipeAnyway}
              >
                <Button.Label>Wipe anyway</Button.Label>
              </Button.Root>
              <Button.Root variant="ghost"
                className="btn btn-ghost"
                disabled={override.busy}
                onClick={() => send({ type: "BACK" })}
              >
                <Button.Label>Back</Button.Label>
              </Button.Root>
            </div>
          ) : (
            <div className="actions">
              <Button.Root variant="solid"
                type="submit"
                className="btn btn-danger"
                data-aeon-part="trigger"
                data-aeon-state={stateAttr}
                disabled={!canSubmit || busy}
              >
                <Button.Label>{snapshot.matches("syncing")
                  ? "Syncing history…"
                  : snapshot.matches("wiping")
                  ? "Wiping…"
                  : "Wipe wallet"}</Button.Label>
              </Button.Root>
              <Button.Root variant="ghost"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  send({ type: "CHANGE_PASSWORD", password: "" });
                  send({ type: "CHANGE_CONFIRM", confirmText: "" });
                  send({ type: "TOGGLE_ACK", acknowledged: false });
                  playWalletSound("soft");
                }}
              >
                <Button.Label>Back</Button.Label>
              </Button.Root>
            </div>
          )}
        </form>
      )}
      <AsyncActionPrompt action={override} />
    </div>
  );
}
