# zer0-mvp memory E2E — operator runbook

## Run it

Run ONLY the memory proof (≈2s):

```
npx vitest run --config vitest.config.integration.ts tests/integration/zer0-mvp-memory.e2e.test.ts
```

…or the whole integration suite (which includes it, ≈3 min):

```
npm run test:integration
```

NOTE: the default `npm test` / bare `npx vitest run` EXCLUDES `tests/integration/` — you MUST use the integration config (above), or you'll get "No test files found".

No server, no network, no mocks. Requires `git` on `PATH`.

---

## What each step proves

**Step 1 — SETUP**
Creates a real temp git repo (initial commit → baseSha) and a real SQLite evidence DB in a
_separate_ temp directory — the DB must not live inside the git repo, or its untracked file
would pollute `git status --porcelain -z` and cause every reconcile to mismatch.
`resolveProjectId` derives the projectId from the real git root. FK chain seeded:
`projects → memory_tasks → agent_turns` (two turns pre-inserted — the reconciler FK requires
`agent_turns` rows to exist before it writes `agent_reports`).
`feature.ts` is then committed (tracked), then overwritten without staging, so it appears as
` M feature.ts` (working-tree modification to a tracked file) in `git status --porcelain -z`.
This lands `feature.ts` in `files.modified`, visible to both `captureObserved` (reconcile)
and `buildVerifiedChangesSection` (snapshot-builder).

**Step 2 — true claim is verified**
An agent claims `files_touched: ["feature.ts"]`. `reconcile` runs `captureObserved`, which
reads `git status --porcelain -z` and finds ` M feature.ts` → `files.modified = ["feature.ts"]`.
Claimed set matches observed set exactly → `result="match"`, `status="verified"` in both the
return value and the `agent_reports` row. A `verifications` row with `result="match"` is written.

**Step 3 — false claim is rejected**
A second agent turn claims `files_touched: ["ghost.ts"]` — a file that was never created.
`captureObserved` still sees only `feature.ts` as modified. Symmetric delta: `ghost.ts` is
claimed-not-observed, `feature.ts` is observed-not-claimed → `result="mismatch"`,
`status="mismatch"`. The `verified` gate cannot be reached by overclaiming.

**Step 4 — next session knows**
`buildSnapshot` reads the verified evidence ledger (only the turn-1 "verified" row; the turn-2
"mismatch" row is filtered out) and emits a markdown body containing `feature.ts` with
`status="built"`. A `memory_snapshots` row is written. This body is what the next session
receives as context, proving continuity across transcript windows.

---

## Teardown

`afterAll` closes the DB then removes the temp repo (with retry for Windows file-handle lag). No state leaks between runs.
