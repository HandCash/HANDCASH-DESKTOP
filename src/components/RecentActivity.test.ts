import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ generation: 0, builds: 0 }));
const account = vi.hoisted(() => ({ identityKey: "02".repeat(33) }));

vi.mock("../wallet/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wallet/session")>()),
  getActiveWallet: () => ({ identityKey: account.identityKey, chain: "main" }),
}));

vi.mock("../wallet/appActivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet/appActivity")>();
  return {
    ...actual,
    getActivityWriteGeneration: () => feed.generation,
    listActivityFeed: () => {
      feed.builds += 1;
      return [];
    },
  };
});

vi.mock("../wallet/paymentFilters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wallet/paymentFilters")>()),
  listPaymentOriginOptions: () => [],
}));

import { ActivityFeed } from "./RecentActivity";
import { activityFeedCache, openWalletCacheKey } from "../wallet/walletCaches";
import { ACTIVITY_COMPOSE_WINDOW } from "../wallet/activityRecords";

const render = () =>
  renderToStaticMarkup(createElement(ActivityFeed, { limit: 7, showWhen: true }));

/** What a mounted feed's effect does: load the open account's feed into the cache. */
const loadFeed = () =>
  activityFeedCache.read({ wallet: openWalletCacheKey(), limit: ACTIVITY_COMPOSE_WINDOW });

describe("activity feed cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    activityFeedCache.clear();
    account.identityKey = "02".repeat(33);
    feed.generation += 1;
    feed.builds = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the first feed once per mount", () => {
    render();
    expect(feed.builds).toBe(1);
  });

  it("serves a remount from the cache when time passes and nothing was written", async () => {
    await loadFeed();
    expect(feed.builds).toBe(1);
    vi.advanceTimersByTime(5 * 60_000);
    render();
    expect(feed.builds).toBe(1);
  });

  it("rebuilds once a write moves the generation", async () => {
    await loadFeed();
    feed.generation += 1;
    render();
    expect(feed.builds).toBe(2);
  });

  it("never serves one account's feed to another", async () => {
    await loadFeed();
    account.identityKey = "03".repeat(33);
    render();
    expect(feed.builds).toBe(2);
  });
});
