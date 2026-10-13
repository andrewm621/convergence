# Agent runtime (Sandbox containers)

One work item = one fork = one container. The Worker mints a short-lived write token for the fork, a Durable Object (`AgentSandbox`, keyed by work item id) starts a container, and a script inside it clones the fork, runs the agent, commits as the work item and pushes. The same protocol is what the local-runner fallback (`apps/runner`) must speak.

## Agent protocol (identical for every runtime)
1. Clone the fork's `main`.
2. Read `AGENTS.md` and `.delta/context/*` (or `context/*` when the fork has no `.delta/context`).
3. Do the task.
4. Write `.delta/claims.json`: a JSON array of `{subject, value, basedOn: "recordId@version"}`. A run that writes none is left without claims; nothing is invented.
5. Commit as author `workitem-<id>` and push to the fork. The agent itself never commits or pushes; the runner does.

## API (all under `/api`, bearer `DEV_TOKEN`)
| Call | Result |
|---|---|
| `POST /agents/dispatch` `{forkRepo, workItemId, prompt, wait?}` | `202` with `AgentRunStarted` (or `200` with both events when `wait: true`). `409` if that work item is already running |
| `GET /agents/runs/:workItemId` | Run state, `AgentRunStarted` / `AgentRunFinished` (null while running), pushed `commit`, `tokenRevoked`, and `activity` lines `{workItemId, ts, kind, text}` |
| `GET /repos/:name/log`, `GET /repos/:name/file?path=` | What landed in a fork |

Dispatch refuses a repo that is not a fork, so an agent token is never minted for a baseline. `AgentRunStarted` is stamped just before the runner launches and `AgentRunFinished` when the Durable Object first sees it exit (within about 0.5 s). Activity timestamps are shifted onto the Durable Object clock (`clockSkewMs`).

## Credentials never enter the container
The container has no direct internet. The Durable Object registers an outbound handler for the fork's git host (`ArtifactsGateway`, `apps/worker/src/agents/outbound.ts`). It adds the token to git requests for that one repo and returns 403 for anything else. The container sees only a credential-free remote, so the token is not in its environment, in `.git/config` or in the process list. The token is revoked when the run ends.

## Modes
`AGENT_MODE` (a Worker var) selects the agent. Everything else in the pipeline is identical.
- `stub` (default): `container/stub-agent-lib.ts` makes a deterministic change under `src/work/<id>.ts`, appends an export to `src/index.ts` and writes `.delta/claims.json` from the context records it read. `STUB_STEP_MS` paces it so concurrent runs visibly overlap.
- `claude`: runs `claude --print --output-format stream-json ...` (Claude Code, pinned in the image) through OpenRouter's Anthropic-compatible endpoint. To enable it:
  1. Worker secret `OPENROUTER_API_KEY` (`wrangler secret put OPENROUTER_API_KEY`; locally in `apps/worker/.dev.vars`).
  2. `AGENT_MODE=claude`, and optionally `AGENT_MODEL` (an OpenRouter slug; default `anthropic/claude-sonnet-5.5`). Deploy with `--var AGENT_MODE:claude` or edit `wrangler.jsonc`.
  The key stays in the Worker. Claude Code gets a placeholder token and `ModelGateway` swaps in the real key on requests to `openrouter.ai/api`.

## Prove concurrency
```bash
set -a; source .env; set +a   # DEV_TOKEN
WORKER_URL=https://<worker>.workers.dev node scripts/check-overlap.mjs --forks 2 --cleanup
```
Needs `ENABLE_SMOKE=1` on the Worker. It seeds a baseline with N forks, dispatches one work item per fork at once, and asserts overlapping run windows, distinct authors in each fork's history, revoked tokens and a valid `.delta/claims.json`.
