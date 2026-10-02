import { useMachine } from "@xstate/react";
import { stateToAttr } from "@aeon-ui/core";
import { wipeMachine } from "../machines/wipeMachine";
import { StatusBanner } from "@aeon-ui/react";
import { wipeAllWalletData } from "../wallet/wipeWallet";
import {
  syncHistoryBeforeWipe,
  wipeRefusalMessage,
} from "../wallet/wipeHistoryGate";
import { playWalletSound } from "../wallet/soundService";
import { ConfirmPasswordGate } from "./ConfirmPasswordGate";

const CONFIRM_WORD = "DELETE";

export function WipeWalletPanel() {
  const [snapshot, send] = useMachine(wipeMachine);
  const stateAttr = stateToAttr(snapshot.value);
  const passwordReady = snapshot.context.unlocked;
  const canSubmit =
    passwordReady &&
    snapshot.context.acknowledged &&
    snapshot.context.confirmText.trim().toUpperCase() === CONFIRM_WORD;

  const busy = snapshot.matches("syncing") || snapshot.matches("wiping");

  const syncThenWipe = async () => {
    const check = await syncHistoryBeforeWipe();
    if (!check.ok) {
      send({ type: "BLOCKED", reason: wipeRefusalMessage(check.refusal) });
      playWalletSound("error");
      return;
    }
    send({ type: "SYNCED", gate: check.gate });
    try {
      await wipeAllWalletData(snapshot.context.password || null, check.gate);
      send({ type: "SUCCESS" });
      playWalletSound("soft");
      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: "FAIL", error: message });
      playWalletSound("error");
    }
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
          lede="Removes the wallet from this device. You’ll need a backup to restore. Confirm with device unlock or your HandCash password."
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

          <label className="field settings-check-label">
            <input
              type="checkbox"
              checked={snapshot.context.acknowledged}
              disabled={busy}
              onChange={(e) =>
                send({ type: "TOGGLE_ACK", acknowledged: e.target.checked })
              }
            />
            <span>I understand this cannot be undone without my backup.</span>
          </label>

          <div className="field">
            <label htmlFor="wipe-confirm">
              Type <strong>{CONFIRM_WORD}</strong>
            </label>
            <input
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
          </div>

          {snapshot.matches("blocked") ? (
            <StatusBanner.Root tone="danger" status="blocked">
              <StatusBanner.Copy>
                <StatusBanner.Title>History not synced</StatusBanner.Title>
                <StatusBanner.Body>{snapshot.context.error}</StatusBanner.Body>
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
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  send({ type: "RETRY" });
                  void syncThenWipe();
                }}
              >
                Sync and wipe
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => send({ type: "BACK" })}
              >
                Back
              </button>
            </div>
          ) : (
            <div className="actions">
              <button
                type="submit"
                className="btn btn-danger"
                data-aeon-part="trigger"
                data-aeon-state={stateAttr}
                disabled={!canSubmit || busy}
              >
                {snapshot.matches("syncing")
                  ? "Syncing history…"
                  : snapshot.matches("wiping")
                  ? "Wiping…"
                  : "Wipe wallet"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  send({ type: "CHANGE_PASSWORD", password: "" });
                  send({ type: "CHANGE_CONFIRM", confirmText: "" });
                  send({ type: "TOGGLE_ACK", acknowledged: false });
                  playWalletSound("soft");
                }}
              >
                Back
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
