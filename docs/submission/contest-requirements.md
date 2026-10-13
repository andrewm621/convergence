# Contest requirements checklist (Cloudflare "Build the next GitHub")

**Checked:** 2026-10-13 against the primary sources below, mapped to repo state at commit `baaf6c8`. Task statuses: T-1, T-2, T-3, T-11 done; T-10 review; T-4, T-5, T-9 in progress; T-6, T-7, T-8, T-12 open.

**The Official Rules PDF is the authority.** Where the contest page, the submission form or the blog posts disagree with it, follow the Rules and flag the gap (see "Ambiguities to resolve").

## Sources

| Tag | Source | URL |
|---|---|---|
| Rules | Official Rules PDF, "Build the Next-Gen Git Platform on Cloudflare Competition" (4 pages, 15 sections) | https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf |
| Page | Contest page. It has no FAQ. | https://www.cloudflare.com/git-competition/ |
| Form | Submission form (public) | https://www.cloudflare.com/git-competition/submit |
| Blog-1 | Announcement post, dated 2026-10-01 | https://blog.cloudflare.com/next-git-platform-on-cloudflare/ |
| Blog-2 | Artifacts beta post. It does not mention the contest. | https://blog.cloudflare.com/artifacts-git-for-agents-beta/ |
| Docs | Artifacts limits | https://developers.cloudflare.com/artifacts/platform/limits/ |

## Key facts at a glance

- **Contest Period:** Oct 1, 2026 9:00 AM EDT to **Oct 14, 2026 11:59 PM PDT** (= Oct 15, 02:59 AM EDT). Sponsor's clock is the official clock. (Rules §2)
- **Judging weights, each scored 1 to 5:** 50% originality and quality of the prototype for agent-oriented software collaboration, 25% effectiveness of multi-agent concurrency, coordination, context preservation, review and conflict handling, 25% ease of use and product/user experience. Ties break on the first criterion. (Rules §6)
- **Finalists:** 3. Each gets 10 minutes live on stage at Cloudflare Connect, Moscone West, San Francisco, **Oct 21, 2026**. (Rules §6)
- **Prize:** first place only, $25,000 in Cloudflare credits valid 12 months, plus an invitation to the VIP Speakers Dinner. (Rules §8)

## Checklist

Status values: **done**, **in progress**, **not started**, **risk**, **info** (a term to know, with no action for us). "Owner-only" means a human attestation or account action that an agent must not do.

| # | Requirement | Source (URL) | Our status | Evidence or owner task | Notes |
|---|---|---|---|---|---|
| | **Eligibility and entry** | | | | |
| 1 | Entrant is a legal resident of the United States or Canada. Header: "VOID OUTSIDE OF THE UNITED STATES AND CANADA". | Rules §3 (PDF) | not started | Owner-only attestation (T-12) | Applies to every Entrant. Unclear whether the optional second attendee counts as an Entrant (see A1). |
| 2 | Entrant is 18 or older as of Oct 1, 2026 9:00 AM EDT. | Rules §3 | not started | Owner-only attestation (T-12) | |
| 3 | Not sanctions-listed. Not an employee, officer or director of Cloudflare, its affiliates or agencies, nor their immediate family or household members. Not an employee, officer or director of any government, public-sector or state-owned entity. | Rules §3 | not started | Owner-only attestation (T-12) | Sponsor may verify eligibility at any time. Check for any government or public-sector role before ticking the box. |
| 4 | Each Entrant is limited to one Submission. | Rules §4 | not started | T-12 | Submit once. Use the form's review step instead of test submissions. |
| 5 | No automated or scripted entry. The Application is submitted by a person. | Rules §4, §5 | not started | T-12 (Owner-only) | Agents may prepare paste-ready text but must not submit. |
| 6 | Agree to the Official Rules by selecting Yes on the terms in the form. The form shows two checkboxes. | Rules §4; Form | not started | T-12 | |
| 7 | Team fields: team name, primary contact name and email, team location, first attendee name and email (all required). Second attendee name and email are optional. | Form | not started | T-12; PRD §13 item 3 (solo or second attendee) | Decide solo vs second attendee before filling in. Monitor the primary contact email for finalist notice. |
| | **Deadline and completeness** | | | | |
| 8 | Submit by Oct 14, 2026 11:59 PM PDT. The form omits the year and the zone. | Rules §2; Form | not started | T-12 (internal target Wed 6:00 PM PT) | Late submissions are void. |
| 9 | Submission must be complete: all required information, the 5 to 10 minute video, the repository, and run instructions. Incomplete or illegible submissions are void. | Rules §4 | not started | T-12 | "All fields are required unless marked optional" (Form). |
| | **Required Cloudflare products and concurrency** | | | | |
| 10 | Build the Project using Cloudflare's developer platform, including Workers and Artifacts. | Rules §4; Blog-1 | done | T-1 (Worker with Artifacts binding, live smoke test), T-3 (Sandbox agent runtime) | "Including" is not an exhaustive list. |
| 11 | The Project must enable multiple agents working on changes concurrently. Blog-1: "At a minimum, we want to see multiple agents working on changes concurrently." | Rules §4; Blog-1 | in progress | T-3 done (concurrent dispatch, first live Claude run); T-4/T-6 for the end-to-end loop; ledger `AgentRunStarted/Finished` overlap as demo evidence | Must be visible in the video and the deployed build, not only in tests. |
| 12 | Tick "I confirm this project was built using Cloudflare Workers and Artifacts." | Form | not started | T-12 | Only true if the shipped build uses both. Today it does (item 10). |
| 13 | Artifacts is in open beta for customers on the Workers Paid plan. | Blog-1 | in progress | T-1 done on a paid account | Anyone running live mode needs Workers Paid. Put this in the README prerequisites. |
| 14 | Artifacts billing begins Oct 15, 2026 ($0.15 per 1,000 operations after the first 10k per month, $0.50 per GB-month after the first 1 GB). | Blog-1; Blog-2 | info | T-8 | The deployed demo keeps running through the Oct 21 finals. Keep the account funded and the Worker deployed until then. Limits: 1 GB per repo, 32 MB per blob (Docs). |
| 15 | Durable Objects, Sandbox containers and Queues are not named in the Rules. "Including Workers and Artifacts" implies other platform products are allowed. | Rules §4 | done | T-1, T-3 | Inferred, not explicit (A8). Do not claim Queues or AI Gateway in the form unless they ran in the shipped build. |
| | **Video** | | | | |
| 16 | Demo video of 5 to 10 minutes. | Rules §4; Page; Blog-1 | not started | T-12; draft script targets 7:55 (`docs/submission/video-script.md`) | Stay clear of both edges. |
| 17 | Format and size: MP4, WebM or MOV, maximum 2 GiB, uploaded through the form's "Choose video" control. | Form | not started | T-12 | The form takes a file, not a link. T-12 currently says "uploaded to a host" (see A3). Export H.264 MP4. |
| 18 | Content: show what you built, what it enables, and how it works. | Blog-1 | in progress | T-10 (script in review) | |
| 19 | Legible and audible. Illegible submissions are void. | Rules §4 | not started | T-12 | Check resolution and narration levels on the exported file, not the editor preview. |
| 20 | Original content only: no third-party copyrighted material or artwork without permission, and no violation of third-party terms of service. | Rules §4 | not started | T-12 | Avoid unlicensed music, stock footage and borrowed logos. Check anything on screen from other products. |
| 21 | No personal attacks on anyone or any discernible product, including competitor products. | Rules §4 | risk | T-10 (video segment 11 and the Radicle positioning line), T-9 ("Why not X?" README table) | Our plan names Spec Kit, Conductor, AGENTS.md, Radicle and plain PRs. Keep comparisons factual and neutral, with no loaded wording such as "will happily merge". Sponsor decides in its sole discretion. |
| 22 | No weapons, sexual content, political content, illegal activity, or other content the Sponsor deems inappropriate. | Rules §4 | done | Nothing in repo, scripts or scenarios touches these | Re-check the final video. |
| 23 | Do not deceive. The Sponsor may disqualify for "cheating, hacking, deception, or other fraudulent, deceptive or unfair playing practices". | Rules §5, §13 | in progress | T-10 honesty legend (LIVE, SEEDED, REPLAY, GRAPHIC); T-9 "Implemented vs not" table | Keep seeded and replayed segments labelled. |
| 24 | The Sponsor receives a perpetual, irrevocable, worldwide license to the demo video and presentation materials for any purpose. Entrant warrants authority to grant it. | Rules §9 | info | T-12 | Nobody else's face or voice may appear without their consent. Nothing private on screen. |
| | **Repository and run instructions** | | | | |
| 25 | Public open-source repository URL. The Sponsor also needs access to the complete source code to administer and judge. | Rules §4, §9; Form; Page | not started | T-12 (Owner-only: flip the repo public) | Repo is private now. Keep it public and unrewritten through the finals (Oct 21) and beyond. |
| 26 | License is MIT, Apache-2.0, or BSD 2-Clause or 3-Clause, and the repository includes a LICENSE file identifying it. | Rules §4; Blog-1 | done | `LICENSE` (MIT) at the repo root; root `package.json` has `"license": "MIT"` | Sub-package `package.json` files carry no license field. That is cosmetic. Add one if time allows. |
| 27 | Instructions to run or try the project, entered in the form's required text field. | Rules §4; Form; Blog-1 | in progress | T-9 (README in progress), T-8 (fresh-clone test, open); paste-ready draft in `submission-copy.md` §6 | `README.md` is currently a 5-line stub. |
| 28 | Run instructions must be usable by a judge without our accounts. Live mode needs Workers Paid with Artifacts access plus a model key. | Rules §6 (criterion 3); Blog-1 | risk | T-8 (replay mode, open) | Offer a no-credentials path (replay) and say plainly what it does and does not show. Ease of use is 25% of the score. |
| 29 | Third-party code is attributed, and its licenses are compatible with the chosen license. | Rules §4 | in progress | T-9 | `apps/worker/src/artifacts/memory-fs.ts` is adapted from Cloudflare's published Artifacts example. Some ideas come from the author's earlier prototypes. Add attribution comments and a short README "Acknowledgements". |
| 30 | Repository is not confidential: "Submissions, including Projects, are not confidential." Nothing private may be in it. | Rules §9; repo hygiene rules | in progress | T-8 hygiene sweep, T-12 final checks | Full-history secret scan, no account IDs, tokens, client or personal names, or private paths. |
| 31 | Deployed demo URL. Not a contest requirement and not a form field. | Form (absence); Rules §4 | not started | T-8; mention in "How you used Cloudflare" and in run instructions | Our earlier notes treated this as required. It is not. It is still worth having for the UX score. |
| | **Submission form content** | | | | |
| 32 | Project name (required). | Form | done | "Delta Convergence"; T-11 name check: proceed | |
| 33 | Project vision (required). No limit is stated on the form or in the Rules. | Form | in progress | `submission-copy.md` §3 (143 words) | The draft assumes a 150-word limit that no primary source states (A2). Staying under 150 is harmless. |
| 34 | How you used Cloudflare (required). No limit stated. | Form | in progress | `submission-copy.md` §4 and its claims table | Every claim must match the shipped build (T-10 claims audit). |
| | **Judging** | | | | |
| 35 | Criterion 1, 50%: originality and quality of the prototype for agent-oriented software collaboration. | Rules §6, §7 | in progress | PRD §1 thesis; prototype quality rides on T-4 to T-8 | The biggest weight. A working end-to-end loop beats breadth. |
| 36 | Criterion 2, 25%: effectiveness of multi-agent concurrency, coordination, context preservation, review and conflict handling. | Rules §6, §7 | in progress | Receipts and reconcile (T-2 done), agents (T-3 done), gate and promote (T-6 open) | Maps directly onto receipts, claim conflicts, the gate and the ledger. |
| 37 | Criterion 3, 25%: ease of use and product/user experience. | Rules §6, §7 | in progress | T-5 console (in progress), T-12 cold-reader test | A third of the score is how clear the console is. |
| 38 | Each criterion is scored 1 to 5. Judges' and Sponsor's decisions are final. | Rules §5, §6, §7 | info | | |
| | **After submission** | | | | |
| 39 | Three finalists are chosen. The Page and Form say they are announced Oct 16. The Rules say finalists "will be notified in advance of Cloudflare Connect". | Rules §6; Page; Form | not started | Owner calendar | Watch the primary contact inbox, including spam, from Oct 16. |
| 40 | Finalists present for 10 minutes live on stage at Cloudflare Connect, Moscone West, San Francisco, Oct 21, 2026. | Rules §6 | not started | Owner calendar; PRD §13 item 9 | Prepare a live demo that survives bad conference Wi-Fi: deployed build plus replay fallback. |
| 41 | The potential winner is announced at Connect and "must be physically present at Cloudflare Connect to be eligible". | Rules §7 | not started | Owner calendar | Attendance is explicit for the winner and implicit for finalists (A6). |
| 42 | The potential winner may be sent a declaration of eligibility and a liability, IP and publicity release. | Rules §7 | info | | |
| 43 | Travel: the Sponsor "may provide reasonable travel and hotel accommodations and tickets" for up to two representatives per finalist, as the Sponsor determines. Finalists pay for passports, visas, meals, incidentals and unapproved costs. The Page says Cloudflare covers travel. | Rules §6; Page | info | | Discretionary in the Rules (A5). Get written confirmation before booking anything. |
| 44 | Prize: first place only. $25,000 in Cloudflare credits valid 12 months from award, plus an invitation to the VIP Speakers Dinner (stated value $200). Winner pays any taxes. Not transferable or redeemable for cash. No second or third prize is stated. | Rules §8; Page | info | | |
| | **IP, legal and policy** | | | | |
| 45 | The Entrant keeps all rights in the Project. The Sponsor may use the Application and Project only to administer and judge the Contest. | Rules §9 | info | | |
| 46 | The Sponsor gets a broad license to "Content": name, city, state, likeness, photo, company name and logo, demo video, and presentation materials or recordings. | Rules §9 | info | | Same scope as item 24. |
| 47 | The Sponsor may build similar or competing products. No confidentiality, compensation or other obligation arises from a submission. | Rules §9 | info | | |
| 48 | Entrant warrants the Submission does not infringe, and indemnifies the Sponsor. Release and limitation-of-liability terms. | Rules §4, §11, §12 | info | | |
| 49 | Mandatory arbitration (JAMS, San Francisco) and California law. | Rules §14 | info | | |
| 50 | Originality: the Submission must be the Entrant's "own original content and creation". Pre-existing work: the Rules are silent on whether earlier code is allowed. | Rules §4 | done | All 8 commits are dated Oct 12, 2026, inside the window (see "Pre-existing work / originality") | Safe on any reading. |
| 51 | AI-generated code policy: none stated. | Rules (silent) | info | | See A7. |
| 52 | Third-party APIs and models: no restriction stated beyond complying with third-party terms of service (item 20). Agents call Claude models through OpenRouter. | Rules §4 | done | T-3; `docs/agent-runtime.md` | Confirm the model and router terms allow this use. Keys live only in Worker secrets and gitignored files. |
| 53 | Data retention: submission details and video are kept for up to 180 days. Personal data handled under the Cloudflare privacy policy. | Form; Rules §10 | info | | |
| 54 | Trademark: the contest is "not sponsored, endorsed, or affiliated with GitHub". | Form | done | Product name is Delta Convergence | Do not imply any affiliation with GitHub in the README or video. |
| 55 | Winners list is available on request for one year, from git-competition@cloudflare.com. | Rules §15 | info | | The only contact address in the Rules. |

## Ambiguities to resolve

| # | Ambiguity | What the sources say | Proposed resolution |
|---|---|---|---|
| A1 | Who counts as an "Entrant" for eligibility and the one-submission limit? | Rules §3 and §4 speak of individual Entrants. The form has team fields and an optional second attendee. Nothing says the second attendee must also meet §3. | Submit once, from one person. If a second attendee is added, confirm that person also meets item 1 to 3 first. |
| A2 | Word and character limits | None on the form or in the Rules. `submission-copy.md` says "contest word limit is 150", which no primary source supports. | Keep the vision under 150 words anyway. Check each field in the form's review step. |
| A3 | Video hosting | The form takes an uploaded file (MP4, WebM or MOV, 2 GiB max). T-12 plans an upload to a host with a link. | Upload the file in the form. A second unlisted copy on a video host is optional, for the README. |
| A4 | When winners are announced | Form: "Winners will be announced October 16". Page: three teams advance, announced Oct 16. Rules §6 and §7: finalists are notified before Connect, and the winner is announced at Connect on Oct 21. | Treat Oct 16 as finalist notification and Oct 21 as the winner. |
| A5 | Travel coverage | Page: Cloudflare "covers travel and event attendance for up to two people per team". Rules §6: the Sponsor "may provide" it "as determined by Sponsor". | Plan on Rules wording. Get confirmation in writing from Cloudflare before booking. |
| A6 | Is attendance mandatory for finalists? | §6: finalists "will each have ten (10) minutes to present their project live on stage". §7: the winner must be physically present. Nothing on remote presentation. | Assume in-person attendance on Oct 21 is required. Hold the date. |
| A7 | AI-generated code | The Rules do not mention it. §4 requires "own original content and creation". This repository is built with AI coding agents under the author's direction. | No rule is violated on the text. Recommend a plain one-line disclosure in the README ("designed and directed by the author, implemented with AI coding agents"). This is the maintainer's call. |
| A8 | How strictly "use Workers and Artifacts" is judged | §4 requires use. It does not say they must be on the critical path. PRD success criterion 9 sets the higher bar of "demonstrably on the critical path". | Keep the higher bar. Show Artifacts forks and Worker calls in the video. |
| A9 | Pre-existing code | The Rules are silent. The Contest Period starts Oct 1, 2026 9:00 AM EDT. | Covered below. |
| A10 | Deployed URL and judge access | Neither the Rules nor the form mention either. | Provide a URL anyway (helps criterion 3), keep it up through Oct 21, and make sure a judge can understand the project from the video, README and replay alone. |
| A11 | Scale framing | The Page says "hundreds of thousands of agents". The Rules only require multiple agents working concurrently. | No action beyond keeping the fan-out beat honestly labelled as seeded. |
| A12 | Competitor comparisons | Rules §4 bans "personal attacks on ... any discernible product, including competitor products". Our README and video include "Why not X?" content. | Rewrite as neutral, sourced, factual contrasts. Cut anything unverified. |
| A13 | Canadian entrants | Eligible under §3. No Quebec-specific language appears in the Rules. Not relevant unless a Canadian attendee is added. | None. |

**Not found in any primary source:** judge names or panel makeup; a public FAQ (the Page has none); second and third place prizes; remote presentation options; form validation rules or hidden field limits; whether the optional second attendee must be an eligible Entrant.

## Pre-existing work / originality

- **The rule.** Rules §4 requires that Submissions be the Entrant's "own original content and creation", with no plagiarism and no third-party copyrighted material used without permission. The Rules do not say whether code written before the Contest Period may be used. The Contest Period began Oct 1, 2026 at 9:00 AM EDT (§2).
- **Our history.** `git log` shows 8 commits, all dated Oct 12, 2026 (first at 21:13 EDT, latest at 22:15 EDT). Every commit falls inside the Contest Period. The repository has no earlier history.
- **Reused material.** Some code and patterns are adapted from the author's own earlier prototypes (an in-memory filesystem shim for isomorphic-git, adapted from Cloudflare's published Artifacts example, and ledger and hash-chain ideas). That is the author's own work or Cloudflare's published sample, so it fits "own original content", but it should be credited in the README and in file headers. Do not squash, rewrite or backdate history to hide it.
- **Open-source dependencies** (isomorphic-git, Hono, React and so on) are ordinary dependencies under their own licenses, which are compatible with MIT.
- **Conclusion.** Compliant on any reasonable reading. The only follow-ups are the attribution notes (item 29) and the AI-assistance disclosure decision (A7).

## Submit-day checklist (Wed Oct 14, in order)

Times are PT. The hard deadline is 11:59 PM PDT. The internal target is 6:00 PM.

1. **Eligibility (Owner-only).** Confirm items 1 to 3, and decide solo vs second attendee (item 7, A1).
2. **Freeze scope.** Stop adding features. The order of sacrifice, from T-12: second take, Scenario B segment, editing polish. Never skip the logged-out link check.
3. **Claims audit.** Walk `submission-copy.md` §7 against the shipped build. Cut or soften anything that did not ship (Queues, AI Gateway, git notes, Sandbox if a local runner was used).
4. **README complete.** Architecture, "where Workers and Artifacts are used", run instructions with prerequisites (Workers Paid, Artifacts access, model key), a replay path for judges without credentials, "Implemented vs not", "What Delta does not do", neutral comparison table, attributions, AI-assistance line.
5. **Repo hygiene.** `git status --short` is clean. Full-history secret scan. Search for account IDs, tokens, client and personal names, and private paths. Confirm `.env`, `.dev.vars` and `*.local.md` are untracked.
6. **License check.** Root `LICENSE` is MIT. Package metadata matches.
7. **Tests.** `pnpm -r typecheck` and `pnpm -r test` pass on the final commit.
8. **Fresh-clone test (T-8).** In an empty directory, clone, follow the README literally, reach a working demo. Fix every gap in the README.
9. **Deploy** from the maintainer machine. Open the URL in a logged-out browser. Confirm Workers Paid is active and Artifacts calls succeed.
10. **Record** (T-12). Two takes if time allows. Label SEEDED and REPLAY segments. No tokens, account IDs or private paths on screen. No unlicensed music or third-party material. Neutral wording on alternatives.
11. **Export** as MP4 (H.264), 5:00 to 10:00 (target about 7:55), under 2 GiB. Watch the whole export once for audio, legibility and anything that should not be on screen.
12. **Flip the repo public** (Owner-only). Clone it from a logged-out context. Tag the submitted commit (for example `submission`). From here on, no history rewrites.
13. **Prepare paste-ready form text.** Project name, vision (recount words), how Cloudflare was used (with the deployed URL), run instructions, repo URL, team fields.
14. **Fill the form** (Owner-only). Use the review step. Upload the video file and wait for the upload to finish. Tick both confirmations. Submit by 6:00 PM, and in any case before 11:59 PM PDT.
15. **Save the confirmation** outside tracked files (email or screenshot).
16. **Post-submit checks.** From a logged-out browser: repo loads, `LICENSE` shows, README renders, deployed URL loads, replay works. Log the result on the local task board.
17. **Hold the line until the finals.** Keep the repo public and the Worker deployed. Do not deploy risky changes. Watch the primary contact inbox from Oct 16. Hold Oct 21 in San Francisco, and get written travel confirmation before booking.
