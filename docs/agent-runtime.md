# Agent runtime (Sandbox containers)

One work item = one fork = one container. The Worker mints a short-lived write token for the fork, a Durable Object (`AgentSandbox`, keyed by work item id) starts a container, and a script inside it clones the fork, runs the agent, commits as the work item and pushes. The same protocol is what the local-runner fallback (`apps/runner`) must speak.

## Agent protocol (identical for every runtime)
1. Clone the fork's `main`.
2. Read `AGENTS.md` and the context records in `.delta/context/*` and `context/*`. A file in `.delta/context/` replaces the same-named file in `context/`.
3. Do the task.
4. Write `.delta/claims.json`: a JSON array of `{subject, value, basedOn: "recordId@version"}`. A run that writes none is left without claims; nothing is invented.
5. Commit as author `workitem-<id>` and push to the fork, but only when something changed. The agent itself never commits or pushes; the runner does.

## API (all under `/api`, bearer `DEV_TOKEN`)
| Call | Result |
|---|---|
| `POST /agents/dispatch` `{forkRepo, workItemId, prompt, wait?, revalidate?}` with header `Idempotency-Key` (required) | `202` while the run is in flight (`AgentRunStarted` only), `200` with both events once it has finished. `wait: true` holds the response until the run ends. `409` if that work item is already running, `422` if the key was used with a different request, `400` without a key |
| `GET /agents/runs/:workItemId` | Run state, `AgentRunStarted` / `AgentRunFinished` (null while running), the verified `commit`, `pushVerified`, `tokenRevoked`, and `activity` lines `{workItemId, ts, kind, text}` |
| `GET /repos/:name/log?ref=`, `GET /repos/:name/file?path=&ref=` | What landed in a fork |

- **Idempotency:** the same key with the same request returns the run it started and mints no second token. Two simultaneous dispatches for one work item launch exactly one run.
- **Fork only:** dispatch refuses a repo that is not a fork, so an agent token is never minted for a baseline.
- **Timestamps:** `AgentRunStarted` is stamped just before the runner launches. `AgentRunFinished` is stamped when the Durable Object first sees the runner exit, within about 0.5 s. Activity timestamps are shifted onto the Durable Object clock (`clockSkewMs`).

## Revalidation (diff-aware re-run on the same fork)
Add `revalidate: {changes: [{recordId, fromVersion, toVersion}], context: {"<record>.md": "<text>"}}` to a dispatch. The runner clones the fork's current head, replaces the matching files in `.delta/context/` with `context`, writes `.delta/receipt.json` (what was delivered: record, version, content hash, base commit) and prompts the agent with "decision X changed from vA to vB; reconcile your work". The receipt is also pushed as a git note on `refs/notes/delta` (best effort). Each `context` file must carry the `toVersion` it claims, or dispatch answers `400` before any token is minted. The commit subject names the change, and the author stays `workitem-<id>`.

## Credentials never enter the container
The container has no direct internet. The Durable Object registers an outbound handler for the fork's git host (`ArtifactsGateway`, `apps/worker/src/agents/outbound.ts`). It adds the token to git requests for that one repo and returns 403 for anything else. The container sees only a credential-free remote, so the token is not in its environment, in `.git/config` or in the process list. The token is revoked when the run ends.

A credential is added only when the request matches exactly: https, default port, no embedded credentials, the exact host, the exact repo path and a git smart-HTTP endpoint (`ArtifactsGateway`); for the model, `POST /api/v1/messages` on `openrouter.ai` whose body names the pinned `AGENT_MODEL` (`ModelGateway`). Anything else gets a 403 with nothing added, and redirects are never followed with a credential attached.

## Trust model: the container is untrusted
Everything the container writes (events, exit code, stderr, `pushed <sha>` lines, `.delta/claims.json`) is treated as hostile input. Event files are read with a byte cap, validated with Zod, stripped of control characters, length-limited and redacted. The work item id on an activity line comes from the run, not the file. The exit code must be one to three digits. A run is marked `succeeded` only if the fork's real history, read through the Artifacts binding, agrees: the head moved, every new commit is authored by `workitem-<id>`, and any SHA the runner claimed is the real head. A claimed push that did not happen, or a commit by another author, fails the run (`pushVerified: false`). A run that has not exited after 30 minutes is failed and its container destroyed. Claims in `.delta/claims.json` stay agent-asserted: they are read from the fork later by the control plane and labelled as unverified, never used as evidence.

## Modes
`AGENT_MODE` (a Worker var) selects the agent. Everything else in the pipeline is identical.
- `stub` (default): `container/stub-agent-lib.ts` makes a deterministic change under `src/work/<id>.ts`, appends an export to `src/index.ts` and writes `.delta/claims.json` from the context records it read. `STUB_STEP_MS` paces it so concurrent runs visibly overlap.
- `claude`: runs `claude --print --output-format stream-json ...` (Claude Code, pinned in the image) through OpenRouter's Anthropic-compatible endpoint. To enable it:
  1. Worker secret `OPENROUTER_API_KEY` (`wrangler secret put OPENROUTER_API_KEY`; locally in `apps/worker/.dev.vars`).
  2. `AGENT_MODE=claude`, and optionally `AGENT_MODEL` (an OpenRouter slug; default `anthropic/claude-sonnet-5.5`). Deploy with `--var AGENT_MODE:claude` or edit `wrangler.jsonc`.
  The key stays in the Worker. Claude Code gets a placeholder token and `ModelGateway` swaps in the real key on requests to `openrouter.ai/api`.
  Runs are capped by `AGENT_MAX_TURNS` (15), `AGENT_MAX_BUDGET_USD` (1) and `AGENT_TIMEOUT_S` (600). Claude Code's stream-json is summarized (tool calls, short text, the result and a usage line) into the run's `activity`.

## Prove concurrency
```bash
set -a; source .env; set +a   # DEV_TOKEN
WORKER_URL=https://<worker>.workers.dev node scripts/check-overlap.mjs --forks 2 --cleanup
```
Needs `ENABLE_SMOKE=1` on the Worker. It seeds a baseline with N forks, dispatches one work item per fork at once, and asserts overlapping run windows, distinct authors in each fork's history, revoked tokens and a valid `.delta/claims.json`. It then checks idempotent replay, the duplicate-dispatch race (one run starts, one gets `409`) and a revalidation on the same fork (claims re-cite `notifications@2`, receipt written).
