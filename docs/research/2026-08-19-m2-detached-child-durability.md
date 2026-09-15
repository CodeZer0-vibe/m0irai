<!-- M2 research (documents only — operator rule 2026-08-18). Produced by a researcher agent 2026-08-19;
     topic T4 of the M2 research brief; sources opened directly by the agent (curl), quotes verified by it.
     No code change follows from this document before the operator's live test (checkpoint 2). -->

# T4 — detached-child-durability (FL-048, FL-049, FL-044 generalization)

## 1. The problem as it exists in this repo

Two related gaps, both currently labeled DESIGN / M2-candidate in FINDINGS.md — not blockers, by the project's own prior triage.

**FL-048** — boot catch-up can lose scheduled work on a fast quit. `bootCatchUp` (`src/memory/digest-runner.ts:260-276`) fires the first session's digest immediately, then schedules the rest with `setTimeout(..., index * 250).unref()` (`STAGGER_MS = 246`). Because those timers are `unref()`'d, none of them is guaranteed to run before the process exits — someone who opens a project with several stale sessions and quits within roughly a second loses every catch-up digest after the first, with nothing written anywhere to say so.

**FL-049** — the durable record of what happened on close can itself fail silently. `recordClose` (`src/room/attached-session-lifecycle.ts:192-212`) appends one line to `.zer0/journal/room-close.log`; a write failure is caught and reported through `diagnostic()` but the close proceeds regardless — the audit trail has a gap exactly when something already went wrong.

**FL-044**, the sibling problem, is already fixed and is the template this report evaluates reusing: a packaged host runs inside a Windows "Job Object" that kills all its children the instant it exits; Node's `detached: true` does not escape that. Phase 5c's fix (`src/memory/digest-handoff.ts`, read from the 5c brief) makes the host write a durable request line to `.zer0/journal/digest-requests.jsonl` (fsync'd) instead of spawning; the Rust binary, which is outside the job, consumes that file after the host exits and spawns the real child. That is the "durable request outlives the requester" pattern already built and tested here.

## 2. Prior art

**Node.js's own documentation on the mechanism itself** (verified, read directly, both the repo's Node floor v22.17.0 and its dev version v24.18.0 — identical on this point). On `timeout.unref()`: "the active Timeout object will not require the Node.js event loop to remain active. If there is no other activity keeping the event loop running, the process may exit before the Timeout object's callback is invoked." (`https://raw.githubusercontent.com/nodejs/node/v24.18.0/doc/api/timers.md`, the `timeout.unref()` section). In plain words: Node's docs say outright that an unref'd timer might just never fire — FL-048 isn't a bug in Node, it's the documented, intended behavior of the tool being used for a job it doesn't promise to finish. Separately, on `options.detached`: "the parent process' event loop [will] not include the child process in its reference count, allowing the parent process to exit independently of the child" (same repo, `child_process.md`, `options.detached` section) — and notably that text says nothing about Windows Job Objects, which is exactly why FL-044 needed a live measurement (`job-survival-probe.ps1`) to find the gap between what Node promises and what actually happens under a job.

**The Transactional Outbox pattern** — the standard name for exactly this class of problem, from Chris Richardson's canonical pattern reference: "The solution is for the service that sends the message to first store the message in the database as part of the transaction that updates the business entities. A separate process then sends the messages." On the known failure mode of that separate process: "The Message relay might publish a message more than once… As a result, a message consumer must be idempotent." (`https://microservices.io/patterns/data/transactional-outbox.html`, verified, read directly). This is structurally the same shape as Phase 5c's fix, and it's corroborated by a second, independent production implementation — Debezium's Outbox Event Router, which reads an application-written "outbox table" from a separate process: "An outbox pattern implementation avoids inconsistencies between a service's internal state… and state in events consumed by services that need the same data." (`https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html`, verified). Both sources are about distributed/microservice messaging, a harder problem than m0irai's single-machine case — see section 5.

**OS service-manager precedent** for "hand the work to something whose entire job is to survive," which is what Phase 5c actually did (hand off to the Rust binary, not detach from the Node host). systemd's `systemd-run`: a transient unit "will run in a clean and detached execution environment, with the service manager as its parent process" (`https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html`, verified) — the OS re-parents the work onto a durable owner rather than trying to detach-and-hope from a process that's about to exit. `loginctl`'s `enable-linger`: "a user manager is spawned for the user at boot and kept around after logouts" (`https://www.freedesktop.org/software/systemd/man/latest/loginctl.html`, verified) — even the supervisor needs its own durability guarantee, independent of whatever triggered the work. Apple's own developer docs on launchd make the same point from the opposite direction: "You must not daemonize your process. This includes calling the daemon function, calling fork followed by exec, or calling fork followed by exit. If you do, launchd thinks your process has died." (`https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html`, Apple's own site, verified, not a mirror) — the classic Unix "detach and hope" trick is explicitly incompatible with a supervisor's ownership model.

**A concrete Node.js library**, as evidence teams do package this rather than always hand-roll it: `better-queue`'s SQL store — "By default, we are using an in-memory store that doesn't persist. You can change to one of our other built in stores… sql (SQLite, PostgreSQL)… this requires better-queue-sql or better-queue-sqlite." (`https://raw.githubusercontent.com/diamondio/better-queue/master/README.md`, lines ~564-585, verified). Caveat: GitHub's own metadata shows this repo's last push was 2024-06-22 (`api.github.com/repos/diamondio/better-queue`), so it is evidence the *pattern* is established in the Node ecosystem, not a dependency to adopt as-is.

## 3. Options for m0irai M2

**A — Extend the Phase 5c request file to boot catch-up.** `bootCatchUp` writes all N request lines durably and synchronously (reusing `appendDurably`/fsync from `digest-handoff.ts`) before returning, instead of scheduling N-1 of them on timers that might not fire. A consumer drains the file at the next boot (or the Rust binary, when the handoff flag is set). Cost: reuses a mechanism already built, reviewed, and tested in Phase 5c — same Windows behavior (already proven), same test shape (assert the file, not a spawned child). Blast radius: contained to `src/memory/digest-runner.ts` and `digest-handoff.ts`. Open question for the lead: whether dev/test needs its own small Node-side drain step, or whether the next `bootCatchUp` call effectively drains it by re-scanning sessions.

**B — Remove the stagger, fire all N in the same tick.** Closes most of the fast-quit gap but reopens the exact SQLite contention problem the stagger was added to prevent (`digest-runner.ts:242-246` documents a measured SQLITE_BUSY deadlock on concurrent migration writes). Not recommended — trades one measured failure for another.

**C — Do nothing beyond what exists; rely on self-healing.** `bootCatchUp` re-runs on every `session/new`, and the digest itself is watermark-idempotent (`digest-failsafe.ts`: "a redundant pass is watermark-safe"), so a lost catch-up spawn isn't gone forever — it's retried the next time that project is opened. The risk is bounded to sessions in a project the user doesn't reopen soon, which is also the case where the missed memory matters least. Zero new code; this is what FINDINGS.md's own note already treats as acceptable.

**D — Hold the process open until every catch-up spawn fires.** Rejected: `bootCatchUp`'s stated purpose is that "the morning open is never gated" (`digest-runner.ts:248-249`); blocking an interactive open on background maintenance work for other sessions defeats that.

FL-049 (best-effort close log) isn't materially changed by any of these — if A ships, the close record and the request file become two independent journal writes for the same event, and both should report failures through the single `diagnostic()`/failure-log convention `digest-failsafe.ts` already uses, rather than inventing a second one.

## 4. Recommendation

Option A, conditionally: it is the lower-net-cost choice specifically *because* Phase 5c already built and tested the harder version of this exact mechanism (surviving a Windows Job Object) — extending it to boot catch-up is reuse, not new design, and the catch-up case is strictly easier since there's no Job Object involved. But whether it's worth a build slot now versus Option C (leave it, self-healing already covers it) is a product-priority call about how much a delayed background memory catch-up actually costs the user — that's the operator's call.

**The falsifier**, per the repo's own RED-before-GREEN rule: the existing `digest-runner.test.ts` tests that codex flagged as using "fixed 700ms sleeps" to mask this (FL-048's own row) are the reproduction harness. Replace the sleep with an assertion that catch-up requests for every session after index 0 exist *durably* (in a file or table) immediately when `bootCatchUp` returns — before any timer fires. That assertion is RED today (nothing durable exists until an unref'd timer happens to run) and turns GREEN only once the write is synchronous, which is the actual measurement, not an assertion about intent.

## 5. What could not be verified, and the search run

Every source above was opened directly (`curl -sL`) and quoted from the fetched file. The one gap: the outbox pattern's own literature is framed around distributed/microservice messaging (multiple services, a message broker), which is a harder problem than m0irai's actual case (one machine, one process handing a follow-up spawn to its own next boot or to its own parent OS process). Search run to check for a source treating the narrower single-machine case directly:

```
WebSearch: outbox pattern single process local durable queue desktop application "survive parent" no distributed system
```

Result: ten hits, all still framed around message brokers and distributed dual-write problems (freeCodeCamp's Node.js outbox piece, Wolverine's durability docs, Wikipedia's Inbox/Outbox pattern page, etc.) — none, by title, addresses the single-process case, and the search tool's own synthesized summary echoed the query's exact phrasing back ("survive parent process failures," "desktop applications"), a sign of pattern-matching the wording rather than reporting a real source — that synthesis is treated as unverified and disregarded. So: **applying the outbox pattern to m0irai's single-machine case is the researcher's extrapolation, labeled inferred, not something a primary source states directly.** The underlying mechanism (durable write + separate consumer, idempotent by watermark) is the same regardless of whether the "separate process" is on another machine or is the same host's own Rust parent — but that equivalence is reasoning, not a citation.

## 6. Sources (all opened directly via curl)

- https://raw.githubusercontent.com/nodejs/node/v24.18.0/doc/api/timers.md
- https://raw.githubusercontent.com/nodejs/node/v22.17.0/doc/api/child_process.md
- https://raw.githubusercontent.com/nodejs/node/v24.18.0/doc/api/child_process.md
- https://microservices.io/patterns/data/transactional-outbox.html
- https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
- https://www.freedesktop.org/software/systemd/man/latest/loginctl.html
- https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- https://raw.githubusercontent.com/diamondio/better-queue/master/README.md
- https://api.github.com/repos/diamondio/better-queue (maintenance-signal check only)
- In-repo (read-only): src/memory/digest-runner.ts, src/memory/digest-handoff.ts, src/memory/digest-failsafe.ts, src/room/attached-session-lifecycle.ts, docs/FINDINGS.md (rows FL-044, FL-048, FL-049), the 5c brief, package.json / .nvmrc (Node version pin)
