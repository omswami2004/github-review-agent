// Settings page: who may mention the bot and which models they get. Loads and saves the access
// settings through the agent's settings API (settings-server.mjs) at api/settings. The agent reads
// them again for every mention, so a saved change applies from the next one.
"use strict";

const API = "api/settings";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Offered in the model lists, along with any other model the settings already use
const KNOWN_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// The parts of the saved settings the form edits
function editable(settings) {
  const models = (role) => {
    const list = settings.models?.[role]?.models || [];
    return { models: list.length ? [...list] : [KNOWN_MODELS[2]], effort: settings.models?.[role]?.effort || "high" };
  };
  return {
    admins: [...(settings.admins || [])],
    repos: (settings.repos || []).map((repo) => ({ repo: repo.repo, who: repo.who, users: [...(repo.users || [])] })),
    contributor_daily_limit: settings.contributor_daily_limit ?? 0,
    models: { admin: models("admin"), contributor: models("contributor") },
  };
}

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
// Usernames as removable chips, with a field to add more. key names the field's draft, and fixed
// chips (the owner) can't be removed.
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
      "They can also pick the model for one reply with ", code("--model"), " and ", code("--effort"), " in their comment."],
    userList(state.settings.admins, "admins", {
      fixed: owner ? [{ name: owner, note: "owner", title: "ADMIN_USER in .env is always an admin" }] : [],
      placeholder: "Add admins by GitHub username",
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
          userList(repo.users, key, { placeholder: "Add people by GitHub username" }),
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
  const options = modelOptions();
  return el("div", { class: "model-row" },
    el("div", { class: "model-role" }, el("strong", { text: label }), el("div", { class: "muted small" }, note)),
    el("label", { class: "model-field" }, el("span", { class: "muted small", text: "Default model" }),
      select(`${label}: default model`, options.map((id) => [id, modelName(id)]), model, (value) => {
        entry.models = [value, ...(fallback && fallback !== value ? [fallback] : [])];
        render();
      })),
    el("label", { class: "model-field" }, el("span", { class: "muted small", text: "Fallback" }),
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
  const backends = state.info.backends || [];
  return card("Models",
    "Used by the Claude backends. The fallback is tried when the default model fails, for example when its usage limit is reached.",
    el("div", { class: "models" },
      modelRow("admin", "Admins", [code("--model"), " and ", code("--effort"), " in a comment override these for one reply."]),
      modelRow("contributor", "Contributors", "Contributors can't choose another model.")),
    backends.includes("agy")
      ? el("p", { class: "muted small" }, code("agy"), " uses ", code("AGY_MODELS"), " from .env, and only answers admins.")
      : null);
}

function intro() {
  const backends = state.info.backends || [];
  const bot = state.info.bot ? `@${state.info.bot}` : "the bot";
  const claude = backends.some((backend) => backend.startsWith("claude-"));
  return el("div", { class: "settings-intro" },
    el("h2", { text: "Who can ask the bot" }),
    el("p", { class: "muted" },
      `Who can mention ${bot}, and what they get. Saved changes apply from the next mention, with no restart. Anyone not covered here is ignored.`),
    claude
      ? null
      : el("p", { class: "field-warning", text: `AI_BACKENDS in .env is "${backends.join(" ")}", with no Claude backend, so contributors get no reviews. Run ./setup.sh to add one.` }));
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
  const caret = !focusKey && active?.type === "text" ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = main.scrollTop;

  main.replaceChildren(intro(), adminsCard(), contributorsCard(), modelsCard());
  main.scrollTop = scroll;
  const field = key ? main.querySelector(`[data-focus="${CSS.escape(key)}"]`) : null;
  if (field) {
    field.focus({ preventScroll: true });
    if (caret) field.setSelectionRange(...caret);
  }
  renderSaveBar();
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
  state.settings = editable(settings);
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
