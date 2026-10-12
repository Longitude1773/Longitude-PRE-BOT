import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alertHeader,
  describeAge,
  detect,
  isAnswered,
  isOwnAlert,
  isProviderError,
  mentionsBot,
  neutralize,
  pruneState,
  shouldReadThread,
  type SlackMessage,
} from "./app-mention-alert-lib.ts";

const BOT = "U0AQZ1WR0M6";
const HUMAN = "U053T09V88P";

// A fixed clock. Slack ts values are seconds-with-microseconds strings.
const NOW = 1_791_840_000;
const ago = (minutes: number) => (NOW - minutes * 60).toFixed(6);

function msg(over: Partial<SlackMessage> = {}): SlackMessage {
  return { ts: ago(30), user: HUMAN, text: "hello", ...over };
}

function run(
  top: SlackMessage[],
  threads: Record<string, SlackMessage[]> = {},
  over: { graceMinutes?: number; lookbackMinutes?: number } = {},
) {
  return detect({
    channel: "C0AR6BHQ9M1",
    top,
    threads: new Map(Object.entries(threads)),
    botUserId: BOT,
    nowSeconds: NOW,
    graceMinutes: over.graceMinutes ?? 10,
    lookbackMinutes: over.lookbackMinutes ?? 180,
  });
}

// --- mentionsBot -----------------------------------------------------------

test("mentionsBot: true for a human message containing the bot mention", () => {
  assert.equal(mentionsBot(msg({ text: `<@${BOT}> approved` }), BOT), true);
});

test("mentionsBot: false for the bot's own messages (prevents self-trigger)", () => {
  assert.equal(mentionsBot(msg({ user: BOT, text: `<@${BOT}> quoted` }), BOT), false);
});

test("mentionsBot: false without a mention, even when the bot is discussed", () => {
  assert.equal(mentionsBot(msg({ text: "the bot seems slow today" }), BOT), false);
});

test("mentionsBot: false for channel-noise subtypes", () => {
  assert.equal(mentionsBot(msg({ text: `<@${BOT}>`, subtype: "channel_join" }), BOT), false);
});

// --- isAnswered ------------------------------------------------------------

test("isAnswered: a later bot message answers the mention", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> hi` });
  const thread = [msg({ ts: ago(60), user: BOT }), mention, msg({ ts: ago(29), user: BOT, text: "done" })];
  assert.equal(isAnswered(thread, mention, BOT), true);
});

test("isAnswered: a bot message BEFORE the mention does not count", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> hi` });
  const thread = [msg({ ts: ago(60), user: BOT, text: "earlier listing post" }), mention];
  assert.equal(isAnswered(thread, mention, BOT), false);
});

test("isAnswered: an empty-text bot reply counts (file-only upload)", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> send the pdf` });
  const thread = [mention, msg({ ts: ago(28), user: BOT, text: "" })];
  assert.equal(isAnswered(thread, mention, BOT), true);
});

test("isAnswered: a Working progress line counts as alive", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> compile a list` });
  const thread = [mention, msg({ ts: ago(27), user: BOT, text: ":hourglass_flowing_sand: Working — 2 min" })];
  assert.equal(isAnswered(thread, mention, BOT), true);
});

test("isAnswered: another human replying does NOT answer for the bot", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> hi` });
  const thread = [mention, msg({ ts: ago(20), user: "U03DTH96RD1", text: "bumping this" })];
  assert.equal(isAnswered(thread, mention, BOT), false);
});

// --- detect: the silent-mention check -------------------------------------

test("detect: flags a top-level mention with no reply at all", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> set balanced revenue to 62500` });
  const { unanswered } = run([mention]);
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].message.ts, mention.ts);
});

test("detect: flags an in-thread mention whose parent is far older than the lookback", () => {
  // The regression that real data exposed: the adjustment sits in an eval
  // thread parented days ago, so the parent is outside the mention window.
  const parent = msg({ ts: ago(60 * 24 * 5), user: BOT, text: "New STR Listing", reply_count: 1, latest_reply: ago(30) });
  const mention = msg({ ts: ago(30), text: `<@${BOT}> set balanced revenue to 62500` });
  const { unanswered } = run([parent], { [parent.ts]: [parent, mention] });
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].message.ts, mention.ts);
  assert.equal(unanswered[0].threadTs, parent.ts);
});

test("detect: does NOT flag a mention still inside its grace period", () => {
  const mention = msg({ ts: ago(3), text: `<@${BOT}> hi` });
  assert.equal(run([mention], {}, { graceMinutes: 10 }).unanswered.length, 0);
});

test("detect: does NOT flag a mention the bot answered", () => {
  const parent = msg({ ts: ago(40), user: BOT, reply_count: 2, latest_reply: ago(28) });
  const mention = msg({ ts: ago(30), text: `<@${BOT}> approved` });
  const reply = msg({ ts: ago(28), user: BOT, text: "Approved — generating the PDF" });
  assert.equal(run([parent], { [parent.ts]: [parent, mention, reply] }).unanswered.length, 0);
});

test("detect: ignores mentions older than the lookback window", () => {
  const mention = msg({ ts: ago(60 * 10), text: `<@${BOT}> hi` });
  assert.equal(run([mention], {}, { lookbackMinutes: 180 }).unanswered.length, 0);
});

test("detect: a mention reachable both ways is reported once", () => {
  const mention = msg({ ts: ago(30), thread_ts: ago(30), text: `<@${BOT}> hi` });
  const { unanswered } = run([mention], { [mention.ts]: [mention] });
  assert.equal(unanswered.length, 1);
});

// --- detect: the provider-error check -------------------------------------

test("detect: flags the exact 2026-10-12 quota reply", () => {
  const parent = msg({ ts: ago(80), user: BOT, reply_count: 2, latest_reply: ago(30) });
  const mention = msg({ ts: ago(31), text: `<@${BOT}> set balanced revenue to 62500` });
  const errorReply = msg({
    ts: ago(30),
    user: BOT,
    text: ":warning: Provider authentication failed. Check the configured credentials; raw provider details are in the gateway logs.",
  });
  const { unanswered, errored } = run([parent], { [parent.ts]: [parent, mention, errorReply] });
  // The bot DID answer, so check 1 stays quiet — check 2 is what catches this.
  assert.equal(unanswered.length, 0);
  assert.equal(errored.length, 1);
  assert.equal(errored[0].message.ts, errorReply.ts);
});

test("detect: ignores a human quoting the error text", () => {
  const human = msg({ ts: ago(30), text: "why did it say Provider authentication failed?" });
  assert.equal(run([human]).errored.length, 0);
});

test("detect: a normal bot answer is not an error", () => {
  const ok = msg({ ts: ago(30), user: BOT, text: "Balanced is $125,500 based on 8 comps." });
  assert.equal(run([ok]).errored.length, 0);
});

// --- self-trigger loop (regression, found by live testing) -----------------

test("detect: does NOT alert on its own alert quoting an error (the loop bug)", () => {
  // The live failure: an alert quotes the offending text verbatim and is posted
  // by the bot's own token, so the provider-error check matched the alert it had
  // just posted and alerted again — once per scheduled run, forever.
  const ownAlert = msg({
    ts: ago(20),
    user: BOT,
    text:
      `<@U05BJ31F72Q>\n${alertHeader.errored(1)}\n` +
      `• _56 min ago_: ":warning: Provider authentication failed. Check the configured credentials; raw provider details are in the gateway logs."`,
  });
  assert.equal(run([ownAlert]).errored.length, 0);
});

test("detect: does NOT alert on its own unanswered-mention alert", () => {
  const ownAlert = msg({ ts: ago(20), user: BOT, text: alertHeader.silent(2) });
  assert.equal(run([ownAlert]).errored.length, 0);
});

test("isOwnAlert: matches both headers, not ordinary bot text", () => {
  assert.equal(isOwnAlert(alertHeader.errored(1)), true);
  assert.equal(isOwnAlert(alertHeader.silent(3)), true);
  assert.equal(isOwnAlert(":warning: Provider authentication failed."), false);
  assert.equal(isOwnAlert("Balanced is $125,500."), false);
});

test("isAnswered: this monitor's own alert does not count as answering", () => {
  const mention = msg({ ts: ago(30), text: `<@${BOT}> hi` });
  const thread = [mention, msg({ ts: ago(20), user: BOT, text: alertHeader.silent(1) })];
  assert.equal(isAnswered(thread, mention, BOT), false);
});

test("detect: a real error still alerts even when an old alert sits nearby", () => {
  const ownAlert = msg({ ts: ago(40), user: BOT, text: alertHeader.errored(1) });
  const realError = msg({ ts: ago(20), user: BOT, text: "⏱️ The model provider is rate-limiting requests." });
  const { errored } = run([ownAlert, realError]);
  assert.equal(errored.length, 1);
  assert.equal(errored[0].message.ts, realError.ts);
});

test("isProviderError: covers each gateway provider-error string", () => {
  for (const text of [
    "⚠️ Provider authentication failed. Check the configured credentials;",
    "⚠️ The model provider rejected the request.",
    "⏱️ The model provider is rate-limiting requests.",
    "⚠️ The model provider failed after retries.",
    "HTTP 429: The usage limit has been reached",
    "Codex provider quota exhausted (429)",
  ]) {
    assert.equal(isProviderError(text), true, text);
  }
  assert.equal(isProviderError("Here are your projections."), false);
});

// --- shouldReadThread ------------------------------------------------------

test("shouldReadThread: skips threads with no replies", () => {
  assert.equal(shouldReadThread(msg({ reply_count: 0 }), NOW - 180 * 60), false);
});

test("shouldReadThread: reads an old thread that has a recent reply", () => {
  const parent = msg({ ts: ago(60 * 24 * 7), reply_count: 3, latest_reply: ago(5) });
  assert.equal(shouldReadThread(parent, NOW - 180 * 60), true);
});

test("shouldReadThread: skips an old thread whose last reply is also old", () => {
  const parent = msg({ ts: ago(60 * 24 * 7), reply_count: 3, latest_reply: ago(60 * 24 * 6) });
  assert.equal(shouldReadThread(parent, NOW - 180 * 60), false);
});

// --- presentation + state --------------------------------------------------

test("neutralize: defuses the bot mention so alerts cannot self-trigger or ping", () => {
  const out = neutralize(`<@${BOT}>   set balanced\n revenue to 62500`, BOT);
  assert.equal(out, "@bot set balanced revenue to 62500");
  assert.equal(out.includes(BOT), false);
});

test("describeAge: minutes, hours, then days", () => {
  assert.equal(describeAge(ago(42), NOW), "42 min ago");
  assert.equal(describeAge(ago(150), NOW), "2.5 h ago");
  assert.equal(describeAge(ago(60 * 48), NOW), "2.0 days ago");
});

test("pruneState: drops entries beyond 3x the window and dedupes", () => {
  const kept = ago(100);
  const dropped = ago(180 * 3 + 60);
  const out = pruneState([kept, kept, dropped], NOW, 180);
  assert.deepEqual(out, [kept]);
});
