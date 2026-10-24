#!/usr/bin/env bash
# ==============================================================================
# Interactive setup for the review agent. It stops the service, asks which AI
# backend to use (Claude Code CLI, Claude API or Antigravity CLI), tests each
# choice right away, and once you type "done" saves the settings to .env and
# redeploys the service. Quitting early starts the service again unchanged.
# ==============================================================================
set -uo pipefail

AGENT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ENV="$AGENT_DIR/.env"
SERVICE="review-agent.service"
UNIT_SRC="$AGENT_DIR/systemd/$SERVICE"
UNIT_DST="$HOME/.config/systemd/user/$SERVICE"
# The service's PATH, so the CLIs tested here are the ones it will run
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [ -t 1 ]; then
  B=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GRN=$'\e[32m' YEL=$'\e[33m' RST=$'\e[0m'
else
  B="" DIM="" RED="" GRN="" YEL="" RST=""
fi
heading() { printf '\n%s== %s ==%s\n' "$B" "$*" "$RST"; }
ok()      { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
fail()    { printf '  %s✗%s %s\n' "$RED" "$RST" "$*"; }
warn()    { printf '  %s!%s %s\n' "$YEL" "$RST" "$*"; }
note()    { printf '  %s%s%s\n' "$DIM" "$*" "$RST"; }

# ask VAR PROMPT [DEFAULT]: read a line into VAR; an empty answer gives DEFAULT
ask() {
  local _answer
  read -r -p "  $2${3:+ [$3]}: " _answer || { echo; exit 1; }
  printf -v "$1" '%s' "${_answer:-${3:-}}"
}

# ask_secret VAR PROMPT: like ask, without echoing what is typed
ask_secret() {
  local _answer
  read -r -s -p "  $2: " _answer || { echo; exit 1; }
  echo >&2
  printf -v "$1" '%s' "$_answer"
}

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the user the service belongs to, without sudo." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 1. Stop the service. From here on, leaving without "done" starts it again.
# ------------------------------------------------------------------------------
heading "GitHub review agent setup"

was_active=false
systemctl --user is-active --quiet "$SERVICE" && was_active=true
deployed=false
TMP_DIR=$(mktemp -d)

on_exit() {
  rm -rf "$TMP_DIR"
  if [ "$deployed" = false ] && [ "$was_active" = true ]; then
    echo
    warn "Setup didn't finish, so nothing was saved. Starting $SERVICE again with its previous settings."
    systemctl --user start "$SERVICE"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

if [ "$was_active" = true ]; then
  systemctl --user stop "$SERVICE" && ok "Stopped $SERVICE"
else
  note "$SERVICE was not running"
fi

# ------------------------------------------------------------------------------
# 2. Load the current settings and the agent's backend functions
# ------------------------------------------------------------------------------
if [ ! -f "$AGENT_ENV" ]; then
  cp "$AGENT_DIR/.env.example" "$AGENT_ENV"
  chmod 600 "$AGENT_ENV"
  note "Created .env from .env.example"
fi
# shellcheck disable=SC1090
set -a; source "$AGENT_ENV"; set +a

# Settings to write to .env when you type "done"
declare -A PENDING=()

heading "GitHub"
is_placeholder() { [ -z "$1" ] || [[ "$1" == *your* ]]; }
if is_placeholder "${GITHUB_TOKEN:-}"; then
  ask_secret GITHUB_TOKEN "GitHub token for the bot account (repo + notifications scopes, input hidden)"
  PENDING[GITHUB_TOKEN]="$GITHUB_TOKEN"
fi
if is_placeholder "${BOT_USER:-}"; then
  ask BOT_USER "Bot's GitHub username"
  PENDING[BOT_USER]="$BOT_USER"
fi
if is_placeholder "${ADMIN_USER:-}"; then
  ask ADMIN_USER "Admin's GitHub username (the bot always answers them)"
  PENDING[ADMIN_USER]="$ADMIN_USER"
fi
if gh_login=$(GH_TOKEN="$GITHUB_TOKEN" gh api user -q .login 2>/dev/null); then
  ok "GitHub token works for @$gh_login (bot: @$BOT_USER, admin: @$ADMIN_USER)"
  [ "$gh_login" != "$BOT_USER" ] && warn "The token belongs to @$gh_login, not the bot user @$BOT_USER"
else
  fail "GitHub rejected the token; the agent can't read or post comments until it's fixed"
fi

# Load run_claude_cli, run_claude_api, run_agy and the defaults without re-reading .env
ENV_FILE="$TMP_DIR/empty.env"
: > "$ENV_FILE"
# shellcheck disable=SC1091
source "$AGENT_DIR/review-agent.sh"
unset ENV_FILE

# ------------------------------------------------------------------------------
# 3. Choose the backends
# ------------------------------------------------------------------------------
heading "AI backend"
note "Current setting: AI_BACKENDS=\"$AI_BACKENDS\""
cat <<EOF
  1) Claude Code CLI      this machine's Claude login; can read code, run gh and open PRs
  2) Claude API           an API key; answers from the comment and the PR diff only
  3) Claude Code CLI, then the Claude API when the CLI fails
  4) Claude API, then the Claude Code CLI when the API fails
  5) Antigravity CLI (agy)
  6) Keep the current setting
EOF
while :; do
  ask choice "Choose 1-6" 6
  case "$choice" in
    1) backends="claude-cli" ;;
    2) backends="claude-api" ;;
    3) backends="claude-cli claude-api" ;;
    4) backends="claude-api claude-cli" ;;
    5) backends="agy" ;;
    6) backends="$AI_BACKENDS" ;;
    *) warn "Pick a number from 1 to 6"; continue ;;
  esac
  break
done
PENDING[AI_BACKENDS]="$backends"

# ------------------------------------------------------------------------------
# 4. Configure and test each chosen backend
# ------------------------------------------------------------------------------
TEST_PROMPT="$TMP_DIR/prompt.txt"
ERR_FILE="$TMP_DIR/stderr.txt"
HDR_FILE="$TMP_DIR/headers.txt"
printf 'This is a connectivity test. Reply with exactly: OK\n' > "$TEST_PROMPT"

# Explain the common failures in plain words
explain_error() {
  local err
  err=$(cat "$ERR_FILE" "$TMP_DIR/out.txt" 2>/dev/null)
  case "$err" in
    *"credit balance"*) note "The API account is out of credits: https://platform.claude.com/settings/billing" ;;
    *enforced_spend_limit_reached*) note "The organization hit its monthly spend cap: https://platform.claude.com/settings/billing" ;;
    *"specified API usage limits"*|*"specified workspace API usage limits"*) note "A spend limit you set was reached: https://platform.claude.com/settings/billing" ;;
    *authentication_error*) note "The key was rejected. Check it, or create one at https://platform.claude.com/settings/keys" ;;
    *permission_error*) note "The key isn't allowed to use this model or workspace" ;;
    *not_found_error*) note "This model isn't available to the key; check the model name" ;;
    *rate_limit_error*|*overloaded_error*) note "Rate-limited or overloaded right now; retrying in a minute usually works" ;;
    *"limit reached"*|*"usage limit"*|*"hit your limit"*) note "The Claude plan's usage limit is used up until it resets" ;;
    *"not logged in"*|*"/login"*|*"Invalid API key"*) note "Log in with: claude auth login" ;;
  esac
}

# test_models BACKEND "MODELS": send the test prompt to each model; fails if any model fails
test_models() {
  local backend="$1" models="$2" model start rc status=0
  for model in $models; do
    note "Testing $model..."
    start=$SECONDS
    "run_${backend//-/_}" "$model" "$TEST_PROMPT" "$HDR_FILE" > "$TMP_DIR/out.txt" 2> "$ERR_FILE"
    rc=$?
    if [ $rc -eq 0 ] && [ -s "$TMP_DIR/out.txt" ]; then
      ok "$model works ($((SECONDS - start))s), replied: $(head -c 60 "$TMP_DIR/out.txt" | tr '\n' ' ')"
      [ -s "$ERR_FILE" ] && note "$(tail -1 "$ERR_FILE")"
    else
      fail "$model failed (exit $rc, $((SECONDS - start))s)"
      tail -n 5 "$ERR_FILE" "$TMP_DIR/out.txt" 2>/dev/null | grep -v '^==>' | grep . | sed 's/^/      /'
      explain_error
      status=1
    fi
  done
  return $status
}

# list_models BACKEND: print the available models as "id<TAB>name" lines
list_models() {
  case "$1" in
    claude-cli|claude-api)
      # The Models API needs a key; without one, list the current Claude models
      if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "$(curl -sS --max-time 20 -o "$TMP_DIR/models.json" -w '%{http_code}' \
          "https://api.anthropic.com/v1/models?limit=100" -H "anthropic-version: 2026-10-21" \
          -H @<(printf 'x-api-key: %s\n' "$ANTHROPIC_API_KEY"))" = 200 ]; then
        jq -r '.data[] | "\(.id)\t\(.display_name)"' "$TMP_DIR/models.json"
      else
        printf '%s\t%s\n' claude-fable-5-1 "Claude Fable 5.1" claude-opus-5-5 "Claude Opus 5.5" \
          claude-sonnet-5-5 "Claude Sonnet 5.5" claude-haiku-5-5 "Claude Haiku 5.5"
      fi
      ;;
    agy) agy models 2>/dev/null | grep $'\t' ;;
  esac
}

# pick_models VAR BACKEND: show the available models, then set VAR to "DEFAULT FALLBACK..."
pick_models() {
  local var="$1" current="${!1}" id name pick fallbacks fb m
  local -a ids=()
  note "Available models:"
  while IFS=$'\t' read -r id name; do
    [ -n "$id" ] || continue
    ids+=("$id")
    printf '    %2d) %-26s %s%s\n' "${#ids[@]}" "$id" "$name" \
      "$([ "$id" = "${current%% *}" ] && echo "  <- current default")"
  done < <(list_models "$2")
  [ ${#ids[@]} -gt 0 ] || warn "Couldn't list the models; type a model name"

  ask pick "Default model (number or name)" "${current%% *}"
  if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le ${#ids[@]} ]; then
    pick="${ids[$((pick - 1))]}"
  fi
  # Suggest the rest of the current list as fallbacks
  fallbacks=""
  for m in $current; do [ "$m" != "$pick" ] && fallbacks+="${fallbacks:+ }$m"; done
  ask fb "Fallback models if it fails, in order ('-' for none)" "${fallbacks:--}"
  [ "$fb" = "-" ] && fb=""
  printf -v "$var" '%s' "$pick${fb:+ $fb}"
  ok "Models: $pick${fb:+, then $fb}"
}

configure_claude_cli() {
  heading "Claude Code CLI"
  if ! command -v claude >/dev/null; then
    fail "claude isn't installed. Install it with: curl -fsSL https://claude.ai/install.sh | bash"
    return 1
  fi
  local auth yn
  auth=$(claude auth status 2>/dev/null)
  if [ "$(jq -r '.loggedIn // false' <<< "$auth" 2>/dev/null)" != true ]; then
    warn "claude isn't logged in on this machine"
    ask yn "Log in now with 'claude auth login'? (y/n)" y
    [[ "$yn" == y* ]] && claude auth login
    auth=$(claude auth status 2>/dev/null)
  fi
  if [ "$(jq -r '.loggedIn // false' <<< "$auth" 2>/dev/null)" = true ]; then
    ok "$(jq -r '"Logged in as \(.email // "unknown"), plan: \(.subscriptionType // .authMethod // "unknown")"' <<< "$auth")"
  fi
  note "Plan usage limits are only shown inside Claude Code: run claude and type /usage"
  pick_models CLAUDE_MODELS claude-cli
  PENDING[CLAUDE_MODELS]="$CLAUDE_MODELS"
  PENDING[CLAUDE_EFFORT]="$CLAUDE_EFFORT"
  test_models claude-cli "$CLAUDE_MODELS"
}

# Rate-limit headroom from the response headers of the last API test
show_rate_limits() {
  local kind limit left
  for kind in requests input-tokens output-tokens; do
    limit=$(grep -i "^anthropic-ratelimit-$kind-limit:" "$HDR_FILE" | tail -1 | cut -d: -f2 | tr -d ' \r')
    left=$(grep -i "^anthropic-ratelimit-$kind-remaining:" "$HDR_FILE" | tail -1 | cut -d: -f2 | tr -d ' \r')
    [ -n "$limit" ] && ok "Rate limit, ${kind/-/ } per minute: $left of $limit left"
  done
}

# This month's spend from the Admin API cost report (amounts are USD cents as decimal strings)
show_month_spend() {
  local key="$1" since code cents
  since=$(date -u +%Y-%m-01T00:00:00Z)
  code=$(curl -sS -o "$TMP_DIR/cost.json" -w '%{http_code}' \
    "https://api.anthropic.com/v1/organizations/cost_report?starting_at=$since&bucket_width=1d&limit=31" \
    -H "anthropic-version: 2026-10-21" \
    -H @<(printf 'x-api-key: %s\n' "$key"))
  if [ "$code" = 200 ]; then
    cents=$(jq '[.data[].results[].amount | tonumber] | add // 0 | round' "$TMP_DIR/cost.json")
    ok "Spent this month (since ${since%T*}): \$$((cents / 100)).$(printf '%02d' $((cents % 100)))"
  else
    fail "Couldn't read the cost report (HTTP $code): $(jq -r '.error.message // empty' "$TMP_DIR/cost.json" 2>/dev/null)"
  fi
}

configure_claude_api() {
  heading "Claude API"
  local new_key admin_key prompt="Anthropic API key (input hidden)"
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    prompt="Anthropic API key, or Enter to keep the current one (ending ${ANTHROPIC_API_KEY: -4})"
  fi
  ask_secret new_key "$prompt"
  if [ -n "$new_key" ]; then
    if [[ ! "$new_key" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]]; then
      fail "That doesn't look like an Anthropic API key (they start with sk-ant-)"
      return 1
    fi
    ANTHROPIC_API_KEY="$new_key"
  elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    fail "The Claude API needs a key. Create one at https://platform.claude.com/settings/keys"
    return 1
  fi
  PENDING[ANTHROPIC_API_KEY]="$ANTHROPIC_API_KEY"

  pick_models CLAUDE_API_MODELS claude-api
  PENDING[CLAUDE_API_MODELS]="$CLAUDE_API_MODELS"
  PENDING[CLAUDE_EFFORT]="$CLAUDE_EFFORT"
  test_models claude-api "$CLAUDE_API_MODELS" || return 1

  show_rate_limits
  note "The API doesn't report the remaining credit balance; see https://platform.claude.com/settings/billing"
  ask_secret admin_key "Admin API key (sk-ant-admin...) to show this month's spend; not saved, Enter to skip"
  [ -n "$admin_key" ] && show_month_spend "$admin_key"
  return 0
}

configure_agy() {
  heading "Antigravity CLI"
  if ! command -v agy >/dev/null; then
    fail "agy isn't installed"
    return 1
  fi
  pick_models AGY_MODELS agy
  PENDING[AGY_MODELS]="$AGY_MODELS"
  test_models agy "$AGY_MODELS"
}

declare -a RESULTS=()
for backend in $backends; do
  case "$backend" in
    claude-cli|claude-api|agy) ;;
    *) warn "Unknown backend '$backend', skipping"; continue ;;
  esac
  while :; do
    if "configure_${backend//-/_}"; then
      RESULTS+=("${GRN}✓${RST} $backend works")
      break
    fi
    ask next "[r]etry, [c]ontinue anyway, or [q]uit without saving" r
    case "$next" in
      c*) RESULTS+=("${RED}✗${RST} $backend failed its test"); break ;;
      q*) exit 1 ;;
    esac
  done
done

# ------------------------------------------------------------------------------
# 5. Confirm, save and redeploy
# ------------------------------------------------------------------------------
heading "Summary"
printf '  Backends, in order: %s\n' "$backends"
for line in "${RESULTS[@]}"; do printf '  %s\n' "$line"; done
[[ " $backends " == *" claude-"* ]] &&
  note "Claude effort: $CLAUDE_EFFORT. In a comment, you (@$ADMIN_USER) can add --model <name> and --effort <level> for one reply."
for key in "${!PENDING[@]}"; do
  case "$key" in
    *TOKEN*|*KEY*) printf '  %s%s%s = (hidden, ending %s)\n' "$DIM" "$key" "$RST" "${PENDING[$key]: -4}" ;;
    *) printf '  %s%s%s = "%s"\n' "$DIM" "$key" "$RST" "${PENDING[$key]}" ;;
  esac
done

while :; do
  ask answer "Type done to save and redeploy, or q to quit without saving" done
  case "$answer" in
    done|d|y|yes) break ;;
    q|quit) exit 1 ;;
  esac
done

# set_env KEY VALUE: replace KEY's line in .env, or add it
set_env() {
  local tmp
  tmp=$(mktemp "$AGENT_ENV.XXXXXX")
  KEY="$1" VALUE="$2" awk '
    BEGIN { line = ENVIRON["KEY"] "=\"" ENVIRON["VALUE"] "\"" }
    index($0, ENVIRON["KEY"] "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$AGENT_ENV" > "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$AGENT_ENV"
}

heading "Deploying"
cp -p "$AGENT_ENV" "$AGENT_ENV.bak"
for key in "${!PENDING[@]}"; do set_env "$key" "${PENDING[$key]}"; done
chmod 600 "$AGENT_ENV"
ok "Saved .env (previous version in .env.bak)"

if ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  mkdir -p "$(dirname "$UNIT_DST")"
  cp "$UNIT_SRC" "$UNIT_DST"
  systemctl --user daemon-reload
  ok "Installed the updated unit file"
fi

deployed=true
systemctl --user enable --quiet "$SERVICE"
systemctl --user restart "$SERVICE"
sleep 3
if systemctl --user is-active --quiet "$SERVICE"; then
  ok "$SERVICE is running"
  journalctl --user -u "$SERVICE" -n 3 --no-pager -o cat | sed 's/^/      /'
else
  fail "$SERVICE didn't stay up. Recent logs:"
  journalctl --user -u "$SERVICE" -n 20 --no-pager -o cat | sed 's/^/      /'
  exit 1
fi
note "Follow it with: journalctl --user -u $SERVICE -f"
