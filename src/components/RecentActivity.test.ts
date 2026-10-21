import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ generation: 0, builds: 0 }));

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

const render = () =>
  renderToStaticMarkup(createElement(ActivityFeed, { limit: 7, showWhen: true }));

describe("activity feed cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    feed.generation += 1;
    feed.builds = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not rebuild the feed when time passes and nothing was written", () => {
    render();
    expect(feed.builds).toBe(1);
    vi.advanceTimersByTime(5 * 60_000);
    render();
    expect(feed.builds).toBe(1);
  });

  it("rebuilds once a write moves the generation", () => {
    render();
    feed.generation += 1;
    render();
    expect(feed.builds).toBe(2);
  });
});
