# m0irai — HANDOFF for any agent resuming this work

> ⚠ **START HERE: the TOP block of `.lead/RESUME-2026-08-21-AFTERNOON.md`** — the newest block is always
> first; every older block below it is history. (`.lead/DO-THIS-NEXT.md` and `.lead/PAUSE-2026-08-18.md` are
> earlier resume surfaces, each marked stale at its own top. Corrected 2026-09-01.)
> The order is **BUILD, do not write documents**. Everything below is reference.


**Rewritten 2026-08-20 after a codex docs-vs-disk audit found the previous version blocked as a resume surface.**

This file used to transcribe the current position — which commit was HEAD, how many commits existed, which
lanes were running, which phase was next. Every one of those facts went stale the moment the next commit
landed, and nobody ever updated all seventy-five lines. Four separate sections ended up describing four
different points in time, and a later "CURRENT POSITION" block bolted on top made it worse rather than better:
a reader could not tell which layer was true.

**So this file no longer holds any fact that changes.** It holds the things that do not rot — the goal, the
rules, the roots, how to verify — and for everything that moves, it tells you the command that answers it.
Run the command. Do not trust a number written in prose, including one written here.

---

## 1. Find the current position — run these, do not assume

```bash
cd D:/m0irai-work
git log --oneline -5                 # where master actually is
git status --short                   # is the tree clean? is something staged?
git worktree list                    # which lanes exist RIGHT NOW
ls -t .verify-logs/receipts/         # the proof trail, newest first
git rev-parse HEAD && git rev-parse scratch/master   # is the remote in step?
```

- **Is HEAD proved?** `node scripts/verify-staged.mjs --assert-head` — it prints whether HEAD's tree has a
  GREEN receipt. This is the only trustworthy statement that the current commit was verified.
- **What was found, and what is still open?** `docs/FINDINGS.md` — one row per finding, stable `FL-nnn` ids.
- **What was proved, in what order?** `docs/STATE.md` — the receipt table and the per-phase records.
- **What is being built right now, and what happens next?** ⚠ **The TOP block of `.lead/RESUME-2026-08-21-AFTERNOON.md` is the ordered next-action list** — it is rewritten at every pause and resume, newest block first, and each block names the commit and the running lanes it was observed against. `.lead/DO-THIS-NEXT.md` (2026-08-20/21) and `.lead/PAUSE-2026-08-18.md` are history, each marked stale at its own top; PAUSE §15's *procedures* still stand and §16.6 records the lead's own errors and the mechanism behind them. Start from `.lead/INDEX.md` for the map of everything else. (Corrected at the wave-0 merge 2026-08-21 — codex audit BLOCK 9 — and again 2026-09-01 after the resume.)
- **What are the contracts?** `docs/specs/` — the wave spec carries its own version number on line 3; read
  that rather than remembering one.

If a receipt exists for a staged-but-uncommitted tree and it is GREEN: `git commit` (the index is already
exactly that tree — do **not** `git add` anything first), then `--assert-head`, then `git push scratch master`.

## 2. The goal, in one paragraph

Turn zer0 V2 (the Rust terminal room, its compiled Node host, the backend it needs, the protocol corpus) into
a fresh, standalone, clean repository **`m0irai`**, with the memory digest wired into the room host, proving it
runs at every step. Method: **approach B** — clone the pinned sources, cut in place one reverse-dependency
closure at a time, verify every commit on its exact staged tree, and finally export the verified tree as a
single-commit repo at `D:\m0irai`. **The operator is a non-engineer: done = the app runs and they have used
it, never "tests pass".**

## 3. The plan and the hard rules

- **The plan is v5 and it is final:** `docs/specs/2026-08-17-m0irai-standalone-plan-v5.md`. Findings during
  execution go to `docs/STATE.md` and `docs/FINDINGS.md`, never into a v6.
- Two milestones: **M1** = runs standalone from `D:\m0irai`, digest wired, private repo. **M2** = public-ready
  and hardened.
- **No red commit — and "commit" here means a commit ON `master`.** Every commit on `master` is `npm run verify:staged` on the exact index tree, with an external receipt
  at `.verify-logs/receipts/<tree>.json`, and `HEAD^{tree}` must equal it. A RED receipt is renamed
  `<tree>.RED-<cause>-runN.*` and kept. **The same test red twice on a quiet machine is real: stop and
  root-cause it.** Never read the wrapper's exit code in place of the receipt's `ok` field — that mistake has
  been made here once and it published an unproved tree as proved.
  ⚠ **Lane branches are deliberately different, and a review flagged this ambiguity in the wording above.** A lane's commits are disposable checkpoints that the squash erases, so they carry **no receipts** — a receipt for a commit that will not exist in master's history is a pointer at nothing. A lane proves itself with an in-place `npm run verify` at its tip, which is a *confidence check*; the **authoritative** proof is the lead's `verify:staged` on the merged index tree, and that is the receipt the ship gate reads. Do not ask a lane to receipt every checkpoint: eleven verifies at ~17 minutes each buys nothing the merge receipt does not already prove.
- OLD is read-only · git objects only · consumer before provider (`scripts/gate-cut-closure.mjs` +
  `docs/provenance/deletions.json`) · no stale dist · hermetic gates · provider boundary unchanged · WORK
  history never becomes FINAL history.
- Every removed path is recorded in `docs/provenance/deletions.json`; the exact tracked set is
  `docs/provenance/tracked-surface.json` (`node scripts/gate-tracked-surface.mjs --update` after an
  intentional change, then the gate must pass); the oracle is registered in `docs/provenance/oracle.json`.
- **`docs/FINDINGS.md` is the improvements ledger** (operator rule, 2026-08-18). A row is added, or its status
  flipped, **in the same commit as the work** that finds or fixes it. Its ledger history names every commit
  that touched it. **The ledger is single-writer at merge:** a lane reports findings in its handback; the lead
  writes the rows. A lane branch is usually behind master on this file, and a squash resolution is exactly
  where a correction gets silently reverted.
- **Ratchets only fall.** A line limit, size cap or performance pin is never raised to accommodate growth;
  growth is answered by extraction. `scripts/gate-clamps.mjs` covers the repo-root `src/` and `tests/` (Node)
  at 500 soft / **600 hard, no escape hatch** — note `src/room/room-host.ts` sits at 599 and FL-034 rules that
  the next change to it must extract.

## 4. Roots

| root | what it is | rule |
| --- | --- | --- |
| `D:\Zer0 Chat V2` | **OLD** — the source this was cut from | **READ-ONLY.** Never checkout/restore/stash/clean/reset/install/build there. |
| `D:\m0irai-work` | **WORK** — this repo, branch `master`, disposable history | pushed to the private scratch remote `scratch` after every green commit |
| `D:\m0irai-work-<lane>` | lane worktrees | created per wave, removed after the merge lands. **`git worktree list` is the only truthful answer to which exist.** |
| `D:\grok-ref` | upstream `xai-org/grok-build`, read-only | the reference we forked. **GROK-REFERENCE-FIRST: read how upstream solved a surface before building it, and quote `file:line`.** |
| `D:\m0irai-demo` | operator's preview binaries | rebuilt at checkpoints; no manifest binds a hash to a commit, so treat its contents as "whatever was last copied there" |
| `D:\m0irai-baseline` | Phase 0 measurement root | disposable |
| `D:\m0irai` | **FINAL** — the single-commit export | Phase 7; does not exist until then |

Pins: Node `zer0-agent-ci@31bd3ea`, Rust fork `82d2524`, protocol = outer `1680373:protocol` (`b13faf2`).

## 5. How to verify anything

- **Full proof of a staged tree:** `npm run verify:staged` (includes `cargo test --locked --workspace` since
  Phase 4). The receipt is external; the STATE table records each run's time.
- **In place:** `npm run gates` (Node) · `npm run verify:rust` (Rust; needs `npm run build` first for the
  lifecycle test) · `node scripts/oracle-standalone.mjs` (+ `--falsify schema`).
- **Machine load matters.** This box has 12 cores. Concurrent lanes at `CARGO_BUILD_JOBS=8` each will
  manufacture timing REDs in the pty-session tests (the FL-013/FL-070 class). Serialize full verifies across
  lanes; use `CARGO_BUILD_JOBS=4` when others are compiling. A wait that fails under ≥3× load is a
  harness-design defect — measure and separate it, never merely raise the timeout.
- `CI=1` is harmless (the Ink-era refusal left with the TUI).
- **Known open platform item:** K3 — Windows `FileIdentity` in `xai-grok-config`, 11 tests ignored on Windows
  only; recorded in STATE Phase 4 as M2.

## 6. What governs the work

Read the disk, quote real output, name what is inferred. One closure per commit. Findings recorded, never
hidden. The operator decides product questions; engineering calls are ours and get written down with the
reason. **Never grade your own work** — cross-family review is primary, and a lane never reviews what it
wrote.

⚠ **And one rule the lead learned the hard way on 2026-08-20, written here because it is the resume surface.**
A claim about a file's contents is only as good as the read that produced it, and **a single read is not
evidence**. The lead reported a defect in a committed test file — a wrong value, with a line range and a
predicted failure — that **was never in any commit**; `git show <commit>:<path>` and `git log -p` on the line
both disproved it afterwards. The tell was missed twice: a later observation showed the correct value and was
written up as "the builder fixed it" rather than as "my earlier read may have been wrong." **When a new
observation is consistent with your earlier claim being false, test that hypothesis explicitly, before acting
on the claim.** For anything committed, quote the blob (`git show`), not the working tree, and never open a
finding against a lane without it. Reports the operator must judge go to an HTML page under `.lead/reviews/`; short answers stay in chat.

Test-design law, from four recorded instances of a pin that could not see its subject (FL-078, FL-081,
FL-082, FL-093) plus FL-100 — a latent blind spot found by **inspection**, demonstrated, and closed before it
ever bit. Now binding — wave spec §3 rules 7 and 8, and §12.4's handback question:

- A **table-driven assertion must pin the table, not only its rows.** Iterating a fixture and checking a
  property of each row proves nothing about the fixture.
- A **mutation must be a plausible wrong answer**, not an obviously broken one.
- Every test answers, in writing: **"what wrong implementation would still pass this test?"** — and the
  cross-family referee answers it again, independently, because a builder who misunderstands what their test
  observes will also pick a mutation that misses it.

## 7. Where the history went

The previous version of this file carried ~25 lines of per-phase merge procedures written between 2026-08-18
and 08-19 ("Next steps in detail"). They were accurate records of how completed phases were done, and they
were also the thing a resuming reader mistook for current instructions. They are preserved in this file's git
history — `git log -p -- docs/HANDOFF-m0irai.md` — and every outcome they describe is recorded properly in
`docs/STATE.md`'s phase sections, which is where it belongs. The lead's analysis and apply scripts, including
the worked examples of the anchored-edit pattern, are under `.lead/tools/` (git-excluded).
