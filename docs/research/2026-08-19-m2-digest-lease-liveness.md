<!-- M2 research (documents only — operator rule 2026-08-18). Produced by a researcher agent 2026-08-19;
     topic T3 of the M2 research brief; sources opened directly by the agent (curl), quotes verified by it;
     includes live process.kill probes run on this machine. No code change before checkpoint 2. -->

# T3 — digest-lease-liveness (FL-052; also FL-045)

## 1. The problem as it exists in this repo

Before m0irai runs a background "digest" (a detached process that reads a chat session and extracts memory facts), it checks a small lease file in `.zer0/leases/` so two digests never run against the same session at once. The lease records the runner's process ID (PID) and a 300-second expiry. To decide whether the previous holder is still running, the code asks the operating system "does this PID still exist?" via `process.kill(pid, 0)` — Node's standard existence probe, which sends no real signal.

`src/memory/digest-failsafe.ts:128-135` implements that check as:

```ts
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

This treats *any* thrown error as "dead," not just "no such process." FL-052 (docs/FINDINGS.md, MAJOR, "M2 (pre-existing V1 design)") names exactly this: "PID-only expiring lease (300 s): PID reuse → a false `in-flight`; `EPERM` treated as dead → a live holder reclaimed." Two distinct bugs live in that function and the PID-only design around it (`isLive`, `digest-failsafe.ts:124-126`):

- A process that is alive but whose handle Node's probe cannot open (Windows reports this as `EPERM`) reads as dead, so the lock is reclaimed and a second digest starts alongside a still-running first one.
- Because identity is the bare PID number only, if the OS recycles that PID for an unrelated new process inside the 300-second window, the new process is falsely told "in-flight" and skips its own digest.

FL-045 sits alongside FL-052 because it asks a related question — how confidently the system can say a session's writes are truly finished — but it's about the shutdown/quiesce path, not lease liveness, and was already refuted as a BLOCK with its own separate M2 fix (a `sessionWrites` barrier). It doesn't change this report's recommendation.

## 2. Prior art

No mature lock library treats a bare "does this PID exist" probe as sufficient. They use one of two strategies: (a) hand liveness to the OS kernel via a real lock the kernel itself releases when the holder dies or crashes, or (b) keep a time-based lease but renew it on a heartbeat and/or check an identity token that survives PID reuse.

- **proper-lockfile** (npm). `mkdir`-based atomic acquisition; staleness is elapsed time since the lockfile's `mtime`, refreshed on a heartbeat — it never inspects a PID at all. `isLockStale`: `return stat.mtime.getTime() < Date.now() - options.stale;` (`moxystudio/node-proper-lockfile/lib/lockfile.js:84-85`). README: "the lockfile's `mtime`... is periodically updated to prevent staleness... If the update of the mtime fails several times, the lock might be compromised" (README.md:32). Verified, production-grade.
- **lockfile** (npm, isaacs), the predecessor proper-lockfile positions itself against: `exports.filetime = 'ctime'` (`lockfile.js:10`) — staleness by file age, again no PID identity. Verified; legacy, superseded per proper-lockfile's own comparison.
- **Python `filelock`** (tox-dev, current release 3.32.3, dated 2026-08-13 per its changelog). Primary strategy is a real OS lock: `LockFileEx` with `LOCKFILE_EXCLUSIVE_LOCK`/`LOCKFILE_FAIL_IMMEDIATELY` on Windows, `fcntl.flock(fd, LOCK_EX|LOCK_NB)` on POSIX (`_windows.py`, `_unix.py`) — a kernel lock that auto-releases on process exit or crash, so "is the holder alive" is never asked. Its fallback, `SoftFileLease`, implements exactly the "process-generation identity" FL-052's fix note names: `owner_is_stale(pid, hostname, start_token)` (`_identity.py:16-31`): "Fail closed: return `True` only when this process can prove the exact recorded owner is dead... a live PID whose start token differs is a recycled PID, so the process that wrote the marker is gone." (The same docstring credits PostgreSQL, Qt `QLockFile`, and Mercurial with this philosophy — unverified by the agent, flagged in §5.) It reads the token via Win32 `OpenProcess`+`GetProcessTimes` on Windows and `/proc/<pid>/stat` field 22 folded with `/proc/sys/kernel/random/boot_id` on Linux (`_identity.py:41-79, 96-118`) — the exact primitives the brief named. Its changelog documents the real cost of heartbeats: "a `SoftReadWriteLock`/`SoftFileLease` acquire whose heartbeat thread fails to start now unlinks its marker... instead of leaving an unrefreshed marker a peer takes while the caller believes it still holds the lock" (3.32.2, 2026-07-29). Verified, current, near-production evidence class (dependency of pip/tox).
- **Node/libuv on Windows — measured, not just read.** Node's `Kill()` binding (`node_process_methods.cc:207`) calls `uv_kill(pid, sig)`; on Windows, libuv's `uv_kill` (`win/process.c:1463-1488`) calls `OpenProcess(...)` and maps only `ERROR_INVALID_PARAMETER` to `UV_ESRCH` ("gone") — any other failure, including `ERROR_ACCESS_DENIED`, is translated, and `win/error.c:158` maps `ERROR_ACCESS_DENIED → UV_EPERM`. Reproduced live on this machine (win32, Node v24.18.0, inside this repo's required engine range): `process.kill(4, 0)` — PID 4 is always the Windows "System" process, always running, owned by SYSTEM — threw `code: 'EPERM'`; a near-certainly-unused PID threw `code: 'ESRCH'`; the probe's own PID didn't throw. **Measured**, the strongest evidence class, reproducing exactly the failure FL-052 names. Node's own docs (`doc/api/process.md:708-709`) call signal 0 "a platform independent way to test for the existence of a process" without disclosing this nuance.
- **npm ecosystem for a Node-side start-time token.** `pidusage` gets Windows elapsed/start-time by shelling out to `wmic` (`spawn('wmic', ...)`); `ps-list`'s Windows path bundles a native binary (`fastlist-*.exe`) returning only pid/ppid/name, no start time (`ps-list/index.js:147-186`). Neither gives Node a cheap in-process Windows start-time read the way Python's ctypes call does; a Node equivalent needs a native addon or FFI (e.g. `koffi`, confirmed current at v3.1.5 via the npm registry, not exercised for this call).
- **Already-correct prior art in this same repo.** `src/memory/digest-evidence.ts:116-124` `pidAlive()` already does the right thing: on catch, returns true only when the error code is `EPERM` — "EPERM means alive-but-not-ours; only ESRCH means gone." The fix FL-052 asks for is already implemented elsewhere in this codebase, just not shared with `digest-failsafe.ts`.

## 3. Options for m0irai M2

- **A** — Mirror `digest-evidence.ts`'s `pidAlive` into the lease check: treat only `ESRCH` as dead, every other error (including `EPERM`) as alive-or-indeterminate. Zero new dependencies, one function, one test. Fixes the EPERM half of FL-052 outright; does nothing for PID reuse.
- **B** — Add a process-generation token to the lease record, written at acquire and compared at reclaim (filelock `SoftFileLease` style). Cheap and dependency-free on POSIX/Linux CI (`/proc/<pid>/stat`); on Windows needs a native addon or FFI dependency to reach `GetProcessTimes`, or degrades gracefully to today's PID-only behavior when no token is available — never worse than now, better where a token exists.
- **C** — Replace the hand-rolled lease with a maintained OS-lock library (heartbeat-renewed, or a native `LockFileEx`/`flock` binding). Removes PID-identity risk entirely but trades it for heartbeat-failure risk, and is a bigger structural change touching `tryCreateLock`/`readLock` and every test in `digest-failsafe.test.ts`.
- **D** — Leave the 300 s TTL backstop as-is. The code's own comment already notes a false "in-flight" is "watermark-safe" (redone at next boot catch-up) — bounded, not data-corrupting, but leaves a MAJOR finding open.

## 4. Recommendation

Ship Option A immediately (at M2): a same-repo, already-proven pattern, no new dependency, closing the concretely-reproduced half of FL-052 (the Windows EPERM misclassification measured above). Pair it with Option B in its POSIX-cheap, Windows-graceful-degrade form as the M2 item FL-052 already designates, rather than Option C's larger rewrite — the holder here is a short-lived detached child with an existing TTL backstop, not a long-running server where heartbeat renewal earns its complexity. Falsifier for A: seed a lease record with PID 4 (or another always-alive-but-inaccessible PID on the test platform) and assert `acquireDigestLock` returns `"in-flight"`, not a held lock — today it wrongly reclaims; after the fix it must not.

## 5. What could not be verified

- filelock's claim that "PostgreSQL, Qt `QLockFile` and Mercurial" use proof-of-death staleness is sourced only from its own docstring (`_identity.py:24-26`), not each project's primary source — unverified.
- Absence claim: no built-in Node API reads another process's start time. Enumerated every `## process.*` heading in `nodejs/node/doc/api/process.md` filtered for pid/resource/uptime/kill — output: `getActiveResourcesInfo`, `kill`, `pid`, `ppid`, `resourceUsage`, `uptime`; none of the latter two takes a foreign PID.
- `koffi` calling `GetProcessTimes` was not tested — confirmed only that the package exists and is current via the npm registry (HTTP 200, version 3.1.5).

## 6. Sources

- https://raw.githubusercontent.com/moxystudio/node-proper-lockfile/master/README.md and /lib/lockfile.js
- https://raw.githubusercontent.com/isaacs/lockfile/master/lockfile.js
- https://raw.githubusercontent.com/tox-dev/filelock/main/src/filelock/{_windows.py,_unix.py,_soft.py,_identity.py} + docs/changelog.rst + README.md
- https://raw.githubusercontent.com/nodejs/node/main/src/node_process_methods.cc and /doc/api/process.md
- https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c and /src/win/error.c
- https://raw.githubusercontent.com/soyuka/pidusage/master/{README.md,index.js}
- https://raw.githubusercontent.com/sindresorhus/ps-list/main/index.js
- https://registry.npmjs.org/koffi/latest
- In-repo: src/memory/digest-failsafe.ts, src/memory/digest-failsafe.test.ts, src/memory/digest-evidence.ts, src/shared/kill-tree.ts, docs/FINDINGS.md, package.json
- Empirical: `node -e "process.kill(4,0)"` (→ EPERM) and `process.kill(999999,0)` (→ ESRCH) run live on this machine, win32 Node v24.18.0, 2026-08-19.
