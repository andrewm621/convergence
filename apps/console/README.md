# Convergence Console

One screen, three panes: the **context timeline** (accepted decisions, v1 to v2, "Propose change"), the **work graph** (baseline, the records it holds, and the work relying on them; the stale edge turns red and dashed), and the **inspector** (Why is this blocked, receipt, claims vs facets, changes, actions, gate preview). A bottom strip shows live agent output and the hash-chained ledger tail.

Stack: Vite, React 19, Tailwind v4, shadcn/ui, `@xyflow/react`, `@dagrejs/dagre`. No `link:` or `file:` dependencies; the only local packages are `contracts`, `delta-core` and the two scenario fixtures.

## Run it

```bash
pnpm install
pnpm --filter console dev        # http://localhost:5173/?mock=1
pnpm --filter console build      # dist/, absolute base (/), served as Worker static assets
pnpm --filter console test
```

## The mock replay

`?mock=1` (or `VITE_MOCK=1`) replays a scripted world through the **real** reconciler: events go through `delta-core`'s `processEvent` in the browser, so every status, edge, reason code and ledger hash is produced by the same rules the Worker uses. Only the agents, git and the clock are scripted. The header says **Mock · replay** so a recording never passes it off as live.

| Key | Does |
|---|---|
| Right arrow or **Next** | play the next beat |
| Left arrow or **Back** | go back (replays from the start) |
| `h` | hide or show the controls |
| numbered dots | jump to a beat |

Beats, Scenario A: two agents running, typo (`PROSE_ONLY`, nothing goes red), draft the decision change, v2 lands (WI-2 stale, WI-1 untouched, one edge red), WI-2 pushes (claim conflict and a failing check), WI-1 promotes, revalidate, the re-run lands, WI-2 promotes. The same controls drive the **Larkhaven County Shelter** scenario (`scenario=shelter-intake`, knowledge work, synthetic: a policy changes under five drafting agents; three go stale, two are untouched, one takes a scoped exception, two are revalidated; the "Synthetic scenario. Not operational guidance." note stays in view), Scenario B (Northwind Sales Ops: one exception, one revalidation, one untouched) and the **fan-out** script (40 seeded items, one decision change, `N evaluated · K stale · M untouched · time`).

Every action in the UI (Propose change, Revalidate, Accept exception, Reject, Promote) also works by hand in the mock, through the same engine.

| URL parameter | Does |
|---|---|
| `scenario=notifications`, `shelter-intake` or `sales-ops` | scenario to open |
| `script=fanout` | open the fan-out script (notifications only) |
| `start=empty` | no accepted context, to show the empty state |
| `controls=0` | start with the replay controls hidden |
| `drip=0` | emit agent output instantly instead of spacing it out |
| `theme=dark` or `light` | theme (also saved) |

## Live mode

Without `?mock=1` the console connects to the Delta Convergence Worker (`docs/control-loop.md`). Everything is under `/api` and scoped to the scenario (`/api/scenarios/:s/...`); the routes are in one file, `src/client/endpoints.ts`.

```bash
# Dev: the Vite server proxies /api (REST and the WebSocket) to wrangler dev on :8787
pnpm --filter worker dev                       # in one terminal
pnpm --filter console dev                      # in another; open http://localhost:5173/#token=<DEV_TOKEN>
```

- **Token.** The Worker's one shared bearer secret (`DEV_TOKEN`). The console takes it from a `#token=...` URL hash param (then removes it from the address bar) or, if there is none, from a prompt. It is kept in `sessionStorage` only (gone when the tab closes), sent as `Authorization: Bearer` on REST and as the WebSocket subprotocol `["delta.v1", "bearer.<base64url>"]`, and never logged or put in a URL. If the Worker refuses it the header shows **Token refused** and an **Enter token** button.
- **Stream.** A WebSocket sends a `snapshot` first, then `event` and `agent-activity`, each with a top-level `meta` (seq, gap, replay, evaluationMs, poller health) that the client splits off before the strict contract parse. It resumes with `?since=<seq>`; `meta.seq` on `agent-activity` is the ledger head when it was sent, so an activity ahead of what the console has seen means a lost event and triggers a REST re-read. If the socket keeps failing it polls `GET /api/scenarios/:s/state` every 3 seconds.
- **Poller health.** `meta.poller` (and `X-Delta-Poller` on the REST read) says whether the poller that reads the Artifacts repos is keeping up. While it is degraded the header shows **Poller degraded** (with the failing repos in its tooltip), a work item that would read *fresh* reads *unconfirmed*, the Fresh condition reads *Freshness unconfirmed*, and Promote is closed. It reopens when health returns.
- **Errors** are `{ error: { code, message, reasonCodes? } }`; a blocked promote puts its reason codes in `error.reasonCodes`. Every POST carries a fresh `Idempotency-Key`.
- **Not served by the Worker yet:** `POST .../seed`, `POST .../start` and `GET .../changes`. In live mode those actions are disabled with a tooltip (`client.capabilities`), and the Changes tab says so, instead of calling a route that does not exist. Mock mode still does all three.

`VITE_API_BASE` sets the API origin (default: same origin, which is how the Worker serves the console); `VITE_API_PROXY` is the dev proxy target (default `http://localhost:8787`).

The mock and the live client both implement `ConsoleClient` (`src/client/types.ts`), and `src/client/create-client.ts` is the one place that picks between them.

The header's "Acting as: Decision owner (demo identity)" comes from one constant, `DEMO_IDENTITY` in `src/config.ts`. The console has no real authentication and says so.

## Served from the Worker

`apps/worker/wrangler.jsonc` has an `assets` block that points at this app's build output (`../console/dist`) with SPA fallback, and `run_worker_first: ["/api/*", "/health"]` so the API and the WebSocket never fall through to `index.html`. Build before you deploy:

```bash
pnpm build:console        # from the repo root; same as pnpm --filter console build
```

## The graph at video size

At 1920x1080 the graph pane is about 1120 x 600 px. The node sizes, dagre spacing and fit padding in `src/features/graph-layout.ts` (`NODE_SIZE`, `SPACING`, `FIT`) are set so 2 to 5 work items frame at about 1:1 (a 17 px title is about 17 px on screen) and 6 still lands above 14 px, while the 40-item fan-out cluster still fits whole. `src/features/graph-fit.test.ts` pins that, so a change to node size cannot quietly make the text tiny again.

## Reading it on camera

- **Receipt.** Each record shows `record@version`, then the named facets the work item was handed, each with a short hash, and the facets that have moved on are marked against the current version. All of it is 14 px or larger. The receipt carries one combined facet hash per record, so the per-facet hashes are computed in the console from each facet's canonical JSON (the tooltip says so). In the Why chain, the receipt chip expands to the same list.
- **Exception card.** An accept-exception reads "Valid while `<record>` is at v`<N>` · lapses at the next version". Once the record moves on (or the fork head does) it reads **Lapsed** with `EXCEPTION_LAPSED` and the reason. It uses delta-core's `classifyExceptions`, the same rule the gate applies.
- **Evaluation time.** In mock mode the strip shows the engine's own time. In live mode the Worker's `evaluationMs` is the reconciler alone (often under 0.01 ms), so the strip shows only a time this browser measured, from sending a change to its verdict arriving (network and poller included). A change this browser did not send shows no time.

## Layout of `src/`

| Path | What |
|---|---|
| `client/` | the `ConsoleClient` interface, the live WebSocket and REST client |
| `mock/` | the in-browser world: `MockCell` (real engine), `MockSession`, beats and scripts |
| `state/` | the view reducer for `WsMessage`, derivations over delta-core, the gate hook |
| `features/` | the panes and their parts |
| `components/` | shadcn primitives and the status, actor and epistemic chips |
