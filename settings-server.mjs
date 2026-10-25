// Settings API for the dashboard's settings page. nginx serves it at /api/ behind the dashboard's
// password. It reads and writes the access settings (data/access.json), which the agent reads
// again for every mention, so a saved change applies from the next one.
//   GET /api/settings   the settings, and what the page shows from .env (bot, owner, backends)
//   PUT /api/settings   replace the settings: {settings, base}, where base is the updated_at the
//                       page loaded, so a change saved elsewhere in the meantime isn't overwritten
// Run with node (no dependencies). It listens on 127.0.0.1 only.
import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SETTINGS_PORT || 9098);
const MAX_BODY = 64 * 1024;

const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The few .env settings this needs, read on every request so a change to .env shows up. Values
// that use shell expansion are skipped, and their defaults used instead.
async function agentEnv() {
  const env = {};
  let text = "";
  try {
    text = await readFile(join(AGENT_DIR, ".env"), "utf8");
  } catch {
    // No .env: the defaults below
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?(BOT_USER|ADMIN_USER|AI_BACKENDS|DATA_DIR|ACCESS_FILE)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (!value.includes("$")) env[match[1]] = value;
  }
  // Relative paths are relative to the agent's directory, its working directory
  const dataDir = resolve(AGENT_DIR, env.DATA_DIR || "data");
  return {
    bot: env.BOT_USER || "",
    owner: env.ADMIN_USER || "",
    backends: (env.AI_BACKENDS || "claude-cli claude-api").split(/\s+/).filter(Boolean),
    accessFile: resolve(AGENT_DIR, env.ACCESS_FILE || join(dataDir, "access.json")),
  };
}

class BadRequest extends Error {}

// Names in the order given, without repeats (compared case-insensitively) or the excluded name
function users(list, what, exclude = "") {
  if (!Array.isArray(list)) throw new BadRequest(`${what} must be a list`);
  if (list.length > 500) throw new BadRequest(`${what}: at most 500 names`);
  const seen = new Set([exclude.toLowerCase()]);
  const result = [];
  for (const raw of list) {
    const name = String(raw).trim().replace(/^@/, "");
    if (!USER_RE.test(name)) throw new BadRequest(`${what}: "${name}" isn't a GitHub username`);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push(name);
  }
  return result;
}

function models(entry, role) {
  if (!entry || typeof entry !== "object") throw new BadRequest(`Models for ${role}s are missing`);
  const list = Array.isArray(entry.models) ? [...new Set(entry.models.map(String))] : [];
  if (list.length < 1 || list.length > 5) throw new BadRequest(`${role}s need a model, and at most 4 fallbacks`);
  for (const model of list) {
    if (!MODEL_RE.test(model)) throw new BadRequest(`"${model}" isn't a model ID`);
  }
  if (!EFFORTS.includes(entry.effort)) throw new BadRequest(`Effort for ${role}s must be one of ${EFFORTS.join(", ")}`);
  return { models: list, effort: entry.effort };
}

// The settings to save, checked and tidied, or a BadRequest saying what is wrong
function checkSettings(input, owner) {
  if (!input || typeof input !== "object") throw new BadRequest("The settings are missing");
  const limit = input.contributor_daily_limit;
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    throw new BadRequest("Reviews per contributor per day must be a whole number from 0 to 1000");
  }
  if (!Array.isArray(input.repos) || input.repos.length > 200) throw new BadRequest("Repos must be a list of at most 200");
  const seen = new Set();
  const repos = [];
  for (const entry of input.repos) {
    const repo = String(entry?.repo || "").trim();
    if (!REPO_RE.test(repo)) throw new BadRequest(`"${repo}" isn't a repo name like owner/repo`);
    if (seen.has(repo.toLowerCase())) throw new BadRequest(`${repo} is listed twice`);
    seen.add(repo.toLowerCase());
    if (entry.who !== "anyone" && entry.who !== "listed") throw new BadRequest(`${repo}: choose who can ask`);
    repos.push({ repo, who: entry.who, users: users(entry.users || [], repo) });
  }
  return {
    admins: users(input.admins || [], "Admins", owner),
    repos,
    contributor_daily_limit: limit,
    models: {
      admin: models(input.models?.admin, "admin"),
      contributor: models(input.models?.contributor, "contributor"),
    },
  };
}

async function readSettings(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY) reject(new BadRequest("The settings are too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// Only the dashboard page may save: a JSON body can't be sent from another site without a CORS
// preflight, which this never answers, and browsers say where a request came from
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return false;
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"];
  return !origin || !host || origin === `https://${host}`;
}

async function handle(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path !== "/api/settings") return send(res, 404, { error: "Not found" });
  const env = await agentEnv();
  const info = { bot: env.bot, owner: env.owner, backends: env.backends };

  if (req.method === "GET") {
    const settings = await readSettings(env.accessFile);
    if (!settings) return send(res, 503, { error: "The agent hasn't written its settings yet. Start review-agent.service once.", info });
    return send(res, 200, { settings, info });
  }

  if (req.method === "PUT") {
    if (!sameOrigin(req)) return send(res, 403, { error: "Settings can only be saved from the dashboard" });
    if (!/^application\/json\b/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Send JSON" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof BadRequest) throw error;
      throw new BadRequest("The request isn't valid JSON");
    }
    const settings = checkSettings(body?.settings, env.owner);
    const current = await readSettings(env.accessFile);
    if ((current?.updated_at || null) !== (body.base || null)) {
      return send(res, 409, { error: "The settings were changed somewhere else since this page loaded them. Reload to see them, then make your change again." });
    }
    settings.updated_at = new Date().toISOString();
    settings.updated_by = String(req.headers["x-remote-user"] || "").slice(0, 100) || null;
    // Write a new file and rename it over the old one, so the agent never reads half a file
    const tmp = `${env.accessFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, env.accessFile);
    console.log(`Saved by ${settings.updated_by || "unknown"}: ${settings.admins.length} admins, ${settings.repos.length} repos`);
    return send(res, 200, { settings, info });
  }

  res.setHeader("allow", "GET, PUT");
  return send(res, 405, { error: "Use GET or PUT" });
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof BadRequest) return send(res, 400, { error: error.message });
    console.error(error);
    send(res, 500, { error: "The settings couldn't be read or saved; see journalctl --user -u review-agent-settings" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Settings API listening on 127.0.0.1:${PORT}`));
