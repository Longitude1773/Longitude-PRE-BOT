import { post } from "../slack.ts";
import {
  asString,
  buildReviewMessage,
  readPostedReviewRecord,
  resolveEvaluationByMls,
  savePostedReviewRecord,
  updateEvaluationSummaryRow,
  upsertThreadContext,
} from "./lib.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const mls = argValue("--mls");
  const channel = argValue("--channel") || process.env.SLACK_CHANNEL_ID;
  const threadTs = argValue("--thread-ts");
  const dryRun = process.argv.includes("--dry-run");
  const forcePost = process.argv.includes("--force-post");
  if (!mls || !channel) throw new Error("Usage: tsx scripts/workflows/post-review.ts --mls <mls> --channel <id> [--thread-ts <ts>] [--force-post] [--dry-run]");

  const resolved = await resolveEvaluationByMls(mls);
  if (!resolved) throw new Error(`No evaluation found for MLS ${mls}.`);

  const { row, data } = resolved;
  const text = await buildReviewMessage(data);

  let ts = asString(row["Slack Timestamp"]);
  if (ts && !forcePost) {
    console.log(JSON.stringify({ ok: true, action: "already_posted", mlsNumber: data.mlsNumber, threadTs: ts, dryRun }, null, 2));
    return;
  }

  const postedRecord = !forcePost ? await readPostedReviewRecord(channel, asString(data.mlsNumber)).catch(() => null) : null;
  const recoveredThreadTs = postedRecord ? asString(postedRecord.record.threadTs) : "";
  if (recoveredThreadTs && !forcePost) {
    if (!dryRun) {
      const nextRow = await updateEvaluationSummaryRow(row, { Status: "posted", "Slack Timestamp": recoveredThreadTs });
      await upsertThreadContext({
        threadTs: recoveredThreadTs,
        row: nextRow,
        data,
        slackChannelId: channel,
        event: {
          kind: "posted-recovery",
          note: "Recovered existing Slack review post from local post ledger.",
          status: "posted",
          version: Number(nextRow.Version),
        },
      });
    }
    console.log(JSON.stringify({
      ok: true,
      action: "recovered_existing_post",
      mlsNumber: data.mlsNumber,
      threadTs: recoveredThreadTs,
      postedRecordPath: postedRecord?.path || "",
      dryRun,
    }, null, 2));
    return;
  }

  if (!dryRun) {
    if (threadTs) {
      const { reply } = await import("../slack.ts");
      await reply(channel, threadTs, text);
      ts = threadTs;
    } else {
      const result = await post(channel, text);
      ts = asString((result as any)?.ts || ts);
    }

    if (ts) {
      await savePostedReviewRecord({
        channel,
        mlsNumber: asString(data.mlsNumber),
        threadTs: ts,
        source: "post-review",
        evalId: asString(row["Eval ID"]),
        version: Number(row.Version),
      });
    }
    const nextRow = await updateEvaluationSummaryRow(row, { Status: "posted", "Slack Timestamp": ts });
    await upsertThreadContext({
      threadTs: ts,
      row: nextRow,
      data,
      slackChannelId: channel,
      event: {
        kind: "posted",
        note: "Evaluation review posted to Slack.",
        status: "posted",
        version: Number(nextRow.Version),
      },
    });
  }

  console.log(JSON.stringify({ ok: true, action: forcePost ? "reposted" : "post_review", mlsNumber: data.mlsNumber, threadTs: ts, dryRun }, null, 2));
}

await main();
