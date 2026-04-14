import {
  asString,
  buildThreadContextRecord,
  readThreadContext,
  resolveEvaluationByMls,
  resolveEvaluationByThread,
  upsertThreadContext,
} from "./lib.ts";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const threadTs = argValue("--thread-ts");
  const mls = argValue("--mls");
  const refresh = process.argv.includes("--refresh");

  if (!threadTs && !mls) {
    throw new Error("Usage: tsx scripts/workflows/thread-context.ts (--thread-ts <ts> | --mls <mls>) [--refresh]");
  }

  if (threadTs && !refresh) {
    const existing = await readThreadContext(threadTs);
    if (existing) {
      console.log(JSON.stringify({ ok: true, source: "thread-context-file", path: existing.path, context: existing.context }, null, 2));
      return;
    }
  }

  const resolved = threadTs
    ? await resolveEvaluationByThread(threadTs)
    : await resolveEvaluationByMls(asString(mls));

  if (!resolved) {
    throw new Error(`No evaluation found for ${threadTs ? `thread ${threadTs}` : `MLS ${mls}`}.`);
  }

  const derivedThreadTs = threadTs || asString(resolved.row["Slack Timestamp"]);
  const context = buildThreadContextRecord(derivedThreadTs, resolved.row, resolved.data);

  if (derivedThreadTs) {
    const saved = await upsertThreadContext({
      threadTs: derivedThreadTs,
      row: resolved.row,
      data: resolved.data,
      event: {
        kind: "context-refresh",
        note: "Thread context refreshed from canonical evaluation artifacts.",
        status: asString(resolved.row.Status),
        version: Number(resolved.row.Version),
      },
    });
    console.log(JSON.stringify({ ok: true, source: "refreshed", path: saved.path, context: saved.context }, null, 2));
    return;
  }

  console.log(JSON.stringify({ ok: true, source: "derived", context }, null, 2));
}

await main();
