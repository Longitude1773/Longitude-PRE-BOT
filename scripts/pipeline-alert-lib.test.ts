import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOLD_ACTION,
  detect,
  deriveFailures,
  isWithinScanWindow,
  mountainHour,
  pruneSamples,
  sampleFrom,
  shouldAlert,
  windowStartToday,
  type DetectConfig,
  type Sample,
  type WatchState,
} from "./pipeline-alert-lib.ts";

// 2026-10-12 20:30Z = 14:30 Mountain (MDT, inside the 07–19 window).
const NOW = new Date("2026-10-12T20:30:00.000Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const CONFIG: DetectConfig = {
  intervalSeconds: 1800,
  startHour: 7,
  endHour: 19,
  scanEnabled: true,
  staleCycles: 2.5,
  minSamples: 3,
};

function state(over: Partial<WatchState> = {}): WatchState {
  return {
    updatedAt: minsAgo(10),
    mode: "watching",
    loggedIn: true,
    totalHotSheetListings: 23,
    queueDepth: 77,
    lastQueueRun: { ok: true, processed: 77, failed: 62, actionCounts: { [HOLD_ACTION]: 62, skip_not_str_market: 3 } },
    twoFactorAlertActive: false,
    ...over,
  };
}

function samples(n: number, over: Partial<Sample> = {}): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    at: minsAgo((n - 1 - i) * 15),
    stateUpdatedAt: minsAgo((n - 1 - i) * 15 + 2),
    queueDepth: 77,
    hotSheet: 23,
    loggedIn: true,
    holds: 62,
    failures: 0,
    posted: 0,
    ...over,
  }));
}

const run = (s: WatchState, smp: Sample[] = samples(3), cfg: Partial<DetectConfig> = {}) =>
  detect({ state: s, samples: smp, now: NOW, config: { ...CONFIG, ...cfg } });
const keys = (s: WatchState, smp?: Sample[], cfg?: Partial<DetectConfig>) => run(s, smp, cfg).map((f) => f.key);

// --- the false positive that would have made this alert useless ------------

test("healthy steady state produces no findings", () => {
  assert.deepEqual(keys(state()), []);
});

test("62 normal holds are NOT a failure (the 2026-10-12 trap)", () => {
  // `lastQueueRun.failed` is survivors = holds + failures. On 2026-10-12 it read
  // 62 while all 62 were healthy holds. Alerting on it directly would fire daily.
  const s = state({ lastQueueRun: { ok: true, processed: 79, failed: 62, actionCounts: { [HOLD_ACTION]: 62 } } });
  assert.equal(deriveFailures(s.lastQueueRun).failures, 0);
  assert.equal(keys(s).includes("queue-failures"), false);
});

// --- deriveFailures --------------------------------------------------------

test("deriveFailures: survivors minus holds yields the failure count", () => {
  const f = deriveFailures({ failed: 20, actionCounts: { [HOLD_ACTION]: 15 } });
  assert.equal(f.holds, 15);
  assert.equal(f.derived, 5);
  assert.equal(f.failures, 5);
});

test("deriveFailures: explicit failure actions are counted", () => {
  const f = deriveFailures({ failed: 3, actionCounts: { failed: 2, skipped_listing_write_failed: 1 } });
  assert.equal(f.explicit, 3);
  assert.equal(f.failures, 3);
});

test("deriveFailures: takes the larger of explicit and derived", () => {
  // Survivors says 10 beyond holds, but only 2 carry a known failure action —
  // trust the larger so a renamed action cannot hide a stall.
  const f = deriveFailures({ failed: 12, actionCounts: { [HOLD_ACTION]: 2, failed: 2 } });
  assert.equal(f.derived, 10);
  assert.equal(f.failures, 10);
});

test("deriveFailures: tolerates a missing lastQueueRun", () => {
  assert.equal(deriveFailures(undefined).failures, 0);
});

// --- the 2026-08-10 signature ---------------------------------------------

test("detect: flags ready listings failing to post (2026-08-10)", () => {
  const s = state({
    queueDepth: 77,
    lastQueueRun: { ok: true, processed: 77, failed: 77, actionCounts: { [HOLD_ACTION]: 62, failed: 15 } },
  });
  const found = run(s).find((f) => f.key === "queue-failures");
  assert.ok(found, "expected queue-failures");
  assert.match(found.title, /15 listing\(s\) failing to post/);
});

test("detect: flags a not-ok queue run", () => {
  assert.ok(keys(state({ lastQueueRun: { ok: false } })).includes("queue-run-error"));
});

// --- the 2026-09-10 signature ---------------------------------------------

test("detect: flags a persistently empty hot sheet", () => {
  const found = run(state({ totalHotSheetListings: 0 }), samples(3, { hotSheet: 0 })).find(
    (f) => f.key === "hot-sheet-empty",
  );
  assert.ok(found, "expected hot-sheet-empty");
  assert.match(found.detail, /SSO login page/);
});

test("detect: a single empty hot-sheet reading is not enough", () => {
  const smp = samples(3);
  smp[smp.length - 1].hotSheet = 0; // only the newest
  assert.equal(keys(state({ totalHotSheetListings: 0 }), smp).includes("hot-sheet-empty"), false);
});

test("detect: empty hot sheet is ignored outside the scan window", () => {
  // 03:30 Mountain — the watcher is asleep, zero listings is expected.
  const night = new Date("2026-10-12T09:30:00.000Z");
  const found = detect({
    state: state({ totalHotSheetListings: 0, updatedAt: night.toISOString() }),
    samples: samples(3, { hotSheet: 0 }),
    now: night,
    config: CONFIG,
  });
  assert.equal(found.map((f) => f.key).includes("hot-sheet-empty"), false);
});

// --- heartbeat staleness ---------------------------------------------------

test("detect: flags a stale heartbeat inside the window", () => {
  const found = run(state({ updatedAt: minsAgo(200) })).find((f) => f.key === "heartbeat-stale");
  assert.ok(found, "expected heartbeat-stale");
  assert.match(found.detail, /threshold 75 min/);
});

test("detect: one skipped cycle is tolerated", () => {
  // 40 min with a 30 min cycle and 2.5x threshold (75 min) must stay quiet.
  assert.equal(keys(state({ updatedAt: minsAgo(40) })).includes("heartbeat-stale"), false);
});

test("detect: no stale alert outside the scan window", () => {
  const night = new Date("2026-10-12T09:30:00.000Z"); // 03:30 MT
  const found = detect({ state: state({ updatedAt: minsAgo(600) }), samples: samples(3), now: night, config: CONFIG });
  assert.equal(found.map((f) => f.key).includes("heartbeat-stale"), false);
});

test("detect: no stale alert when scanning is disabled", () => {
  assert.equal(
    keys(state({ updatedAt: minsAgo(600) }), samples(3), { scanEnabled: false }).includes("heartbeat-stale"),
    false,
  );
});

test("detect: early-morning heartbeat from last night is not a 12h stall", () => {
  // 07:20 MT. Newest heartbeat is 18:55 MT yesterday — raw age ~12h, but the
  // watcher was only due 20 min ago, so this must stay quiet.
  const morning = new Date("2026-10-12T13:20:00.000Z");
  const lastNight = new Date("2026-10-12T00:55:00.000Z").toISOString();
  const found = detect({
    state: state({ updatedAt: lastNight, totalHotSheetListings: 23 }),
    samples: samples(3),
    now: morning,
    config: CONFIG,
  });
  assert.equal(found.map((f) => f.key).includes("heartbeat-stale"), false);
});

// --- login / 2FA -----------------------------------------------------------

test("detect: flags a persistent logged-out state", () => {
  assert.ok(keys(state({ loggedIn: false }), samples(3, { loggedIn: false })).includes("logged-out"));
});

test("detect: a single logged-out reading is not enough", () => {
  const smp = samples(3);
  smp[smp.length - 1].loggedIn = false;
  assert.equal(keys(state({ loggedIn: false }), smp).includes("logged-out"), false);
});

test("detect: flags an active 2FA gate", () => {
  assert.ok(keys(state({ twoFactorAlertActive: true })).includes("two-factor-active"));
});

// --- window + time helpers -------------------------------------------------

test("isWithinScanWindow: matches watch-mls.ts (hour >= start && hour < end, MT)", () => {
  assert.equal(isWithinScanWindow(new Date("2026-10-12T20:30:00Z"), 7, 19), true); // 14:30 MT
  assert.equal(isWithinScanWindow(new Date("2026-10-12T09:30:00Z"), 7, 19), false); // 03:30 MT
  assert.equal(isWithinScanWindow(new Date("2026-10-13T01:30:00Z"), 7, 19), false); // 19:30 MT
  assert.equal(isWithinScanWindow(new Date("2026-10-13T00:30:00Z"), 7, 19), true); // 18:30 MT
});

test("mountainHour: converts to Mountain, not local", () => {
  assert.equal(mountainHour(new Date("2026-10-12T20:30:00Z")), 14);
});

test("windowStartToday: resolves 07:00 MT for the current Mountain date", () => {
  const w = windowStartToday(NOW, 7);
  assert.equal(mountainHour(w), 7);
  assert.ok(w.getTime() < NOW.getTime());
  assert.ok((NOW.getTime() - w.getTime()) / 3_600_000 < 24);
});

test("windowStartToday: still lands on 07:00 MT in winter (MST)", () => {
  const winter = new Date("2026-01-15T20:30:00Z"); // 13:30 MST
  assert.equal(mountainHour(windowStartToday(winter, 7)), 7);
});

// --- sampling, dedup, pruning ---------------------------------------------

test("sampleFrom: snapshots holds and failures separately", () => {
  const s = sampleFrom(
    state({ lastQueueRun: { ok: true, failed: 20, actionCounts: { [HOLD_ACTION]: 15, evaluation_posted: 2 } } }),
    NOW,
  );
  assert.equal(s.holds, 15);
  assert.equal(s.failures, 5);
  assert.equal(s.posted, 2);
  assert.equal(s.hotSheet, 23);
});

test("shouldAlert: fires when never alerted, then respects the cooldown", () => {
  assert.equal(shouldAlert(undefined, NOW, 360), true);
  assert.equal(shouldAlert(minsAgo(30), NOW, 360), false);
  assert.equal(shouldAlert(minsAgo(400), NOW, 360), true);
});

test("pruneSamples: drops observations past the retention window", () => {
  const kept = { ...samples(1)[0], at: minsAgo(60) };
  const dropped = { ...samples(1)[0], at: minsAgo(60 * 30) };
  assert.deepEqual(pruneSamples([dropped, kept], NOW, 24), [kept]);
});

test("detect: multiple simultaneous faults are all reported", () => {
  const s = state({
    updatedAt: minsAgo(300),
    loggedIn: false,
    totalHotSheetListings: 0,
    twoFactorAlertActive: true,
    lastQueueRun: { ok: false, failed: 30, actionCounts: { [HOLD_ACTION]: 10, failed: 20 } },
  });
  const k = keys(s, samples(3, { hotSheet: 0, loggedIn: false }));
  for (const expected of ["heartbeat-stale", "queue-failures", "queue-run-error", "hot-sheet-empty", "logged-out", "two-factor-active"]) {
    assert.ok(k.includes(expected), `missing ${expected}`);
  }
});
