/**
 * Gateway liveness alert — catches the failure modes nothing else does.
 *
 * Every gateway outage so far (2026-08-10, 09-10, 09-11, 10-12) presented the
 * same way in Slack: you mention the bot and the conversation goes wrong, while
 * the MLS watcher keeps posting new listings normally (that path never touches
 * the model). Process liveness lies — `launchctl list` showed a healthy PID
 * through all four — and on 2026-09-11 two separate faults left *no log line at
 * all*. The only signal that would have caught every one of them is the
 * conversation itself.
 *
 * Two independent checks, because the outages come in two shapes:
 *
 *   1. SILENT — a human mentions the bot and no reply ever arrives.
 *      The 2026-09-11 shape (dropped Slack events, silently black-holed model).
 *
 *   2. ERRORED — the bot *does* reply, but with a provider error.
 *      The 2026-10-12 shape: the Codex 5-hour cap was exhausted and the bot
 *      answered a mention 2 seconds later with "Provider authentication
 *      failed". Check 1 is blind to this by design — it got an answer.
 *
 * Deliberately independent of the gateway: a short-lived script over the Slack
 * Web API, so it keeps working when the thing it watches is dead. Outbound
 * Slack kept working through all four outages. Residual gap: if outbound Slack
 * itself breaks, nothing here can reach you.
 *
 * Decision logic (and its tests) lives in `app-mention-alert-lib.ts`; this file
 * is only I/O, scheduling concerns, and message formatting.
 *
 * Usage:
 *   npx tsx scripts/app-mention-alert.ts                 # the scheduled check
 *   npx tsx scripts/app-mention-alert.ts --dry-run       # detect + print; posts nothing, writes nothing
 *   npx tsx scripts/app-mention-alert.ts --seed          # record current state as seen, alert on nothing
 *   npx tsx scripts/app-mention-alert.ts --grace 5 --lookback 360
 *
 * Env (all optional except the token):
 *   SLACK_BOT_TOKEN                 required
 *   APP_MENTION_WATCH_CHANNELS      comma-separated channel IDs to watch (default: SLACK_CHANNEL_ID)
 *   APP_MENTION_ALERT_CHANNEL_ID    where alerts are posted (default: SLACK_CHANNEL_ID)
 *   APP_MENTION_ALERT_USER_ID       user to @mention in alerts, e.g. U05... (default: none)
 *   APP_MENTION_GRACE_MINUTES       how long the bot gets to answer (default: 10)
 *   APP_MENTION_LOOKBACK_MINUTES    how recent a message must be to be judged (default: 180)
 *   APP_MENTION_DISCOVERY_MINUTES   how far back to look for threads (default: 20160 = 14 days)
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  alertHeader,
  describeAge,
  detect,
  neutralize,
  pruneState,
  shouldReadThread,
  type Finding,
  type SlackMessage,
} from "./app-mention-alert-lib.ts";

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

const stateFile = resolve(repoRoot, "data/inbox/app-mention-alert-state.json");

type AlertState = {
  updatedAt: string;
  alertedMentions: string[];
  alertedErrors: string[];
};

function argValue(flag: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const args = {
  dryRun: process.argv.includes("--dry-run"),
  seed: process.argv.includes("--seed"),
  graceMinutes: Number(argValue("--grace") || process.env.APP_MENTION_GRACE_MINUTES || 10),
  lookbackMinutes: Number(argValue("--lookback") || process.env.APP_MENTION_LOOKBACK_MINUTES || 180),
  discoveryMinutes: Number(argValue("--discovery") || process.env.APP_MENTION_DISCOVERY_MINUTES || 20160),
  channel: argValue("--channel"),
};

function log(message: string) {
  console.log(`[${new Date().toISOString()}] app-mention-alert: ${message}`);
}

async function readState(): Promise<AlertState | null> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as AlertState;
  } catch {
    return null;
  }
}

async function writeState(state: AlertState) {
  await mkdir(resolve(repoRoot, "data/inbox"), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not set.");

  const { slackApi, post } = await import("./slack.ts");

  const auth = await slackApi("auth.test", {});
  const botUserId: string = auth.user_id;
  if (!botUserId) throw new Error("auth.test returned no user_id — cannot identify the bot.");

  const watchChannels = args.channel
    ? [args.channel]
    : (process.env.APP_MENTION_WATCH_CHANNELS || process.env.SLACK_CHANNEL_ID || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
  if (watchChannels.length === 0) {
    throw new Error("No channels to watch — set APP_MENTION_WATCH_CHANNELS or SLACK_CHANNEL_ID.");
  }

  const nowSeconds = Date.now() / 1000;
  const mentionOldestTs = nowSeconds - args.lookbackMinutes * 60;
  const discoveryOldest = (nowSeconds - args.discoveryMinutes * 60).toFixed(6);

  log(
    `bot=${auth.user} (${botUserId}) channels=${watchChannels.join(",")} ` +
      `lookback=${args.lookbackMinutes}m discovery=${args.discoveryMinutes}m grace=${args.graceMinutes}m` +
      `${args.dryRun ? " [DRY RUN]" : ""}${args.seed ? " [SEED]" : ""}`,
  );

  const unanswered: Finding[] = [];
  const errored: Finding[] = [];
  const warnings: string[] = [];

  for (const channel of watchChannels) {
    const top: SlackMessage[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const hist = await slackApi("conversations.history", {
          channel,
          oldest: discoveryOldest,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        top.push(...((hist.messages || []) as SlackMessage[]));
        cursor = hist.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
        if (page === 9) {
          warnings.push(`channel ${channel}: stopped paging history after 10 pages — discovery window may be truncated`);
        }
      }
    } catch (error) {
      // A channel we cannot read must not silently reduce coverage.
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`could not read channel ${channel}: ${detail}`);
      log(`WARN could not read ${channel}: ${detail}`);
      continue;
    }

    // Read only the threads that could hold a mention worth acting on.
    const threads = new Map<string, SlackMessage[]>();
    for (const parent of top) {
      if (!shouldReadThread(parent, mentionOldestTs)) continue;
      const threadTs = parent.thread_ts || parent.ts;
      if (threads.has(threadTs)) continue;
      try {
        const res = await slackApi("conversations.replies", { channel, ts: threadTs, limit: 200 });
        threads.set(threadTs, (res.messages || []) as SlackMessage[]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`could not read thread ${threadTs} in ${channel}: ${detail}`);
      }
    }

    const found = detect({
      channel,
      top,
      threads,
      botUserId,
      nowSeconds,
      graceMinutes: args.graceMinutes,
      lookbackMinutes: args.lookbackMinutes,
    });
    unanswered.push(...found.unanswered);
    errored.push(...found.errored);
    log(`${channel}: ${top.length} top-level, ${threads.size} thread(s) read → ${found.unanswered.length} unanswered, ${found.errored.length} errored`);
  }

  const prior = await readState();
  const firstRun = prior === null;
  const alertedMentions = new Set(prior?.alertedMentions || []);
  const alertedErrors = new Set(prior?.alertedErrors || []);

  const newUnanswered = unanswered.filter((u) => !alertedMentions.has(u.message.ts));
  const newErrored = errored.filter((e) => !alertedErrors.has(e.message.ts));

  const nextState: AlertState = {
    updatedAt: new Date().toISOString(),
    alertedMentions: pruneState(
      [...alertedMentions, ...unanswered.map((u) => u.message.ts)],
      nowSeconds,
      args.lookbackMinutes,
    ),
    alertedErrors: pruneState(
      [...alertedErrors, ...errored.map((e) => e.message.ts)],
      nowSeconds,
      args.lookbackMinutes,
    ),
  };

  // First run (or --seed) records what is already there and alerts on nothing,
  // so standing history cannot produce an alert storm on install.
  if (firstRun || args.seed) {
    const why = args.seed ? "--seed" : "no prior state file (first run)";
    log(`${why}: recording ${unanswered.length} unanswered + ${errored.length} errored as already-seen, alerting on none`);
    if (!args.dryRun) await writeState(nextState);
    console.log(JSON.stringify({ ok: true, seeded: true, unanswered: unanswered.length, errored: errored.length, warnings }, null, 2));
    return;
  }

  const lines: string[] = [];

  if (newUnanswered.length > 0) {
    lines.push(alertHeader.silent(newUnanswered.length));
    for (const u of newUnanswered.slice(0, 5)) {
      let link = "";
      try {
        const pl = await slackApi("chat.getPermalink", { channel: u.channel, message_ts: u.message.ts });
        if (pl.permalink) link = ` <${pl.permalink}|open>`;
      } catch {
        /* a permalink is a nicety, not worth failing the alert over */
      }
      lines.push(`• _${describeAge(u.message.ts, nowSeconds)}_: "${neutralize(u.message.text, botUserId).slice(0, 140)}"${link}`);
    }
    if (newUnanswered.length > 5) lines.push(`• …and ${newUnanswered.length - 5} more`);
    lines.push("_Check `launchctl list | grep longitude.pre-bot`, then `/tmp/str-bot-gateway.log` (filter out `Session is closed`)._");
  }

  if (newErrored.length > 0) {
    lines.push(alertHeader.errored(newErrored.length));
    for (const e of newErrored.slice(0, 3)) {
      lines.push(`• _${describeAge(e.message.ts, nowSeconds)}_: "${neutralize(e.message.text, botUserId).slice(0, 160)}"`);
    }
    lines.push(
      "_If it says authentication, check the Codex quota FIRST_ — `last_status` / `last_error_reset_at` in `~/.hermes/auth.json`. " +
        "An exhausted 5-hour cap is reported as an auth failure. Do not re-authenticate.",
    );
  }

  for (const warning of warnings) lines.push(`⚠️ ${warning}`);

  if (lines.length === 0) {
    log("healthy — nothing to report");
    if (!args.dryRun) await writeState(nextState);
    console.log(JSON.stringify({ ok: true, healthy: true, warnings }, null, 2));
    return;
  }

  const mentionUser = process.env.APP_MENTION_ALERT_USER_ID;
  if (mentionUser) lines.unshift(`<@${mentionUser}>`);
  const alertText = lines.join("\n");

  if (args.dryRun) {
    log("DRY RUN — would post:");
    console.log(alertText);
  } else {
    const alertChannel = process.env.APP_MENTION_ALERT_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;
    if (!alertChannel) throw new Error("No alert destination — set APP_MENTION_ALERT_CHANNEL_ID or SLACK_CHANNEL_ID.");
    // Posted top-level, never into the affected thread: a reply from the bot's
    // own token would make the next run read the mention as answered.
    const posted = await post(alertChannel, alertText);
    // Second line of defense against the self-trigger loop that live testing
    // exposed: remember the alert's own ts, so even if `isOwnAlert` stops
    // matching (e.g. someone rewords a header) this message can never be
    // re-detected as a provider error and alerted about.
    if (posted?.ts) nextState.alertedErrors = pruneState([...nextState.alertedErrors, posted.ts], nowSeconds, args.lookbackMinutes);
    await writeState(nextState);
    log(`alerted to ${alertChannel}`);
  }

  console.log(
    JSON.stringify({ ok: true, alerted: true, unanswered: newUnanswered.length, errored: newErrored.length, warnings }, null, 2),
  );
}

main().catch((error) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
