import { useSyncExternalStore } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { copyText } from "../../wallet/clipboard";
import {
  describeDevSigningKey,
  exportDevSigningKey,
} from "../../wallet/devSigningKey";
import { setNavSection } from "../../wallet/navStore";
import {
  publicIdentitiesGeneration,
  subscribePublicIdentities,
} from "../../wallet/publicIdentities";
import { playWalletSound } from "../../wallet/soundService";
import { toastError } from "../../wallet/toast";
import { getWalletRuntime } from "../../wallet/walletRuntime";
import { AsyncActionPrompt } from "../AsyncActionPrompt";
import { FingerprintIcon } from "../icons";
import { SettingsControlRow } from "./SettingsControlRow";

/**
 * Developer key: copy the shared identity's current BAP signing key for a
 * server that signs as that identity. Rotation (which retires it) lives on
 * the Identity panel.
 */
export function DevKeyList() {
  // Re-render on publish / rotate / share; the description is derived below.
  useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration);
  const action = useAsyncAction<"copy">();
  const runtime = getWalletRuntime();
  const status = runtime ? describeDevSigningKey(runtime) : null;
  if (!status) return null;
  const ready = status.kind === "ready" ? status.key : null;

  const copy = async () => {
    if (!ready) return;
    const outcome = await action.run(
      "copy",
      async () => {
        const runtime = getWalletRuntime();
        if (!runtime) throw new Error("Unlock the wallet first.");
        const key = exportDevSigningKey(runtime);
        if (!(await copyText(key.wif, { label: "developer key" }))) {
          throw new Error("Could not copy the developer key.");
        }
      },
      {
        confirm: {
          title: "Copy developer key?",
          body: `A server holding this key signs as ${ready.name}. It holds no funds and cannot reveal your wallet keys, but it can sign a key rotation. If it leaks, rotate the signing key on Identity.`,
          confirmLabel: "Copy key",
        },
      }
    );
    if (!outcome.ok && outcome.error)
      toastError("Developer key", outcome.error);
  };

  return (
    <>
      <ul
        className="settings-list"
        data-aeon-scope="dev-key"
        data-aeon-state={action.stateAttr}
      >
        <SettingsControlRow
          icon={<FingerprintIcon size={20} />}
          label="Developer key"
          description={
            ready
              ? `Signs BAP as ${ready.name} · identity-${
                  ready.seq
                } · ${ready.address.slice(0, 8)}…`
              : status.kind === "refused"
              ? status.message
              : undefined
          }
        >
          <span className="settings-action-stack">
            <button
              type="button"
              className="btn btn-primary settings-action-btn"
              disabled={!ready || action.busy}
              onClick={() => void copy()}
            >
              {action.running("copy") ? "Copying…" : "Copy key"}
            </button>
            <button
              type="button"
              className="btn settings-action-btn"
              disabled={action.busy}
              onClick={() => {
                playWalletSound("soft");
                setNavSection("identity");
              }}
            >
              {ready ? "Rotate" : "Publish"}
            </button>
          </span>
        </SettingsControlRow>
      </ul>
      <AsyncActionPrompt action={action} />
    </>
  );
}
