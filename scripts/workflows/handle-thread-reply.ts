import { spawnSync } from "node:child_process";

import { reply } from "../slack.ts";
import {
  applyStructuredAdjustment,
  asNumber,
  asString,
  buildProjectionReply,
  cloneEvalData,
  logSlackEvent,
  parseAdjustmentRequest,
  resolveEvaluationByMls,
  resolveEvaluationByThread,
  saveEvalData,
  upsertAdjustmentForMls,
  upsertThreadContext,
  updateEvaluationSummaryRow,
  writeEvaluationVersion,
  type AdjustmentCategory,
} from "./lib.ts";
import { loadMarketKnowledge } from "./market-knowledge.ts";
import { applyTierCorrection, parseTierCorrection, TierCorrectionError } from "./tier-correction.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function classify(text: string) {
  const lower = text.toLowerCase();
  if (/\bapprove(d)?\b/.test(lower)) return "approve";
  if (/\bdismiss(ed)?\b|\breject(ed)?\b/.test(lower)) return "dismiss";
  if (parseTierCorrection(text)) return "adjust";
  const adjustment = parseAdjustmentRequest(text);
  if (adjustment.kind === "ok" || adjustment.kind === "clarify") return "adjust";
  return "question";
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
  const action = classify(text);

  if (action === "approve") {
    if (!dryRun) {
      const result = spawnSync("npx", ["tsx", "scripts/workflows/approve-eval.ts", "--channel", channel, "--thread-ts", targetThreadTs], {
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

    console.log(JSON.stringify({ ok: true, action, threadTs: targetThreadTs, mlsNumber: data.mlsNumber, eventPath, dryRun }, null, 2));
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
    const tierParsed = parseTierCorrection(text);
    const parsed = parseAdjustmentRequest(text);
    let clarifyMessage = "";
    let category: AdjustmentCategory = "revenue";
    const reasons: string[] = [];

    if (tierParsed?.kind === "clarify") {
      clarifyMessage = tierParsed.message;
    } else if (tierParsed?.kind === "ok") {
      try {
        reasons.push(applyTierCorrection(data, tierParsed.tier, await loadMarketKnowledge(), { keepNumbers: tierParsed.keepNumbers }).reasoning);
        category = "classification-tier";
      } catch (error) {
        if (!(error instanceof TierCorrectionError)) throw error;
        clarifyMessage = error.message;
      }
      // A number in the same reply ("tier 1, set balanced to 27,400") lands on
      // top of the re-underwrite. Skip the generic "higher tier" uplift, which
      // would double-count the tier change.
      if (!clarifyMessage && parsed.kind === "ok" && parsed.spec.category !== "general-direction") {
        reasons.push(applyStructuredAdjustment(data, parsed.spec).reasoning);
      }
    } else if (parsed.kind === "none") {
      throw new Error("Adjustment was classified but no supported rule matched.");
    } else if (parsed.kind === "clarify") {
      clarifyMessage = parsed.message;
    } else {
      reasons.push(applyStructuredAdjustment(data, parsed.spec).reasoning);
      category = parsed.spec.category;
    }

    if (clarifyMessage) {
      if (!dryRun) {
        await reply(channel, targetThreadTs, clarifyMessage);
        await upsertThreadContext({
          threadTs: targetThreadTs,
          row,
          data,
          slackChannelId: channel,
          event: {
            kind: "thread-reply",
            action: "adjust_clarify",
            user,
            text,
            note: clarifyMessage,
            status: asString(row.Status),
            version: asNumber(row.Version),
            eventPath,
          },
        });
      }

      console.log(JSON.stringify({
        ok: true,
        action: "adjust_clarify",
        message: clarifyMessage,
        threadTs: targetThreadTs,
        mlsNumber: data.mlsNumber,
        eventPath,
        dryRun,
      }, null, 2));
      return;
    }

    const reasoning = reasons.join(" ");
    const nextVersion = asNumber(row.Version) + 1;

    if (!dryRun) {
      await saveEvalData(path, data);
      await writeEvaluationVersion(data, {
        source: asString((row as any)["Listing Source"] || "new_listing"),
        version: String(nextVersion),
        status: "pending_review",
        "slack-ts": targetThreadTs,
        // Carry an existing R2 key forward (re-eval of an approved row); leave
        // null for still-pending rows. Never re-introduce a local path.
        "pdf-path": asString(row["PDF Path"]) || undefined,
      });
      await upsertAdjustmentForMls({
        evalId: asString(row["Eval ID"]),
        mlsNumber: asString(row["MLS #"]),
        requestedBy: user,
        requestText: text,
        category,
        reasoning,
        after: data,
        fallbackBefore: before,
        classification: {
          market: asString(data.market),
          subMarket: asString(data.subMarket),
          luxuryTier: asString(data.luxuryTier),
          amenities: data.amenities || { primary: [], secondary: [] },
        },
      });
      await reply(channel, targetThreadTs, buildProjectionReply(data, reasoning));
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
              note: reasoning,
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
      category,
      reasoning,
      luxuryTier: data.luxuryTier,
      revenue: {
        optimized: data.projections?.high.revenue,
        balanced: data.projections?.medium.revenue,
        conservative: data.projections?.low.revenue,
      },
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
