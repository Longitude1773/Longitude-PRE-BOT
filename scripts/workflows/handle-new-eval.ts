import {
  loadEvalData,
  pdfPathForEval,
  resolveEvaluationByMls,
  writeEvaluationVersion,
  asString,
  logSlackEvent,
  readPostedReviewRecord,
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
  const source = argValue("--source") || "new_listing";
  const forcePost = process.argv.includes("--force-post");
  const dryRun = process.argv.includes("--dry-run");

  if (!mls) throw new Error("Usage: tsx scripts/workflows/handle-new-eval.ts --mls <mls> [--channel <id>] [--thread-ts <ts>] [--source new_listing] [--force-post] [--dry-run]");
  if (!channel) throw new Error("Missing --channel or SLACK_CHANNEL_ID.");

  const eventPath = await logSlackEvent("new-eval", {
    mls,
    channel,
    threadTs,
    source,
    forcePost,
    dryRun,
    receivedAt: new Date().toISOString(),
  });

  const evalFile = await loadEvalData(mls);
  let resolved = await resolveEvaluationByMls(mls);
  let createdEvalId = "";
  let createdVersion = 0;

  if (!resolved) {
    if (!dryRun) {
      const rows = await writeEvaluationVersion(evalFile.data, {
        source,
        status: "pending_review",
        version: "1",
        "pdf-path": pdfPathForEval(evalFile.data),
      });
      createdEvalId = asString(rows.evalId);
      createdVersion = 1;
      resolved = await resolveEvaluationByMls(mls);
    } else {
      createdVersion = 1;
    }
  }

  if (!resolved && !dryRun) throw new Error(`Could not resolve evaluation for MLS ${mls} after writing sheet rows.`);

  const existingThreadTs = resolved ? asString(resolved.row["Slack Timestamp"]) : "";
  if (existingThreadTs && !forcePost) {
    console.log(JSON.stringify({
      ok: true,
      action: "already_posted",
      mlsNumber: mls,
      evalId: resolved ? asString(resolved.row["Eval ID"]) : createdEvalId,
      version: resolved ? Number(resolved.row.Version) : createdVersion,
      threadTs: existingThreadTs,
      eventPath,
      dryRun,
    }, null, 2));
    return;
  }

  const postedRecord = !forcePost ? await readPostedReviewRecord(channel, mls).catch(() => null) : null;
  const recoveredThreadTs = postedRecord ? asString(postedRecord.record.threadTs) : "";
  if (recoveredThreadTs && !forcePost) {
    if (!dryRun && resolved) {
      const nextRow = await updateEvaluationSummaryRow(resolved.row, { Status: "posted", "Slack Timestamp": recoveredThreadTs });
      await upsertThreadContext({
        threadTs: recoveredThreadTs,
        row: nextRow,
        data: resolved.data,
        slackChannelId: channel,
        event: {
          kind: "posted-recovery",
          note: "Recovered existing Slack review post from local post ledger.",
          status: "posted",
          version: Number(nextRow.Version),
          eventPath,
        },
      });
    }
    console.log(JSON.stringify({
      ok: true,
      action: "recovered_existing_post",
      mlsNumber: mls,
      evalId: resolved ? asString(resolved.row["Eval ID"]) : createdEvalId,
      version: resolved ? Number(resolved.row.Version) : createdVersion,
      threadTs: recoveredThreadTs,
      postedRecordPath: postedRecord?.path || "",
      eventPath,
      dryRun,
    }, null, 2));
    return;
  }

  let postedThreadTs = existingThreadTs;
  if (!dryRun) {
    const { post, reply } = await import("../slack.ts");
    const { buildReviewMessage } = await import("./lib.ts");
    const active = resolved!;
    const data = active.data;
    const text = await buildReviewMessage(data);

    if (threadTs) {
      await reply(channel, threadTs, text);
      postedThreadTs = threadTs;
    } else {
      const result = await post(channel, text);
      postedThreadTs = asString((result as any)?.ts || "");
    }

    if (postedThreadTs) {
      await savePostedReviewRecord({
        channel,
        mlsNumber: mls,
        threadTs: postedThreadTs,
        source,
        eventPath,
        evalId: asString(active.row["Eval ID"]),
        version: Number(active.row.Version),
      });
    }
    const nextRow = await updateEvaluationSummaryRow(active.row, { Status: "posted", "Slack Timestamp": postedThreadTs });
    await upsertThreadContext({
      threadTs: postedThreadTs,
      row: nextRow,
      data,
      slackChannelId: channel,
      event: {
        kind: "posted",
        note: "Initial evaluation review posted to Slack.",
        status: "posted",
        version: Number(nextRow.Version),
        eventPath,
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    action: existingThreadTs && forcePost ? "reposted" : "posted",
    mlsNumber: mls,
    evalId: resolved ? asString(resolved.row["Eval ID"]) : createdEvalId,
    version: resolved ? Number(resolved.row.Version) : createdVersion,
    threadTs: postedThreadTs,
    eventPath,
    dryRun,
  }, null, 2));
}

await main();
