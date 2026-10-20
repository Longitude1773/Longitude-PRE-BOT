/**
 * Prune the watcher's debug snapshots. Every scan writes several HTML frames per
 * listing to data/inbox/html-debug and nothing ever removed them (609k files /
 * 52 GB by 2026-10-20). They exist only for after-the-fact debugging, so keep a
 * short window.
 *
 * MHTML is different: heal-mls-links.ts re-reads the files named in the link
 * healing queue, so anything that queue references is kept regardless of age.
 *
 *   npx tsx scripts/prune-debug-artifacts.ts --dry-run
 *   npx tsx scripts/prune-debug-artifacts.ts [--html-days 7] [--mhtml-days 14]
 */
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const inboxDir = resolve(repoRoot, "data/inbox");
const htmlDebugDir = resolve(inboxDir, "html-debug");
const mhtmlDir = resolve(inboxDir, "mhtml");
const healingQueueFile = resolve(inboxDir, "mls-link-healing-queue.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
function numberArg(name: string, fallback: number) {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
const htmlDays = numberArg("--html-days", 7);
const mhtmlDays = numberArg("--mhtml-days", 14);

/** Snapshot names start with safeTimestamp(): 2026-07-06T18-28-43-582Z-... */
function timestampFromName(name: string) {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  return Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
}

async function prune(dir: string, maxAgeDays: number, keep: Set<string>) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  let kept = 0;
  for (const name of names) {
    if (keep.has(name)) {
      kept += 1;
      continue;
    }
    const path = resolve(dir, name);
    const createdAt = timestampFromName(name) ?? (await stat(path).then((s) => s.mtimeMs).catch(() => Date.now()));
    if (createdAt >= cutoff) {
      kept += 1;
      continue;
    }
    if (!dryRun) await unlink(path).catch(() => {});
    removed += 1;
  }
  return { dir, maxAgeDays, scanned: names.length, removed, kept };
}

async function referencedMhtml() {
  const raw = await readFile(healingQueueFile, "utf8").catch(() => "");
  return new Set([...raw.matchAll(/mhtml\/([^"/]+\.mhtml)/g)].map((match) => match[1]));
}

const summary = {
  dryRun,
  html: await prune(htmlDebugDir, htmlDays, new Set()),
  mhtml: await prune(mhtmlDir, mhtmlDays, await referencedMhtml()),
};
console.log(JSON.stringify(summary));
