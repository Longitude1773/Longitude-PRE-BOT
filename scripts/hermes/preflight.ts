import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");
const requiredEnv = [
  "HERMES_AGENT_DIR",
  "STR_BOT_DIR",
  "SYSTEM_PROMPT_FILE",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
] as const;

const recommendedEnv = [
  "SLACK_CHANNEL_ID",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
] as const;

const requiredFiles = [
  resolve(repoRoot, "HERMES.md"),
  resolve(repoRoot, "scripts/sheets.ts"),
  resolve(repoRoot, "scripts/slack.ts"),
  resolve(repoRoot, "scripts/generate-pdf.ts"),
  resolve(repoRoot, "data/market-knowledge.md"),
] as const;

const missingEnv = requiredEnv.filter((key) => !process.env[key] || String(process.env[key]).trim() === "");
const missingFiles = requiredFiles.filter((filePath) => !existsSync(filePath));
const recommendedMissing = recommendedEnv.filter((key) => !process.env[key] || String(process.env[key]).trim() === "");

const resolvedProjectDir = resolve(process.env.STR_BOT_DIR || repoRoot);
const resolvedPromptFile = process.env.SYSTEM_PROMPT_FILE ? resolve(process.env.SYSTEM_PROMPT_FILE) : "";
const promptFileExists = resolvedPromptFile ? existsSync(resolvedPromptFile) : false;
const projectDirMatchesRepo = resolvedProjectDir === repoRoot;
const gatewayEntry = process.env.HERMES_AGENT_DIR
  ? resolve(process.env.HERMES_AGENT_DIR, "gateway/run.py")
  : "";
const gatewayEntryExists = gatewayEntry ? existsSync(gatewayEntry) : false;
const gatewayEntryHasConflictMarkers =
  gatewayEntryExists &&
  /^(<<<<<<< |=======|>>>>>>> )/m.test(readFileSync(gatewayEntry, "utf8"));

function checkPythonModule(moduleName: string) {
  try {
    execFileSync("python3", ["-c", `import ${moduleName}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const pythonChecks = {
  dotenv: checkPythonModule("dotenv"),
  firecrawl: checkPythonModule("firecrawl"),
  slack_bolt: checkPythonModule("slack_bolt"),
};

const summary = {
  ok:
    missingEnv.length === 0 &&
    missingFiles.length === 0 &&
    promptFileExists &&
    projectDirMatchesRepo &&
    gatewayEntryExists &&
    !gatewayEntryHasConflictMarkers &&
    Object.values(pythonChecks).every(Boolean),
  repoRoot,
  projectDir: resolvedProjectDir,
  projectDirMatchesRepo,
  systemPromptFile: resolvedPromptFile,
  promptFileExists,
  gatewayEntry,
  gatewayEntryExists,
  gatewayEntryHasConflictMarkers,
  pythonChecks,
  missingEnv,
  missingFiles,
  recommendedMissing,
};

if (!summary.ok) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(summary, null, 2));
