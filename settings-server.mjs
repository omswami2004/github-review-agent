// Settings API for the dashboard's settings page. nginx serves it at /api/ behind the dashboard's
// password. It reads and writes the access settings (data/access.json), which the agent reads
// again for every mention, so a saved change applies from the next one.
//   GET /api/settings   the settings, and what the page shows from .env (bot, owner, backends,
//                       agy's models, and whether an API key is set)
//   PUT /api/settings   replace the settings: {settings, base}, where base is the updated_at the
//                       page loaded, so a change saved elsewhere in the meantime isn't overwritten
//   PUT /api/api-key    save the Claude API key: {key}. It is checked with Anthropic first, then
//                       written to API_KEY_FILE (data/secrets/anthropic-api-key.json), mode 600 in
//                       a mode 700 folder. The agent reads it for every reply, so no restart.
//   DELETE /api/api-key remove the saved key (ANTHROPIC_API_KEY in .env is used again, if set)
// No answer ever contains the key: only where it came from and its last four characters.
// Run with node (no dependencies). It listens on 127.0.0.1 only.
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SETTINGS_PORT || 9098);
const MAX_BODY = 64 * 1024;

const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// The methods a reply can be written with. agy can't be limited to reading files, so it never
// answers a contributor.
const BACKENDS = ["claude-cli", "claude-api", "agy"];
const CONTRIBUTOR_BACKENDS = ["claude-cli", "claude-api"];
// Anthropic API keys look like sk-ant-api03-...; the exact form is left to Anthropic's check
const API_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const ANTHROPIC_VERSION = "2026-10-21";

// The few .env settings this needs, read on every request so a change to .env shows up. Values
// that use shell expansion are skipped, and their defaults used instead. Of ANTHROPIC_API_KEY,
// only whether it is set and its last four characters are kept.
async function agentEnv() {
  const env = {};
  let text = "";
  try {
    text = await readFile(join(AGENT_DIR, ".env"), "utf8");
  } catch {
    // No .env: the defaults below
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?(BOT_USER|ADMIN_USER|AI_BACKENDS|AGY_MODELS|DATA_DIR|ACCESS_FILE|API_KEY_FILE|ANTHROPIC_API_KEY)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (match[1] === "ANTHROPIC_API_KEY") env.envKey = value === "" ? null : value.includes("$") ? "" : value.slice(-4);
    else if (!value.includes("$")) env[match[1]] = value;
  }
  // Relative paths are relative to the agent's directory, its working directory
  const dataDir = resolve(AGENT_DIR, env.DATA_DIR || "data");
  return {
    bot: env.BOT_USER || "",
    owner: env.ADMIN_USER || "",
    backends: (env.AI_BACKENDS || "claude-cli claude-api").split(/\s+/).filter(Boolean),
    agyModels: (env.AGY_MODELS || "gemini-3.8-flash-high claude-opus-4-6-thinking claude-sonnet-4-6").split(/\s+/).filter(Boolean),
    // The last four characters of ANTHROPIC_API_KEY in .env, "" if they can't be known, or null
    envKey: env.envKey ?? null,
    accessFile: resolve(AGENT_DIR, env.ACCESS_FILE || join(dataDir, "access.json")),
    apiKeyFile: resolve(AGENT_DIR, env.API_KEY_FILE || join(dataDir, "secrets", "anthropic-api-key.json")),
  };
}

// An error to answer with: 400 for a request that can't be done as sent
class BadRequest extends Error {
  status = 400;
}
// 502: Anthropic couldn't be asked whether the key works
class UpstreamError extends BadRequest {
  status = 502;
}

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
  const result = { models: list, effort: entry.effort };
  // The methods, a default and fallbacks. Without them the agent uses AI_BACKENDS from .env.
  if (entry.backends !== undefined) {
    const allowed = role === "contributor" ? CONTRIBUTOR_BACKENDS : BACKENDS;
    const backends = Array.isArray(entry.backends) ? [...new Set(entry.backends.map(String))] : [];
    if (backends.length < 1 || backends.length > allowed.length) throw new BadRequest(`${role}s need a method`);
    for (const backend of backends) {
      if (!allowed.includes(backend)) {
        throw new BadRequest(backend === "agy" ? "Contributors can't use agy" : `"${backend}" isn't a method`);
      }
    }
    result.backends = backends;
  }
  return result;
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

// The saved API key, {key, saved_at, saved_by}, or null. A file that can't be parsed counts as no
// key, as it does for the agent, and saving a new key replaces it.
async function readApiKey(file) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    return typeof saved?.key === "string" && saved.key ? saved : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      console.error(`${file} isn't valid JSON, so it is ignored`);
      return null;
    }
    throw error;
  }
}

// What the page shows about the key: where the agent gets it from, and its last four characters
async function apiKeyInfo(env) {
  const saved = await readApiKey(env.apiKeyFile);
  if (saved) {
    return { source: "settings", hint: saved.key.slice(-4), saved_at: saved.saved_at || null, saved_by: saved.saved_by || null, env_key: env.envKey !== null };
  }
  if (env.envKey !== null) return { source: "env", hint: env.envKey, env_key: true };
  return { source: null, env_key: false };
}

const scrubKeys = (text) => String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");

// Ask Anthropic whether the key works, with a request that costs nothing (listing the models).
// Throws a BadRequest saying why not.
async function checkApiKey(key) {
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const why = error.name === "TimeoutError" ? "no answer in 20 seconds" : error.cause?.code || error.message;
    throw new UpstreamError(`Anthropic couldn't be reached to check the key (${scrubKeys(why)}). It wasn't saved; try again.`);
  }
  if (response.ok) return;
  let message = "";
  try {
    message = (await response.json())?.error?.message || "";
  } catch {
    // Not JSON
  }
  const detail = message ? `: ${scrubKeys(message).slice(0, 200)}` : "";
  if (response.status === 401) throw new BadRequest(`Anthropic rejected this key (HTTP 401${detail}). It wasn't saved.`);
  if (response.status === 403) throw new BadRequest(`This key isn't allowed to use the API (HTTP 403${detail}). It wasn't saved.`);
  throw new UpstreamError(`Anthropic couldn't check the key (HTTP ${response.status}${detail}). It wasn't saved; try again.`);
}

// Write the key where only this user can read it: a new file, mode 600, renamed over the old one
// so the agent never reads half a file, in a folder created with mode 700
async function saveApiKey(file, record) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
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

// The JSON body of a PUT from the dashboard page, or an error to answer with
async function jsonBody(req) {
  if (!sameOrigin(req)) throw Object.assign(new BadRequest("Settings can only be saved from the dashboard"), { status: 403 });
  if (!/^application\/json\b/.test(req.headers["content-type"] || "")) throw Object.assign(new BadRequest("Send JSON"), { status: 415 });
  try {
    return JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("The request isn't valid JSON");
  }
}

const remoteUser = (req) => String(req.headers["x-remote-user"] || "").slice(0, 100) || null;

async function handleApiKey(req, res, env) {
  if (req.method === "PUT") {
    const body = await jsonBody(req);
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key) throw new BadRequest("Paste the key first");
    if (key.startsWith("sk-ant-admin")) throw new BadRequest("That's an Admin API key, which can't write replies. Use a regular API key (sk-ant-api...).");
    if (key.startsWith("sk-ant-oat")) throw new BadRequest("That's a Claude Code login token, not an API key. Create an API key at platform.claude.com.");
    if (!API_KEY_RE.test(key)) throw new BadRequest("That doesn't look like an Anthropic API key (they start with sk-ant-api).");
    await checkApiKey(key);
    const user = remoteUser(req);
    await saveApiKey(env.apiKeyFile, { key, saved_at: new Date().toISOString(), saved_by: user });
    console.log(`Claude API key saved by ${user || "unknown"}, after Anthropic accepted it`);
    return send(res, 200, { api_key: await apiKeyInfo(env) });
  }
  if (req.method === "DELETE") {
    if (!sameOrigin(req)) return send(res, 403, { error: "The key can only be removed from the dashboard" });
    await rm(env.apiKeyFile, { force: true });
    console.log(`Claude API key removed by ${remoteUser(req) || "unknown"}`);
    return send(res, 200, { api_key: await apiKeyInfo(env) });
  }
  res.setHeader("allow", "PUT, DELETE");
  return send(res, 405, { error: "Use PUT or DELETE" });
}

async function handle(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path !== "/api/settings" && path !== "/api/api-key") return send(res, 404, { error: "Not found" });
  const env = await agentEnv();
  if (path === "/api/api-key") return handleApiKey(req, res, env);
  const info = { bot: env.bot, owner: env.owner, backends: env.backends, agy_models: env.agyModels, api_key: await apiKeyInfo(env) };

  if (req.method === "GET") {
    const settings = await readSettings(env.accessFile);
    if (!settings) return send(res, 503, { error: "The agent hasn't written its settings yet. Start review-agent.service once.", info });
    return send(res, 200, { settings, info });
  }

  if (req.method === "PUT") {
    const body = await jsonBody(req);
    const settings = checkSettings(body?.settings, env.owner);
    const current = await readSettings(env.accessFile);
    if ((current?.updated_at || null) !== (body.base || null)) {
      return send(res, 409, { error: "The settings were changed somewhere else since this page loaded them. Reload to see them, then make your change again." });
    }
    settings.updated_at = new Date().toISOString();
    settings.updated_by = remoteUser(req);
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
    if (error instanceof BadRequest) return send(res, error.status, { error: error.message });
    console.error(error);
    send(res, 500, { error: "The settings couldn't be read or saved; see journalctl --user -u review-agent-settings" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Settings API listening on 127.0.0.1:${PORT}`));
