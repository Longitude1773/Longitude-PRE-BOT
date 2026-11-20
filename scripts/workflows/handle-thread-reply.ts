import { spawnSync } from "node:child_process";

import type { EvalData } from "../write-sheet-data.ts";
import { reply } from "../slack.ts";
import {
  asNumber,
  asString,
  buildProjectionReply,
  cloneEvalData,
  logSlackEvent,
  resolveEvaluationByMls,
  resolveEvaluationByThread,
  saveEvalData,
  upsertAdjustmentForMls,
  upsertThreadContext,
  updateEvaluationSummaryRow,
  writeEvaluationVersion,
  type AdjustmentCategory,
  type EvalSheetRow,
} from "./lib.ts";
import { applyReplyAdjustments, isAdjustmentReply } from "./reply-adjustments.ts";
import { applySeasonalityProfile, parseSeasonalityProfile, SEASONALITY_LABEL } from "./seasonality.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function classify(text: string) {
  const lower = text.toLowerCase();
  if (/\bapprove(d)?\b/.test(lower)) return "approve";
  if (/\bdismiss(ed)?\b|\breject(ed)?\b/.test(lower)) return "dismiss";
  if (isAdjustmentReply(text)) return "adjust";
  return "question";
}

type ReplyContext = {
  channel: string;
  targetThreadTs: string;
  user: string;
  text: string;
  eventPath: string;
  row: EvalSheetRow;
  path: string;
};

// Save an adjusted eval as the next version (pending review), log it to
// Adjustments, and optionally post the updated projections to the thread.
async function persistAdjustedVersion(
  ctx: ReplyContext,
  data: EvalData,
  before: EvalData,
  change: { category: AdjustmentCategory; reasoning: string; action: string; postReply: boolean },
) {
  const { row } = ctx;
  await saveEvalData(ctx.path, data);
  await writeEvaluationVersion(data, {
    source: asString((row as any)["Listing Source"] || "new_listing"),
    version: String(asNumber(row.Version) + 1),
    status: "pending_review",
    "slack-ts": ctx.targetThreadTs,
    // Carry an existing R2 key forward (re-eval of an approved row); leave
    // null for still-pending rows. Never re-introduce a local path.
    "pdf-path": asString(row["PDF Path"]) || undefined,
  });
  await upsertAdjustmentForMls({
    evalId: asString(row["Eval ID"]),
    mlsNumber: asString(row["MLS #"]),
    requestedBy: ctx.user,
    requestText: ctx.text,
    category: change.category,
    reasoning: change.reasoning,
    after: data,
    fallbackBefore: before,
    classification: {
      market: asString(data.market),
      subMarket: asString(data.subMarket),
      luxuryTier: asString(data.luxuryTier),
      amenities: data.amenities || { primary: [], secondary: [] },
    },
  });
  if (change.postReply) await reply(ctx.channel, ctx.targetThreadTs, buildProjectionReply(data, change.reasoning));
  if (ctx.targetThreadTs) {
    const latest = await resolveEvaluationByThread(ctx.targetThreadTs);
    if (latest) {
      await upsertThreadContext({
        threadTs: ctx.targetThreadTs,
        row: latest.row,
        data: latest.data,
        slackChannelId: ctx.channel,
        event: {
          kind: "thread-reply",
          action: change.action,
          user: ctx.user,
          text: ctx.text,
          note: change.reasoning,
          status: asString(latest.row.Status),
          version: asNumber(latest.row.Version),
          eventPath: ctx.eventPath,
        },
      });
    }
  }
}

function projectionSummary(data: EvalData) {
  return {
    luxuryTier: data.luxuryTier,
    seasonalityProfile: data.seasonalityProfile || "standard",
    revenue: {
      optimized: data.projections?.high.revenue,
      balanced: data.projections?.medium.revenue,
      conservative: data.projections?.low.revenue,
    },
    balancedMonthly: data.projections?.medium.monthly.map((m) => m.revenue),
  };
}

async function main() {
  const channel = argValue("--channel") || process.env.SLACK_CHANNEL_ID;
  const threadTs = argValue("--thread-ts");
  const mls = argValue("--mls");
  const user = argValue("--user") || "";
  const text = argValue("--text") || "";
  const dryRun = process.argv.includes("--dry-run");

  if (!channel || (!threadTs && !mls) || !text) {
    throw new Error("Usage: tsx scripts/workflows/handle-thread-reply.ts --channel <id> (--thread-ts <ts> | --mls <mls>) --text <text> [--user <id>] [--dry-run]");
  }

  const eventPath = await logSlackEvent("thread-reply", { channel, threadTs, mls, user, text, receivedAt: new Date().toISOString() });
  const resolved = threadTs ? await resolveEvaluationByThread(threadTs) : await resolveEvaluationByMls(asString(mls));
  if (!resolved) throw new Error(`No evaluation found for thread ${threadTs || mls}.`);

  const { row, path, data } = resolved;
  const targetThreadTs = threadTs || asString(row["Slack Timestamp"]);
  const ctx: ReplyContext = { channel, targetThreadTs, user, text, eventPath, row, path };
  const action = classify(text);

  if (action === "approve") {
    // "approve ski-heavy" / "approve summer-heavy": reshape the months first,
    // save that as the next version, then approve it. Straight to the PDF;
    // annual figures do not change, so there is nothing new to review.
    const season = parseSeasonalityProfile(text);
    if (season?.kind === "clarify") {
      if (!dryRun) await reply(channel, targetThreadTs, `${season.message} Nothing was approved yet.`);
      console.log(JSON.stringify({ ok: true, action: "approve_clarify", message: season.message, threadTs: targetThreadTs, mlsNumber: data.mlsNumber, eventPath, dryRun }, null, 2));
      return;
    }
    let reshape: { reasoning: string } | undefined;
    if (season?.kind === "ok") {
      const before = cloneEvalData(data);
      reshape = applySeasonalityProfile(data, season.profile);
      if (!dryRun) {
        await reply(channel, targetThreadTs, `Applied the ${SEASONALITY_LABEL[season.profile]} seasonality curve (annual totals unchanged). Generating the PDF…`);
        await persistAdjustedVersion(ctx, data, before, { category: "seasonality", reasoning: reshape.reasoning, action: "approve_reshape", postReply: false });
      }
    }

    if (!dryRun) {
      const result = spawnSync("npx", ["tsx", "scripts/workflows/approve-eval.ts", "--channel", channel, "--thread-ts", targetThreadTs, "--user", user], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || "approve-eval failed");
      if (targetThreadTs) {
        const latest = await resolveEvaluationByThread(targetThreadTs);
        if (latest) {
          await upsertThreadContext({
            threadTs: targetThreadTs,
            row: latest.row,
            data: latest.data,
            slackChannelId: channel,
            event: {
              kind: "thread-reply",
              action,
              user,
              text,
              note: "Approval request executed for this eval thread.",
              status: asString(latest.row.Status),
              version: asNumber(latest.row.Version),
              eventPath,
            },
          });
        }
      }
    }

    console.log(JSON.stringify({
      ok: true,
      action,
      reasoning: reshape?.reasoning,
      ...(reshape ? projectionSummary(data) : {}),
      threadTs: targetThreadTs,
      mlsNumber: data.mlsNumber,
      eventPath,
      dryRun,
    }, null, 2));
    return;
  }

  if (action === "dismiss") {
    if (!dryRun) {
      const nextRow = await updateEvaluationSummaryRow(row, { Status: "dismissed" });
      await reply(channel, targetThreadTs, "Dismissed. I won’t generate a PDF for this one.");
      await upsertThreadContext({
        threadTs: targetThreadTs,
        row: nextRow,
        data,
        slackChannelId: channel,
        event: {
          kind: "thread-reply",
          action,
          user,
          text,
          note: "Eval dismissed from Slack thread.",
          status: "dismissed",
          version: asNumber(nextRow.Version),
          eventPath,
        },
      });
    }

    console.log(JSON.stringify({ ok: true, action, threadTs: targetThreadTs, mlsNumber: data.mlsNumber, eventPath, dryRun }, null, 2));
    return;
  }

  if (action === "adjust") {
    const before = cloneEvalData(data);
    const result = await applyReplyAdjustments(data, text);
    if (result.kind === "none") {
      throw new Error("Adjustment was classified but no supported rule matched.");
    }
    if (result.kind === "clarify") {
      if (!dryRun) {
        await reply(channel, targetThreadTs, result.message);
        await upsertThreadContext({
          threadTs: targetThreadTs,
          row,
          data: before,
          slackChannelId: channel,
          event: {
            kind: "thread-reply",
            action: "adjust_clarify",
            user,
            text,
            note: result.message,
            status: asString(row.Status),
            version: asNumber(row.Version),
            eventPath,
          },
        });
      }

      console.log(JSON.stringify({
        ok: true,
        action: "adjust_clarify",
        message: result.message,
        threadTs: targetThreadTs,
        mlsNumber: data.mlsNumber,
        eventPath,
        dryRun,
      }, null, 2));
      return;
    }

    const nextVersion = asNumber(row.Version) + 1;
    if (!dryRun) {
      await persistAdjustedVersion(ctx, data, before, { category: result.category, reasoning: result.reasoning, action, postReply: true });
    }

    console.log(JSON.stringify({
      ok: true,
      action,
      category: result.category,
      reasoning: result.reasoning,
      ...projectionSummary(data),
      threadTs: targetThreadTs,
      mlsNumber: data.mlsNumber,
      nextVersion,
      eventPath,
      dryRun,
    }, null, 2));
    return;
  }

  const questionReply = [
    data.narrative ? `Context: ${data.narrative}` : "",
    data.methodology ? `Methodology: ${data.methodology}` : "",
  ].filter(Boolean).join("\n\n") || "I can answer the review thread, but this question needs a manual read of the comps and market assumptions."

  if (!dryRun) {
    await reply(channel, targetThreadTs, questionReply);
    await upsertThreadContext({
      threadTs: targetThreadTs,
      row,
      data,
      slackChannelId: channel,
      event: {
        kind: "thread-reply",
        action,
        user,
        text,
        note: "Answered a question in the eval thread.",
        status: asString(row.Status),
        version: asNumber(row.Version),
        eventPath,
      },
    });
  }

  console.log(JSON.stringify({ ok: true, action, threadTs: targetThreadTs, mlsNumber: data.mlsNumber, eventPath, dryRun }, null, 2));
}

await main();
