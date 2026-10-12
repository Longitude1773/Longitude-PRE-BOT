/**
 * Pure decision logic for the gateway liveness alert.
 *
 * Split out from `app-mention-alert.ts` so the rules can be tested without
 * Slack: the runner does the I/O, everything here is a pure function over
 * already-fetched messages. Time is always an explicit `nowSeconds` argument
 * for the same reason.
 *
 * See `app-mention-alert.ts` for why the two checks exist.
 */

export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  /** ts of the newest reply; present on threaded parents in conversations.history */
  latest_reply?: string;
  subtype?: string;
};

/**
 * Bot replies that mean "the model layer is broken", not "here is your answer".
 * These are the gateway's own user-facing provider-error strings
 * (`_gateway_provider_error_reply` in hermes `gateway/run.py`). Matching the
 * rendered Slack text rather than a log line is deliberate: it is what you
 * actually see, and it survives the gateway logging nothing at all.
 */
export const PROVIDER_ERROR_PATTERNS = [
  /provider authentication failed/i,
  /model provider rejected the request/i,
  /model provider is rate-limiting/i,
  /model provider failed after retries/i,
  /usage limit has been reached/i,
  /quota exhausted/i,
];

/** Subtypes that are channel noise, never a real request to the bot. */
export const IGNORED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "message_deleted",
  "message_changed",
  "thread_broadcast_joined",
  "bot_add",
  "bot_remove",
]);

export function isProviderError(text: string | undefined) {
  return PROVIDER_ERROR_PATTERNS.some((p) => p.test(text || ""));
}

/** True when this is a human message addressed to the bot. */
export function mentionsBot(message: SlackMessage, botUserId: string) {
  if (message.user === botUserId) return false;
  if (message.subtype && IGNORED_SUBTYPES.has(message.subtype)) return false;
  return (message.text || "").includes(`<@${botUserId}>`);
}

/**
 * Whether a thread needs reading.
 *
 * Thread discovery deliberately reaches much further back than the mention
 * window, because an adjustment or approval normally lands in an eval thread
 * whose parent message is days old, and `conversations.history` returns only
 * top-level messages. Gating on `latest_reply` keeps that cheap: a thread with
 * no activity inside the mention window cannot contain a mention we would act
 * on, so it is never fetched.
 */
export function shouldReadThread(parent: SlackMessage, mentionOldestTs: number) {
  if (!parent.reply_count) return false;
  return Number(parent.latest_reply || 0) >= mentionOldestTs;
}

/**
 * Answered = any bot message in the same thread strictly after the mention.
 *
 * An empty-text bot message counts: file-only replies (e.g. a PDF upload) carry
 * no text, and a "⏳ Working…" progress line is a legitimate acknowledgement —
 * the bot is alive and working, which is exactly what this check is asking.
 */
export function isAnswered(thread: SlackMessage[], mention: SlackMessage, botUserId: string) {
  return thread.some((m) => m.user === botUserId && Number(m.ts) > Number(mention.ts));
}

/**
 * Neutralize bot mentions inside quoted text, so an alert that quotes
 * "<@BOT> set balanced revenue to X" neither fires a real ping nor writes the
 * bot's own mention string into a message a later run reads back.
 */
export function neutralize(text: string | undefined, botUserId: string) {
  return (text || "")
    .replace(new RegExp(`<@${botUserId}>`, "g"), "@bot")
    .replace(/\s+/g, " ")
    .trim();
}

export function minutesAgo(ts: string, nowSeconds: number) {
  return (nowSeconds - Number(ts)) / 60;
}

export function describeAge(ts: string, nowSeconds: number) {
  const m = minutesAgo(ts, nowSeconds);
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)} h ago`;
  return `${(h / 24).toFixed(1)} days ago`;
}

export type Finding = { channel: string; message: SlackMessage; threadTs: string };

export type Detection = {
  /** Human mentions past their grace period with no bot reply in-thread. */
  unanswered: Finding[];
  /** Bot replies that are provider errors rather than answers. */
  errored: Finding[];
};

/**
 * Apply both checks to one channel's already-fetched messages.
 *
 * `threads` maps threadTs → full message list (parent first), containing only
 * the threads the runner decided to read via `shouldReadThread`.
 */
export function detect(opts: {
  channel: string;
  top: SlackMessage[];
  threads: Map<string, SlackMessage[]>;
  botUserId: string;
  nowSeconds: number;
  graceMinutes: number;
  lookbackMinutes: number;
}): Detection {
  const { channel, top, threads, botUserId, nowSeconds, graceMinutes, lookbackMinutes } = opts;
  const mentionOldestTs = nowSeconds - lookbackMinutes * 60;
  const isRecent = (ts: string | undefined) => Number(ts || 0) >= mentionOldestTs;

  // --- Check 1: silent mentions ---
  const candidates: Array<{ mention: SlackMessage; threadTs: string }> = [];
  for (const m of top) {
    if (isRecent(m.ts) && mentionsBot(m, botUserId)) {
      candidates.push({ mention: m, threadTs: m.thread_ts || m.ts });
    }
  }
  for (const [threadTs, msgs] of threads) {
    for (const r of msgs.slice(1)) {
      if (isRecent(r.ts) && mentionsBot(r, botUserId)) candidates.push({ mention: r, threadTs });
    }
  }

  const unanswered: Finding[] = [];
  const seenMentionTs = new Set<string>();
  for (const { mention, threadTs } of candidates) {
    if (seenMentionTs.has(mention.ts)) continue;
    seenMentionTs.add(mention.ts);
    // Still inside its grace period — the bot is allowed to be thinking.
    if (minutesAgo(mention.ts, nowSeconds) < graceMinutes) continue;
    // A top-level mention with no thread read yields [], so it is unanswered —
    // which is correct: the bot replies in-thread.
    const thread = threads.get(threadTs) || [];
    if (!isAnswered(thread, mention, botUserId)) {
      unanswered.push({ channel, message: mention, threadTs });
    }
  }

  // --- Check 2: provider-error replies ---
  const errored: Finding[] = [];
  const seenErrorTs = new Set<string>();
  const scan = (msgs: SlackMessage[], threadTs: string) => {
    for (const m of msgs) {
      if (m.user !== botUserId) continue;
      if (!isRecent(m.ts)) continue;
      if (seenErrorTs.has(m.ts)) continue;
      if (!isProviderError(m.text)) continue;
      seenErrorTs.add(m.ts);
      errored.push({ channel, message: m, threadTs });
    }
  };
  scan(top, "");
  for (const [threadTs, msgs] of threads) scan(msgs, threadTs);

  return { unanswered, errored };
}

/**
 * Keep dedup state bounded. Anything older than the window can no longer be
 * re-detected, so remembering it forever would only grow the file.
 */
export function pruneState(tsList: Iterable<string>, nowSeconds: number, lookbackMinutes: number) {
  return [...new Set(tsList)]
    .filter((ts) => minutesAgo(ts, nowSeconds) < lookbackMinutes * 3)
    .sort();
}
