import { spawnSync } from "node:child_process";

import { asString, pdfPathForEval, r2KeyForEval, resolveEvaluationByThread, resolveEvaluationByMls, updateEvaluationSummaryRow, upsertThreadContext } from "./lib.ts";
import { upload } from "../slack.ts";
import { uploadPdfToR2 } from "../r2.ts";

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
