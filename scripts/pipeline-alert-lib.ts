/**
 * Pure decision logic for the pipeline stall alert.
 *
 * Split from `pipeline-alert.ts` so the rules are testable without a live
 * watcher: the runner does I/O, everything here is a pure function over an
 * already-read `mls-watch-state.json` plus the alert's own sample history.
 * Time is always an explicit argument.
 *
 * WHAT THIS TARGETS — the two real stalls, not invented failure modes:
 *
 *   2026-08-10 (4 days unnoticed): the watcher stayed up, its heartbeat kept
 *   updating and `loggedIn` stayed true, while a Supabase row cap caused every
 *   ready listing to fail its write and get re-queued. Nothing posted for four
 *   days. The tell was `action: "failed"` repeating, not liveness.
 *
 *   2026-09-10: `looksLoggedIn` reported a live session while parked on the SSO
 *   login page. The heartbeat said `loggedIn=true`; the tell was
 *   `hotSheet=0 parsed=0/0`.
 *
 * Hence: every check here reads an *outcome*, never a liveness flag.
 */

export type QueueRun = {
  ok?: boolean;
  processed?: number;
  /**
   * MISLEADING FIELD NAME — this is `survivors.length`, i.e. items written back
   * to the queue, which is normal holds PLUS real failures. On 2026-10-12 it
   * read 62 while every one of those 62 was a healthy
   * `hold_missing_str_approval`. Never alert on this directly; use
   * `deriveFailures()`.
   */
  failed?: number;
  actionCounts?: Record<string, number>;
};

export type WatchState = {
  updatedAt?: string;
  mode?: string;
  loggedIn?: boolean;
  totalHotSheetListings?: number;
  resolvedHotSheetListings?: number;
  queueDepth?: number;
  lastQueueRun?: QueueRun;
  twoFactorAlertActive?: boolean;
};

/** One observation, persisted so later runs can reason about persistence. */
export type Sample = {
  at: string;
  stateUpdatedAt: string;
  queueDepth: number;
  hotSheet: number;
  loggedIn: boolean;
  holds: number;
  failures: number;
  posted: number;
};

export type Finding = { key: string; title: string; detail: string };

export const HOLD_ACTION = "hold_missing_str_approval";
const EXPLICIT_FAILURE_ACTIONS = ["failed", "skipped_listing_write_failed"];

/**
 * Real failures in a queue run, separated from normal holds.
 *
 * Two independent derivations, taking the larger:
 *  - explicit: the failure action names the processor emits.
 *  - derived: `survivors - holds`. Since an item is only written back to the
 *    queue because it is held or because it failed, the difference *is* the
 *    failure count. This keeps working if a failure action is renamed or added.
 */
export function deriveFailures(run: QueueRun | undefined) {
  const counts = run?.actionCounts || {};
  const explicit = EXPLICIT_FAILURE_ACTIONS.reduce((n, k) => n + (counts[k] || 0), 0);
  const holds = counts[HOLD_ACTION] || 0;
  const survivors = typeof run?.failed === "number" ? run.failed : 0;
  const derived = Math.max(0, survivors - holds);
  return { explicit, derived, holds, survivors, failures: Math.max(explicit, derived) };
}

export function mountainHour(now: Date) {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", hour12: false }).format(now),
  );
}

/** Mirrors `isWithinScanWindow` in watch-mls.ts: `hour >= start && hour < end`, Mountain Time. */
export function isWithinScanWindow(now: Date, startHour: number, endHour: number) {
  const hour = mountainHour(now);
  return hour >= startHour && hour < endHour;
}

/**
 * Start of today's scan window, in absolute terms.
 *
 * Needed so staleness is measured from when the watcher was *due* to run. At
 * 07:05 the newest heartbeat is legitimately from ~18:5x yesterday; measuring
 * raw age would call that a 12-hour stall every single morning.
 */
export function windowStartToday(now: Date, startHour: number) {
  // Derive the zone's current UTC offset from the zone itself: format `now` in
  // Mountain, re-read those wall-clock fields as if they were UTC, and the
  // difference from `now` is the offset. DST-safe without hardcoding -6/-7.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  const hh = get("hour") === "24" ? "00" : get("hour"); // en-CA can emit hour 24
  const asIfUtc = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}:${get("second")}Z`);
  const offsetMs = asIfUtc - now.getTime();
  const mtMidnightUtc = Date.parse(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`) - offsetMs;
  return new Date(mtMidnightUtc + startHour * 3_600_000);
}

export function sampleFrom(state: WatchState, now: Date): Sample {
  const { failures, holds } = deriveFailures(state.lastQueueRun);
  return {
    at: now.toISOString(),
    stateUpdatedAt: String(state.updatedAt || ""),
    queueDepth: Number(state.queueDepth || 0),
    hotSheet: Number(state.totalHotSheetListings || 0),
    loggedIn: state.loggedIn !== false,
    holds,
    failures,
    posted: Number(state.lastQueueRun?.actionCounts?.evaluation_posted || 0),
  };
}

function minutesBetween(a: number, b: number) {
  return Math.abs(a - b) / 60_000;
}

export type DetectConfig = {
  intervalSeconds: number;
  startHour: number;
  endHour: number;
  scanEnabled: boolean;
  /** Heartbeat is stale past this multiple of the cycle interval. */
  staleCycles: number;
  /** Consecutive bad samples required before a persistence check fires. */
  minSamples: number;
};

/**
 * Apply every check. `samples` must be oldest-first and already include the
 * current observation as its last element.
 */
export function detect(opts: { state: WatchState; samples: Sample[]; now: Date; config: DetectConfig }): Finding[] {
  const { state, samples, now, config } = opts;
  const findings: Finding[] = [];
  const inWindow = isWithinScanWindow(now, config.startHour, config.endHour);
  const current = samples[samples.length - 1];

  // --- 1. Heartbeat stale -------------------------------------------------
  // The watcher sleeps outside its window and when scanning is disabled, so
  // staleness only means anything inside an active window.
  if (config.scanEnabled && inWindow) {
    const stateMs = Date.parse(state.updatedAt || "") || 0;
    const dueFrom = Math.max(stateMs, windowStartToday(now, config.startHour).getTime());
    const staleMin = minutesBetween(now.getTime(), dueFrom);
    const thresholdMin = (config.intervalSeconds * config.staleCycles) / 60;
    if (staleMin > thresholdMin) {
      findings.push({
        key: "heartbeat-stale",
        title: "MLS watcher has stopped cycling",
        detail:
          `No watcher heartbeat for ${Math.round(staleMin)} min (threshold ${Math.round(thresholdMin)} min = ` +
          `${config.staleCycles}× the ${Math.round(config.intervalSeconds / 60)} min cycle). ` +
          `Last state write: ${state.updatedAt || "never"}. Check \`launchctl list | grep longitude.pre-bot\` ` +
          "and `~/Library/Logs/longitude-pre-bot/str-mls-watch.log` — note the process can be alive and still not working.",
      });
    }
  }

  // --- 2. Real queue failures --------------------------------------------
  const f = deriveFailures(state.lastQueueRun);
  if (f.failures > 0) {
    findings.push({
      key: "queue-failures",
      title: `${f.failures} listing(s) failing to post`,
      detail:
        `The queue retained ${f.survivors} item(s): ${f.holds} normal hold(s) and ${f.failures} failure(s). ` +
        `This is the 2026-08-10 signature — ready listings failing their write and re-queueing every cycle, ` +
        "which ran 4 days unnoticed. Check `~/Library/Logs/longitude-pre-bot/str-mls-watch.log` for the per-listing error.",
    });
  }

  // --- 3. The queue run itself errored -----------------------------------
  if (state.lastQueueRun && state.lastQueueRun.ok === false) {
    findings.push({
      key: "queue-run-error",
      title: "Queue processor returned not-ok",
      detail: `\`lastQueueRun.ok\` is false in \`mls-watch-state.json\`. Nothing in that cycle was processed.`,
    });
  }

  // --- 4. Hot sheet persistently empty (the 2026-09-10 signature) --------
  if (config.scanEnabled && inWindow && samples.length >= config.minSamples) {
    const recent = samples.slice(-config.minSamples);
    if (recent.every((s) => s.hotSheet === 0)) {
      const span = Math.round(minutesBetween(Date.parse(recent[0].at), now.getTime()));
      findings.push({
        key: "hot-sheet-empty",
        title: "Hot sheet has returned zero listings",
        detail:
          `${recent.length} consecutive checks over ${span} min saw 0 hot-sheet listings. ` +
          "On 2026-09-10 this was the only tell while the heartbeat still claimed `loggedIn=true` — " +
          "the session was parked on the SSO login page. Credential or login-detection problem, " +
          "not an empty market.",
      });
    }
  }

  // --- 5. Logged out, persistently ---------------------------------------
  if (samples.length >= config.minSamples) {
    const recent = samples.slice(-config.minSamples);
    if (recent.every((s) => !s.loggedIn)) {
      findings.push({
        key: "logged-out",
        title: "Watcher reports logged out of FlexMLS",
        detail: `\`loggedIn\` has been false for ${recent.length} consecutive checks. A credential change also ` +
          "requires deleting the Playwright profile under `.playwright/` — a stale profile keeps the old session.",
      });
    }
  }

  // --- 6. 2FA gate ---------------------------------------------------------
  if (state.twoFactorAlertActive === true) {
    findings.push({
      key: "two-factor-active",
      title: "FlexMLS is waiting on a 2FA code",
      detail: "`twoFactorAlertActive` is set — the watcher cannot log in until the code is submitted " +
        "(`npm run workflow:submit-mls-2fa`). Scraping is stalled until then.",
    });
  }

  void current;
  return findings;
}

/**
 * Per-signal dedup with a re-alert cooldown.
 *
 * A cooldown rather than alert-once, deliberately: the 2026-08-10 stall lasted
 * four days, and a single message that scrolls away is how it stayed unnoticed.
 * A persisting fault should keep nagging, just not every cycle.
 */
export function shouldAlert(lastAlertedIso: string | undefined, now: Date, cooldownMinutes: number) {
  if (!lastAlertedIso) return true;
  const last = Date.parse(lastAlertedIso);
  if (!last) return true;
  return minutesBetween(now.getTime(), last) >= cooldownMinutes;
}

/** Keep the sample ring bounded. */
export function pruneSamples(samples: Sample[], now: Date, keepHours: number) {
  return samples.filter((s) => minutesBetween(Date.parse(s.at), now.getTime()) <= keepHours * 60);
}
