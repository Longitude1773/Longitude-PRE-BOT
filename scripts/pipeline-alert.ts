/**
 * Pipeline stall alert — the other half of the alerting story.
 *
 * `app-mention-alert.ts` watches the *conversation*, so it is blind to a watcher
 * that has quietly stopped producing: nobody mentions the bot, so nothing looks
 * wrong. This watches *outcomes* instead, and targets the two stalls that
 * actually happened:
 *
 *   2026-08-10 — ran 4 days unnoticed. The watcher stayed up, its heartbeat kept
 *   updating, `loggedIn` stayed true, and a Supabase row cap made every ready
 *   listing fail its write and re-queue. Nothing posted for four days.
 *
 *   2026-09-10 — `looksLoggedIn` reported a live session while parked on the SSO
 *   login page. The heartbeat said `loggedIn=true`; the only tell was
 *   `hotSheet=0 parsed=0/0`.
 *
 * Both were invisible to liveness: `launchctl list` showed healthy PIDs the
 * whole time. So every check here reads an outcome, never a liveness flag.
 *
 * Runs as its own short-lived process rather than inside the watcher, because
 * the watcher is the thing that can stall — code inside it cannot report its
 * own silence. Reads `data/inbox/mls-watch-state.json`, which the watcher
 * rewrites every cycle (a genuine heartbeat, unlike `gateway_state.json`, which
 * only writes on state changes).
 *
 * Usage:
 *   npx tsx scripts/pipeline-alert.ts                 # the scheduled check
 *   npx tsx scripts/pipeline-alert.ts --dry-run       # detect + print; posts nothing, writes nothing
 *   npx tsx scripts/pipeline-alert.ts --seed          # record a sample, alert on nothing
 *   npx tsx scripts/pipeline-alert.ts --cooldown 120
 *   npx tsx scripts/pipeline-alert.ts --dry-run \
 *     --state-file tmp/fixture.json --alert-state-file tmp/alert.json   # test against a fixture
 *
 * Env (all optional except the token):
 *   SLACK_BOT_TOKEN                   required
 *   PIPELINE_ALERT_CHANNEL_ID         where alerts post (default: SLACK_CHANNEL_ID)
 *   PIPELINE_ALERT_USER_ID            user to @mention (default: APP_MENTION_ALERT_USER_ID)
 *   PIPELINE_ALERT_COOLDOWN_MINUTES   re-alert interval while a fault persists (default: 360)
 *   PIPELINE_ALERT_STALE_CYCLES       heartbeat stale past N cycle intervals (default: 2.5)
 *   PIPELINE_ALERT_MIN_SAMPLES        consecutive bad samples before persistence checks fire (default: 3)
 *   FLEXMLS_WATCH_INTERVAL_SECONDS / FLEXMLS_SCAN_WINDOW_START_HOUR /
 *   FLEXMLS_SCAN_WINDOW_END_HOUR / FLEXMLS_SCAN_ENABLED — read so this agrees with the watcher
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  detect,
  pruneSamples,
  sampleFrom,
  shouldAlert,
  type Finding,
  type Sample,
  type WatchState,
} from "./pipeline-alert-lib.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// Load .env before importing slack.ts — it reads SLACK_BOT_TOKEN at import time.
try {
  for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      const key = line.slice(0, i).trim();
      if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
    }
  }
} catch {
  /* env supplied by the environment instead */
}

function flagValue(flag: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// `--state-file` / `--alert-state-file` exist so the whole runner can be
// exercised against a fixture without writing to the live watcher state, which
// the watcher rewrites every cycle and which `create-zillow-eval.ts` reads to
// decide whether the watcher is up.
const watchStateFile = resolve(repoRoot, flagValue("--state-file") || "data/inbox/mls-watch-state.json");
const stateFile = resolve(repoRoot, flagValue("--alert-state-file") || "data/inbox/pipeline-alert-state.json");

type AlertState = {
  updatedAt: string;
  samples: Sample[];
  alerted: Record<string, string>;
};

function argValue(flag: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const args = {
  dryRun: process.argv.includes("--dry-run"),
  seed: process.argv.includes("--seed"),
  cooldownMinutes: Number(argValue("--cooldown") || process.env.PIPELINE_ALERT_COOLDOWN_MINUTES || 360),
};

const config = {
  intervalSeconds: Number(process.env.FLEXMLS_WATCH_INTERVAL_SECONDS || 1800),
  startHour: Number(process.env.FLEXMLS_SCAN_WINDOW_START_HOUR || 7),
  endHour: Number(process.env.FLEXMLS_SCAN_WINDOW_END_HOUR || 19),
  scanEnabled: String(process.env.FLEXMLS_SCAN_ENABLED || "true").toLowerCase() !== "false",
  staleCycles: Number(process.env.PIPELINE_ALERT_STALE_CYCLES || 2.5),
  minSamples: Number(process.env.PIPELINE_ALERT_MIN_SAMPLES || 3),
};

function log(message: string) {
  console.log(`[${new Date().toISOString()}] pipeline-alert: ${message}`);
}

async function readState(): Promise<AlertState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as AlertState;
    return { updatedAt: parsed.updatedAt, samples: parsed.samples || [], alerted: parsed.alerted || {} };
  } catch {
    return null;
  }
}

async function writeState(s: AlertState) {
  await mkdir(resolve(repoRoot, "data/inbox"), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(s, null, 2)}\n`);
}

function formatAlert(findings: Finding[], mentionUser: string | undefined) {
  const lines: string[] = [];
  if (mentionUser) lines.push(`<@${mentionUser}>`);
  lines.push(
    findings.length === 1
      ? "🚨 *MLS pipeline problem*"
      : `🚨 *${findings.length} MLS pipeline problems*`,
  );
  for (const f of findings) {
    lines.push(`• *${f.title}*`);
    lines.push(`   ${f.detail}`);
  }
  lines.push(
    "_A process can be alive and still doing nothing — verify rows written and messages posted, not `launchctl` status._",
  );
  return lines.join("\n");
}

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not set.");

  const now = new Date();

  // The watcher state file missing entirely is itself a finding — it means the
  // watcher has never run on this machine, or its inbox was wiped.
  let watchState: WatchState | null = null;
  try {
    watchState = JSON.parse(await readFile(watchStateFile, "utf8")) as WatchState;
  } catch (error) {
    watchState = null;
    log(`WARN could not read ${watchStateFile}: ${error instanceof Error ? error.message : error}`);
  }

  const prior = await readState();
  const firstRun = prior === null;

  const findings: Finding[] = [];
  let sample: Sample | null = null;

  if (!watchState) {
    findings.push({
      key: "watch-state-missing",
      title: "No MLS watcher state file",
      detail:
        `\`data/inbox/mls-watch-state.json\` is missing or unreadable. The watcher writes it every cycle, ` +
        "so either it has never run here or the inbox was cleared. Check " +
        "`launchctl list | grep longitude.pre-bot` and `/tmp/str-mls-watch.log`.",
    });
  } else {
    sample = sampleFrom(watchState, now);
    const samples = pruneSamples([...(prior?.samples || []), sample], now, 24);
    findings.push(...detect({ state: watchState, samples, now, config }));
    log(
      `watcher: updatedAt=${watchState.updatedAt} mode=${watchState.mode} loggedIn=${watchState.loggedIn} ` +
        `hotSheet=${sample.hotSheet} queueDepth=${sample.queueDepth} holds=${sample.holds} ` +
        `failures=${sample.failures} posted=${sample.posted}`,
    );
  }

  const nextSamples = pruneSamples([...(prior?.samples || []), ...(sample ? [sample] : [])], now, 24);
  const nextState: AlertState = {
    updatedAt: now.toISOString(),
    samples: nextSamples,
    alerted: { ...(prior?.alerted || {}) },
  };

  log(`${findings.length} finding(s): ${findings.map((f) => f.key).join(", ") || "none"}`);

  // First run (or --seed) records a sample and alerts on nothing. Persistence
  // checks need history anyway, so a first run cannot judge them fairly.
  if (firstRun || args.seed) {
    const why = args.seed ? "--seed" : "no prior state file (first run)";
    log(`${why}: recorded a sample, alerting on none`);
    for (const f of findings) nextState.alerted[f.key] = now.toISOString();
    if (!args.dryRun) await writeState(nextState);
    console.log(JSON.stringify({ ok: true, seeded: true, findings: findings.map((f) => f.key) }, null, 2));
    return;
  }

  const due = findings.filter((f) => shouldAlert(prior?.alerted?.[f.key], now, args.cooldownMinutes));
  const suppressed = findings.length - due.length;
  if (suppressed > 0) log(`${suppressed} finding(s) within the ${args.cooldownMinutes} min cooldown — not re-alerting`);

  if (due.length === 0) {
    log(findings.length === 0 ? "healthy — nothing to report" : "all findings still in cooldown");
    if (!args.dryRun) await writeState(nextState);
    console.log(JSON.stringify({ ok: true, healthy: findings.length === 0, suppressed }, null, 2));
    return;
  }

  const alertText = formatAlert(due, process.env.PIPELINE_ALERT_USER_ID || process.env.APP_MENTION_ALERT_USER_ID);

  if (args.dryRun) {
    log("DRY RUN — would post:");
    console.log(alertText);
  } else {
    const { post } = await import("./slack.ts");
    const channel = process.env.PIPELINE_ALERT_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;
    if (!channel) throw new Error("No alert destination — set PIPELINE_ALERT_CHANNEL_ID or SLACK_CHANNEL_ID.");
    await post(channel, alertText);
    for (const f of due) nextState.alerted[f.key] = now.toISOString();
    await writeState(nextState);
    log(`alerted to ${channel}: ${due.map((f) => f.key).join(", ")}`);
  }

  console.log(JSON.stringify({ ok: true, alerted: due.map((f) => f.key), suppressed }, null, 2));
}

main().catch((error) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
