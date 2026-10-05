import { useEffect, useState, useSyncExternalStore } from "react";
import { stateToAttr } from "@aeon-ui/core";
import { MetricStrip } from "@aeon-ui/ui";
import { useMachine } from "@xstate/react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useDisplayCurrency } from "../hooks/useDisplayCurrency";
import { devKeysPanelMachine } from "../machines/devKeysPanelMachine";
import { copyText } from "../wallet/clipboard";
import {
  devKeysRevision,
  devSignEligibility,
  devWalletHoldings,
  exportDevKeyConfig,
  fundDevWallet,
  generateDevKey,
  listDevKeys,
  recoverDevWallet,
  refreshDevWallet,
  removeDevKey,
  subscribeDevKeys,
  type DevKeyView,
  type DevWalletStatus,
} from "../wallet/devKeys";
import type { DisplayCurrency } from "../wallet/displayCurrency";
import { formatPrimaryFromSats, formatSecondaryFromSats } from "../wallet/fx";
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
import { Skeleton } from "./Skeleton";

type DevKeyAction =
  | "create"
  | "copy"
  | "fund"
  | "recover"
  | "refresh"
  | "remove";

const FUND_PRESETS = [1_000, 10_000, 100_000] as const;

function shortKey(publicKey: string): string {
  return `${publicKey.slice(0, 8)}…${publicKey.slice(-6)}`;
}

function createdLabel(at: number): string | null {
  if (!at) return null;
  return `Created ${new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function signLabel(key: DevKeyView): string | null {
  if (!key.sign) return null;
  if (!key.publicKey) return "Another identity";
  return key.sign.state === "active" && key.sign.name
    ? `Signs as ${key.sign.name}`
    : "Signing retired";
}

function walletNote(
  status: DevWalletStatus,
  host: string,
  currency: DisplayCurrency
): string {
  switch (status.kind) {
    case "loading":
      return `Reading ${host}…`;
    case "ready":
      return `Stored on ${host}. Only your server spends it.`;
    case "unreachable":
      return `Can’t reach ${host}: ${status.error}`;
    case "settling":
      return [
        status.funding > 0
          ? `${formatPrimaryFromSats(
              status.funding,
              currency
            )} on its way to the server`
          : null,
        status.recovering > 0
          ? `${formatPrimaryFromSats(
              status.recovering,
              currency
            )} on its way back — Recover finishes it`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

function signNote(key: DevKeyView): string {
  if (!key.publicKey) return "Present the identity it signs as to use it.";
  if (key.sign?.state === "active") {
    return `Your server signs as ${key.sign.name} with it. It holds no funds.`;
  }
  return "An identity key rotation retired it. It no longer signs.";
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
  const { status } = key.wallet;
  return (
    status.kind === "ready" &&
    status.summary.money === 0 &&
    status.summary.items === 0 &&
    status.summary.tokens === 0
  );
}

function recoverable(key: DevKeyView): boolean {
  if (!key.wallet) return false;
  const { status } = key.wallet;
  if (status.kind === "settling" && status.recovering > 0) return true;
  return (devWalletHoldings(status)?.money ?? 0) > 0;
}

function WalletMetrics({
  status,
  currency,
}: {
  status: DevWalletStatus;
  currency: DisplayCurrency;
}) {
  const held = devWalletHoldings(status);
  const value = (text: string) =>
    held ? (
      text
    ) : status.kind === "unreachable" ? (
      "—"
    ) : (
      <Skeleton width="3.5rem" height="1rem" />
    );
  return (
    <MetricStrip.Root density="loose" className="dev-wallet-metrics">
      <MetricStrip.Chip>
        <MetricStrip.Value>
          {value(held ? formatPrimaryFromSats(held.money, currency) : "")}
        </MetricStrip.Value>
        <MetricStrip.Label>
          Balance
          {held && held.money > 0
            ? ` · ${formatSecondaryFromSats(held.money, currency)}`
            : ""}
        </MetricStrip.Label>
      </MetricStrip.Chip>
      <MetricStrip.Chip>
        <MetricStrip.Value>
          {value(held ? held.items.toLocaleString() : "")}
        </MetricStrip.Value>
        <MetricStrip.Label>{held?.items === 1 ? "Item" : "Items"}</MetricStrip.Label>
      </MetricStrip.Chip>
      <MetricStrip.Chip>
        <MetricStrip.Value>
          {value(held ? held.tokens.toLocaleString() : "")}
        </MetricStrip.Value>
        <MetricStrip.Label>{held?.tokens === 1 ? "Token" : "Tokens"}</MetricStrip.Label>
      </MetricStrip.Chip>
    </MetricStrip.Root>
  );
}

function Overview({
  keys,
  currency,
}: {
  keys: DevKeyView[];
  currency: DisplayCurrency;
}) {
  const wallets = keys.flatMap((k) => (k.wallet ? [k.wallet.status] : []));
  const held = wallets.map(devWalletHoldings);
  const reading = wallets.some(
    (s, i) => held[i] == null && s.kind !== "unreachable"
  );
  const unreachable = held.filter((h) => h == null).length;
  const money = held.reduce((sum, h) => sum + (h?.money ?? 0), 0);
  return (
    <MetricStrip.Root
      density="loose"
      className="dev-wallet-metrics"
      data-aeon-part="overview"
    >
      <MetricStrip.Chip>
        <MetricStrip.Value>{keys.length}</MetricStrip.Value>
        <MetricStrip.Label>{keys.length === 1 ? "Key" : "Keys"}</MetricStrip.Label>
      </MetricStrip.Chip>
      <MetricStrip.Chip>
        <MetricStrip.Value>{wallets.length}</MetricStrip.Value>
        <MetricStrip.Label>
          {wallets.length === 1 ? "Server wallet" : "Server wallets"}
        </MetricStrip.Label>
      </MetricStrip.Chip>
      <MetricStrip.Chip>
        <MetricStrip.Value>
          {reading ? (
            <Skeleton width="3.5rem" height="1rem" />
          ) : unreachable === wallets.length && wallets.length > 0 ? (
            "—"
          ) : (
            formatPrimaryFromSats(money, currency)
          )}
        </MetricStrip.Value>
        <MetricStrip.Label>
          Held by servers
          {!reading && unreachable > 0 ? ` · ${unreachable} unreachable` : ""}
        </MetricStrip.Label>
      </MetricStrip.Chip>
    </MetricStrip.Root>
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
  const fundKey = snapshot.matches("funding") ? snapshot.context.fundKey : null;
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

  const fundForm = (n: number) => (
    <div className="settings-form" data-aeon-part="fund">
      <div className="field">
        <label htmlFor="dev-key-fund">Amount (sats)</label>
        <input
          id="dev-key-fund"
          inputMode="numeric"
          placeholder="10,000"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
          autoComplete="off"
          autoFocus
        />
      </div>
      <div data-aeon-part="fund-presets">
        {FUND_PRESETS.map((sats) => (
          <button
            key={sats}
            type="button"
            className="permission-chip"
            data-aeon-state={fundSats === sats ? "selected" : "idle"}
            onClick={() => setAmount(String(sats))}
          >
            {formatSats(sats)} sats
          </button>
        ))}
      </div>
      <p data-aeon-part="fund-preview">
        {fundable
          ? `≈ ${formatPrimaryFromSats(
              fundSats,
              currency
            )} from this wallet. You approve it next.`
          : "Paid from this wallet. You approve it next."}
      </p>
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
                await fundDevWallet(n, fundSats);
              } catch (error) {
                if (error instanceof WalletPaymentDenied) return null;
                throw error;
              }
              paid = true;
              return `Sent ${formatSats(fundSats)} sats to Key ${n}`;
            });
            if (ok && paid) {
              setAmount("");
              send({ type: "DONE" });
            }
          }}
        >
          {action.running("fund")
            ? "Sending…"
            : fundable
            ? `Fund ${formatSats(fundSats)} sats`
            : "Fund"}
        </button>
      </div>
    </div>
  );

  const actions = (key: DevKeyView) => (
    <div data-aeon-part="key-actions">
      {key.wallet ? (
        <button
          type="button"
          className="btn btn-primary"
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
      <button
        type="button"
        className={key.wallet ? "btn btn-ghost" : "btn btn-primary"}
        disabled={!key.publicKey || action.busy}
        onClick={() =>
          void run(
            "copy",
            async () => {
              const env = exportDevKeyConfig(requireWalletRuntime(), key.n);
              if (!(await copyText(env, { label: "developer key" }))) {
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
        {action.running("copy") ? "Copying…" : "Copy server config"}
      </button>
      {recoverable(key) ? (
        <button
          type="button"
          className="btn btn-ghost"
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
      {key.wallet ? (
        <button
          type="button"
          className="btn"
          disabled={!key.publicKey || action.busy || key.wallet.refreshing}
          onClick={() =>
            void run("refresh", async () => {
              await refreshDevWallet(requireWalletRuntime(), key.n);
              return null;
            })
          }
        >
          {key.wallet.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      ) : null}
      {removable(key) ? (
        <button
          type="button"
          className="btn btn-ghost"
          data-aeon-part="remove"
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
    </div>
  );

  const card = (key: DevKeyView) => {
    const sign = signLabel(key);
    const created = createdLabel(key.createdAt);
    return (
      <li
        key={key.n}
        data-aeon-part="key"
        data-aeon-state={key.wallet ? key.wallet.status.kind : "sign-only"}
      >
        <div data-aeon-part="key-head">
          <span data-aeon-part="key-icon" aria-hidden>
            {key.sign ? (
              <FingerprintIcon size={20} />
            ) : (
              <WalletScopeIcon size={20} />
            )}
          </span>
          <div data-aeon-part="key-title">
            <strong>Key {key.n}</strong>
            <span data-aeon-part="key-meta">
              {key.publicKey ? (
                <button
                  type="button"
                  data-aeon-part="pubkey"
                  title={key.publicKey}
                  onClick={async () => {
                    if (
                      await copyText(key.publicKey!, { label: "public key" })
                    ) {
                      toastSuccess("Public key copied");
                    }
                  }}
                >
                  {shortKey(key.publicKey)}
                </button>
              ) : null}
              {created ? <span>{created}</span> : null}
            </span>
          </div>
          <div data-aeon-part="capabilities">
            {sign ? (
              <span
                data-aeon-part="capability"
                data-aeon-state={
                  key.sign?.state === "active" && key.publicKey
                    ? "signing"
                    : "retired"
                }
              >
                {sign}
              </span>
            ) : null}
            {key.wallet ? (
              <span data-aeon-part="capability" data-aeon-state="wallet">
                Wallet
              </span>
            ) : null}
          </div>
        </div>
        {key.wallet ? (
          <>
            <WalletMetrics status={key.wallet.status} currency={currency} />
            <p
              data-aeon-part="key-note"
              data-aeon-state={key.wallet.status.kind}
            >
              {walletNote(key.wallet.status, key.wallet.storageHost, currency)}
            </p>
          </>
        ) : (
          <p data-aeon-part="key-note" data-aeon-state="sign-only">
            {signNote(key)}
          </p>
        )}
        {fundKey === key.n ? fundForm(key.n) : actions(key)}
      </li>
    );
  };

  return (
    <div
      className="nav-section-body settings-scroll"
      data-aeon-scope="dev-keys"
      data-aeon-state={stateToAttr(snapshot.value)}
    >
      <p className="settings-hint">
        Keys you give your own server. Each one can sign as your identity, hold
        a wallet your server spends, or both. None of them can reveal your
        wallet keys.
      </p>
      {snapshot.matches("creating") ? (
        <div className="settings-form" data-aeon-part="create">
          <label
            className={`wallet-setup-option${
              canSign ? "" : " is-disabled"
            }${canSign && capabilities.sign ? " is-selected" : ""}`}
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
          <label
            className={`wallet-setup-option${
              capabilities.wallet ? " is-selected" : ""
            }`}
          >
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
      ) : keys.length === 0 ? (
        <EmptyState
          title="No developer keys"
          body="Create one to give a server its own identity signature or wallet."
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
          <div data-aeon-part="head">
            <Overview keys={keys} currency={currency} />
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy || fundKey != null}
              onClick={startCreate}
            >
              New key
            </button>
          </div>
          <ul data-aeon-part="keys" data-aeon-state={action.stateAttr}>
            {keys.map(card)}
          </ul>
        </>
      )}
      <AsyncActionPrompt action={action} />
    </div>
  );
}
