import { useEffect, useState, useSyncExternalStore } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useDisplayCurrency } from "../../hooks/useDisplayCurrency";
import { copyText } from "../../wallet/clipboard";
import { formatPrimaryFromSats } from "../../wallet/fx";
import {
  describeServerWallet,
  exportServerWalletConfig,
  fundServerWallet,
  recoverServerWallet,
  refreshServerWallet,
  rotateServerWallet,
  serverWalletRevision,
  setUpServerWallet,
  subscribeServerWallet,
  type ServerWalletSummary,
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

function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

function summaryLine(
  summary: ServerWalletSummary,
  currency: ReturnType<typeof useDisplayCurrency>
): string {
  return [
    formatPrimaryFromSats(summary.money, currency),
    count(summary.items, "item"),
    count(summary.tokens, "token"),
  ].join(" · ");
}

/**
 * Server wallet: the BRC-100 wallet a developer's server runs, opened here
 * over the same storage. Shows what it holds; spends only on Recover.
 */
export function ServerWalletList() {
  useSyncExternalStore(subscribeServerWallet, serverWalletRevision);
  const currency = useDisplayCurrency();
  const action = useAsyncAction<ServerWalletAction>();
  const [amount, setAmount] = useState("");
  const runtime = getWalletRuntime();
  const status = runtime ? describeServerWallet(runtime) : null;
  const ready = status?.kind === "ready" ? status : null;
  const generation = ready?.generation ?? null;

  useEffect(() => {
    if (!runtime || generation == null) return;
    void refreshServerWallet(runtime).catch(() => {});
  }, [runtime, generation]);

  if (!status) return null;
  const summary = ready?.summary ?? null;
  const fundSats = Math.trunc(Number(amount));
  const fundable = Number.isFinite(fundSats) && fundSats > 0;
  const holdsMoney = (summary?.money ?? 0) > 0 || ready?.pending === true;
  const empty =
    summary != null &&
    summary.money === 0 &&
    summary.items === 0 &&
    summary.tokens === 0;

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

  const description = !ready
    ? undefined
    : summary
    ? summaryLine(summary, currency)
    : ready.error
    ? "Storage unreachable"
    : "Loading…";

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
                        const env = exportServerWalletConfig(
                          requireWalletRuntime()
                        );
                        if (!(await copyText(env, { label: "server key" }))) {
                          throw new Error("Could not copy the server key.");
                        }
                        return null;
                      },
                      {
                        confirm: {
                          title: "Copy server key?",
                          body: "Copies SERVER_PRIVATE_KEY and WALLET_STORAGE_URL for your server. It can spend what this wallet funds it with, and nothing else.",
                          confirmLabel: "Copy key",
                        },
                      }
                    )
                  }
                >
                  {action.running("copy") ? "Copying…" : "Copy key"}
                </button>
                {holdsMoney ? (
                  <button
                    type="button"
                    className="btn settings-action-btn"
                    disabled={action.busy}
                    onClick={() =>
                      void run(
                        "recover",
                        async () => {
                          const result = await recoverServerWallet();
                          return `Recovered ${formatPrimaryFromSats(
                            result.satoshis,
                            currency
                          )}`;
                        },
                        {
                          confirm: {
                            title: "Recover server wallet?",
                            body: "Moves its money back here. Items and tokens stay with the server. Stop the server first.",
                            confirmLabel: "Recover",
                          },
                        }
                      )
                    }
                  >
                    {action.running("recover") ? "Recovering…" : "Recover"}
                  </button>
                ) : empty ? (
                  <button
                    type="button"
                    className="btn settings-action-btn"
                    disabled={action.busy}
                    onClick={() =>
                      void run(
                        "rotate",
                        async () => {
                          await rotateServerWallet(requireWalletRuntime());
                          return "Server key rotated — copy the new key to your server";
                        },
                        {
                          confirm: {
                            title: "Rotate server key?",
                            body: "Retires the current key. Copy the new one to your server.",
                            confirmLabel: "Rotate",
                          },
                        }
                      )
                    }
                  >
                    {action.running("rotate") ? "Rotating…" : "Rotate"}
                  </button>
                ) : null}
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
                    return `Sent ${formatSats(fundSats)} sats to the server wallet`;
                  },
                  {
                    confirm: {
                      title: "Fund server wallet?",
                      body: `Sends ${formatSats(fundSats)} sats to your server.`,
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
