#!/usr/bin/env bash
# ==============================================================================
# GitHub Automated Code Review & Assistant Agent
# Uses Antigravity CLI (agy) to review code and assist when the bot is mentioned.
# ==============================================================================

# Determine script directory (resolving symlinks)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

# ------------------------------------------------------------------------------
# Environment Configuration Loading
# ------------------------------------------------------------------------------
if [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
elif [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env"; set +a
elif [ -f "$HOME/.review-agent.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$HOME/.review-agent.env"; set +a
fi

# ------------------------------------------------------------------------------
# Configuration Validation
# ------------------------------------------------------------------------------
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "[ERROR] GITHUB_TOKEN is not set. Please define it in your .env file." >&2
  exit 1
fi
export GITHUB_TOKEN

if [ -z "${BOT_USER:-}" ]; then
  echo "[ERROR] BOT_USER is not set. Please define it in your .env file." >&2
  exit 1
fi

if [ -z "${ADMIN_USER:-}" ]; then
  echo "[ERROR] ADMIN_USER is not set. Please define it in your .env file." >&2
  exit 1
fi

# Bot identity defaults
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$BOT_USER}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-${BOT_USER}@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$BOT_USER}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-${BOT_USER}@users.noreply.github.com}"

# State files & storage directories
DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}"
mkdir -p "$DATA_DIR" 2>/dev/null || true

PROCESSED_FILE="${PROCESSED_FILE:-$DATA_DIR/processed_comments.txt}"
UNLOCKED_THREADS_FILE="${UNLOCKED_THREADS_FILE:-$DATA_DIR/unlocked_threads.txt}"
LOG_FILE="${LOG_FILE:-$SCRIPT_DIR/review.log}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"

# Execution tuning
AGY_TIMEOUT="${AGY_TIMEOUT:-15m0s}"
AGY_FLAGS="${AGY_FLAGS:---dangerously-skip-permissions}"

# Monitored repositories list
if [ -n "${WATCH_REPOS:-}" ]; then
  if [[ ! "$(declare -p WATCH_REPOS 2>/dev/null)" =~ "declare -a" ]]; then
    IFS=', ' read -r -a WATCH_REPOS <<< "$WATCH_REPOS"
  fi
else
  WATCH_REPOS=()
fi

# Response footer
DEFAULT_FOOTER=$'\n\n---\n*Msgs from AI review agent powered by Antigravity CLI*'
BOT_FOOTER="${BOT_FOOTER:-$DEFAULT_FOOTER}"

touch "$PROCESSED_FILE"
touch "$UNLOCKED_THREADS_FILE"
touch "$LOG_FILE"

log() {
  local msg="[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

is_thread_unlocked() {
  local repo="$1"
  local item_num="$2"
  local thread_key="${repo}#${item_num}"

  # Fast cache check
  if grep -qx "$thread_key" "$UNLOCKED_THREADS_FILE" 2>/dev/null; then
    return 0
  fi

  # Query issue / PR metadata
  local issue_data
  issue_data=$(gh api "repos/$repo/issues/$item_num" 2>/dev/null)
  if [ -n "$issue_data" ]; then
    local issue_author issue_body
    issue_author=$(echo "$issue_data" | jq -r '.user.login // empty')
    issue_body=$(echo "$issue_data" | jq -r '.body // empty')

    # Condition: Bot created the issue or PR
    if [ "$issue_author" = "$BOT_USER" ]; then
      echo "$thread_key" >> "$UNLOCKED_THREADS_FILE"
      return 0
    fi

    # Condition: Admin created the issue/PR and mentioned the bot in description
    if [ "$issue_author" = "$ADMIN_USER" ]; then
      if echo "$issue_body" | grep -qi "@$BOT_USER"; then
        echo "$thread_key" >> "$UNLOCKED_THREADS_FILE"
        return 0
      fi
    fi
  fi

  # Check previous comments in thread:
  # Has bot already commented, or has Admin mentioned bot?
  local comments_json
  comments_json=$(gh api "repos/$repo/issues/$item_num/comments?per_page=100" 2>/dev/null)
  if [ -n "$comments_json" ]; then
    local has_prior_engagement
    has_prior_engagement=$(echo "$comments_json" | jq -r --arg bot "$BOT_USER" --arg admin "$ADMIN_USER" '
      any(.[]?; (.user.login == $bot) or (.user.login == $admin and (.body | test("@" + $bot; "i"))))
    ')
    if [ "$has_prior_engagement" = "true" ]; then
      echo "$thread_key" >> "$UNLOCKED_THREADS_FILE"
      return 0
    fi
  fi

  return 1
}

process_comment() {
  local repo="$1"
  local item_num="$2"
  local comment_id="$3"
  local comment_user="$4"
  local comment_user_type="$5"
  local prompt_body="$6"
  local comment_api_path="${7:-issues/comments}"

  if [ -z "$comment_id" ] || [ -z "$comment_user" ]; then
    return
  fi

  # Already processed check
  if grep -qx "$comment_id" "$PROCESSED_FILE"; then
    return
  fi

  # 1. Ignore self comments
  if [ "$comment_user" = "$BOT_USER" ]; then
    return
  fi

  # 2. Ignore bot accounts (e.g. vercel[bot], github-actions[bot], etc.)
  if [ "$comment_user_type" = "Bot" ] || [[ "$comment_user" =~ \[[bB]ot\]$ ]] || [[ "$comment_user" =~ ^bot- ]]; then
    log "Ignoring bot comment from @$comment_user on $repo #$item_num (Comment ID: $comment_id)"
    echo "$comment_id" >> "$PROCESSED_FILE"
    return
  fi

  # 3. Ignore comments that do not address / mention the bot
  if ! echo "$prompt_body" | grep -qi "@$BOT_USER"; then
    log "Ignoring comment from @$comment_user on $repo #$item_num (Comment ID: $comment_id): does not mention @$BOT_USER"
    echo "$comment_id" >> "$PROCESSED_FILE"
    return
  fi

  # 4. Scope & Authorization Check
  local thread_key="${repo}#${item_num}"
  local authorized=false

  if [ "$comment_user" = "$ADMIN_USER" ]; then
    log "Authorized: Comment is from Admin @$ADMIN_USER on $repo #$item_num"
    authorized=true
    if ! grep -qx "$thread_key" "$UNLOCKED_THREADS_FILE" 2>/dev/null; then
      echo "$thread_key" >> "$UNLOCKED_THREADS_FILE"
      log "Unlocked thread $thread_key for future interactions by anyone"
    fi
  elif is_thread_unlocked "$repo" "$item_num"; then
    log "Authorized: Thread $thread_key is unlocked (created by bot or previously unlocked by @$ADMIN_USER)"
    authorized=true
  fi

  if [ "$authorized" != "true" ]; then
    log "Ignoring mention from @$comment_user on $repo #$item_num (Comment ID: $comment_id): bot only responds to @$ADMIN_USER unless thread was created by bot or already unlocked by @$ADMIN_USER."
    echo "$comment_id" >> "$PROCESSED_FILE"
    return
  fi

  log "Processing authorized mention from @$comment_user in $repo #$item_num (Comment ID: $comment_id)"
  log "Comment prompt: $prompt_body"

  # 5. Fire eyes reaction to indicate acknowledgment
  if [[ "$comment_id" =~ ^[0-9]+$ ]]; then
    gh api --method POST \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "repos/$repo/$comment_api_path/$comment_id/reactions" \
      -f content='eyes' >/dev/null 2>&1 &
  fi

  # 6. Check if this is a PR or Issue, and fetch diff if available
  local truncated_diff=""
  local item_type="Issue"
  local diff_file="/tmp/item_${item_num}_diff.txt"
  if gh pr diff "$item_num" -R "$repo" > "$diff_file" 2>/dev/null && [ -s "$diff_file" ]; then
    truncated_diff=$(head -c 60000 "$diff_file")
    item_type="Pull Request"
  elif gh pr view "$item_num" -R "$repo" >/dev/null 2>&1; then
    item_type="Pull Request"
  fi
  rm -f "$diff_file"

  # 7. Process with Antigravity CLI (agy)
  log "Forwarding message to Antigravity CLI (agy)..."
  local full_prompt
  full_prompt=$(cat <<PROMPT_EOF
You are an AI assistant responding to a GitHub mention in repository $repo on $item_type #$item_num.

Context:
- Repository: $repo
- $item_type: #$item_num
${truncated_diff:+- Pull Request Diff:
$truncated_diff}

User Message / Instruction (from @$comment_user):
$prompt_body

Instructions:
Directly fulfill the user's request above.
- If the user asks for a review, perform a code review.
- If the user asks you to create a PR, write code, answer questions, explain logic, or take an action, execute or answer exactly what they asked.

Identity & Git Commit Policy:
- You are strictly $BOT_USER (email: $GIT_AUTHOR_EMAIL).
- $ADMIN_USER is the repository maintainer/admin whom you listen to and never impersonate.
- NEVER use, sign, or author git commits as $ADMIN_USER.
- All git commits MUST be authored and committed strictly by $BOT_USER <$GIT_AUTHOR_EMAIL>.
PROMPT_EOF
  )

  log "-------------------- [AGY EXECUTION START] --------------------"
  local temp_output
  temp_output=$(mktemp /tmp/agy_reply.XXXXXX)

  # Stream live to terminal, log file, and capture into temp_output
  agy $AGY_FLAGS --print-timeout "$AGY_TIMEOUT" -p "$full_prompt" 2>&1 | tee "$temp_output" | tee -a "$LOG_FILE"
  local agy_exit=${PIPESTATUS[0]}

  log "-------------------- [AGY EXECUTION END (exit: $agy_exit)] --------------------"

  local ai_reply
  ai_reply=$(cat "$temp_output")
  rm -f "$temp_output"

  if [ $agy_exit -ne 0 ] || [ -z "$ai_reply" ]; then
    log "ERROR: agy returned empty response or failed with exit code $agy_exit"
    echo "$comment_id" >> "$PROCESSED_FILE"
    return
  fi

  # 8. Post response to PR or Issue
  local full_response="${ai_reply}${BOT_FOOTER}"
  log "Posting response comment to $repo $item_type #$item_num..."
  local post_result
  local post_exit=1

  if [ "$item_type" = "Pull Request" ]; then
    post_result=$(gh pr comment "$item_num" -R "$repo" --body "$full_response" 2>&1)
    post_exit=$?
  fi

  if [ $post_exit -ne 0 ]; then
    post_result=$(gh issue comment "$item_num" -R "$repo" --body "$full_response" 2>&1)
    post_exit=$?
  fi

  if [ $post_exit -eq 0 ]; then
    log "Successfully posted response to $repo $item_type #$item_num: $post_result"
    echo "$comment_id" >> "$PROCESSED_FILE"
    if ! grep -qx "$thread_key" "$UNLOCKED_THREADS_FILE" 2>/dev/null; then
      echo "$thread_key" >> "$UNLOCKED_THREADS_FILE"
    fi
  else
    log "ERROR posting comment to $repo $item_type #$item_num: $post_result"
  fi
}

poll_notifications() {
  local notifications
  notifications=$(gh api notifications -q '
    .[] | select((.reason=="mention" or .reason=="author" or .reason=="comment") and (.subject.type=="PullRequest" or .subject.type=="Issue"))
    | "\(.id) \(.repository.full_name) \(.subject.type) \(.subject.url) \(.subject.latest_comment_url // "")"
  ' 2>/dev/null)

  while read -r notif_id repo subj_type subj_url comment_url; do
    [ -z "$notif_id" ] && continue

    local item_num
    item_num=$(basename "$subj_url")

    local comment_id=""
    local comment_user=""
    local comment_user_type="User"
    local comment_body=""
    local comment_api_path="issues/comments"

    if [ -n "$comment_url" ] && [ "$comment_url" != "null" ]; then
      if [[ "$comment_url" =~ /pulls/comments/([0-9]+) ]]; then
        comment_api_path="pulls/comments"
      fi

      local comment_json
      comment_json=$(gh api "$comment_url" 2>/dev/null)
      if [ -n "$comment_json" ]; then
        comment_id=$(echo "$comment_json" | jq -r '.id // empty')
        comment_user=$(echo "$comment_json" | jq -r '.user.login // empty')
        comment_user_type=$(echo "$comment_json" | jq -r '.user.type // "User"')
        comment_body=$(echo "$comment_json" | jq -r '.body // empty')
      fi
    fi

    # If comment_url was missing or pointed to the subject itself
    if [ -z "$comment_id" ]; then
      local subj_json
      subj_json=$(gh api "$subj_url" 2>/dev/null)
      if [ -n "$subj_json" ]; then
        comment_id="subj_$(echo "$subj_json" | jq -r '.id // empty')"
        comment_user=$(echo "$subj_json" | jq -r '.user.login // empty')
        comment_user_type=$(echo "$subj_json" | jq -r '.user.type // "User"')
        comment_body=$(echo "$subj_json" | jq -r '.body // empty')
      fi
    fi

    if [ -n "$comment_id" ]; then
      process_comment "$repo" "$item_num" "$comment_id" "$comment_user" "$comment_user_type" "$comment_body" "$comment_api_path"
    fi

    # Mark notification as read so it is not processed repeatedly
    gh api --method PATCH "notifications/threads/$notif_id" >/dev/null 2>&1
  done <<< "$notifications"
}

poll_repo_comments() {
  local repo="$1"
  local comments
  comments=$(gh api "repos/$repo/issues/comments?sort=created&direction=desc&per_page=15" \
    -q '.[] | select((.body | test("@'$BOT_USER'"; "i")) and .user.login != "'$BOT_USER'") | "\(.id) \(.issue_url) \(.user.login) \(.user.type // "User")"' 2>/dev/null)

  while read -r comment_id issue_url comment_user comment_user_type; do
    [ -z "$comment_id" ] && continue

    if grep -qx "$comment_id" "$PROCESSED_FILE"; then
      continue
    fi

    local item_num
    item_num=$(basename "$issue_url")

    local comment_body
    comment_body=$(gh api "repos/$repo/issues/comments/$comment_id" -q '.body' 2>/dev/null)

    process_comment "$repo" "$item_num" "$comment_id" "$comment_user" "$comment_user_type" "$comment_body" "issues/comments"
  done <<< "$comments"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  log "=== Review Agent started as @$BOT_USER (Admin: @$ADMIN_USER) ==="
  log "Monitoring notifications and repos: ${WATCH_REPOS[*]:-(None specified)}"

  # Polling loop
  while true; do
    poll_notifications

    for r in "${WATCH_REPOS[@]}"; do
      poll_repo_comments "$r"
    done

    sleep "$POLL_INTERVAL"
  done
fi
