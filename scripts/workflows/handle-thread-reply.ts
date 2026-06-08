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
  pdfPathForEval,
  resolveEvaluationByMls,
  resolveEvaluationByThread,
  saveEvalData,
  upsertAdjustmentForMls,
  upsertThreadContext,
  updateEvaluationSummaryRow,
  writeEvaluationVersion,
} from "./lib.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function classify(text: string) {
  const lower = text.toLowerCase();
  if (/\bapprove(d)?\b/.test(lower)) return "approve";
  if (/\bdismiss(ed)?\b|\breject(ed)?\b/.test(lower)) return "dismiss";
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
    const parsed = parseAdjustmentRequest(text);
    if (parsed.kind === "none") {
      throw new Error("Adjustment was classified but no supported rule matched.");
    }
    if (parsed.kind === "clarify") {
      if (!dryRun) {
        await reply(channel, targetThreadTs, parsed.message);
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
            note: parsed.message,
            status: asString(row.Status),
            version: asNumber(row.Version),
            eventPath,
          },
        });
      }

      console.log(JSON.stringify({
        ok: true,
        action: "adjust_clarify",
        threadTs: targetThreadTs,
        mlsNumber: data.mlsNumber,
        eventPath,
        dryRun,
      }, null, 2));
      return;
    }

    const { reasoning } = applyStructuredAdjustment(data, parsed.spec);
    const nextVersion = asNumber(row.Version) + 1;

    if (!dryRun) {
      await saveEvalData(path, data);
      await writeEvaluationVersion(data, {
        source: asString((row as any)["Listing Source"] || "new_listing"),
        version: String(nextVersion),
        status: "pending_review",
        "slack-ts": targetThreadTs,
        "pdf-path": asString(row["PDF Path"]) || pdfPathForEval(data),
      });
      await upsertAdjustmentForMls({
        evalId: asString(row["Eval ID"]),
        mlsNumber: asString(row["MLS #"]),
        requestedBy: user,
        requestText: text,
        category: parsed.spec.category,
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
