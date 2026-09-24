import { getActiveWallet } from '../wallet/session'

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { PaymentFiltersPanel } from "./PaymentFiltersPanel";
import { TopBarPopover } from "./TopBarPopover";
import {
  ActivityIcon,
  AppsIcon,
  CancelListingIcon,
  CollectablesIcon,
  FilterIcon,
  FriendsIcon,
  ListingIcon,
  MintIcon,
  PurchaseIcon,
  ReceiveIcon,
  SendIcon,
  SoldIcon,
  FireIcon,
  RefreshIcon,
  WarningIcon,
} from "./icons";
import { DeferredImage } from "./DeferredImage";
import { useChunkedCount } from "./useChunkedCount";
import { useScrollIdle } from "./uiFeed/useScrollIdle";
import { useWindowedRange } from "./uiFeed/useWindowedRange";
import { CollectableVerifyMark } from "./CollectableVerifyMark";
import { LoadingSpinner } from "./LoadingSpinner";
import {
  activityEntryKey,
  activityEntryContinues,
  activityEntryTitle,
  activityTokenAmountDisplay,
  archiveOversizedBulkSendDebris,
  expireStaleInboundPending,
  expireStaleOutboundPending,
  getActivityWriteGeneration,
  isEventActivity,
  isItemActivity,
  isBurnActivity,
  isTokenActivity,
  isPendingActivity,
  isFailedActivity,
  activityFailureLabel,
  countFailedActivity,
  isUtxoHealActivity,
  listRecentActivity,
  subscribeAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
} from "../wallet/appActivity";
import { inFlightSettlementLabel } from "../wallet/settlementCopy";
import { getTxByTxid } from "../wallet/txStore";
import {
  clearAllFailedSpends,
  countClearableFailedSpends,
  countRebroadcastableFailedSpends,
  countUnresolvedPeerTransfers,
  isCounterpartySettlePending,
  publishUnresolvedPeerTransfers,
  rebroadcastAllFailedSpends,
} from "../wallet/spendAttempt";
import { toastError, toastSuccess } from "../wallet/toast";
import {
  markActivitySeen,
  noteActivityAnnounced,
  shouldAnnounceActivity,
} from "../wallet/activitySeen";
import { viewActivityItem } from "../wallet/activityItemView";
import {
  activityActionMark,
  type ActivityActionMark,
} from "../wallet/activityActionMark";
import {
  activityBatchName,
  ACTIVITY_COMPOSE_WINDOW,
  previewActivityRecords,
  type ActivityBatch,
  type ActivityRecord,
} from "../wallet/activityRecords";
import { subscribeCollectables } from "../wallet/collectables";
import { isItemProven } from "../wallet/provenCache";
import { subscribeFungibles } from "../wallet/token";
import {
  getVerificationProgress,
  isOutpointVerifying,
  subscribeVerificationProgress,
} from "../wallet/verificationProgress";
import { bsvLogoForClassic } from "../assets/brand/bsvLogos";
import {
  getBsvLogoClassic,
  subscribeBsvLogoClassic,
} from "../wallet/bsvLogoPreference";
import {
  DEFAULT_PAYMENT_FILTERS,
  filterPaymentActivity,
  listPaymentOriginOptions,
  type PaymentFilters,
  type PaymentOriginOption,
} from "../wallet/paymentFilters";
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from "../wallet/fx";
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from "../wallet/displayCurrency";
import {
  getPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from "../wallet/paymentProgress";
import { LIVE_OUTBOUND_ID, mergeLiveOutbound } from "../wallet/liveOutboundRow";
import {
  openPaymentDetails,
  openSetting,
  setNavSection,
} from "../wallet/navStore";
import { subscribeConnectedApps } from "../wallet/permissions";
import { playWalletSound } from "../wallet/soundService";
import type { Chain } from "../wallet/vault";
import {
  phraseImportBelongsToWallet,
  peekPhraseItemMigrateCursor,
  subscribePhraseItemMigrateCursor,
  type PhraseItemMigrateCursor,
} from "../wallet/phraseSweep";

import { EmptyState } from "./EmptyState";
import { AppAvatar } from "./AppAvatar";
import { appDisplayName } from "../wallet/appIdentity";

/** Paint a few rows per frame so Activity does not block the UI on open. */
const RENDER_CHUNK = 24;

function PendingPhraseImportRow({
  cursor,
}: {
  cursor: PhraseItemMigrateCursor;
}) {
  const skipped = Math.max(0, Math.trunc(cursor.skipped ?? 0));
  const failed = Math.max(0, Math.trunc(cursor.failed));
  const moved = Math.max(0, Math.trunc(cursor.moved));
  const detail = [
    `${moved.toLocaleString()} imported`,
    `${Math.max(0, Math.trunc(cursor.offset)).toLocaleString()} scanned`,
    failed > 0 ? `${failed.toLocaleString()} failed` : null,
    skipped > 0 ? `${skipped.toLocaleString()} skipped` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const status =
    cursor.stopped === "funds"
      ? "Paused — add BSV to continue"
      : "Paused — review details";

  return (
    <li
      data-aeon-scope="phrase-import"
      data-aeon-state="paused"
      data-activity-key={`phrase-import:${cursor.sourceAddress}`}
      data-activity-pending=""
    >
      <button
        type="button"
        className="history-row history-row-btn"
        onClick={() => {
          playWalletSound("soft");
          openSetting("import-phrase");
        }}
        aria-label={`Review paused collectable import, ${detail}`}
      >
        <div className="history-icon-wrap">
          <div className="history-icon">
            <span className="history-item-thumb-icon" aria-hidden>
              <CollectablesIcon size={18} />
            </span>
          </div>
          <span
            className="history-pending-mark"
            aria-label="Import paused"
            title="Import paused safely"
          >
            <LoadingSpinner size="sm" />
          </span>
        </div>
        <div className="history-body">
          <strong className="history-title">Collectable import paused</strong>
          <span className="history-when" title={`${status}. ${detail}`}>
            {status} · {detail}
          </span>
        </div>
        <div className="history-amount-block">
          <span className="history-amount history-amount-item">Review</span>
        </div>
      </button>
    </li>
  );
}

type ActivityFeedSnapshot = {
  generation: number;
  entries: ActivityEntry[];
  origins: PaymentOriginOption[];
};

const feedCache = new Map<number, ActivityFeedSnapshot>();

function readActivityFeed(limit: number): ActivityFeedSnapshot {
  const generation = getActivityWriteGeneration();
  const hit = feedCache.get(limit);
  if (hit && hit.generation === generation) return hit;
  const snapshot = {
    generation,
    entries: listRecentActivity(limit),
    origins: listPaymentOriginOptions(limit),
  };
  feedCache.set(limit, snapshot);
  return snapshot;
}

function invalidateActivityFeed(limit?: number): void {
  if (limit == null) feedCache.clear();
  else feedCache.delete(limit);
}

function formatWhen(at: number): string {
  const diff = Math.max(0, Date.now() - at);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;

  const years = Math.floor(days / 365);
  if (years === 1) return "1 year ago";
  return `${years} years ago`;
}

/**
 * One glyph per action. The `Record` is exhaustive by type, so a new action mark
 * cannot ship reusing another action's icon by omission.
 */
function actionGlyphs(
  icon: number
): Record<ActivityActionMark, { label: string; glyph: ReactNode }> {
  return {
    failed: { label: "Failed", glyph: <WarningIcon size={icon} /> },
    list: { label: "Listing", glyph: <ListingIcon size={icon - 1} /> },
    cancel: {
      label: "Cancel listing",
      glyph: <CancelListingIcon size={icon} />,
    },
    sale: { label: "Sold", glyph: <SoldIcon size={icon + 1} /> },
    purchase: { label: "Purchase", glyph: <PurchaseIcon size={icon} /> },
    burn: { label: "Burn", glyph: <FireIcon size={icon - 1} /> },
    mint: { label: "Mint", glyph: <MintIcon size={icon - 1} /> },
    send: { label: "Send", glyph: <SendIcon size={icon * 0.75} /> },
    receive: { label: "Receive", glyph: <ReceiveIcon size={icon} /> },
  };
}

const OVERLAY_GLYPHS = actionGlyphs(9);
const TIMELINE_GLYPHS = actionGlyphs(15);

/** Subscript action mark shared by the Activity list, detail hero, and item history. */
export function HistoryActionMarkBadge({
  mark,
  label,
  inline = false,
  size = "overlay",
}: {
  mark: ActivityActionMark;
  label?: string;
  /** Timeline / legend — a mark of its own, not a subscript of another mark. */
  inline?: boolean;
  size?: "overlay" | "timeline";
}) {
  const { label: fallback, glyph } = (
    size === "timeline" ? TIMELINE_GLYPHS : OVERLAY_GLYPHS
  )[mark];
  const text = label ?? fallback;
  return (
    <span
      className={`history-action-badge is-${mark}${
        inline ? " history-action-badge--inline" : ""
      }${size === "timeline" ? " history-action-badge--timeline" : ""}`}
      aria-label={text}
      title={text}
    >
      {glyph}
    </span>
  );
}

export function HistoryActionBadge({ entry }: { entry: ActivityEntry }) {
  const mark = activityActionMark(entry);
  if (!mark) return null;
  return (
    <HistoryActionMarkBadge mark={mark} label={OVERLAY_GLYPHS[mark].label} />
  );
}

/** Subject thumb, batch stack, and the four corner marks — shared with the detail hero. */
export function HistoryIconCluster({
  entry,
  assets = [],
  batch = null,
  verifying = false,
  stacked = true,
}: {
  entry: ActivityEntry;
  assets?: readonly ActivityEntry[];
  batch?: ActivityBatch | null;
  verifying?: boolean;
  /** Parent batch only — line items are one subject, never a pile. */
  stacked?: boolean;
}) {
  const [classicBsvLogo, setClassicBsvLogo] = useState(() =>
    getBsvLogoClassic()
  );
  useEffect(() => subscribeBsvLogoClassic(setClassicBsvLogo), []);
  const spent = entry.kind === "spent";
  const event = isEventActivity(entry);
  const item = isItemActivity(entry);
  const burned = isBurnActivity(entry);
  const pending = isPendingActivity(entry);
  const inventoryProven = Boolean(
    entry.item?.outpoint && isItemProven(entry.item.outpoint)
  );
  const indexInstall =
    event &&
    pending &&
    (entry.method === "index-install" || entry.method === "index-sync");
  const showPending = pending && (spent || !inventoryProven || indexInstall);
  const listing = entry.method === "market-list";
  const cancelling = entry.method === "market-cancel";
  const shown = entry.item ? viewActivityItem(entry.item) : undefined;
  const showVerify = Boolean(
    !spent && !event && !inventoryProven && (showPending || (item && verifying))
  );
  const showSending = Boolean(
    (spent && !event && showPending) ||
      (burned && pending) ||
      ((listing || cancelling) && pending) ||
      indexInstall
  );
  const sendingLabel = burned
    ? "Burning"
    : listing
    ? "Listing"
    : cancelling
    ? "Cancelling"
    : "Sending";

  const showStack = Boolean(
    stacked && batch && batch.count > 1 && assets.length > 0
  );

  return (
    <div className="history-icon-wrap">
      {showStack ? (
        <span className="history-icon-stack" aria-hidden>
          {assets.slice(0, 2).map((asset, index) => {
            const face = asset.item ? viewActivityItem(asset.item) : null;
            if (!face?.imageUrl) return null;
            return (
              <span
                key={activityEntryKey(asset)}
                className="history-icon-stack-face"
                style={{ zIndex: 1 + index }}
              >
                <DeferredImage
                  className="history-item-thumb"
                  src={face.imageUrl}
                  alt=""
                  width={28}
                  height={28}
                  skeletonWidth={28}
                  skeletonHeight={28}
                  skeletonRadius={6}
                  retainDecoded
                  decoding="async"
                />
              </span>
            );
          })}
        </span>
      ) : null}
      <div className="history-icon">
        {event && !(shown && shown.imageUrl) ? (
          <span className="history-item-thumb-icon" aria-hidden>
            {eventIcon(entry)}
          </span>
        ) : (item || listing || cancelling) && shown?.imageUrl ? (
          <DeferredImage
            className="history-item-thumb"
            src={shown.imageUrl}
            alt=""
            width={28}
            height={28}
            skeletonWidth={28}
            skeletonHeight={28}
            skeletonRadius={6}
            retainDecoded
            decoding="async"
            fallback={
              <span className="history-item-thumb-icon">
                <CollectablesIcon size={18} />
              </span>
            }
          />
        ) : item || listing || cancelling ? (
          <span className="history-item-thumb-icon">
            <CollectablesIcon size={18} />
          </span>
        ) : (
          <img
            className="history-asset-logo"
            src={bsvLogoForClassic(classicBsvLogo)}
            alt=""
            width={32}
            height={32}
          />
        )}
      </div>
      <CollectableVerifyMark
        verifying={!showSending && showVerify}
        outpoint={entry.item?.outpoint}
      />
      {showSending ? (
        <span
          className="history-pending-mark"
          aria-live="polite"
          aria-label={sendingLabel}
          title={sendingLabel}
        >
          <LoadingSpinner size="sm" />
        </span>
      ) : null}
      {showStack ? (
        <span
          className="history-batch-count"
          aria-label={`${batch!.count} collectables`}
        >
          {batch!.count}
        </span>
      ) : null}
      <HistoryAppBadge entry={entry} />
      <HistoryActionBadge entry={entry} />
    </div>
  );
}

function HistoryRow({
  entry,
  rowKey,
  currency,
  usdPerBsv,
  showWhen,
  newest = false,
  verifying = false,
  amountEntry = null,
  assets = [],
  batch = null,
}: {
  entry: ActivityEntry;
  /** Feed identity that survives Sending… → Sent / Receiving… → Received. */
  rowKey?: string;
  currency: DisplayCurrency;
  usdPerBsv: number | null;
  showWhen: boolean;
  newest?: boolean;
  verifying?: boolean;
  /** Money leg of the same transaction — a purchase price, sale proceeds. */
  amountEntry?: ActivityEntry | null;
  /** Further distinct assets moved by the same transaction. */
  assets?: readonly ActivityEntry[];
  /** Set when the transaction moved several collectables at once. */
  batch?: ActivityBatch | null;
}) {
  const spent = entry.kind === "spent";
  const event = isEventActivity(entry);
  const item = isItemActivity(entry);
  const token = isTokenActivity(entry);
  const burned = isBurnActivity(entry);
  const pending = isPendingActivity(entry);
  const failed = isFailedActivity(entry);
  const failureReason = failed ? activityFailureLabel(entry) : null;
  const inventoryProven = Boolean(
    entry.item?.outpoint && isItemProven(entry.item.outpoint)
  );
  const indexInstall =
    event &&
    pending &&
    (entry.method === "index-install" || entry.method === "index-sync");
  const utxoHeal = isUtxoHealActivity(entry);
  const utxoHealDone = utxoHeal && !failed && entry.sats > 0;
  const showPending = pending && (spent || !inventoryProven || indexInstall);
  const listing = entry.method === "market-list";
  const cancelling = entry.method === "market-cancel";
  // Identity as the wallet knows it now, not as the row froze it on arrival.
  const shown = entry.item ? viewActivityItem(entry.item) : undefined;
  const named = shown ? { ...entry, item: shown } : entry;
  // A batch is named by what it is, not by whichever member sorted first. The
  // verb still comes from the subject, so "Sent"/"Burned"/"Sold" stay correct.
  const batchName = batch ? activityBatchName(batch) : null;
  const title = activityEntryTitle(
    batchName && named.item
      ? { ...named, item: { ...named.item, name: batchName } }
      : named
  );
  // Every member by name, for the row the feed deliberately does not spell out.
  const batchNames = batchName
    ? [entry, ...assets]
        .map((asset) =>
          asset.item ? viewActivityItem(asset.item).name?.trim() : ""
        )
        .filter((name): name is string => Boolean(name))
        .join(", ")
    : null;
  // A pending spend the wallet cannot price yet has no transaction built —
  // it is still clearing approval. Say so, rather than signing an empty amount
  // or falling through to the no-rate dash, which read as a stray "—".
  const approving = spent && showPending && entry.sats <= 0;
  const amountLabel = utxoHealDone
    ? formatPrimaryFromSats(entry.sats, currency, usdPerBsv)
    : event
    ? eventAmountLabel(entry)
    : token
    ? activityTokenAmountDisplay(named)
    : item
    ? batchName || shown?.name || "Collectable"
    : approving
    ? "Approving"
    : showPending && entry.sats <= 0
    ? "…"
    : formatPrimaryFromSats(entry.sats, currency, usdPerBsv);
  // A composed record prices itself from the money leg of the same transaction:
  // an item row alone would read "Item" where the user expects what it cost.
  const moneyLabel = amountEntry
    ? formatPrimaryFromSats(amountEntry.sats, currency, usdPerBsv)
    : null;
  const signed = moneyLabel
    ? currency === "usd" && usdPerBsv == null
      ? "—"
      : `${amountEntry!.kind === "spent" ? "−" : "+"}${moneyLabel}`
    : utxoHealDone
    ? `+${amountLabel}`
    : event
    ? amountLabel
    : token
    ? amountLabel
    : item
    ? "Item"
    : approving
    ? amountLabel
    : currency === "usd" && usdPerBsv == null
    ? "—"
    : spent
    ? `−${amountLabel}`
    : `+${amountLabel}`;
  const subtitle =
    failed && failureReason
      ? failureReason
      : event
      ? entry.origin !== WALLET_ACTIVITY_ORIGIN
        ? entry.origin
        : null
      : item && shown?.app
      ? shown.app
      : null;

  const entryKey = rowKey ?? activityEntryKey(entry);
  const rec = entry.txid ? getTxByTxid(entry.txid) : null;
  const settlementLabel = inFlightSettlementLabel({
    status: entry.status,
    txid: entry.txid,
    chainProof: rec?.chainProof,
    minedHeight: rec?.minedHeight,
  });
  const pendingLabel = settlementLabel ?? "Signed";

  return (
    <li
      data-activity-key={entryKey}
      data-activity-newest={newest ? "" : undefined}
      data-activity-pending={showPending ? "" : undefined}
      data-activity-failed={failed ? "" : undefined}
    >
      <button
        type="button"
        className={`history-row history-row-btn${failed ? " is-failed" : ""}`}
        onClick={() => {
          if (entry.id === LIVE_OUTBOUND_ID) return;
          if (utxoHeal) return;
          playWalletSound("soft");
          openPaymentDetails(entry.id);
        }}
      >
        <HistoryIconCluster
          entry={entry}
          assets={assets}
          batch={batch}
          verifying={verifying}
        />
        <div className="history-body history-progress-body">
          <strong className="history-title" title={batchNames ?? undefined}>
            {title}
          </strong>
          {subtitle ? (
            <span className="history-when" title={subtitle}>
              {subtitle}
            </span>
          ) : null}
        </div>
        <div className="history-amount-block">
          <span
            className={
              utxoHealDone || moneyLabel
                ? "history-amount"
                : event || item || failed || approving
                ? "history-amount history-amount-item"
                : "history-amount"
            }
            title={amountLabel}
          >
            {failed ? "Failed" : signed}
          </span>
          {showWhen ? (
            <span className="history-when">
              {showPending ? pendingLabel : formatWhen(entry.at)}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  );
}

/** Related app mark, opposite the transaction action badge. */
export function HistoryAppBadge({ entry }: { entry: ActivityEntry }) {
  if (
    isEventActivity(entry) ||
    !entry.origin ||
    entry.origin === WALLET_ACTIVITY_ORIGIN
  ) {
    return null;
  }
  const name = appDisplayName(entry.origin);
  return (
    <span
      className="history-app-badge"
      aria-label={`App: ${name}`}
      title={name}
    >
      <AppAvatar origin={entry.origin} name={name} size="sm" embedded />
    </span>
  );
}

function eventAmountLabel(entry: ActivityEntry): string {
  const m = entry.method;
  if (m === "utxo-heal") return "Heal";
  if (m === "connect" || m === "approve") return "Allowed";
  if (m === "connect-deny" || m === "deny") return "Denied";
  if (m === "disconnect") return "Removed";
  if (m === "add-friend") return "Friend";
  if (m === "forget-collectable") return "Forgot";
  if (m === "market-list") return "Listed";
  if (m === "market-cancel") return "Cancelled";
  return "Action";
}

function eventIcon(entry: ActivityEntry) {
  const m = entry.method;
  if (m === "utxo-heal") return <RefreshIcon size={18} />;
  if (m === "add-friend") return <FriendsIcon size={18} />;
  if (
    m.startsWith("connect") ||
    m === "disconnect" ||
    m === "approve" ||
    m === "deny"
  ) {
    return <AppsIcon size={18} />;
  }
  return <ActivityIcon size={18} />;
}

type FeedProps = {
  chain?: Chain;
  /** Records shown after composing a full transaction window. */
  limit?: number;
  title?: string;
  embedded?: boolean;
  emptyLabel?: string;
  showCount?: boolean;
  showFilters?: boolean;
  showWhen?: boolean;
  /** Footer CTA under the list (dashboard recent activity). */
  viewAllLabel?: string;
  onViewAll?: () => void;
};

function useActivityFeed(limit: number) {
  const [entries, setEntries] = useState<ActivityEntry[]>(
    () => readActivityFeed(limit).entries
  );
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() =>
    getCachedUsdPerBsv()
  );
  const [currency, setCurrency] = useState<DisplayCurrency>(() =>
    getDisplayCurrency()
  );
  const [origins, setOrigins] = useState<PaymentOriginOption[]>(
    () => readActivityFeed(limit).origins
  );
  const [payment, setPayment] = useState<PaymentProgress>(() =>
    getPaymentProgress()
  );

  useEffect(() => subscribeUsdRate(setUsdPerBsv), []);
  useEffect(() => subscribeDisplayCurrency(setCurrency), []);
  useEffect(() => subscribePaymentProgress(setPayment), []);
  useEffect(() => {
    const refresh = () => {
      archiveOversizedBulkSendDebris()
      expireStaleInboundPending();
      expireStaleOutboundPending();
      invalidateActivityFeed(limit);
      const snapshot = readActivityFeed(limit);
      setEntries(snapshot.entries);
      setOrigins(snapshot.origins);
    };
    refresh();
    const unsubActivity = subscribeAppActivity(refresh);
    const unsubApps = subscribeConnectedApps(refresh);
    let assetTimer = 0;
    const refreshAfterAssetPaint = () => {
      // Authenticity, icon, and encoding upgrades can arrive in short bursts.
      // The feed only needs their settled projection; rebuilding it for every
      // intermediate cache paint used to interrupt foreground input.
      window.clearTimeout(assetTimer);
      assetTimer = window.setTimeout(refresh, 280);
    };
    const unsubItems = subscribeCollectables(refreshAfterAssetPaint);
    const unsubTokens = subscribeFungibles(refreshAfterAssetPaint);
    return () => {
      window.clearTimeout(assetTimer);
      unsubActivity();
      unsubApps();
      unsubItems();
      unsubTokens();
    };
  }, [limit]);

  const merged = useMemo(
    () => mergeLiveOutbound(entries, payment),
    [entries, payment]
  );

  return { entries: merged, usdPerBsv, currency, origins };
}

/**
 * Keep newest rows in view when the feed is at its default (top) scroll.
 *
 * The flash announces a transaction that just landed and has not been shown
 * before, decided from the durable seen record keyed by event identity plus the
 * entry's own age. Opening Activity, flicking between tabs, or reopening the app
 * all re-mount the feed over entries the user has already read, and none of
 * those are arrivals.
 */
function useStickNewestToTop(
  listRef: RefObject<HTMLElement | null>,
  newest: { key: string; at: number } | undefined,
  shownKeys: readonly string[]
) {
  const stickToTopRef = useRef(true);
  // Stable fingerprint so collectables healing the feed cannot re-fire the
  // announce effect and restart the top-row animation on every inventory tick.
  const shownFingerprint = shownKeys.join("\0");

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToTopRef.current = el.scrollTop <= 24;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [listRef]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!newest) {
      if (shownKeys.length > 0) markActivitySeen(shownKeys);
      return;
    }

    const fresh = shouldAnnounceActivity(newest.key, newest.at);
    // Whether we flash or not, this key is decided for the session — tab
    // switches must not re-evaluate a tip still inside the recency window.
    noteActivityAnnounced(newest.key);
    markActivitySeen(shownKeys);
    if (!fresh || !stickToTopRef.current) return;

    let clearFresh: number | undefined;
    const pin = () => {
      el.scrollTop = 0;
      stickToTopRef.current = true;
      const row = el.querySelector<HTMLElement>(
        `[data-activity-key="${CSS.escape(newest.key)}"]`
      );
      if (!row) return;
      row.classList.remove("is-fresh");
      // Restart CSS animation if another arrival lands quickly.
      void row.offsetWidth;
      row.classList.add("is-fresh");
      // Drop the class when the animation ends. Leaving `is-fresh` on a
      // keep-alive Activity panel restarts the highlight every time the tab is
      // un-hidden — that was the remaining top-row flash.
      window.clearTimeout(clearFresh);
      clearFresh = window.setTimeout(() => {
        row.classList.remove("is-fresh");
      }, 780);
    };
    pin();
    const raf = window.requestAnimationFrame(pin);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(clearFresh);
    };
    // shownFingerprint stands in for shownKeys identity without array churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRef, newest?.key, newest?.at, shownFingerprint]);
}

function useContinuousRecordKeys(records: readonly ActivityRecord[]): string[] {
  const prevRef = useRef<{ stable: string; entry: ActivityEntry }[]>([]);
  const taken = new Set<string>();
  const next: { stable: string; entry: ActivityEntry }[] = [];
  const keys: string[] = [];
  for (const record of records) {
    const found = prevRef.current.find(
      (row) =>
        !taken.has(row.stable) &&
        activityEntryContinues(row.entry, record.subject)
    );
    let stable = found?.stable ?? record.key;
    if (taken.has(stable)) stable = record.key;
    taken.add(stable);
    keys.push(stable);
    next.push({ stable, entry: record.subject });
  }
  prevRef.current = next;
  return keys;
}

export function ActivityFeed({
  limit = 40,
  title = "Recent activity",
  embedded = false,
  emptyLabel = "No activity yet",
  showCount = true,
  showFilters = false,
  showWhen = false,
  viewAllLabel,
  onViewAll,
}: FeedProps) {
  const { entries, usdPerBsv, currency, origins } = useActivityFeed(
    ACTIVITY_COMPOSE_WINDOW,
  );
  const [filters, setFilters] = useState<PaymentFilters>(
    DEFAULT_PAYMENT_FILTERS
  );
  const [verification, setVerification] = useState(() =>
    getVerificationProgress()
  );
  const [phraseImport, setPhraseImport] = useState(() =>
    peekPhraseItemMigrateCursor()
  );
  const listRef = useRef<HTMLUListElement>(null);
  const scrolling = useScrollIdle(listRef);
  useEffect(() => subscribeVerificationProgress(setVerification), []);
  useEffect(() => subscribePhraseItemMigrateCursor(setPhraseImport), []);
  const visiblePhraseImport = phraseImportBelongsToWallet(
    phraseImport,
    getActiveWallet()?.identityKey
  )
    ? phraseImport
    : null;

  const filtered = useMemo(
    () => (showFilters ? filterPaymentActivity(entries, filters) : entries),
    [entries, filters, showFilters]
  );
  // One transaction is one record: a listing and the item it created, a purchase
  // and what it bought, a sale and its proceeds.
  const records = useMemo(
    () => previewActivityRecords(filtered, limit),
    [filtered, limit],
  );
  const recordKeys = useContinuousRecordKeys(records);
  const shownCount = useChunkedCount(records.length, RENDER_CHUNK, scrolling);
  const windowed = useWindowedRange({
    total: shownCount,
    itemExtent: 72,
    overscan: 10,
    rowSelector: '[data-activity-key]:not([data-aeon-scope="phrase-import"])',
    scrollRef: listRef,
  });
  const visibleRecords = records.slice(windowed.start, windowed.end);
  const newest = useMemo(() => {
    const top = records[0];
    const key = recordKeys[0];
    return top && key ? { key, at: top.subject.at } : undefined;
  }, [records, recordKeys]);
  const shownKeys = useMemo(
    () => records.flatMap((record) => record.entries.map(activityEntryKey)),
    [records]
  );
  useStickNewestToTop(listRef, newest, shownKeys);

  const filtersActive =
    filters.kind !== DEFAULT_PAYMENT_FILTERS.kind ||
    filters.time !== DEFAULT_PAYMENT_FILTERS.time ||
    filters.origin !== DEFAULT_PAYMENT_FILTERS.origin ||
    filters.status !== DEFAULT_PAYMENT_FILTERS.status;

  // Count from the store, not the capped feed. Transfers the recipient can
  // still broadcast are excluded. Signed sends whose inputs are still unspent
  // stay in the count; the confirm copy and bulk clear keep them until spent.
  const failedCount = useMemo(
    () =>
      showFilters
        ? countFailedActivity((entry) => isCounterpartySettlePending(entry))
        : 0,
    [entries, showFilters]
  );
  const [clearingFailed, setClearingFailed] = useState(false);
  const [rebroadcastingFailed, setRebroadcastingFailed] = useState(false);
  const [rebroadcastCount, setRebroadcastCount] = useState(0);
  const [clearableCount, setClearableCount] = useState(0);
  const [publishingPending, setPublishingPending] = useState(false);
  const pendingPeerCount = useMemo(
    () => (showFilters ? countUnresolvedPeerTransfers() : 0),
    [entries, showFilters]
  );

  useEffect(() => {
    if (!showFilters || failedCount === 0) {
      setRebroadcastCount(0);
      setClearableCount(0);
      return;
    }
    const chain = getActiveWallet()?.chain;
    if (!chain) {
      setRebroadcastCount(0);
      setClearableCount(0);
      return;
    }
    let cancelled = false;
    void Promise.all([
      countRebroadcastableFailedSpends(chain),
      countClearableFailedSpends(chain),
    ]).then(([rebroadcastable, clearable]) => {
      if (!cancelled) {
        setRebroadcastCount(rebroadcastable);
        setClearableCount(clearable);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entries, showFilters, failedCount]);

  const rebroadcastFailed = async () => {
    if (rebroadcastingFailed || rebroadcastCount === 0) return;
    const confirmed = window.confirm(
      `Rebroadcast ${rebroadcastCount} signed failed send${
        rebroadcastCount === 1 ? "" : "s"
      }? This re-submits the original transactions — it does not create new spends.`
    );
    if (!confirmed) return;
    setRebroadcastingFailed(true);
    try {
      const { rebroadcasted, skipped, failed, errors } =
        await rebroadcastAllFailedSpends();
      if (rebroadcasted > 0) {
        toastSuccess(
          "Rebroadcast sent",
          `Submitted ${rebroadcasted} signed transfer${
            rebroadcasted === 1 ? "" : "s"
          } to the network.${
            skipped > 0
              ? ` Skipped ${skipped} that need a fresh send or are still live.`
              : ""
          }`
        );
      } else if (failed > 0) {
        toastError(
          "Rebroadcast failed",
          errors[0] ?? "No signed transfers could be rebroadcast."
        );
      } else {
        toastError(
          "Nothing to rebroadcast",
          "No failed sends have a signed transfer ready to resubmit."
        );
      }
    } catch (err) {
      toastError(
        "Rebroadcast failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setRebroadcastingFailed(false);
    }
  };

  const clearFailed = async () => {
    if (clearingFailed || clearableCount === 0) return;
    const confirmed = window.confirm(
      `Clear ${clearableCount} failed send${
        clearableCount === 1 ? "" : "s"
      } from Activity? Unsigned failed sends are removed. Signed sends that never reached the chain can be cleared too. A signed send whose inputs already spent on chain is dropped from history only — it does not undo the spend.`
    );
    if (!confirmed) return;
    setClearingFailed(true);
    try {
      const { removed, kept } = await clearAllFailedSpends();
      if (removed === 0 && kept > 0) {
        toastError(
          "Nothing cleared",
          `${kept} failed send${
            kept === 1 ? "" : "s"
          } could not be cleared — chain status was unavailable, or the recipient can still broadcast a live transfer.`
        );
      } else {
        toastSuccess(
          "Cleared failed sends",
          `Removed ${removed} row${removed === 1 ? "" : "s"} from Activity.${
            kept > 0
              ? ` Kept ${kept} still live (coins unspent, or the recipient can still broadcast).`
              : ""
          }`
        );
      }
    } catch (err) {
      toastError(
        "Clear failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setClearingFailed(false);
    }
  };

  const publishPending = async () => {
    if (publishingPending || pendingPeerCount === 0) return;
    setPublishingPending(true);
    try {
      const result = await publishUnresolvedPeerTransfers();
      if (result.published > 0 || result.confirmed > 0) {
        toastSuccess(
          "Pending transfers submitted",
          `${result.published} original signed transaction${
            result.published === 1 ? "" : "s"
          } published${result.confirmed ? `; ${result.confirmed} already confirmed` : ""}.`
        );
      } else {
        toastError(
          "No transfers submitted",
          result.errors[0] ?? "The signed transaction bodies are not available yet."
        );
      }
    } finally {
      setPublishingPending(false);
    }
  };

  // Drop a selected app filter if that origin disappears.
  useEffect(() => {
    if (filters.origin === "all") return;
    if (origins.some((o) => o.id === filters.origin)) return;
    setFilters((prev) => ({ ...prev, origin: "all" }));
  }, [origins, filters.origin]);

  const body =
    filtered.length === 0 && !visiblePhraseImport ? (
      <EmptyState
        icon={<ActivityIcon size={28} />}
        title={entries.length === 0 ? emptyLabel : "Nothing matches"}
        body={
          entries.length === 0
            ? "Sends, receives, connections, and other wallet actions show up here."
            : filters.status === "failed"
            ? "No failed sends match these filters."
            : "Try clearing filters to see more activity."
        }
      />
    ) : (
      <ul className="history-list" ref={listRef}>
        {windowed.padStart > 0 ? (
          <li
            className="history-window-pad"
            data-ui-feed-pad="start"
            style={{ height: windowed.padStart }}
            aria-hidden
          />
        ) : null}
        {visiblePhraseImport ? (
          <PendingPhraseImportRow cursor={visiblePhraseImport} />
        ) : null}
        {visibleRecords.map((record, index) => (
          <HistoryRow
            key={recordKeys[windowed.start + index] ?? record.key}
            rowKey={recordKeys[windowed.start + index] ?? record.key}
            entry={record.subject}
            amountEntry={record.money}
            assets={record.assets}
            batch={record.batch}
            currency={currency}
            usdPerBsv={usdPerBsv}
            showWhen={showWhen}
            newest={windowed.start === 0 && index === 0}
            verifying={
              !(
                record.subject.item?.outpoint &&
                isItemProven(record.subject.item.outpoint)
              ) &&
              (isPendingActivity(record.subject) ||
                isOutpointVerifying(
                  record.subject.item?.outpoint,
                  verification
                ))
            }
          />
        ))}
        {windowed.padEnd > 0 ? (
          <li
            className="history-window-pad"
            data-ui-feed-pad="end"
            style={{ height: windowed.padEnd }}
            aria-hidden
          />
        ) : null}
        {viewAllLabel && onViewAll ? (
          <li className="history-view-all-row">
            <button
              type="button"
              className="history-view-all"
              onClick={() => {
                playWalletSound("soft");
                onViewAll();
              }}
            >
              {viewAllLabel}
            </button>
          </li>
        ) : null}
      </ul>
    );

  const head = (
    <div className="connected-panel-head">
      <h2>{title}</h2>
      <div className="connected-panel-head-actions">
        {showCount ? (
          <span className="connected-count">{filtered.length}</span>
        ) : null}
        {showFilters && pendingPeerCount > 0 ? (
          <button
            type="button"
            className="activity-rebroadcast-failed"
            disabled={publishingPending}
            title="Publish original signed peer transfers still waiting on recipients"
            onClick={() => {
              playWalletSound("soft");
              void publishPending();
            }}
          >
            {publishingPending
              ? "Publishing…"
              : `Publish signed ${pendingPeerCount}`}
          </button>
        ) : null}
        {showFilters && rebroadcastCount > 0 ? (
          <button
            type="button"
            className="activity-rebroadcast-failed"
            disabled={rebroadcastingFailed}
            title="Rebroadcast signed failed sends"
            onClick={() => {
              playWalletSound("soft");
              void rebroadcastFailed();
            }}
          >
            {rebroadcastingFailed
              ? "Rebroadcasting…"
              : `Rebroadcast ${rebroadcastCount}`}
          </button>
        ) : null}
        {showFilters && clearableCount > 0 ? (
          <button
            type="button"
            className="activity-clear-failed"
            disabled={clearingFailed}
            title="Remove failed sends that are safe to drop from Activity"
            onClick={() => {
              playWalletSound("soft");
              void clearFailed();
            }}
          >
            {clearingFailed ? "Clearing…" : `Clear ${clearableCount} failed`}
          </button>
        ) : null}
        {showFilters ? (
          <TopBarPopover
            ariaLabel="Activity filters"
            title="Filters"
            className="activity-filter-popover"
            triggerClassName="activity-filter-toggle"
            contentClassName="activity-filter-popover-content"
            active={filtersActive}
            onTrigger={() => playWalletSound("soft")}
            trigger={
              <>
                <FilterIcon size={16} />
                {filtersActive ? (
                  <span className="activity-filter-dot" aria-hidden />
                ) : null}
              </>
            }
          >
            <PaymentFiltersPanel
              id="activity-filters"
              value={filters}
              origins={origins}
              onChange={setFilters}
            />
          </TopBarPopover>
        ) : null}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div
        className={showFilters ? "history-embedded history-with-filters" : "history-embedded"}
        data-aeon-scope="activity-feed"
      >
        {head}
        {body}
      </div>
    );
  }

  return (
    <section className="history-panel panel" data-aeon-scope="recent-activity">
      {head}
      {body}
    </section>
  );
}

/** Side column feed. */
export function RecentActivityPanel({ chain }: { chain?: Chain }) {
  return (
    <ActivityFeed
      chain={chain}
      title="Your activity"
      limit={15}
      showCount={false}
      viewAllLabel="View full activity"
      onViewAll={() => setNavSection("activity")}
    />
  );
}

/** Full activity tab. */
export function TransactionsPanel({ chain }: { chain?: Chain }) {
  return (
    <ActivityFeed
      chain={chain}
      title="Activity"
      limit={200}
      embedded
      emptyLabel="No activity yet"
      showCount={false}
      showFilters
      showWhen
    />
  );
}
