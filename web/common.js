// Helpers shared by the activity page (app.js) and the settings page (settings.js)
"use strict";

const $ = (id) => document.getElementById(id);

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

// claude-opus-5-5 -> Claude Opus 5.5
function modelName(id) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id || "");
  if (!match) return id || "";
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return `Claude ${family} ${match[2]}${match[3] ? "." + match[3] : ""}`;
}
