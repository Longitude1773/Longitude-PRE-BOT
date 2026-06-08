import { spawnSync } from "node:child_process";

import { asString, pdfPathForEval, resolveEvaluationByThread, resolveEvaluationByMls, updateEvaluationSummaryRow, upsertThreadContext } from "./lib.ts";
import { upload } from "../slack.ts";

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
    const nextRow = await updateEvaluationSummaryRow(row, {
      Status: "approved",
      "PDF Path": pdfPath,
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
  }

  console.log(JSON.stringify({
    ok: true,
    action: "approved",
    mlsNumber: data.mlsNumber,
    threadTs: targetThreadTs,
    pdfPath,
    dryRun,
  }, null, 2));
}

await main();
