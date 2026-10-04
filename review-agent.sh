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
# Models tried in order (see `agy models`); the next one is used if a model fails,
# e.g. because its quota is exhausted.
AGY_MODELS="${AGY_MODELS:-gemini-3.8-flash-high claude-sonnet-5-5-high gemini-3.1-pro-high}"

# Monitored repositories list
if [ -n "${WATCH_REPOS:-}" ]; then
  if [[ ! "$(declare -p WATCH_REPOS 2>/dev/null)" =~ "declare -a" ]]; then
    IFS=', ' read -r -a WATCH_REPOS <<< "$WATCH_REPOS"
  fi
else
  WATCH_REPOS=()
fi

# Response footer
# BOT_FOOTER is optional extra text; the "Reviewed by" line is always appended after it.
BOT_FOOTER="${BOT_FOOTER:-}"
OWNER_NAME="${OWNER_NAME:-$ADMIN_USER}"

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
  elif [[ "$comment_id" =~ ^subj_ ]]; then
    gh api --method POST \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "repos/$repo/issues/$item_num/reactions" \
      -f content='eyes' >/dev/null 2>&1 &
  fi

  # 6. Check if this is a PR or Issue, and fetch diff if available
  local truncated_diff=""
  local item_type="Issue"
  local diff_file="/tmp/item_${item_num}_diff.txt"
  if gh pr diff "$item_num" -R "$repo" > "$diff_file" 2>/dev/null && [ -s "$diff_file" ]; then
    local diff_size
    diff_size=$(wc -c < "$diff_file")
    if [ "$diff_size" -gt 90000 ]; then
      truncated_diff="$(head -c 90000 "$diff_file")"$'\n\n[Diff truncated: exceeded 90KB limit for review prompt]'
    else
      truncated_diff=$(cat "$diff_file")
    fi
    item_type="Pull Request"
  elif gh pr view "$item_num" -R "$repo" --json number >/dev/null 2>&1; then
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

Critical Execution Constraints:
1. OUTPUT ONLY THE RESPONSE TEXT: Output strictly your final Markdown response. Do NOT include conversational meta-monologue, scratchpad chatter, or planning statements (e.g. NEVER output "Let me analyze the diff...", "Now let me compose...", "Good — no reviews yet...", "The review has been posted...", or "Here's a summary:").
2. DO NOT POST VIA TOOLS: NEVER execute 'gh pr review', 'gh pr comment', 'gh issue comment', or curl commands to post comments or reviews yourself. The parent runner script automatically takes your response text and posts it to GitHub.
3. CODE REVIEW FORMAT: If the user asks for a review (or review feedback), follow this strict format without any text preceding "## 📋 Code Review":

## 📋 Code Review

| Metric | Assessment |
| :--- | :--- |
| **Verdict** | ✅ Approved / ⚠️ Changes Requested / 💬 Comment Only |
| **Risk Level** | 🟢 Low / 🟡 Medium / 🔴 High |
| **Scope** | [1-sentence summary of affected components] |

### 🔍 Executive Overview
[2-3 concise sentences summarizing the purpose, architecture, and overall quality of the changes.]

---

### 🔴 Blocking Issues (Must Fix Before Merge)
*Critical bugs, security vulnerabilities, runtime crashes, breaking API changes, or broken tests.*

- **\`[filename]\` (line [range]) — [Issue Title]**:
  - **Problem**: Clear description of what fails and when.
  - **Impact**: Security, stability, or correctness consequence.
  - **Suggested Fix**:
    \`\`\`[language]
    // Concrete code replacement
    \`\`\`
*(If none, explicitly write: "✅ None identified.")*

---

### 🟡 Non-Blocking Suggestions (Nice to Have)
*Performance optimizations, edge cases, naming, ergonomics, and documentation.*

- **\`[filename]\` (line [range]) — [Suggestion Title]**:
  - **Observation**: What could be improved.
  - **Recommendation**: Alternative approach or refinement.
*(If none, explicitly write: "None identified.")*

---

### 🟢 Positive Highlights
*Architectural decisions, safety rails, clean patterns, or comprehensive test coverage.*

- **[Highlight 1]**: Why this was well done.
- **[Highlight 2]**: Why this was well done.

---

Instructions for Non-Review Requests:
- If the user asks you to create a PR, write code, answer questions, explain logic, or take an action, execute or answer exactly what they asked clearly and directly without conversational preambles.

Code Review Isolation:
- When performing a code review, analyze the diff and codebase passively. NEVER checkout git branches, stash/pop changes, or modify files in local server workspaces.

Identity & Git Commit Policy:
- You are strictly $BOT_USER (email: $GIT_AUTHOR_EMAIL).
- $ADMIN_USER is the repository maintainer/admin whom you listen to and never impersonate.
- NEVER use, sign, or author git commits as $ADMIN_USER.
- All git commits MUST be authored and committed strictly by $BOT_USER <$GIT_AUTHOR_EMAIL>.
PROMPT_EOF
  )

  # Ensure full_prompt never exceeds Linux kernel MAX_ARG_STRLEN (128 KiB = 131,072 bytes)
  if [ ${#full_prompt} -gt 120000 ]; then
    full_prompt="${full_prompt:0:120000}"$'\n\n[Prompt truncated to stay within system argument limits]'
  fi

  # Try each model in AGY_MODELS until one produces a reply
  local ai_reply="" agy_exit=1 model temp_output
  for model in $AGY_MODELS; do
    log "-------------------- [AGY EXECUTION START (model: $model)] --------------------"
    temp_output=$(mktemp /tmp/agy_reply.XXXXXX)

    # Stream live to terminal, log file, and capture into temp_output
    agy $AGY_FLAGS --model "$model" --print-timeout "$AGY_TIMEOUT" -p "$full_prompt" 2>&1 | tee "$temp_output" | tee -a "$LOG_FILE"
    agy_exit=${PIPESTATUS[0]}

    log "-------------------- [AGY EXECUTION END (model: $model, exit: $agy_exit)] --------------------"

    ai_reply=$(cat "$temp_output")
    rm -f "$temp_output"

    # Sanitize reply: strip intermediate agent loop/idle chatter and extract clean review
    if echo "$ai_reply" | grep -q "## 📋 Code Review"; then
      ai_reply=$(echo "$ai_reply" | awk '/## 📋 Code Review/{p=1} p')
    else
      ai_reply=$(echo "$ai_reply" | sed -E \
        -e '/^No response received within the allotted time/d' \
        -e '/^\*(Current Time|Active Task|Active Timers|Subagents|Background Work Remaining|Awaiting Asynchronous Event|State: IDLE|Turn Policy|Session ID|Next Steps|Next Step Trigger|Execution Context|Waiting for task ID|Process details|Idle Policy|Context check|Timeout condition|Notification channel|End of cycle marker|Task ID to monitor|Awaiting notification event|Sleeping|Event listener active|End of turn).*\*$/d' \
        -e '/^\.\.\.$/d')
      ai_reply=$(echo "$ai_reply" | awk 'NF{p=1} p')
    fi

    if [ $agy_exit -eq 0 ] && [ -n "$ai_reply" ]; then
      # A short reply that reads like a quota error is a failure, not a review
      if [ ${#ai_reply} -lt 600 ] && echo "$ai_reply" | grep -qiE 'quota|rate.?limit|resource.?exhausted|usage limit|credit|429'; then
        log "Model $model looks quota-limited; trying next model"
        ai_reply=""
        agy_exit=1
        continue
      fi
      log "Reply generated by model: $model"
      break
    fi

    log "Model $model failed (exit: $agy_exit); trying next model"
    ai_reply=""
  done

  if [ $agy_exit -ne 0 ] || [ -z "$ai_reply" ]; then
    log "ERROR: all models in AGY_MODELS failed or returned an empty response (last exit code $agy_exit)"
    echo "$comment_id" >> "$PROCESSED_FILE"
    return
  fi

  # 8. Post response to PR or Issue
  local full_response="${ai_reply}${BOT_FOOTER}"$'\n\n---\n'"*Reviewed by ${model} on behalf of [${OWNER_NAME}](https://github.com/${ADMIN_USER})*"
  log "Posting response comment to $repo $item_type #$item_num..."
  local post_result
  local post_exit=1
  local resp_file
  resp_file=$(mktemp /tmp/bot_resp.XXXXXX)
  printf "%s\n" "$full_response" > "$resp_file"

  if [ "$item_type" = "Pull Request" ]; then
    post_result=$(gh pr comment "$item_num" -R "$repo" -F "$resp_file" 2>&1)
    post_exit=$?
  fi

  if [ $post_exit -ne 0 ]; then
    post_result=$(gh issue comment "$item_num" -R "$repo" -F "$resp_file" 2>&1)
    post_exit=$?
  fi
  rm -f "$resp_file"

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
    | "\(.id) \(.repository.full_name) \(.subject.type) \(.subject.url) \(.subject.latest_comment_url // "none") \(.reason) \(.updated_at)"
  ' 2>&1)
  local notif_exit=$?

  if [ $notif_exit -ne 0 ]; then
    if [ "${NOTIF_WARN_LOGGED:-false}" != "true" ]; then
      log "[INFO] GitHub notifications API unavailable (exit: $notif_exit). Polling via WATCH_REPOS."
      NOTIF_WARN_LOGGED=true
    fi
    return
  fi

  while read -r notif_id repo subj_type subj_url comment_url notif_reason updated_at; do
    [ -z "$notif_id" ] && continue

    local item_num
    item_num=$(basename "$subj_url")
    local thread_handled=false

    # Case 1: comment_url is an actual comment endpoint (contains /comments/<id>)
    if [ -n "$comment_url" ] && [ "$comment_url" != "none" ] && [[ "$comment_url" =~ /comments/([0-9]+) ]]; then
      local comment_api_path="issues/comments"
      if [[ "$comment_url" =~ /pulls/comments/ ]]; then
        comment_api_path="pulls/comments"
      fi

      local comment_json
      comment_json=$(gh api "$comment_url" 2>/dev/null)
      if [ -n "$comment_json" ]; then
        local comment_id comment_user comment_user_type comment_body
        comment_id=$(echo "$comment_json" | jq -r '.id // empty')
        comment_user=$(echo "$comment_json" | jq -r '.user.login // empty')
        comment_user_type=$(echo "$comment_json" | jq -r '.user.type // "User"')
        comment_body=$(echo "$comment_json" | jq -r '.body // empty')

        if [ -n "$comment_id" ]; then
          process_comment "$repo" "$item_num" "$comment_id" "$comment_user" "$comment_user_type" "$comment_body" "$comment_api_path"
          thread_handled=true
        fi
      fi
    fi

    # Case 2: comment_url was missing, "none", or pointed to the PR/issue itself (/pulls/123 or /issues/123).
    # Actively inspect recent comments on this issue/PR for mentions of the bot.
    if [ "$thread_handled" = "false" ]; then
      local recent_comments
      recent_comments=$(gh api "repos/$repo/issues/comments?sort=created&direction=desc&per_page=15" 2>/dev/null)
      # Check issue-level comments for this issue/PR
      local matched_comments
      matched_comments=$(gh api "repos/$repo/issues/$item_num/comments?sort=created&direction=desc&per_page=10" \
        -q '.[] | select((.body | test("@'$BOT_USER'"; "i")) and .user.login != "'$BOT_USER'") | "\(.id) \(.user.login) \(.user.type // "User")"' 2>/dev/null)

      while read -r c_id c_user c_utype; do
        [ -z "$c_id" ] && continue
        if ! grep -qx "$c_id" "$PROCESSED_FILE"; then
          local c_body
          c_body=$(gh api "repos/$repo/issues/comments/$c_id" -q '.body' 2>/dev/null)
          process_comment "$repo" "$item_num" "$c_id" "$c_user" "$c_utype" "$c_body" "issues/comments"
        fi
        thread_handled=true
      done <<< "$matched_comments"

      # Also inspect recent PR review comments if this is a Pull Request
      if [ "$subj_type" = "PullRequest" ]; then
        local matched_pull_comments
        matched_pull_comments=$(gh api "repos/$repo/pulls/$item_num/comments?sort=created&direction=desc&per_page=10" \
          -q '.[] | select((.body | test("@'$BOT_USER'"; "i")) and .user.login != "'$BOT_USER'") | "\(.id) \(.user.login) \(.user.type // "User")"' 2>/dev/null)

        while read -r c_id c_user c_utype; do
          [ -z "$c_id" ] && continue
          if ! grep -qx "$c_id" "$PROCESSED_FILE"; then
            local c_body
            c_body=$(gh api "repos/$repo/pulls/comments/$c_id" -q '.body' 2>/dev/null)
            process_comment "$repo" "$item_num" "$c_id" "$c_user" "$c_utype" "$c_body" "pulls/comments"
          fi
          thread_handled=true
        done <<< "$matched_pull_comments"
      fi
    fi

    # Case 3: Check if the mention was in the opening Issue / PR description itself
    if [ "$thread_handled" = "false" ]; then
      local subj_json
      subj_json=$(gh api "$subj_url" 2>/dev/null)
      if [ -n "$subj_json" ]; then
        local s_id s_user s_utype s_body
        s_id="subj_$(echo "$subj_json" | jq -r '.id // empty')"
        s_user=$(echo "$subj_json" | jq -r '.user.login // empty')
        s_utype=$(echo "$subj_json" | jq -r '.user.type // "User"')
        s_body=$(echo "$subj_json" | jq -r '.body // empty')

        if echo "$s_body" | grep -qi "@$BOT_USER"; then
          if ! grep -qx "$s_id" "$PROCESSED_FILE"; then
            process_comment "$repo" "$item_num" "$s_id" "$s_user" "$s_utype" "$s_body" "issues/comments"
          fi
          thread_handled=true
        fi
      fi
    fi

    # Acknowledgment:
    # If handled, mark as read. If not handled and reason was "mention", check age:
    # if older than 3 minutes (e.g. comment was deleted/edited away), mark as read so we don't loop forever.
    # Otherwise keep unread so the next polling cycle can retry.
    if [ "$thread_handled" = "true" ] || [ "$notif_reason" != "mention" ]; then
      gh api --method PATCH "notifications/threads/$notif_id" >/dev/null 2>&1
    else
      local notif_age=0
      if [ -n "$updated_at" ]; then
        local updated_epoch now_epoch
        updated_epoch=$(date -d "$updated_at" +%s 2>/dev/null || echo 0)
        now_epoch=$(date +%s)
        notif_age=$(( now_epoch - updated_epoch ))
      fi
      if [ "$notif_age" -gt 180 ]; then
        log "Notice: Notification $notif_id ($repo #$item_num) has no indexed mention after ${notif_age}s; marking read."
        gh api --method PATCH "notifications/threads/$notif_id" >/dev/null 2>&1
      else
        log "Notice: Mention notification $notif_id ($repo #$item_num) not yet indexed by comments API (${notif_age}s old); keeping unread for retry."
      fi
    fi
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

poll_repo_pull_comments() {
  local repo="$1"
  local comments
  comments=$(gh api "repos/$repo/pulls/comments?sort=created&direction=desc&per_page=15" \
    -q '.[] | select((.body | test("@'$BOT_USER'"; "i")) and .user.login != "'$BOT_USER'") | "\(.id) \(.pull_request_url) \(.user.login) \(.user.type // "User")"' 2>/dev/null)

  while read -r comment_id pr_url comment_user comment_user_type; do
    [ -z "$comment_id" ] && continue

    if grep -qx "$comment_id" "$PROCESSED_FILE"; then
      continue
    fi

    local item_num
    item_num=$(basename "$pr_url")

    local comment_body
    comment_body=$(gh api "repos/$repo/pulls/comments/$comment_id" -q '.body' 2>/dev/null)

    process_comment "$repo" "$item_num" "$comment_id" "$comment_user" "$comment_user_type" "$comment_body" "pulls/comments"
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
      poll_repo_pull_comments "$r"
    done

    sleep "$POLL_INTERVAL"
  done
fi
