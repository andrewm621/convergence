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
| `POST /agents/dispatch` `{forkRepo, workItemId, prompt, wait?, revalidate?, model?}` with header `Idempotency-Key` (required) | `202` while the run is in flight (`AgentRunStarted` only), `200` with both events once it has finished. `wait: true` holds the response until the run ends. `409` if that work item is already running, `400 MODEL_NOT_ALLOWED` for a model outside `AGENT_MODELS`, `422` if the key was used with a different request, `400` without a key |
| `GET /agents/runs/:workItemId` | Run state, `AgentRunStarted` / `AgentRunFinished` (null while running), the run's `model`, the verified `commit`, `pushVerified`, `tokenRevoked`, `usage` (requests, tokens and dollars as metered by the gateways) and `activity` lines `{workItemId, ts, kind, text}` |
| `GET /repos/:name/log?ref=`, `GET /repos/:name/file?path=&ref=` | What landed in a fork |

- **Idempotency:** the same key with the same request returns the run it started and mints no second token. Two simultaneous dispatches for one work item launch exactly one run.
- **Fork only:** dispatch refuses a repo that is not a fork, so an agent token is never minted for a baseline.
- **Timestamps:** `AgentRunStarted` is stamped just before the runner launches. `AgentRunFinished` is stamped when the Durable Object first sees the runner exit, within about 0.5 s. Activity timestamps are shifted onto the Durable Object clock (`clockSkewMs`).

## Revalidation (diff-aware re-run on the same fork)
Add `revalidate: {changes: [{recordId, fromVersion, toVersion}], context: {"<record>.md": "<text>"}}` to a dispatch. The runner clones the fork's current head, replaces the matching files in `.delta/context/` with `context`, writes `.delta/receipt.json` (what was delivered: record, version, content hash, base commit) and prompts the agent with "decision X changed from vA to vB; reconcile your work". The receipt is also pushed as a git note on `refs/notes/delta` (best effort). Each `context` file must carry the `toVersion` it claims, or dispatch answers `400` before any token is minted. The commit subject names the change, and the author stays `workitem-<id>`.

## Credentials never enter the container
The container has no direct internet. The Durable Object registers an outbound handler for the fork's git host (`ArtifactsGateway`, `apps/worker/src/agents/outbound.ts`). It adds the token to git requests for that one repo and returns 403 for anything else. The container sees only a credential-free remote, so the token is not in its environment, in `.git/config` or in the process list. The token is revoked when the run ends.

A credential is added only when the request matches exactly, in one canonical form. The gateway refuses (403, nothing injected, nothing forwarded) unless the raw request URL string equals its own canonicalization, so a different spelling of the same URL never reaches the upstream: percent-encoded dots, slashes or backslashes, backslashes, double slashes, dot segments, userinfo, any port (even `:443`), fragments, uppercase or IDN or trailing-dot hosts, and any query string other than the one expected. The allowed requests are:
- Artifacts (`ArtifactsGateway`): `GET <repo>/info/refs?service=git-upload-pack|git-receive-pack` and `POST <repo>/git-upload-pack|git-receive-pack` with no query, on the fork's own host and path.
- Model (`ModelGateway`): `POST https://openrouter.ai/api/v1/messages` (with `?beta=true` allowed), whose body names the run's pinned model.
Redirects are never followed with a credential attached.

## Budgets are enforced by the gateways, not the agent
The container controls Claude Code's flags, so no cap relies on them. Every run gets a meter in its Durable Object, and each gateway call is admitted against it before it is forwarded:
- **Model request:** at most `AGENT_MAX_MODEL_REQUESTS` (40) calls, body at most 8 MB. The model string must equal the pinned slug exactly, and a pin may not carry a `:variant` suffix (`:online`, `:nitro`, `:floor`, `:thinking`...) or a `~alias`. `max_tokens` is required and clamped to `AGENT_MAX_OUTPUT_TOKENS` (8192, with any extended-thinking budget kept below it). Only a whitelist of top-level fields is forwarded (`model`, `messages`, `system`, `max_tokens`, `metadata`, `stop_sequences`, `stream`, `temperature`, `top_p`, `top_k`, `tools`, `tool_choice`, `thinking`); the rest are dropped, and OpenRouter's rerouting fields (`models`, `provider`, `route`, `preset`, `plugins`, `web_search_options`, `transforms`, `mcp_servers`, `session_id`, `trace`, `usage`) get a `400`, as does any tool with a `type` other than `custom` (server tools: web search, code execution, computer use). Only five headers cross (`content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `user-agent`), and the upstream URL is a constant, so `?beta=true` is accepted from Claude Code but never forwarded.
- **Model accounting:** the worst case is reserved before the call is forwarded, in tokens (estimated input plus `max_tokens`) and in dollars (the whole body as input tokens plus `max_tokens` as output, at the model's top rates in `src/agents/model-prices.ts`), so parallel calls cannot overshoot `AGENT_MAX_TOTAL_TOKENS` (1,000,000) or `AGENT_MAX_COST_USD` (0.25). Each call is settled exactly once, by request id: a clean 2xx with a complete usage block is charged what it used and the `cost` OpenRouter reports; a missing, zero, negative or NaN `cost` is priced from the table instead. Everything else is charged the worst case: a non-2xx, a response with no usage or unparseable, a stream that never reached `message_stop`, a stream the container aborted or the upstream cut, a failed fetch. A model with no price entry cannot run in claude mode (dispatch refuses it, and so does the gateway). If the meter cannot be reached or does not know the run, nothing is forwarded.
- **Meter durability:** the meter is persisted in the work item's Durable Object, so a restart keeps the counters. A stored meter that is missing or not intact (NaN, negative, wrong type) refuses every call and fails the run. When a run ends, any call still unsettled is charged its reserved worst case and a late report for it is ignored.
- **Git:** at most `AGENT_MAX_GIT_REQUESTS` (60) calls and 64 MB per body, counted as the body streams when no length is declared.
- Once any cap is crossed every further call gets `429`, and the run is failed at once with `run budget exceeded: <which cap>` and its container destroyed. When a run ends its meter is deactivated, so a lingering container is refused.

## Trust model: the container is untrusted
Everything the container writes (events, exit code, stderr, `pushed <sha>` lines, `.delta/claims.json`) is treated as hostile input. Event files are read with a byte cap, validated with Zod, stripped of control characters, length-limited and redacted. The work item id on an activity line comes from the run, not the file. The exit code must be one to three digits. A run is marked `succeeded` only if the fork's real history, read through the Artifacts binding, agrees, and verification fails closed. The container is stopped and the write token revoked first, so the history is frozen. Then: the fork head before the run is known and visible in the recent history (a truncated or rewritten history fails), the new commits are a plain linear chain from it with no merges, every new commit is authored by `workitem-<id>`, and any SHA the runner claimed is the real head. If the log read throws, hangs (15 s limit per read), comes back empty, short or malformed, or any field is missing, the run is `failed` with `pushVerified: false`. A revalidation must also carry a `.delta/receipt.json` at the pushed commit that equals, field for field, the receipt the Worker computed from the context it sent. A claimed push that did not happen, or a commit by another author, fails the run. A run that has not exited after 30 minutes is failed and its container destroyed. Claims in `.delta/claims.json` stay agent-asserted: they are read from the fork later by the control plane and labelled as unverified, never used as evidence.

## Modes
`AGENT_MODE` (a Worker var) selects the agent. Everything else in the pipeline is identical.
- `stub` (default): `container/stub-agent-lib.ts` makes a deterministic change under `src/work/<id>.ts`, appends an export to `src/index.ts` and writes `.delta/claims.json` from the context records it read. `STUB_STEP_MS` paces it so concurrent runs visibly overlap.
- `claude`: runs `claude --print --output-format stream-json ...` (Claude Code, pinned in the image) through OpenRouter's Anthropic-compatible endpoint. To enable it:
  1. Worker secret `OPENROUTER_API_KEY` (`wrangler secret put OPENROUTER_API_KEY`; locally in `apps/worker/.dev.vars`).
  2. `AGENT_MODE=claude`. Deploy with `--var AGENT_MODE:claude` or edit `wrangler.jsonc`.
  3. Models: `AGENT_MODEL` is the default OpenRouter slug and `AGENT_MODELS` (comma-separated) is the allowlist for a per-dispatch `model`. Each run is pinned to its model at the gateway.
  The key stays in the Worker. Claude Code gets a placeholder token and `ModelGateway` swaps in the real key on requests to `openrouter.ai/api`.
  Claude Code is also given `--max-turns` (`AGENT_MAX_TURNS`, 15), a wall-clock `timeout` (`AGENT_TIMEOUT_S`, 600) and `--max-budget-usd` (`AGENT_MAX_BUDGET_USD`), but treat those as a backstop: Claude Code prices every model at Anthropic rates, which is about 50x too high for a cheap model, so a tight value stops a healthy run (it did, on MiniMax). The real dollar cap is the gateway's `AGENT_MAX_COST_USD`. Claude Code's stream-json is summarized (tool calls, short text, the result and a usage line) into the run's `activity`.

## Prove concurrency
```bash
set -a; source .env; set +a   # DEV_TOKEN
WORKER_URL=https://<worker>.workers.dev node scripts/check-overlap.mjs --forks 2 --cleanup
```
Needs `ENABLE_SMOKE=1` on the Worker. It seeds a baseline with N forks, dispatches one work item per fork at once, and asserts overlapping run windows, distinct authors in each fork's history, revoked tokens and a valid `.delta/claims.json`. It then checks idempotent replay, the duplicate-dispatch race (one run starts, one gets `409`) and a revalidation on the same fork (claims re-cite `notifications@2`, receipt written).

## Cheap and mixed models (live results, 2026-10-13)
Claude Code drives non-Anthropic models through OpenRouter's Anthropic-compatible `/api/v1/messages`: a probe returned a native `tool_use` for `openai/gpt-6-luna`, and all three live runs completed the notifications task (MiniMax on a second attempt, after the budget flag was fixed). OpenRouter's docs only guarantee Anthropic first-party models for Claude Code, so each model needs a check. GLM and MiniMax also publish their own Anthropic-compatible endpoints (`https://api.z.ai/api/anthropic`, `https://api.minimax.io/anthropic`; both answer `401` without a key). They need their own keys, so we stay on the single OpenRouter key.

Same task (WI-2 notifications), a fresh fork each, one dispatch per model (MiniMax twice, see its row), gateway-capped at $0.25:

| Model (OpenRouter slug) | Price in / out per M tokens | Result | Run time | Cost metered by the gateway |
|---|---|---|---|---|
| `openai/gpt-6-luna` | $0.10 / $0.50 | pushed as `workitem-wi-2-m1`, valid and accurate `claims.json` (`notifications@1`), push verified | 48 s | $0.0049 (13 model calls, 17 turns; it re-read the same files several times) |
| `z-ai/glm-5.3-flash` | $0.026 / $0.90 | pushed as `workitem-wi-2-m2`, valid and accurate claims, push verified | 63 s | $0.0013 (5 calls) |
| `minimax/minimax-m3` | $0.30 / $1.20 | re-run with the budget flag loosened to a $5 backstop: pushed as `workitem-wi-2-m1`, valid and accurate claims (`notifications@1`), push verified. The first attempt had failed only because Claude Code's own `--max-budget-usd 0.25` fired after a Write (it prices every model at Anthropic rates) | 30 s (wall 33 s) | $0.0278 (8 model calls, 10 turns, 129k in / 1.5k out; Claude Code's own estimate for the same run was $0.60) |

`z-ai/glm-5.3-flash` is the default (`AGENT_MODEL`) as the cheapest that worked. `try-models.mjs` reproduces the comparison: `node scripts/try-models.mjs <slug>... [--cleanup]`. MiniMax is the most expensive of the three here, about 20x GLM and 5x Luna for this task, but still under three cents a run. Its first attempt (14 s, $0.0140, no push) is what exposed the budget-flag problem described above.
