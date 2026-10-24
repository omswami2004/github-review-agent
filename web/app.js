// Review agent activity viewer. Reads the records the agent writes under runs/:
//   runs/index.json            every reply, newest first (each entry is a meta.json)
//   runs/<id>/meta.json        the reply's details and its attempts
//   runs/<id>/attempt-<n>.*    one attempt's events (.jsonl) or output (.txt)
//   runs/<id>/prompt.txt       the prompt sent to the model
//   runs/<id>/reply.md         the comment that was posted
"use strict";

const POLL_MS = 4000;
const OUTPUT_PREVIEW_CHARS = 3000;
const STATUS_LABELS = {
  running: "Running",
  posted: "Posted",
  failed: "Failed",
  post_failed: "Post failed",
  interrupted: "Interrupted",
};

const state = { runs: [], indexText: "", selectedId: null, detailKey: "" };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function markdown(text) {
  const node = el("div", { class: "md" });
  node.innerHTML = DOMPurify.sanitize(marked.parse(text || "", { gfm: true }));
  for (const link of node.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return node;
}

// Only GitHub links from the record become clickable
function githubLink(url, text) {
  return typeof url === "string" && url.startsWith("https://github.com/")
    ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text })
    : el("span", { text });
}

async function fetchText(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

function parseJsonLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partial last line while the attempt is still being written
    }
  }
  return events;
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function between(start, end) {
  if (!start) return null;
  return (end ? Date.parse(end) : Date.now()) - Date.parse(start);
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function formatNumber(n) {
  return typeof n === "number" ? n.toLocaleString() : "";
}

function statusBadge(status) {
  return el("span", { class: `badge status-${status}`, text: STATUS_LABELS[status] || status || "Unknown" });
}

// claude-opus-5-5 -> Claude Opus 5.5
function modelName(id) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id || "");
  if (!match) return id || "";
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return `Claude ${family} ${match[2]}${match[3] ? "." + match[3] : ""}`;
}

// Long tool output is shown in part, with a button for the rest
function collapsibleOutput(text, isError) {
  const pre = el("pre", { class: isError ? "output error" : "output" });
  if (text.length <= OUTPUT_PREVIEW_CHARS) {
    pre.textContent = text || "(no output)";
    return pre;
  }
  pre.textContent = text.slice(0, OUTPUT_PREVIEW_CHARS);
  const more = el("button", {
    class: "link-button",
    text: `Show all ${formatNumber(text.length)} characters`,
    onclick: () => {
      pre.textContent = text;
      more.remove();
    },
  });
  return el("div", {}, pre, more);
}

// ---------------------------------------------------------------------------
// Run list
// ---------------------------------------------------------------------------
async function loadIndex() {
  let text;
  try {
    text = await fetchText("runs/index.json");
  } catch {
    text = "[]";
  }
  if (text === state.indexText) return false;
  state.indexText = text;
  try {
    state.runs = JSON.parse(text);
  } catch {
    state.runs = [];
  }
  renderList();
  return true;
}

function renderList() {
  const query = $("filter").value.trim().toLowerCase();
  const status = $("status-filter").value;
  const runs = state.runs.filter((run) => {
    if (status && run.status !== status) return false;
    if (!query) return true;
    return [run.repo, run.author, run.comment, String(run.number)].join(" ").toLowerCase().includes(query);
  });

  const running = state.runs.filter((run) => run.status === "running").length;
  $("summary").textContent = `${state.runs.length} ${state.runs.length === 1 ? "reply" : "replies"} recorded`;
  $("live").hidden = running === 0;
  $("empty").hidden = state.runs.length > 0;

  const list = $("runs");
  list.replaceChildren(
    ...runs.map((run) => {
      const model = run.answered_by?.model || run.requested_model || "";
      return el(
        "li",
        {},
        el(
          "a",
          { href: `#run=${encodeURIComponent(run.id)}`, class: run.id === state.selectedId ? "run selected" : "run" },
          el("div", { class: "run-top" }, el("strong", { text: `${run.repo} #${run.number}` }), statusBadge(run.status)),
          el("div", { class: "run-comment", text: run.comment || "" }),
          el(
            "div",
            { class: "run-meta muted" },
            `@${run.author} · ${timeAgo(run.started_at)}`,
            model ? ` · ${modelName(model)}` : "",
            run.finished_at ? ` · ${formatDuration(between(run.started_at, run.finished_at))}` : ""
          )
        )
      );
    })
  );
}

// ---------------------------------------------------------------------------
// Attempt timelines
// ---------------------------------------------------------------------------
function item(kind, label, body, extra = {}) {
  return el("li", { class: `event event-${kind}${extra.nested ? " nested" : ""}` },
    el("div", { class: "event-label", text: label }),
    el("div", { class: "event-body" }, body));
}

function toolResultText(block) {
  if (!block) return null;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
  }
  return "";
}

function toolSummary(name, input, cwd) {
  const rel = (path) => (cwd && typeof path === "string" && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path);
  switch (name) {
    case "Bash":
      return input.command;
    case "Read":
      return rel(input.file_path) + (input.offset ? ` (from line ${input.offset})` : "");
    case "Grep":
      return `${input.pattern}${input.path ? " in " + rel(input.path) : ""}${input.glob ? " (" + input.glob + ")" : ""}`;
    case "Glob":
      return input.pattern + (input.path ? " in " + rel(input.path) : "");
    case "Edit":
    case "Write":
      return rel(input.file_path);
    case "WebFetch":
      return input.url;
    case "WebSearch":
      return input.query;
    case "Task":
    case "Agent":
      return input.description || "";
    default:
      return JSON.stringify(input);
  }
}

function resultFacts(result) {
  const usage = result.usage || {};
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const facts = [
    result.is_error ? "Ended with an error" : "Finished",
    result.num_turns != null ? `${result.num_turns} turns` : "",
    result.duration_ms != null ? formatDuration(result.duration_ms) : "",
    input ? `${formatNumber(input)} input tokens (${formatNumber(usage.cache_read_input_tokens || 0)} from cache)` : "",
    usage.output_tokens != null ? `${formatNumber(usage.output_tokens)} output tokens` : "",
    typeof result.total_cost_usd === "number" ? `about $${result.total_cost_usd.toFixed(2)} at API prices` : "",
  ].filter(Boolean);
  return facts.join(" · ");
}

function thinkingBody(text) {
  return text && text.trim()
    ? el("div", { class: "thinking-text", text: text.trim() })
    : el("span", { class: "muted", text: "(no summary)" });
}

// Claude Code CLI: the stream-json event log
function renderCliAttempt(events, run) {
  const results = new Map();
  for (const event of events) {
    if (event.type !== "user" || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type === "tool_result") results.set(block.tool_use_id, block);
    }
  }

  let cwd = "";
  const items = [];
  for (const event of events) {
    const nested = Boolean(event.parent_tool_use_id);
    if (event.type === "system" && event.subtype === "init") {
      cwd = event.cwd || "";
      const where = cwd.includes("/worktree.") && run.checkout
        ? `the checkout of ${run.repo} at ${run.checkout}`
        : cwd || "?";
      items.push(item("session", "Started", `${modelName(event.model)} in ${where}`));
    } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "thinking") {
          items.push(item("thinking", "Thinking", thinkingBody(block.thinking), { nested }));
        } else if (block.type === "text" && block.text?.trim()) {
          items.push(item("text", "Claude", markdown(block.text), { nested }));
        } else if (block.type === "tool_use") {
          const output = results.get(block.id);
          const outputText = toolResultText(output);
          items.push(item("tool", block.name, el("div", {},
            el("code", { class: "tool-call", text: toolSummary(block.name, block.input || {}, cwd) }),
            block.input?.description ? el("div", { class: "muted small", text: block.input.description }) : null,
            outputText == null
              ? el("div", { class: "muted small", text: "Waiting for output..." })
              : el("details", { "data-key": `out-${block.id}` },
                  el("summary", { text: output.is_error ? "Error output" : `Output (${formatNumber(outputText.length)} characters)` }),
                  collapsibleOutput(outputText, output.is_error))
          ), { nested }));
        }
      }
    } else if (event.type === "result") {
      items.push(item(event.is_error ? "error" : "result", "Result", el("div", {},
        el("div", { text: resultFacts(event) }),
        event.is_error && event.result ? el("pre", { class: "output error", text: event.result }) : null)));
    }
  }
  return items;
}

// Claude API: the server-sent events of one streamed request
function renderApiAttempt(events) {
  const blocks = [];
  let start = null;
  let end = null;
  const items = [];
  for (const event of events) {
    if (event.type === "message_start") start = event.message;
    else if (event.type === "content_block_start") {
      const block = event.content_block || {};
      blocks[event.index] = { type: block.type, text: block.text || block.thinking || "" };
    } else if (event.type === "content_block_delta") {
      const block = blocks[event.index];
      if (!block) continue;
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      else if (event.delta.type === "thinking_delta") block.text += event.delta.thinking;
    } else if (event.type === "message_delta") end = event;
    else if (event.type === "error") {
      items.push(item("error", "Error", `${event.error?.type}: ${event.error?.message}`));
    } else if (event.type === "http_error") {
      let message = event.body;
      try {
        message = JSON.parse(event.body).error?.message || event.body;
      } catch {
        // Not JSON; show it as it is
      }
      items.push(item("error", `HTTP ${event.status}`, message));
    }
  }
  if (start) items.unshift(item("session", "Started", modelName(start.model)));
  for (const block of blocks.filter(Boolean)) {
    if (block.type === "thinking") items.push(item("thinking", "Thinking", thinkingBody(block.text)));
    else if (block.type === "text") items.push(item("text", "Claude", markdown(block.text)));
  }
  if (end) {
    const facts = [
      `Stopped: ${end.delta?.stop_reason}`,
      start?.usage ? `${formatNumber(start.usage.input_tokens)} input tokens` : "",
      end.usage ? `${formatNumber(end.usage.output_tokens)} output tokens` : "",
    ].filter(Boolean);
    items.push(item(end.delta?.stop_reason === "end_turn" ? "result" : "error", "Result", facts.join(" · ")));
  }
  return items;
}

async function renderAttempt(run, attempt) {
  let body;
  try {
    const text = await fetchText(`runs/${encodeURIComponent(run.id)}/${encodeURIComponent(attempt.file)}`);
    if (attempt.backend === "agy") body = [item("text", "Output", collapsibleOutput(text, false))];
    else {
      const events = parseJsonLines(text);
      body = attempt.backend === "claude-cli" ? renderCliAttempt(events, run) : renderApiAttempt(events);
    }
  } catch (error) {
    body = [item("error", "Missing", `The log for this attempt couldn't be loaded (${error.message}).`)];
  }
  if (attempt.status === "running") body.push(item("session", "Working", el("span", { class: "muted", text: "Still running..." })));

  const label = attempt.status === "ok" ? "answered" : attempt.status === "quota" ? "hit a usage limit" : attempt.status;
  return el("section", { class: "attempt" },
    el("h3", {},
      `Attempt ${attempt.n}: ${attempt.backend}, ${modelName(attempt.model)}`,
      el("span", { class: `badge attempt-${attempt.status}`, text: label }),
      el("span", { class: "muted small", text: ` effort ${attempt.effort} · ${formatDuration(between(attempt.started_at, attempt.finished_at))}` })),
    el("ol", { class: "timeline" }, body));
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------
function fact(label, value) {
  return value ? [el("dt", { text: label }), el("dd", {}, value)] : [];
}

async function renderDetail(force = false) {
  const id = state.selectedId;
  const detail = $("detail");
  if (!id) return;

  let run;
  try {
    run = JSON.parse(await fetchText(`runs/${encodeURIComponent(id)}/meta.json`));
  } catch {
    detail.replaceChildren(el("p", { class: "muted placeholder", text: "This reply's record is gone (records are deleted after a week)." }));
    return;
  }

  // Re-render only when something changed; keep open sections and the scroll position
  const attemptSizes = [];
  for (const attempt of run.attempts || []) {
    try {
      const head = await fetch(`runs/${encodeURIComponent(id)}/${encodeURIComponent(attempt.file)}`, { method: "HEAD", cache: "no-store" });
      attemptSizes.push(head.headers.get("content-length"));
    } catch {
      attemptSizes.push("?");
    }
  }
  const key = JSON.stringify([run, attemptSizes]);
  if (!force && key === state.detailKey) return;
  state.detailKey = key;
  const open = new Set([...detail.querySelectorAll("details[open][data-key]")].map((node) => node.dataset.key));
  const scroll = detail.scrollTop;

  const header = el("div", { class: "detail-header" },
    el("a", { href: "#", class: "back", text: "All replies" }),
    el("h2", {}, githubLink(run.url, `${run.repo} #${run.number}`), " ", statusBadge(run.status)),
    run.reply_url ? githubLink(run.reply_url, "View the posted reply on GitHub") : null);

  const comment = el("div", { class: "comment" },
    el("div", { class: "muted small" }, githubLink(run.comment_url, `@${run.author} commented`), ` · ${formatTime(run.started_at)}`),
    el("div", { class: "comment-text", text: run.comment || "" }));

  const facts = el("dl", { class: "facts" },
    fact("Type", run.type),
    fact("Answered by", run.answered_by ? `${modelName(run.answered_by.model)} (${run.answered_by.backend})` : ""),
    fact("Requested model", run.requested_model ? modelName(run.requested_model) : ""),
    fact("Effort", run.effort),
    fact("Backends", run.backends),
    fact("CI", run.ci),
    fact("Checkout", run.checkout ? `commit ${run.checkout}` : ""),
    fact("Duration", formatDuration(between(run.started_at, run.finished_at)) + (run.finished_at ? "" : " so far")));

  const attempts = await Promise.all((run.attempts || []).map((attempt) => renderAttempt(run, attempt)));

  const sections = [header, comment, facts];
  sections.push(el("h3", { class: "section-title", text: "Activity" }));
  sections.push(...(attempts.length ? attempts : [el("p", { class: "muted", text: "Gathering the diff, CI results and the code checkout..." })]));
  if (run.status === "posted" || run.status === "post_failed") {
    try {
      const reply = await fetchText(`runs/${encodeURIComponent(id)}/reply.md`);
      const label = run.status === "posted" ? "Posted reply" : "Reply (posting it failed)";
      sections.push(el("details", { "data-key": "reply" }, el("summary", { text: label }), el("div", { class: "reply" }, markdown(reply))));
    } catch {
      // No reply file
    }
  }
  try {
    const prompt = await fetchText(`runs/${encodeURIComponent(id)}/prompt.txt`);
    sections.push(el("details", { "data-key": "prompt" }, el("summary", { text: `Prompt sent to the model (${formatNumber(prompt.length)} characters)` }), collapsibleOutput(prompt, false)));
  } catch {
    // The prompt isn't written yet
  }

  detail.replaceChildren(...sections);
  for (const node of detail.querySelectorAll("details[data-key]")) {
    if (open.has(node.dataset.key)) node.open = true;
  }
  detail.scrollTop = scroll;
}

// ---------------------------------------------------------------------------
// Routing and polling
// ---------------------------------------------------------------------------
function selectFromHash() {
  const match = /run=([^&]+)/.exec(location.hash);
  state.selectedId = match ? decodeURIComponent(match[1]) : null;
  state.detailKey = "";
  document.body.classList.toggle("has-selection", Boolean(state.selectedId));
  renderList();
  if (state.selectedId) {
    $("detail").replaceChildren(el("p", { class: "muted placeholder", text: "Loading..." }));
    renderDetail(true);
  }
}

async function poll() {
  await loadIndex();
  const selected = state.runs.find((run) => run.id === state.selectedId);
  if (selected && (selected.status === "running" || state.detailKey === "")) await renderDetail();
}

$("filter").addEventListener("input", renderList);
$("status-filter").addEventListener("change", renderList);
window.addEventListener("hashchange", selectFromHash);

loadIndex().then(selectFromHash);
setInterval(poll, POLL_MS);
