#!/bin/sh
# In-container driver for one work item: clone the fork, run the agent, commit as the work item, push.
# Started by the AgentSandbox Durable Object. The git remote carries no credentials: the Worker's
# outbound handler adds the Artifacts token to requests for this one repo, so nothing secret is in
# this environment, in .git/config or in the process list.
#
# Env: WORK_ITEM_ID AGENT_MODE AGENT_MODEL AGENT_PROMPT COMMIT_SUBJECT ARTIFACTS_GIT_REMOTE
#      GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL STUB_STEP_MS REPO_DIR EVENTS_FILE
set -eu

REPO_DIR="${REPO_DIR:-/workspace/repo}"
EVENTS_FILE="${EVENTS_FILE:-/workspace/task/events.jsonl}"
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

emit agent "starting agent (mode: $AGENT_MODE)"
case "$AGENT_MODE" in
stub)
	node /opt/delta/stub-agent.mjs --repo "$REPO_DIR" --work-item "$WORK_ITEM_ID" \
		--events "$EVENTS_FILE" --step-ms "${STUB_STEP_MS:-0}"
	;;
claude)
	# One-line swap point: the command is what the Cloudflare tutorial uses. Its stream-json output is
	# kept as the event log; Claude Code exits 0 even when a model call fails, so the final result
	# event decides success.
	claude --print --output-format stream-json --verbose --dangerously-skip-permissions \
		--no-session-persistence --model "$AGENT_MODEL" -- "$AGENT_PROMPT" >/workspace/task/claude.jsonl
	tail -n 1 /workspace/task/claude.jsonl | grep -q '"is_error":true' && {
		emit error "claude reported an error"
		exit 3
	}
	;;
*)
	emit error "unknown AGENT_MODE: $AGENT_MODE"
	exit 2
	;;
esac

# The agent never commits. A missing .delta/claims.json is left missing (T-2 maps that to NO_CLAIMS).
git add -A
if git diff --cached --quiet; then
	emit commit "nothing to commit"
else
	git commit --quiet -m "$COMMIT_SUBJECT"
	emit commit "committed $(git rev-parse HEAD) as $GIT_AUTHOR_NAME"
fi

# Each work item owns its fork, so contention is not expected; retry stale refs anyway (3 tries, jitter).
attempt=1
while :; do
	if out="$(git push origin "HEAD:$BRANCH" 2>&1)"; then
		emit push "pushed $(git rev-parse HEAD)"
		break
	fi
	emit git "push attempt $attempt failed: $out"
	if [ "$attempt" -ge 3 ] || ! printf '%s' "$out" | grep -qi 'stale'; then
		emit error "push failed"
		exit 4
	fi
	attempt=$((attempt + 1))
	git pull --quiet --rebase origin "$BRANCH" || true
	sleep "$(awk 'BEGIN{srand(); printf "%.2f", 0.1 + rand()*0.4}')"
done
emit done "run finished"
