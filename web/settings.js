// Settings page: who may mention the bot, and the method and models they get. Loads and saves the access
// settings through the agent's settings API (settings-server.mjs) at api/settings. The agent reads
// them again for every mention, so a saved change applies from the next one. The Claude API key is
// saved on its own, at api/api-key, and is never sent back: the page only learns its last four
// characters.
"use strict";

const API = "api/settings";
const KEY_API = "api/api-key";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// The short names "--model" takes in a comment, as in resolve_model in review-agent.sh. Their models
// are offered in the model lists, along with any other model the settings already use.
const MODEL_ALIASES = {
  fable: "claude-fable-5-2",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};
const KNOWN_MODELS = Object.values(MODEL_ALIASES);
// The methods a reply can be written with. agy can't be limited to reading files, so contributors
// don't get it.
const METHODS = [
  ["claude-cli", "Claude Code CLI"],
  ["claude-api", "Claude API (API key)"],
  ["agy", "Antigravity CLI (agy)"],
];
const ROLE_METHODS = { admin: ["claude-cli", "claude-api", "agy"], contributor: ["claude-cli", "claude-api"] };
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

// settings: what the form shows. saved: the same as JSON, as last loaded or saved, to tell whether
// anything changed. base: the updated_at it was loaded at. drafts and errors: the text typed into
// each "add" field and what was wrong with it, kept across re-renders.
const state = {
  settings: null,
  saved: "",
  base: null,
  meta: {},
  info: {},
  drafts: {},
  errors: {},
  saving: false,
  status: null,
  // The API key card: whether a key is being saved or removed, and how that went
  keySaving: false,
  keyStatus: null,
};

// The key field is made once and moved into each re-render, so what is typed stays in the field
// and nowhere else
const keyInput = el("input", {
  type: "password",
  class: "key-input",
  placeholder: "sk-ant-api03-...",
  "aria-label": "Claude API key",
  "data-focus": "api-key",
  autocomplete: "off",
  autocapitalize: "off",
  spellcheck: "false",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  oninput: () => renderKeyButtons(),
  onkeydown: (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveKey();
    }
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// The parts of the saved settings the form edits. Settings saved before methods could be chosen
// have none, and the agent then uses AI_BACKENDS from .env, so the form starts from that.
function editable(settings, info = {}) {
  const models = (role) => {
    const entry = settings.models?.[role] || {};
    const list = entry.models || [];
    const allowed = ROLE_METHODS[role];
    let backends = (entry.backends || info.backends || []).filter((backend) => allowed.includes(backend));
    if (!backends.length) backends = ["claude-cli"];
    return {
      models: list.length ? [...list] : [KNOWN_MODELS[2]],
      effort: entry.effort || "high",
      backends,
    };
  };
  return {
    admins: [...(settings.admins || [])],
    repos: (settings.repos || []).map((repo) => ({ repo: repo.repo, who: repo.who, users: [...(repo.users || [])] })),
    contributor_daily_limit: settings.contributor_daily_limit ?? 0,
    models: { admin: models("admin"), contributor: models("contributor") },
  };
}

// Whether the agent has a Claude API key, from the settings page or from .env
const hasApiKey = () => Boolean(state.info.api_key?.source);

function dirty() {
  return state.settings !== null && JSON.stringify(state.settings) !== state.saved;
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// "alice, @bob carol" -> valid ["alice", "bob", "carol"], and the names that aren't usernames
function parseUsers(text) {
  const names = text.split(/[\s,]+/).map((name) => name.replace(/^@/, "")).filter(Boolean);
  return { valid: names.filter((name) => USER_RE.test(name)), invalid: names.filter((name) => !USER_RE.test(name)) };
}

// "owner/repo", "github.com/owner/repo" or a link to anything in the repo -> "owner/repo"
function parseRepo(text) {
  const match = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+\/[^/\s#?]+)/.exec(text.trim());
  const repo = match ? match[1].replace(/\.git$/, "") : "";
  return REPO_RE.test(repo) ? repo : null;
}

function githubLink(path, text) {
  return el("a", { href: `https://github.com/${path}`, target: "_blank", rel: "noopener noreferrer", text });
}

// description: text, or a list of text and nodes
function card(title, description, ...body) {
  return el("section", { class: "card" },
    el("h3", { text: title }),
    el("p", { class: "muted card-description" }, description),
    ...body);
}

const code = (text) => el("code", { text });

// ---------------------------------------------------------------------------
// Form parts
// ---------------------------------------------------------------------------
// Usernames as removable chips, with a field to add more. Several names can be typed at once,
// separated by spaces or commas, with or without a leading @. key names the field's draft, and
// fixed chips (the owner) can't be removed.
function userList(list, key, { fixed = [], placeholder = "GitHub username" } = {}) {
  const add = () => {
    const { valid, invalid } = parseUsers(state.drafts[key] || "");
    for (const name of valid) {
      if (![...fixed.map((chip) => chip.name), ...list].some((user) => sameName(user, name))) list.push(name);
    }
    state.drafts[key] = invalid.join(" ");
    state.errors[key] = invalid.length ? `Not a GitHub username: ${invalid.join(", ")}` : "";
    render(key);
  };
  return el("div", { class: "user-list" },
    list.length || fixed.length
      ? el("ul", { class: "chips" },
          fixed.map((chip) => el("li", { class: "chip fixed", title: chip.title },
            githubLink(chip.name, `@${chip.name}`), el("span", { class: "chip-note", text: chip.note }))),
          list.map((name, i) => el("li", { class: "chip" },
            githubLink(name, `@${name}`),
            el("button", {
              type: "button",
              class: "chip-remove",
              title: "Remove",
              "aria-label": `Remove @${name}`,
              text: "×",
              onclick: () => {
                list.splice(i, 1);
                render();
              },
            }))))
      : null,
    el("div", { class: "add-row" },
      el("input", {
        type: "text",
        value: state.drafts[key] || "",
        placeholder,
        "aria-label": placeholder,
        "data-focus": key,
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        oninput: (event) => { state.drafts[key] = event.target.value; },
        onkeydown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        },
      }),
      el("button", { type: "button", class: "button", text: "Add", onclick: add })),
    state.errors[key] ? el("p", { class: "field-error", text: state.errors[key] }) : null);
}

function adminsCard() {
  const owner = state.info.owner;
  return card("Admins",
    ["Can ask for anything in any repo: reviews, answers, code changes and pull requests. " +
      "They can also pick the method and model for one reply with ", code("--method"), ", ", code("--model"), " and ", code("--effort"), " in their comment."],
    userList(state.settings.admins, "admins", {
      fixed: owner ? [{ name: owner, note: "owner", title: "ADMIN_USER in .env is always an admin" }] : [],
      placeholder: "Add admins by GitHub username (the @ is optional)",
    }));
}

function repoItem(repo, index) {
  const key = `repo:${repo.repo.toLowerCase()}`;
  const choice = (value, label) => el("label", { class: "choice" },
    el("input", {
      type: "radio",
      name: `who-${index}`,
      value,
      checked: repo.who === value,
      "data-focus": `who-${index}-${value}`,
      onchange: () => {
        repo.who = value;
        render();
      },
    }),
    label);
  return el("li", { class: "repo" },
    el("div", { class: "repo-head" },
      el("strong", { class: "repo-name" }, githubLink(repo.repo, repo.repo)),
      el("div", { class: "choices", role: "radiogroup", "aria-label": `Who can ask in ${repo.repo}` },
        choice("anyone", "Anyone"),
        choice("listed", "Only these people")),
      el("button", {
        type: "button",
        class: "link-button danger",
        text: "Remove",
        "aria-label": `Remove ${repo.repo}`,
        onclick: () => {
          state.settings.repos.splice(index, 1);
          render();
        },
      })),
    repo.who === "anyone"
      ? el("p", { class: "muted small repo-note", text: "Anyone on GitHub who comments on a pull request here can ask for a review." })
      : el("div", {},
          userList(repo.users, key, { placeholder: "Add people by GitHub username (the @ is optional)" }),
          repo.users.length ? null : el("p", { class: "field-warning", text: "Nobody can ask here until you add people." })));
}

function contributorsCard() {
  const s = state.settings;
  const addRepo = () => {
    const text = (state.drafts.repo || "").trim();
    const repo = parseRepo(text);
    if (!repo) {
      state.errors.repo = text ? `"${text}" isn't a repo. Use owner/repo or a GitHub link.` : "";
    } else if (s.repos.some((entry) => sameName(entry.repo, repo))) {
      state.errors.repo = `${repo} is already listed.`;
    } else {
      s.repos.push({ repo, who: "anyone", users: [] });
      state.drafts.repo = "";
      state.errors.repo = "";
    }
    render("repo");
  };

  return card("Contributors",
    "Can ask for a review of a pull request in these repos, and nothing else. For them the bot reads " +
      "the PR's code but can't run commands, change code or post anything except the review. On an " +
      "issue, it replies that it only reviews pull requests.",
    s.repos.length
      ? el("ul", { class: "repos" }, s.repos.map(repoItem))
      : el("p", { class: "muted empty-note", text: "No repos yet, so only admins can use the bot." }),
    el("div", { class: "add-row" },
      el("input", {
        type: "text",
        value: state.drafts.repo || "",
        placeholder: "owner/repo or a GitHub link",
        "aria-label": "Repo to open to contributors",
        "data-focus": "repo",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        oninput: (event) => { state.drafts.repo = event.target.value; },
        onkeydown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addRepo();
          }
        },
      }),
      el("button", { type: "button", class: "button", text: "Add repo", onclick: addRepo })),
    state.errors.repo ? el("p", { class: "field-error", text: state.errors.repo }) : null,
    el("div", { class: "limit" },
      el("label", { for: "daily-limit", text: "Reviews per contributor per day" }),
      el("input", {
        id: "daily-limit",
        type: "number",
        min: "0",
        max: "1000",
        step: "1",
        inputmode: "numeric",
        value: String(s.contributor_daily_limit),
        oninput: (event) => {
          const value = event.target.value.trim();
          s.contributor_daily_limit = /^\d+$/.test(value) ? Number(value) : value;
          renderSaveBar();
        },
      })),
    el("p", { class: "muted small", text: "Counted over the last 24 hours, across all repos. 0 means no limit. A contributor who reaches it is told to ask again later." }));
}

function modelOptions() {
  const used = ["admin", "contributor"].flatMap((role) => state.settings.models[role].models);
  return [...new Set([...KNOWN_MODELS, ...used])];
}

function select(label, options, value, onchange) {
  return el("select", { "aria-label": label, "data-focus": label, onchange: (event) => onchange(event.target.value) },
    options.map(([id, text]) => el("option", { value: id, selected: id === value, text })));
}

function modelRow(role, label, note) {
  const entry = state.settings.models[role];
  const [model = KNOWN_MODELS[1], fallback = ""] = entry.models;
  const [method = "claude-cli", fallbackMethod = ""] = entry.backends;
  const options = modelOptions();
  const methods = METHODS.filter(([id]) => ROLE_METHODS[role].includes(id));
  return el("div", { class: "model-row" },
    el("div", { class: "model-role" }, el("strong", { text: label }), el("div", { class: "muted small" }, note)),
    el("label", { class: "model-field" }, el("span", { class: "muted small", text: "Method" }),
      select(`${label}: method`, methods, method, (value) => {
        entry.backends = [value, ...(fallbackMethod && fallbackMethod !== value ? [fallbackMethod] : [])];
        render();
      })),
    el("label", { class: "model-field" }, el("span", { class: "muted small", text: "Fallback method" }),
      select(`${label}: fallback method`, [["", "None"], ...methods.filter(([id]) => id !== method)], fallbackMethod, (value) => {
        entry.backends = [method, ...(value ? [value] : [])];
        render();
      })),
    el("label", { class: "model-field new-line" }, el("span", { class: "muted small", text: "Default model" }),
      select(`${label}: default model`, options.map((id) => [id, modelName(id)]), model, (value) => {
        entry.models = [value, ...(fallback && fallback !== value ? [fallback] : [])];
        render();
      })),
    el("label", { class: "model-field" }, el("span", { class: "muted small", text: "Fallback model" }),
      select(`${label}: fallback model`, [["", "None"], ...options.filter((id) => id !== model).map((id) => [id, modelName(id)])], fallback, (value) => {
        entry.models = [model, ...(value ? [value] : [])];
        render();
      })),
    el("label", { class: "model-field" }, el("span", { class: "muted small", text: "Effort" }),
      select(`${label}: effort`, EFFORTS.map((effort) => [effort, effort]), entry.effort, (value) => {
        entry.effort = value;
        render();
      })));
}

function modelsCard() {
  const used = ["admin", "contributor"].flatMap((role) => state.settings.models[role].backends);
  const agyModels = state.info.agy_models || [];
  return card("Method and models",
    ["The method writes the reply: the Claude Code CLI with this machine's Claude login, which can read the code and run commands; " +
      "the Claude API with the API key, which answers from the diff and the discussion in the prompt; or the Antigravity CLI. " +
      "The fallback method, and the fallback model, are tried when the first one fails, for example when its usage limit is reached. " +
      "The models and effort are for the Claude methods."],
    el("div", { class: "models" },
      modelRow("admin", "Admins", [code("--method"), ", ", code("--model"), " and ", code("--effort"), " in a comment override these for one reply."]),
      modelRow("contributor", "Contributors", "Contributors can't choose another method or model, and can't use agy.")),
    used.includes("claude-api") && !hasApiKey()
      ? el("p", { class: "field-warning" }, "No API key is set, so the Claude API method will fail. Add one under Claude API key below.")
      : null,
    used.includes("agy")
      ? el("p", { class: "muted small" }, code("agy"), " uses ", code("AGY_MODELS"), " from .env",
          agyModels.length ? [" (", agyModels.join(", "), ")"] : "", ", tried in order, and only answers admins.")
      : null);
}

// Example comments that choose the method, model and effort for one reply, filled in with the
// admins' current settings, and the values each option takes
function commentOptionsCard() {
  const bot = `@${state.info.bot || "bot"}`;
  const admin = state.settings.models.admin;
  const model = modelName(admin.models[0] || KNOWN_MODELS[1]);
  const fable = modelName(MODEL_ALIASES.fable);
  const noKey = hasApiKey() ? "" : " No API key is set, so this fails until one is added.";
  // Each option stays on one line with its value, so "--effort low" never breaks after a hyphen
  const example = (comment, explanation) => el("li", { class: "example" },
    el("code", { class: "example-comment" }, `${bot} ${comment}`.split(/(--[a-z]+ \S+)/)
      .map((part) => part.startsWith("--") ? el("span", { class: "option", text: part }) : part)),
    el("span", { class: "muted small" }, explanation));
  const list = (items) => items.flatMap(([value, label], i) =>
    [i === 0 ? "" : i === items.length - 1 ? " or " : ", ", code(value), label ? ` (${label})` : ""]);
  return card("Choosing for one reply",
    ["Admins can add ", code("--model"), ", ", code("--effort"), " and ", code("--method"), " to a mention to choose for that reply only. " +
      "What they name is tried first, with the settings above as the fallback. The options are removed before the model reads the comment, and are ignored in a contributor's."],
    el("ul", { class: "examples" },
      example("review this PR --model fable", `${fable}, the most capable model, at the admins' effort (${admin.effort})`),
      example("review this PR --model fable --effort max", `${fable} at max effort: the most thorough, and the slowest`),
      example("what does parse_config() return on an empty file? --model haiku --effort low",
        `${modelName(MODEL_ALIASES.haiku)} at low effort, for a quick, cheaper answer`),
      example("review this PR --method api",
        `The Claude API instead of the CLI, with the admins' model (${model}). It answers from the diff and the discussion, and can't run commands or push.${noKey}`),
      example("review this PR --method api --model fable --effort high", `The Claude API with ${fable} at high effort`)),
    el("dl", { class: "options-ref" },
      el("dt", {}, code("--model")),
      el("dd", {}, list(Object.entries(MODEL_ALIASES).map(([alias, id]) => [alias, modelName(id)])), ", or a full model ID such as ", code(MODEL_ALIASES.sonnet)),
      el("dt", {}, code("--effort")),
      el("dd", {}, list(EFFORTS.map((effort) => [effort]))),
      el("dt", {}, code("--method")),
      el("dd", {}, list([["cli", "Claude Code CLI"], ["api", "Claude API"], ["agy", "Antigravity CLI"]]))));
}

// The Claude API key: where the agent gets it from, a field to save a new one, and a button to
// remove the saved one
function apiKeyCard() {
  const key = state.info.api_key || {};
  const ending = key.hint ? [" It ends in ", code(key.hint), "."] : "";
  let current;
  if (key.source === "settings") {
    const when = key.saved_at ? ` on ${new Date(key.saved_at).toLocaleString()}` : "";
    current = el("p", { class: "key-current" }, el("strong", { text: "Saved here" }), `${when}${key.saved_by ? ` by ${key.saved_by}` : ""}.`, ending,
      key.env_key ? [" ", code("ANTHROPIC_API_KEY"), " in .env is also set, and isn't used while this one is saved."] : "");
  } else if (key.source === "env") {
    current = el("p", { class: "key-current" }, el("strong", { text: "From .env" }), " (", code("ANTHROPIC_API_KEY"), ").", ending,
      " A key saved here replaces it.");
  } else {
    current = el("p", { class: "field-warning" }, "No key is set, so the Claude API method fails until one is added.");
  }
  const status = state.keyStatus;
  return card("Claude API key",
    ["For the Claude API method. A new key is checked with Anthropic before it's saved, and then used from the next reply. " +
      "It's kept on the server in a file only the agent's user can read, and is never sent back to this page, which only shows its last four characters. " +
      "Create one at ", el("a", { href: "https://platform.claude.com/settings/keys", target: "_blank", rel: "noopener noreferrer", text: "platform.claude.com" }), "."],
    current,
    el("div", { class: "add-row" },
      keyInput,
      el("button", { type: "button", class: "button primary", id: "key-save", text: key.source === "settings" ? "Replace key" : "Save key", onclick: saveKey })),
    state.keySaving ? el("p", { class: "muted small key-status", text: state.keySaving === "remove" ? "Removing..." : "Checking the key with Anthropic..." }) : null,
    !state.keySaving && status?.error ? el("p", { class: "field-error", text: status.error }) : null,
    !state.keySaving && status?.done ? el("p", { class: "field-ok", text: status.done }) : null,
    key.source === "settings"
      ? el("button", { type: "button", class: "link-button danger", id: "key-remove", text: "Remove the saved key", onclick: removeKey })
      : null);
}

// Enable the key buttons for what is typed, without re-rendering while the key is typed
function renderKeyButtons() {
  const save = $("key-save");
  const remove = $("key-remove");
  if (save) save.disabled = Boolean(state.keySaving) || !keyInput.value.trim();
  if (remove) remove.disabled = Boolean(state.keySaving);
}

async function keyRequest(method, body) {
  const response = await fetch(KEY_API, {
    method,
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Not JSON, such as nginx's own error page
  }
  if (!response.ok) throw new Error(data.error || `The settings API answered HTTP ${response.status}`);
  return data;
}

async function saveKey() {
  const key = keyInput.value.trim();
  if (!key || state.keySaving) return;
  state.keySaving = "save";
  state.keyStatus = null;
  render();
  try {
    const data = await keyRequest("PUT", { key });
    state.info.api_key = data.api_key;
    keyInput.value = "";
    state.keyStatus = { done: "Saved. Anthropic accepted the key, and the agent uses it from the next reply." };
  } catch (error) {
    state.keyStatus = { error: error.message };
  } finally {
    state.keySaving = false;
  }
  render();
}

async function removeKey() {
  if (state.keySaving) return;
  const fallback = state.info.api_key?.env_key
    ? "The key in .env (ANTHROPIC_API_KEY) will be used instead."
    : "No key will be left, so the Claude API method will fail until one is added.";
  if (!confirm(`Remove the saved Claude API key? ${fallback}`)) return;
  state.keySaving = "remove";
  state.keyStatus = null;
  render();
  try {
    const data = await keyRequest("DELETE");
    state.info.api_key = data.api_key;
    state.keyStatus = { done: "Removed." };
  } catch (error) {
    state.keyStatus = { error: `Not removed: ${error.message}` };
  } finally {
    state.keySaving = false;
  }
  render();
}

function intro() {
  const bot = state.info.bot ? `@${state.info.bot}` : "the bot";
  return el("div", { class: "settings-intro" },
    el("h2", { text: "Who can ask the bot" }),
    el("p", { class: "muted" },
      `Who can mention ${bot}, and what they get. Saved changes apply from the next mention, with no restart. Anyone not covered here is ignored.`));
}

// ---------------------------------------------------------------------------
// Rendering, loading and saving
// ---------------------------------------------------------------------------
// Rebuild the form, keeping the scroll position and the focused field. focusKey names an "add"
// field to focus instead, after something was added from it.
function render(focusKey) {
  const main = $("settings");
  const active = document.activeElement;
  const key = focusKey || active?.dataset?.focus;
  const caret = !focusKey && (active?.type === "text" || active?.type === "password") ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = main.scrollTop;

  main.replaceChildren(intro(), adminsCard(), contributorsCard(), modelsCard(), apiKeyCard(), commentOptionsCard());
  main.scrollTop = scroll;
  const field = key ? main.querySelector(`[data-focus="${CSS.escape(key)}"]`) : null;
  if (field) {
    field.focus({ preventScroll: true });
    if (caret) field.setSelectionRange(...caret);
  }
  renderSaveBar();
  renderKeyButtons();
}

function problems() {
  const limit = state.settings.contributor_daily_limit;
  if (!Number.isInteger(limit) || limit > 1000) return "Reviews per contributor per day must be a whole number from 0 to 1000.";
  return "";
}

function renderSaveBar() {
  const changed = dirty();
  const problem = changed ? problems() : "";
  $("save").disabled = !changed || state.saving || Boolean(problem);
  $("discard").disabled = !changed || state.saving;

  const status = $("save-status");
  status.className = "save-status muted";
  if (state.saving) status.textContent = "Saving...";
  else if (problem) {
    status.textContent = problem;
    status.className = "save-status error";
  } else if (state.status?.error) {
    status.textContent = state.status.error;
    status.className = "save-status error";
  } else if (changed) status.textContent = "Unsaved changes";
  else if (state.status?.saved) status.textContent = "Saved. It applies from the next mention.";
  else if (state.meta.updated_at) {
    status.textContent = `Last saved ${new Date(state.meta.updated_at).toLocaleString()}${state.meta.updated_by ? ` by ${state.meta.updated_by}` : ""}`;
  } else status.textContent = "";
}

function useSettings(settings, info) {
  state.settings = editable(settings, info);
  state.saved = JSON.stringify(state.settings);
  state.base = settings.updated_at || null;
  state.meta = { updated_at: settings.updated_at, updated_by: settings.updated_by };
  state.info = info || {};
}

async function request(method, body) {
  const response = await fetch(API, {
    method,
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Not JSON, such as nginx's own error page
  }
  if (!response.ok) throw new Error(data.error || `The settings API answered HTTP ${response.status}`);
  return data;
}

async function load() {
  try {
    const data = await request("GET");
    useSettings(data.settings, data.info);
    state.status = null;
    render();
  } catch (error) {
    $("settings").replaceChildren(
      el("p", { class: "field-error placeholder", text: `The settings couldn't be loaded: ${error.message}` }),
      el("p", { class: "placeholder" }, el("button", { type: "button", class: "button", text: "Try again", onclick: load })));
  }
}

async function save() {
  if (!dirty() || state.saving || problems()) return;
  state.saving = true;
  state.status = null;
  renderSaveBar();
  try {
    const data = await request("PUT", { settings: state.settings, base: state.base });
    useSettings(data.settings, data.info);
    state.status = { saved: true };
  } catch (error) {
    state.status = { error: `Not saved: ${error.message}` };
  } finally {
    state.saving = false;
  }
  render();
}

$("save").addEventListener("click", save);
$("discard").addEventListener("click", () => {
  state.settings = JSON.parse(state.saved);
  state.drafts = {};
  state.errors = {};
  state.status = null;
  render();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty()) event.preventDefault();
});

load();
