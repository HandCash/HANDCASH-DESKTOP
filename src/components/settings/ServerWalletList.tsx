import { useState, useSyncExternalStore } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { copyText } from "../../wallet/clipboard";
import {
  describeServerWallet,
  exportServerWalletConfig,
  fundServerWallet,
  recoverServerWallet,
  rotateServerWallet,
  serverWalletRevision,
  setUpServerWallet,
  subscribeServerWallet,
} from "../../wallet/serverWallet";
import { formatSats } from "../../wallet/session";
import { playWalletSound } from "../../wallet/soundService";
import { toastError, toastSuccess } from "../../wallet/toast";
import {
  getWalletRuntime,
  requireWalletRuntime,
} from "../../wallet/walletRuntime";
import { AsyncActionPrompt } from "../AsyncActionPrompt";
import { WalletScopeIcon } from "../icons";
import { SettingsControlRow } from "./SettingsControlRow";

type ServerWalletAction = "setup" | "copy" | "fund" | "recover" | "rotate";

/**
 * Server wallet: a derived key a developer's server spends. This wallet tracks
 * it from the server's reports and spends it only on Recover.
 */
export function ServerWalletList() {
  useSyncExternalStore(subscribeServerWallet, serverWalletRevision);
  const action = useAsyncAction<ServerWalletAction>();
  const [amount, setAmount] = useState("");
  const runtime = getWalletRuntime();
  if (!runtime) return null;
  const status = describeServerWallet(runtime);
  const ready = status.kind === "ready" ? status : null;
  const fundSats = Math.trunc(Number(amount));
  const fundable = Number.isFinite(fundSats) && fundSats > 0;

  const run = async (
    kind: ServerWalletAction,
    task: () => Promise<string | null>,
    confirm?: Parameters<typeof action.run>[2]
  ) => {
    let done: string | null = null;
    const outcome = await action.run(
      kind,
      async () => {
        done = await task();
      },
      confirm
    );
    if (outcome.ok) {
      playWalletSound("soft");
      if (done) toastSuccess(done);
    } else if (outcome.error) {
      toastError("Server wallet", outcome.error);
    }
  };

  const description = ready
    ? `${formatSats(ready.trackedSats)} sats tracked · ${ready.outputs} output${
        ready.outputs === 1 ? "" : "s"
      } · ${
        ready.lastReportAt
          ? `last report ${new Date(ready.lastReportAt).toLocaleString()}`
          : "no report yet"
      }`
    : "A separate key your server spends. This wallet tracks it from the server's reports and never spends it unless you recover.";

  return (
    <>
      <ul
        className="settings-list"
        data-aeon-scope="server-wallet"
        data-aeon-state={action.stateAttr}
      >
        <SettingsControlRow
          icon={<WalletScopeIcon size={20} />}
          label="Server wallet"
          description={description}
        >
          <span className="settings-action-stack">
            {!ready ? (
              <button
                type="button"
                className="btn btn-primary settings-action-btn"
                disabled={action.busy}
                onClick={() =>
                  void run("setup", async () => {
                    setUpServerWallet(requireWalletRuntime());
                    return null;
                  })
                }
              >
                {action.running("setup") ? "Setting up…" : "Set up"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary settings-action-btn"
                  disabled={action.busy}
                  onClick={() =>
                    void run(
                      "copy",
                      async () => {
                        const config = await exportServerWalletConfig(
                          requireWalletRuntime()
                        );
                        if (
                          !(await copyText(config, { label: "server key" }))
                        ) {
                          throw new Error("Could not copy the server key.");
                        }
                        return null;
                      },
                      {
                        confirm: {
                          title: "Copy server key?",
                          body: "Copies the server key with where to report (this identity's server_wallet box). A server holding it can spend everything you fund it with, so fund only what the server needs. It cannot reach this wallet's balance or other keys.",
                          confirmLabel: "Copy key",
                        },
                      }
                    )
                  }
                >
                  {action.running("copy") ? "Copying…" : "Copy key"}
                </button>
                {ready.outputs > 0 || ready.pendingRecover ? (
                  <button
                    type="button"
                    className="btn settings-action-btn"
                    disabled={action.busy}
                    onClick={() =>
                      void run(
                        "recover",
                        async () => {
                          const result = await recoverServerWallet();
                          return `Recovered ${formatSats(
                            result.satoshis
                          )} sats`;
                        },
                        {
                          confirm: {
                            title: "Recover server wallet?",
                            body: `Moves ${formatSats(
                              ready.trackedSats
                            )} tracked sats back into this wallet. Stop the server first: a spend it signs at the same time makes the network reject one of the two.`,
                            confirmLabel: "Recover",
                          },
                        }
                      )
                    }
                  >
                    {action.running("recover") ? "Recovering…" : "Recover"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn settings-action-btn"
                    disabled={action.busy}
                    onClick={() =>
                      void run(
                        "rotate",
                        async () => {
                          rotateServerWallet(requireWalletRuntime());
                          return "Server key rotated — copy the new key to your server";
                        },
                        {
                          confirm: {
                            title: "Rotate server key?",
                            body: "Retires the current key. Reports signed with it are refused from now on; copy the new key to your server.",
                            confirmLabel: "Rotate",
                          },
                        }
                      )
                    }
                  >
                    {action.running("rotate") ? "Rotating…" : "Rotate"}
                  </button>
                )}
              </>
            )}
          </span>
        </SettingsControlRow>
      </ul>
      {ready ? (
        <div
          className="settings-form settings-form-compact"
          data-aeon-part="server-wallet-fund"
        >
          <div className="field">
            <label htmlFor="server-wallet-fund">Fund (sats)</label>
            <input
              id="server-wallet-fund"
              inputMode="numeric"
              placeholder="10000"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              autoComplete="off"
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!fundable || action.busy}
              onClick={() =>
                void run(
                  "fund",
                  async () => {
                    await fundServerWallet(fundSats);
                    setAmount("");
                    return `Sent ${formatSats(
                      fundSats
                    )} sats to the server wallet`;
                  },
                  {
                    confirm: {
                      title: "Fund server wallet?",
                      body: `Sends ${formatSats(
                        fundSats
                      )} sats to the server key. The server can spend them; this wallet keeps tracking them.`,
                      confirmLabel: "Send",
                    },
                  }
                )
              }
            >
              {action.running("fund") ? "Sending…" : "Fund"}
            </button>
          </div>
        </div>
      ) : null}
      <AsyncActionPrompt action={action} />
    </>
  );
}
