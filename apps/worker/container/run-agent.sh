#!/usr/bin/env bash
# In-container driver for one work item: clone the fork, run the agent, commit as the work item, push.
# Started by the AgentSandbox Durable Object. The git remote carries no credentials: the Worker's
# outbound handler adds the Artifacts token to requests for this one repo, so nothing secret is in
# this environment, in .git/config or in the process list.
#
# Everything written to EVENTS_FILE is a progress report for display. The Durable Object does not trust it:
# the outcome is decided from the fork's real history.
#
# Env: WORK_ITEM_ID AGENT_MODE AGENT_MODEL AGENT_PROMPT COMMIT_SUBJECT ARTIFACTS_GIT_REMOTE
#      GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL STUB_STEP_MS REPO_DIR TASK_DIR EVENTS_FILE
#      AGENT_MAX_TURNS AGENT_MAX_BUDGET_USD AGENT_TIMEOUT_S (claude mode caps)
# A revalidation run also finds the new context in $TASK_DIR/inbox and the changes in $TASK_DIR/revalidate.json.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/workspace/repo}"
TASK_DIR="${TASK_DIR:-/workspace/task}"
EVENTS_FILE="${EVENTS_FILE:-$TASK_DIR/events.jsonl}"
BRANCH="${BRANCH:-main}"

esc() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-500; }
emit() {
	printf '{"workItemId":"%s","ts":"%s","kind":"%s","text":"%s"}\n' \
		"$(esc "$WORK_ITEM_ID")" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$1" "$(esc "$2")" >>"$EVENTS_FILE"
}

emit clone "cloning the fork"
if ! out="$(git clone --quiet --branch "$BRANCH" --single-branch "$ARTIFACTS_GIT_REMOTE" "$REPO_DIR" 2>&1)"; then
	emit error "clone failed: $out"
	exit 5
fi
cd "$REPO_DIR"
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
BASE_SHA="$(git rev-parse HEAD)"
emit clone "cloned at $BASE_SHA"

REVALIDATING=0
if [ -f "$TASK_DIR/revalidate.json" ]; then
	REVALIDATING=1
	# Hand the agent the new context packet and a receipt of what was delivered.
	mkdir -p .delta/context
	cp "$TASK_DIR"/inbox/*.md .delta/context/
	node /opt/delta/write-receipt.mjs --repo "$REPO_DIR" --work-item "$WORK_ITEM_ID" \
		--base-commit "$BASE_SHA" --changes "$TASK_DIR/revalidate.json"
	emit receipt "revalidation receipt written to .delta/receipt.json"
fi

emit agent "starting agent (mode: $AGENT_MODE)"
case "$AGENT_MODE" in
stub)
	node /opt/delta/stub-agent.mjs --repo "$REPO_DIR" --work-item "$WORK_ITEM_ID" \
		--events "$EVENTS_FILE" --step-ms "${STUB_STEP_MS:-0}"
	;;
claude)
	# The command is what the Cloudflare tutorial uses. Its stream-json is kept in claude.jsonl and a short,
	# redacted summary is appended to the event log for the console. Claude Code exits 0 even when a model
	# call fails, so the final result event decides success.
	# Capped three ways: turns, dollars and wall clock (timeout exits 124, which fails the pipeline).
	timeout --kill-after=10 "${AGENT_TIMEOUT_S:-600}" \
		claude --print --output-format stream-json --verbose --dangerously-skip-permissions \
		--no-session-persistence --model "$AGENT_MODEL" \
		--max-turns "${AGENT_MAX_TURNS:-15}" --max-budget-usd "${AGENT_MAX_BUDGET_USD:-1}" -- "$AGENT_PROMPT" |
		node /opt/delta/claude-events.mjs --events "$EVENTS_FILE" --raw "$TASK_DIR/claude.jsonl" --work-item "$WORK_ITEM_ID"
	last="$(tail -n 1 "$TASK_DIR/claude.jsonl" 2>/dev/null || true)"
	case "$last" in
	*'"is_error":true'*)
		emit error "claude reported an error"
		exit 3
		;;
	esac
	;;
*)
	emit error "unknown AGENT_MODE: $AGENT_MODE"
	exit 2
	;;
esac

# The agent never commits. A missing .delta/claims.json is left missing (T-2 maps that to NO_CLAIMS).
git add -A
if git diff --cached --quiet; then
	emit commit "nothing to commit; not pushing"
	emit done "run finished"
	exit 0
fi
git commit --quiet -m "$COMMIT_SUBJECT"
HEAD_SHA="$(git rev-parse HEAD)"
emit commit "committed $HEAD_SHA as $GIT_AUTHOR_NAME"

# Each work item owns its fork, so contention is not expected; retry stale refs anyway (3 tries, jitter).
attempt=1
while :; do
	if out="$(git push origin "HEAD:$BRANCH" 2>&1)"; then
		emit push "pushed $HEAD_SHA"
		break
	fi
	emit git "push attempt $attempt failed: $out"
	if [ "$attempt" -ge 3 ] || ! printf '%s' "$out" | grep -qi 'stale'; then
		emit error "push failed"
		exit 4
	fi
	attempt=$((attempt + 1))
	git pull --quiet --rebase origin "$BRANCH" || true
	HEAD_SHA="$(git rev-parse HEAD)"
	sleep "$(awk 'BEGIN{srand(); printf "%.2f", 0.1 + rand()*0.4}')"
done

if [ "$REVALIDATING" = 1 ]; then
	# The receipt also travels with the repo as a git note (refs/notes/delta). Best effort: the push above stands without it.
	if git notes --ref=delta add -f -F .delta/receipt.json "$HEAD_SHA" && git push --quiet origin refs/notes/delta 2>/dev/null; then
		emit receipt "receipt note pushed to refs/notes/delta"
	else
		emit receipt "receipt note not pushed (refs/notes/delta)"
	fi
fi
emit done "run finished"
