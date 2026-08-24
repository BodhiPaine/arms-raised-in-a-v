#!/usr/bin/env node
// Pulls all toots for a Mastodon account via the public REST API and writes
// each one as an individual Obsidian-flavored Markdown note.
//
// Config (env vars, all can also go in a local .env-style export before running):
//   MASTODON_INSTANCE   e.g. "mastodon.social" (no protocol, no trailing slash)
//   MASTODON_USERNAME   e.g. "bodhipaine" (no leading @)
//   MASTODON_OUT_DIR    default "Mastodon"
//   MASTODON_EXCLUDE_REPLIES  "true" to skip replies (default "false")
//   MASTODON_EXCLUDE_REBLOGS  "true" to skip boosts (default "true")
//
// Only fetches public data via the unauthenticated API, so it only ever
// sees what anyone can already see on the profile.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INSTANCE = requireEnv("MASTODON_INSTANCE");
const USERNAME = requireEnv("MASTODON_USERNAME").replace(/^@/, "");
const OUT_DIR = process.env.MASTODON_OUT_DIR || "Mastodon";
const EXCLUDE_REPLIES = (process.env.MASTODON_EXCLUDE_REPLIES || "false") === "true";
const EXCLUDE_REBLOGS = (process.env.MASTODON_EXCLUDE_REBLOGS || "true") === "true";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing required env var ${name}. Set MASTODON_INSTANCE and MASTODON_USERNAME before running.\n` +
        `Example: MASTODON_INSTANCE=mastodon.social MASTODON_USERNAME=bodhipaine node scripts/sync-mastodon-toots.mjs`
    );
    process.exit(1);
  }
  return value;
}

const API_BASE = `https://${INSTANCE}/api/v1`;

async function apiGet(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "arms-raised-in-a-v-mastodon-sync" },
  });
  if (!res.ok) {
    throw new Error(`Mastodon API request failed (${res.status} ${res.statusText}): ${url}`);
  }
  return res;
}

async function lookupAccountId(username) {
  const res = await apiGet(`${API_BASE}/accounts/lookup?acct=${encodeURIComponent(username)}`);
  const account = await res.json();
  if (!account.id) {
    throw new Error(`Could not find account "${username}" on ${INSTANCE}`);
  }
  return account.id;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [, url, rel] = part.match(/<([^>]+)>;\s*rel="([^"]+)"/) || [];
    if (rel === "next") return url;
  }
  return null;
}

async function fetchAllStatuses(accountId) {
  const statuses = [];
  let url =
    `${API_BASE}/accounts/${accountId}/statuses?limit=40` +
    `&exclude_replies=${EXCLUDE_REPLIES}&exclude_reblogs=${EXCLUDE_REBLOGS}`;

  while (url) {
    const res = await apiGet(url);
    const batch = await res.json();
    if (batch.length === 0) break;
    statuses.push(...batch);
    url = parseNextLink(res.headers.get("link"));
  }
  return statuses;
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text) {
  return text.replace(/&(#39|#x27|amp|lt|gt|quot|apos|nbsp|#\d+);/g, (match, entity) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? match;
  });
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).trim();
}

// Mastodon status HTML is simple and server-generated (paragraphs, <br>,
// and anchors for links/mentions/hashtags), so a small regex pass is enough
// to turn it into readable Markdown without pulling in an HTML parser dep.
function htmlToMarkdown(html) {
  if (!html) return "";
  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/^<p>/i, "")
    .replace(/<\/p>$/i, "");

  text = text.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, (_match, href, inner) => {
    const label = stripTags(inner);
    return `[${label}](${href})`;
  });

  text = stripTags(text);
  return text.trim();
}

function slugifyTitle(text, maxLen = 80) {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) || "Untitled toot";
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 1).trim()}…` : firstLine;
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlList(values) {
  if (values.length === 0) return "[]";
  return `[${values.map(yamlString).join(", ")}]`;
}

function buildNote(status) {
  const bodySource = status.spoiler_text ? status.spoiler_text : status.content;
  const markdownBody = htmlToMarkdown(bodySource);
  const plainText = stripTags(bodySource);
  const title = slugifyTitle(plainText || status.spoiler_text || "Untitled toot");
  const tags = ["mastodon", ...status.tags.map((t) => t.name)];
  const date = status.created_at.slice(0, 10);

  const mediaLines = status.media_attachments.map((media) => {
    const alt = media.description ? media.description.replace(/\n/g, " ") : media.type;
    return media.type === "image" ? `![${alt}](${media.url})` : `[${alt}](${media.url})`;
  });

  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `date: ${status.created_at}`,
    `mastodon_id: ${yamlString(status.id)}`,
    `url: ${yamlString(status.url || status.uri)}`,
    `tags: ${yamlList(tags)}`,
    `visibility: ${yamlString(status.visibility)}`,
    `reblog: ${Boolean(status.reblog)}`,
    "---",
    "",
  ].join("\n");

  let body = markdownBody || "*(no text content)*";
  if (status.spoiler_text) {
    body = `> ${status.spoiler_text}\n\n${htmlToMarkdown(status.content)}`;
  }
  if (mediaLines.length > 0) {
    body += `\n\n${mediaLines.join("\n\n")}`;
  }
  body += `\n\n[View on Mastodon](${status.url || status.uri})\n`;

  return { filename: `${date}-${status.id}.md`, content: frontmatter + body };
}

async function main() {
  const outPath = path.resolve(process.cwd(), OUT_DIR);
  await mkdir(outPath, { recursive: true });

  const existing = new Set(
    (await readdir(outPath)).filter((f) => f.endsWith(".md")).map((f) => f)
  );

  console.log(`Looking up @${USERNAME}@${INSTANCE}...`);
  const accountId = await lookupAccountId(USERNAME);

  console.log("Fetching all statuses (this paginates through your full history)...");
  const statuses = await fetchAllStatuses(accountId);
  console.log(`Fetched ${statuses.length} statuses.`);

  let written = 0;
  let skipped = 0;
  for (const status of statuses) {
    const note = buildNote(status);
    if (existing.has(note.filename)) {
      skipped += 1;
      continue;
    }
    await writeFile(path.join(outPath, note.filename), note.content, "utf8");
    written += 1;
  }

  console.log(`Done. Wrote ${written} new note(s), skipped ${skipped} already-synced toot(s).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
