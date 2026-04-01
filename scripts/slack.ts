/**
 * Slack API utility — CLI tool for the Claude Code agent to interact with Slack.
 *
 * Usage:
 *   tsx scripts/slack.ts post <channel> <text> [blocks-json]
 *   tsx scripts/slack.ts reply <channel> <thread_ts> <text>
 *   tsx scripts/slack.ts upload <channel> <file_path> [title] [thread_ts]
 *   tsx scripts/slack.ts reactions <channel> <ts>
 *   tsx scripts/slack.ts replies <channel> <ts>
 *   tsx scripts/slack.ts history <channel> [limit]
 */

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN!;
const BASE = "https://slack.com/api";

async function slackApi(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Slack API error (${method}): ${data.error}`);
    process.exit(1);
  }
  return data;
}

async function slackUpload(method: string, formData: FormData) {
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    body: formData,
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Slack API error (${method}): ${data.error}`);
    process.exit(1);
  }
  return data;
}

async function post(channel: string, text: string, blocksJson?: string) {
  const body: Record<string, unknown> = { channel, text };
  if (blocksJson) {
    body.blocks = JSON.parse(blocksJson);
  }
  const data = await slackApi("chat.postMessage", body);
  console.log(JSON.stringify({ ts: data.ts, channel: data.channel }));
}

async function reply(channel: string, threadTs: string, text: string) {
  const data = await slackApi("chat.postMessage", {
    channel,
    text,
    thread_ts: threadTs,
  });
  console.log(JSON.stringify({ ts: data.ts, channel: data.channel }));
}

async function upload(
  channel: string,
  filePath: string,
  title?: string,
  threadTs?: string
) {
  const { readFileSync } = await import("fs");
  const { basename } = await import("path");
  const fileData = readFileSync(filePath);
  const fileName = basename(filePath);

  // Step 1: Get upload URL (this endpoint requires form-urlencoded, not JSON)
  const params = new URLSearchParams();
  params.set("filename", fileName);
  params.set("length", String(fileData.length));
  const urlRaw = await fetch(`${BASE}/files.getUploadURLExternal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const urlRes = await urlRaw.json();
  if (!urlRes.ok) {
    console.error(`Slack API error (files.getUploadURLExternal): ${urlRes.error}`);
    process.exit(1);
  }

  // Step 2: Upload file content
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([fileData]), fileName);
  await fetch(urlRes.upload_url, { method: "POST", body: uploadForm });

  // Step 3: Complete upload
  const channelId = channel;
  const completeBody: Record<string, unknown> = {
    files: [{ id: urlRes.file_id, title: title || fileName }],
    channel_id: channelId,
  };
  if (threadTs) {
    completeBody.thread_ts = threadTs;
  }
  await slackApi("files.completeUploadExternal", completeBody);
  console.log(JSON.stringify({ file_id: urlRes.file_id }));
}

async function reactions(channel: string, ts: string) {
  const data = await slackApi("reactions.get", {
    channel,
    timestamp: ts,
    full: true,
  });
  console.log(JSON.stringify(data.message?.reactions || []));
}

async function replies(channel: string, ts: string) {
  const data = await slackApi("conversations.replies", {
    channel,
    ts,
    limit: 100,
  });
  const messages = (data.messages || []).slice(1).map((m: any) => ({
    user: m.user,
    text: m.text,
    ts: m.ts,
    bot_id: m.bot_id,
  }));
  console.log(JSON.stringify(messages, null, 2));
}

async function history(channel: string, limit?: string) {
  const data = await slackApi("conversations.history", {
    channel,
    limit: parseInt(limit || "20"),
  });
  const messages = (data.messages || []).map((m: any) => ({
    user: m.user,
    text: m.text,
    ts: m.ts,
    thread_ts: m.thread_ts,
    reply_count: m.reply_count,
    bot_id: m.bot_id,
  }));
  console.log(JSON.stringify(messages, null, 2));
}

// CLI entrypoint
const [, , command, ...args] = process.argv;

switch (command) {
  case "post":
    await post(args[0], args[1], args[2]);
    break;
  case "reply":
    await reply(args[0], args[1], args[2]);
    break;
  case "upload":
    await upload(args[0], args[1], args[2], args[3]);
    break;
  case "reactions":
    await reactions(args[0], args[1]);
    break;
  case "replies":
    await replies(args[0], args[1]);
    break;
  case "history":
    await history(args[0], args[1]);
    break;
  default:
    console.error(
      "Usage: tsx scripts/slack.ts <post|reply|upload|reactions|replies|history> ..."
    );
    process.exit(1);
}
