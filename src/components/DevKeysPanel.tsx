import { useEffect, useState, useSyncExternalStore } from "react";
import { stateToAttr } from "@aeon-ui/core";
import { useMachine } from "@xstate/react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useDisplayCurrency } from "../hooks/useDisplayCurrency";
import { devKeysPanelMachine } from "../machines/devKeysPanelMachine";
import { copyText } from "../wallet/clipboard";
import {
  devKeysRevision,
  devSignEligibility,
  exportDevKeyConfig,
  fundDevWallet,
  generateDevKey,
  listDevKeys,
  recoverDevWallet,
  refreshDevWallet,
  removeDevKey,
  subscribeDevKeys,
  type DevKeyView,
  type DevWalletSummary,
} from "../wallet/devKeys";
import { formatPrimaryFromSats } from "../wallet/fx";
import { WalletPaymentDenied } from "../wallet/permissions";
import {
  publicIdentitiesGeneration,
  subscribePublicIdentities,
} from "../wallet/publicIdentities";
import { formatSats } from "../wallet/session";
import { playWalletSound } from "../wallet/soundService";
import { toastError, toastSuccess } from "../wallet/toast";
import {
  getWalletRuntime,
  requireWalletRuntime,
} from "../wallet/walletRuntime";
import { AsyncActionPrompt } from "./AsyncActionPrompt";
import { EmptyState } from "./EmptyState";
import { FingerprintIcon, WalletScopeIcon } from "./icons";
import { SettingsControlRow } from "./settings/SettingsControlRow";

type DevKeyAction = "create" | "copy" | "fund" | "recover" | "remove";

function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

function holdings(
  summary: DevWalletSummary,
  currency: ReturnType<typeof useDisplayCurrency>
): string {
  return [
    formatPrimaryFromSats(summary.money, currency),
    count(summary.items, "item"),
    count(summary.tokens, "token"),
  ].join(" · ");
}

function describe(
  key: DevKeyView,
  currency: ReturnType<typeof useDisplayCurrency>
): string {
  if (!key.publicKey) return "Present the identity it signs as to use it";
  const parts: string[] = [];
  if (key.sign) {
    parts.push(
      key.sign.state === "active"
        ? `Signs as ${key.sign.name}`
        : "Signing retired"
    );
  }
  if (key.wallet) {
    parts.push(
      key.wallet.summary
        ? holdings(key.wallet.summary, currency)
        : key.wallet.error
        ? "Storage unreachable"
        : "Loading…"
    );
  }
  return parts.join(" · ");
}

function copyBody(key: DevKeyView): string {
  const signs = key.sign?.state === "active" ? key.sign.name : null;
  if (signs && key.wallet) {
    return `A server holding this key signs as ${signs} and spends what you fund it with. It cannot reveal your wallet keys. If it leaks, rotate the identity key and recover its money.`;
  }
  if (signs) {
    return `A server holding this key signs as ${signs}. It holds no funds and cannot reveal your wallet keys, but it can sign a key rotation. If it leaks, rotate the identity key.`;
  }
  return "It can spend what you fund it with, and nothing else.";
}

function removable(key: DevKeyView): boolean {
  if (key.sign?.state === "active") return false;
  if (!key.wallet) return true;
  const s = key.wallet.summary;
  return (
    !key.wallet.pending &&
    s != null &&
    s.money === 0 &&
    s.items === 0 &&
    s.tokens === 0
  );
}

/**
 * Developer keys: keys handed to your server. Each is created with what it may
 * do — sign as your identity, hold a wallet your server spends, or both.
 */
export function DevKeysPanel() {
  useSyncExternalStore(subscribeDevKeys, devKeysRevision);
  useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration);
  const [snapshot, send] = useMachine(devKeysPanelMachine);
  const currency = useDisplayCurrency();
  const action = useAsyncAction<DevKeyAction>();
  const [capabilities, setCapabilities] = useState({
    sign: false,
    wallet: false,
  });
  const [amount, setAmount] = useState("");
  const runtime = getWalletRuntime();
  const keys = runtime ? listDevKeys(runtime) : [];
  const signing = runtime ? devSignEligibility(runtime) : null;
  const walletList = keys
    .filter((k) => k.wallet && k.publicKey)
    .map((k) => k.n)
    .join(",");

  useEffect(() => {
    if (!runtime || !walletList) return;
    for (const n of walletList.split(",").map(Number)) {
      void refreshDevWallet(runtime, n).catch(() => {});
    }
  }, [runtime, walletList]);

  if (!runtime || !signing) return null;
  const canSign = signing.kind === "ready";
  const chosen = (canSign && capabilities.sign) || capabilities.wallet;
  const fundKey = snapshot.context.fundKey;
  const fundSats = Math.trunc(Number(amount));
  const fundable = Number.isFinite(fundSats) && fundSats > 0;

  const run = async (
    kind: DevKeyAction,
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
      toastError("Developer key", outcome.error);
    }
    return outcome.ok;
  };

  const startCreate = () => {
    playWalletSound("soft");
    setCapabilities({ sign: false, wallet: false });
    send({ type: "NEW" });
  };

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="dev-keys"
      data-aeon-state={stateToAttr(snapshot.value)}
    >
      {snapshot.matches("creating") ? (
        <div className="settings-form" data-aeon-part="create">
          <label
            className={`wallet-setup-option${canSign ? "" : " is-disabled"}`}
          >
            <input
              type="checkbox"
              checked={canSign && capabilities.sign}
              disabled={!canSign}
              onChange={(e) =>
                setCapabilities((c) => ({ ...c, sign: e.target.checked }))
              }
            />
            <span className="wallet-setup-option-body">
              <strong>
                {signing.kind === "ready" ? `Sign as ${signing.name}` : "Sign"}
              </strong>
              <span>
                {signing.kind === "ready"
                  ? "Your server signs as this identity"
                  : signing.message}
              </span>
            </span>
          </label>
          <label className="wallet-setup-option">
            <input
              type="checkbox"
              checked={capabilities.wallet}
              onChange={(e) =>
                setCapabilities((c) => ({ ...c, wallet: e.target.checked }))
              }
            />
            <span className="wallet-setup-option-body">
              <strong>Wallet</strong>
              <span>Your server spends it; you fund and recover it here</span>
            </span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={action.busy}
              onClick={() => send({ type: "CANCEL" })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy || !chosen}
              onClick={async () => {
                const ok = await run("create", async () => {
                  const n = generateDevKey(requireWalletRuntime(), {
                    sign: canSign && capabilities.sign,
                    wallet: capabilities.wallet,
                  });
                  return `Key ${n} created`;
                });
                if (ok) send({ type: "DONE" });
              }}
            >
              {action.running("create") ? "Creating…" : "Create key"}
            </button>
          </div>
        </div>
      ) : snapshot.matches("funding") && fundKey != null ? (
        <div className="settings-form" data-aeon-part="fund">
          <div className="field">
            <label htmlFor="dev-key-fund">Fund Key {fundKey} (sats)</label>
            <input
              id="dev-key-fund"
              inputMode="numeric"
              placeholder="10000"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              autoComplete="off"
              autoFocus
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={action.busy}
              onClick={() => send({ type: "CANCEL" })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!fundable || action.busy}
              onClick={async () => {
                let paid = false;
                const ok = await run("fund", async () => {
                  try {
                    await fundDevWallet(fundKey, fundSats);
                  } catch (error) {
                    if (error instanceof WalletPaymentDenied) return null;
                    throw error;
                  }
                  paid = true;
                  return `Sent ${formatSats(fundSats)} sats to Key ${fundKey}`;
                });
                if (ok && paid) {
                  setAmount("");
                  send({ type: "DONE" });
                }
              }}
            >
              {action.running("fund") ? "Sending…" : "Fund"}
            </button>
          </div>
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          title="No developer keys"
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={startCreate}
            >
              New key
            </button>
          }
        />
      ) : (
        <>
          <ul className="settings-list" data-aeon-state={action.stateAttr}>
            {keys.map((key) => (
              <SettingsControlRow
                key={key.n}
                icon={
                  key.sign ? (
                    <FingerprintIcon size={20} />
                  ) : (
                    <WalletScopeIcon size={20} />
                  )
                }
                label={`Key ${key.n}`}
                description={describe(key, currency)}
              >
                <span className="settings-action-stack">
                  <button
                    type="button"
                    className="btn btn-primary settings-action-btn"
                    disabled={!key.publicKey || action.busy}
                    onClick={() =>
                      void run(
                        "copy",
                        async () => {
                          const env = exportDevKeyConfig(
                            requireWalletRuntime(),
                            key.n
                          );
                          if (
                            !(await copyText(env, { label: "developer key" }))
                          ) {
                            throw new Error("Could not copy the key.");
                          }
                          return null;
                        },
                        {
                          confirm: {
                            title: `Copy Key ${key.n}?`,
                            body: copyBody(key),
                            confirmLabel: "Copy key",
                          },
                        }
                      )
                    }
                  >
                    {action.running("copy") ? "Copying…" : "Copy"}
                  </button>
                  {key.wallet ? (
                    <button
                      type="button"
                      className="btn settings-action-btn"
                      disabled={!key.publicKey || action.busy}
                      onClick={() => {
                        playWalletSound("soft");
                        setAmount("");
                        send({ type: "FUND", n: key.n });
                      }}
                    >
                      Fund
                    </button>
                  ) : null}
                  {key.wallet &&
                  ((key.wallet.summary?.money ?? 0) > 0 ||
                    key.wallet.pending) ? (
                    <button
                      type="button"
                      className="btn settings-action-btn"
                      disabled={!key.publicKey || action.busy}
                      onClick={() =>
                        void run(
                          "recover",
                          async () => {
                            const result = await recoverDevWallet(key.n);
                            return `Recovered ${formatPrimaryFromSats(
                              result.satoshis,
                              currency
                            )}`;
                          },
                          {
                            confirm: {
                              title: `Recover Key ${key.n}?`,
                              body: "Moves its money back here. Items and tokens stay with the server. Stop the server first.",
                              confirmLabel: "Recover",
                            },
                          }
                        )
                      }
                    >
                      {action.running("recover") ? "Recovering…" : "Recover"}
                    </button>
                  ) : null}
                  {removable(key) ? (
                    <button
                      type="button"
                      className="btn settings-action-btn"
                      disabled={action.busy}
                      onClick={() =>
                        void run(
                          "remove",
                          async () => {
                            await removeDevKey(requireWalletRuntime(), key.n);
                            return null;
                          },
                          {
                            confirm: {
                              title: `Remove Key ${key.n}?`,
                              body: "A server still holding it keeps working until you stop it.",
                              confirmLabel: "Remove",
                            },
                          }
                        )
                      }
                    >
                      {action.running("remove") ? "Removing…" : "Remove"}
                    </button>
                  ) : null}
                </span>
              </SettingsControlRow>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy}
              onClick={startCreate}
            >
              New key
            </button>
          </div>
        </>
      )}
      <AsyncActionPrompt action={action} />
    </div>
  );
}
