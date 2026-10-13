# AGENTS.md: Delta Convergence

Instructions for any coding agent working in this repo: Claude Code, Cursor (local or cloud agents), Codex, Grok. `CLAUDE.md` is a symlink to this file.

## What this is
Delta Convergence is a deterministic reconciliation control plane for concurrent human and agent work, built on Cloudflare Workers and Artifacts. When an accepted decision changes mid-flight, it finds the work that relied on the old version, blocks it from merging, and drives a human-approved reconciliation. No LLM is needed for the control loop.

**The spec is [`docs/PRD.md`](docs/PRD.md).** Read §4 (contracts and rules R1–R9), §5 (architecture and repo layout) and §9 (build plan) before changing anything. The PRD wins over your assumptions; if you think it's wrong, say so in your task channel and don't silently diverge.

This is a contest entry with a hard deadline: **Wed 2026-10-14, 11:59 PM PT.** Prefer working and demonstrable over complete.

## Task board (Maestro)
Work is tracked as Maestro tasks in [`.maestro/tasks/`](.maestro/tasks/). Each task has a goal, context pointers and acceptance boxes.
- Pick up a task only if its `depends_on` tasks are done and nobody else has a live claim on it.
- Check acceptance boxes in `.maestro/todos/T-<id>.todos.md` as you go.
- If you're blocked or facing a decision you can't make, post a question to the task's channel (`.maestro/channels/T-<id>.md`). Don't guess silently.
- When all boxes pass and typecheck and tests are green, set the task status to `review`.

## Layout
```
packages/contracts/   Zod schemas: ContextRecord, ContextReceipt, Claim, Evidence, Dependency, Resolution, events, effects
packages/delta-core/  pure reconcile(state, event, policy) → { state, effects }; rules R1–R9; ledger hash chain (WebCrypto)
apps/worker/          Hono API, WorkspaceCell Durable Object, Artifacts adapter, poller/queue consumer, agent dispatch
apps/console/         React SPA (Vite, Tailwind v4, shadcn, React Flow) served as Worker static assets
apps/runner/          local agent runner fallback (same protocol as the sandbox)
scenarios/            seeded fixtures: notifications (coding), sales-ops (knowledge work)
docs/PRD.md           the spec
```

## Commands
```bash
pnpm install
pnpm -r typecheck
pnpm -r test                   # vitest
pnpm --filter worker dev       # wrangler dev; Artifacts has NO local emulation, so it hits the real service
pnpm --filter worker exec wrangler deploy   # maintainer machine only (see Secrets)
```

## Conventions
- TypeScript strict. Zod for every boundary. Named exports and function declarations.
- `delta-core` stays **pure**: no I/O, no Cloudflare types, no LLM calls. Every rule has a named invariant test.
- Never call an LLM to decide a condition, an authorization or a promotion. Models propose; humans and deterministic rules decide.
- Mutating endpoints take an `Idempotency-Key`. Promotion re-checks freshness at current heads (rule R7).
- Workers: no I/O, timers or randomness at module scope. Release Artifacts handles with `using`.

## Cloudflare Artifacts gotchas (verified live)
- The binding only **reads** (`log`, `readCommit`, `readTree`, `readBlob`, `readFile`) and manages repos and tokens (`create`, `fork`, `createToken`). Writes go through git over HTTPS with isomorphic-git and the patched in-memory fs in `apps/worker`.
- Two concurrent pushes to one repo: one fails with `stale ref`. Keep a single writer per repo; the Durable Object serializes writes. Retry 3× with jitter.
- Artifacts tokens carry an `?expires=` suffix. Strip it for Basic auth. Pass tokens in an auth header or via `onAuth`, **never in a URL**, and redact them from logs and responses.
- `readTree` returns direct children only, so walk it recursively.
- There is no local emulation. `wrangler dev` uses the real service.

## Agent sandbox gotchas (verified live; details in `docs/agent-runtime.md`)
- Cloudflare's current Sandbox model is a Durable Object that owns `ctx.container`, with `@cloudflare/sandbox` `Files` helpers and outbound handlers (`interceptOutboundHttps`). The older `getSandbox()` / `Sandbox` class API is gone from the docs.
- The Durable Object config uses `migrations`. The newer `exports` map is mutually exclusive with `migrations`, so it can't be added to a Worker whose first class already shipped through a migration.
- Never put a token in the container. Give the `AgentSandbox` DO an outbound handler that injects the Artifacts token for exactly one repo.
- `enableInternet: false` plus per-host intercepts is the egress allowlist. Containers re-sign intercepted HTTPS, so point `GIT_SSL_CAINFO` / `NODE_EXTRA_CA_CERTS` at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`.
- `exec()` does not inherit env. Pass everything per call. Run long tasks detached (`setsid`, state in files) and poll or use an alarm.
- Image size `lite` runs the stub but is about 2x slower than `standard-1`.
- `wrangler types` needs `--strict-vars=false` (the `types` script) or var comparisons become literal-type errors.

## Secrets and public-repo hygiene (hard rules; this repo is public)
- Never commit secrets, tokens, account IDs, `.env`, `.dev.vars` or `*.local.md`. They're gitignored, so keep it that way.
- Never write real client names, real people's names or private file paths into tracked files. Fixtures use synthetic organizations ("Northwind Field Services").
- A maintainer may keep private context in a gitignored `CLAUDE.local.md`. You may read it if it exists. **Never copy its contents into tracked files.**
- Cloud agents (e.g. Cursor cloud) **do not deploy.** They write code and tests and open PRs; deploys run from a maintainer machine.
- Before every commit, run `git status --short` and confirm nothing secret or private is staged.

## Definition of done for any change
`pnpm -r typecheck` and `pnpm -r test` pass, the relevant Maestro acceptance boxes are checked, and no hygiene rule is broken.
