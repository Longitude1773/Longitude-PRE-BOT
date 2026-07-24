import { spawnSync } from "node:child_process";

import { asString, pdfPathForEval, r2KeyForEval, resolveEvaluationByThread, resolveEvaluationByMls, updateEvaluationSummaryRow, upsertThreadContext } from "./lib.ts";
import { reply, upload } from "../slack.ts";
import { uploadPdfToR2 } from "../r2.ts";
import { createAgentTaskForListing, type CreateAgentTaskResult } from "../hubspot-agent-task.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const channel = argValue("--channel") || process.env.SLACK_CHANNEL_ID;
  const threadTs = argValue("--thread-ts");
  const mls = argValue("--mls");
  const dryRun = process.argv.includes("--dry-run");

  if (!channel) throw new Error("Missing --channel or SLACK_CHANNEL_ID.");
  if (!threadTs && !mls) throw new Error("Pass --thread-ts or --mls.");

  const resolved = threadTs
    ? await resolveEvaluationByThread(threadTs)
    : await resolveEvaluationByMls(asString(mls));
  if (!resolved) throw new Error("Evaluation not found.");

  const { row, path, data } = resolved;
  let hubspot: CreateAgentTaskResult | { ok: false; reason: string } | undefined;
  // Name the PDF after the street address (house number, street, unit) rather
  // than the MLS#/ZPID. Recomputed here so the generated file + Slack upload
  // always match the address even if an older row stored an id-based path.
  const pdfPath = pdfPathForEval(data);
  const targetThreadTs = threadTs || asString(row["Slack Timestamp"]);

  if (!dryRun) {
    const result = spawnSync("npx", ["tsx", "scripts/generate-pdf.ts", path, pdfPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "PDF generation failed.");
    }

    await upload(channel, pdfPath, `Revenue Evaluation - ${data.address || data.mlsNumber}`, targetThreadTs);

    // Upload the generated PDF to R2. The DB stores the R2 object key (not the
    // local path); a populated pdf_path means "a downloadable PDF exists".
    const createdAt = asString(row["Created At"]) || new Date().toISOString();
    const r2Key = r2KeyForEval({ address: data.address, mlsNumber: data.mlsNumber, createdAt });
    await uploadPdfToR2(r2Key, pdfPath);

    const nextRow = await updateEvaluationSummaryRow(row, {
      Status: "approved",
      "PDF Path": r2Key,
    });
    if (targetThreadTs) {
      await upsertThreadContext({
        threadTs: targetThreadTs,
        row: nextRow,
        data,
        slackChannelId: channel,
        event: {
          kind: "approved",
          action: "approve",
          note: "Generated PDF and uploaded it to the review thread.",
          status: "approved",
          version: Number(nextRow.Version),
        },
      });
    }

    // Best-effort HubSpot: upsert the listing agent contact + create a reminder
    // task. Runs LAST so a HubSpot failure can never undo the approval, PDF,
    // R2 upload, or status flip — all already done above. Never throws out of
    // here; a genuine failure posts a ⚠️ note to the thread but the approve
    // still succeeds. Operates on the exact resolved Eval ID (no version
    // ambiguity), and is idempotent on that row's hubspot_task_id.
    try {
      const result = await createAgentTaskForListing({ evalId: asString(row["Eval ID"]) });
      hubspot = result;
      // Speak up only when it's actionable: a genuine skip we'd want to fix
      // (no agent email captured) or a write-back that didn't persist. Silent
      // on by-design skips (wrong-source, already-exists).
      if (targetThreadTs && result.skipped === "no-agent-email") {
        await reply(channel, targetThreadTs, `⚠️ No HubSpot task — ${result.reason}`);
      } else if (targetThreadTs && result.writeBackFailed && result.taskUrl) {
        await reply(
          channel,
          targetThreadTs,
          `⚠️ HubSpot task created (${result.taskUrl}) but ids were not saved to Supabase — ` +
            `run the hubspot-writeback columns migration.`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      hubspot = { ok: false, reason };
      console.error(`HubSpot task step failed (non-blocking): ${reason}`);
      if (targetThreadTs) {
        await reply(channel, targetThreadTs, `⚠️ HubSpot task not created — ${reason}`);
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "approved",
    mlsNumber: data.mlsNumber,
    threadTs: targetThreadTs,
    pdfPath,
    dryRun,
    hubspot,
  }, null, 2));
}

await main();
