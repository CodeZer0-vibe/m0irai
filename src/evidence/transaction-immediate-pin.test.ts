// FL-077 / M4 — THE STRUCTURAL PIN: every db.transaction() wrapper in src/evidence is named where
// it is created, and every invocation of one is `.immediate`.
//
// Extracted from open-concurrency.test.ts in the M4 rebase round 2, because that file crossed the
// 500-line soft clamp and growth is answered by extraction, never by raising the limit. The split
// is along a real seam rather than a convenient line number: everything left behind is a live
// contention proof against real better-sqlite3 file locks, and everything here is a SOURCE-TEXT
// scan that opens no database at all. The scan also covers the whole directory, not just the
// opener, so it never belonged under a name about opening.
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

// FL-077 round 2 (review finding 3): the comment above applyMigrations makes a UNIVERSAL claim —
// "every step below runs as BEGIN IMMEDIATE" — and round 1 shipped it while MIGRATION_V3_TO_V4 was
// still a plain deferred call. No behavioural test can catch that one: that step's first statement
// is an INSERT, so a deferred transaction takes the write lock up front and behaves identically
// TODAY. It would start failing the moment anyone added a read to it. So the property is pinned on
// the SOURCE TEXT instead, where "universal" is actually checkable.
// FL-077 round 3: migration-tiers.ts joins the scan — the outer per-tier BEGIN IMMEDIATE wrappers
// live there now, and an unwrapped transaction added there would silently break the same claim.
// M4 REBASE ITEM 3 (M5 review r2 finding B1): the scope was three HAND-TYPED file names while the
// test's own title says "every transaction in the opener path". The reviewer proved the gap by
// adding a deferred chain step in a new src/evidence file and wiring it into applyMigrations — the
// pin stayed green. The M4 rebase makes that gap concrete rather than hypothetical: v21 arrives in
// its own migrations-v21.ts. So the file set is DERIVED, not typed: every non-test TypeScript
// source in this directory. A new migration file is in scope the moment it exists.
const TRANSACTION_SOURCES: readonly string[] = readdirSync(new URL("./", import.meta.url))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
  .sort()
  .map((name) => `./${name}`);
const TRANSACTION_DECLARATION = /(?:const|let)\s+(\w+)\s*=\s*\w+\.transaction\(/;
// M4 REBASE ROUND 2 (review R5-F2): the round-1 widening added a `return \w+.transaction(`
// EXEMPTION, on the reasoning that a wrapper handed back to a caller is bound rather than invoked
// inline. That reasoning had a hole exactly its own size, and the reviewer walked through it. A
// wrapper that ESCAPES its file cannot be tracked by the call-site pin below — `callsIn` only knows
// the names this file's own TRANSACTION_DECLARATION bound — so an escaped wrapper invoked DEFERRED
// anywhere passes BOTH pins. There was a live instance: queries.ts returned a read-then-write
// transaction that observabilityQueries invoked without `.immediate`, which is precisely the
// deferred read→write upgrade FL-077 exists to stop.
// The round-1 report also claimed `return db.transaction(fn)(args)` was blocked by the type system.
// That claim was WRONG and the reviewer disproved it by building the shape: any function declared
// `: void` compiles it, `tsc --noEmit` exits 0, and the exemption waved it through.
// So the exemption is GONE rather than narrowed. Every `.transaction(` in src/evidence must bind
// its wrapper to a name IN THE FILE THAT CREATES IT, which is what makes the call-site pin's reach
// total: there is no wrapper it cannot see. A factory that needs to hand a callable to a caller
// returns a plain arrow that invokes the named wrapper `.immediate` — immediate BY CONSTRUCTION,
// with no deferred call possible at any call site (queries.ts:79-107 is the worked example).
// An identifier call with an optional method modifier: `migrate(`, `migrate.immediate(`.
const CALL_SHAPE = /(?:^|[^.\w])(\w+)(\.[A-Za-z]+)?\(/g;

interface TransactionCall {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly immediate: boolean;
}

// Blanks comments while PRESERVING line numbers, so a violation reports a line you can jump to.
function strippedLines(source: string): string[] {
  let inBlock = false;
  return source.split("\n").map((raw) => {
    let out = raw;
    if (inBlock) {
      const end = out.indexOf("*/");
      if (end === -1) return "";
      out = out.slice(end + 2);
      inBlock = false;
    }
    const blockStart = out.indexOf("/*");
    if (blockStart !== -1) {
      const end = out.indexOf("*/", blockStart + 2);
      if (end === -1) {
        inBlock = true;
        out = out.slice(0, blockStart);
      } else {
        out = out.slice(0, blockStart) + out.slice(end + 2);
      }
    }
    const lineComment = out.indexOf("//");
    return lineComment === -1 ? out : out.slice(0, lineComment);
  });
}

function callsIn(file: string, lines: string[]): TransactionCall[] {
  const names = new Set<string>();
  for (const line of lines) {
    const declared = TRANSACTION_DECLARATION.exec(line);
    if (declared !== null) names.add(declared[1] as string);
  }
  const calls: TransactionCall[] = [];
  lines.forEach((line, index) => {
    if (TRANSACTION_DECLARATION.test(line)) return; // the wrapper's own declaration, not a call
    for (const call of line.matchAll(CALL_SHAPE)) {
      if (!names.has(call[1] as string)) continue;
      calls.push({
        file,
        line: index + 1,
        text: line.trim(),
        immediate: call[2] === ".immediate",
      });
    }
  });
  return calls;
}

function transactionCallSites(): TransactionCall[] {
  return TRANSACTION_SOURCES.flatMap((file) =>
    callsIn(file, strippedLines(readFileSync(new URL(file, import.meta.url), "utf8"))),
  );
}

it("FL-077 round 2: every transaction in src/evidence is invoked as .immediate", () => {
  const calls = transactionCallSites();
  console.info(
    `transaction call sites scanned: ${calls.length} across ${TRANSACTION_SOURCES.length} files`,
  );
  // Positive control FIRST: a rename, an extraction or a broken regex would make the scan find
  // nothing, and an empty result must fail here rather than read as a clean pass. Floor is the
  // MEASURED surface (r3b finding 6): ratchets move WITH the surface they guard.
  // Round 2 note: this floor moved 19 -> 21 because the R5-F2 fix made two call sites VISIBLE that
  // the scan could not previously reach — queries.ts's wrappers used to escape the file unnamed.
  expect(calls.length).toBeGreaterThanOrEqual(21);
  // Second control, for the widened scope (B1): the file set is derived from the directory, so a
  // filter typo would silently shrink it back toward the three hand-typed names it replaced.
  expect(TRANSACTION_SOURCES.length).toBeGreaterThanOrEqual(20);
  expect(TRANSACTION_SOURCES).toContain("./migrations-v21.ts");
  const deferred = calls
    .filter((call) => !call.immediate)
    .map((call) => `${call.file}:${call.line}  ${call.text}`);
  expect(deferred).toEqual([]);
});

it("FL-077 round 2: every transaction wrapper is NAMED in the file that creates it", () => {
  // Two shapes are banned by this one rule, and both are deferred transactions the call-site pin
  // above cannot name (review R5-F2):
  //   `db.transaction(fn)(args)`      — built and invoked inline, never named at all.
  //   `return db.transaction(fn)`     — ESCAPES the file, so its call sites are somewhere this scan
  //                                     does not look, and one of them can invoke it deferred.
  // Naming the wrapper where it is created is what gives the call-site pin total reach.
  const offenders: string[] = [];
  let seen = 0;
  for (const file of TRANSACTION_SOURCES) {
    strippedLines(readFileSync(new URL(file, import.meta.url), "utf8")).forEach((line, index) => {
      if (!line.includes(".transaction(")) return;
      seen += 1;
      if (!TRANSACTION_DECLARATION.test(line))
        offenders.push(`${file}:${index + 1}  ${line.trim()}`);
    });
  }
  console.info(`db.transaction() declarations scanned: ${seen}`);
  expect(seen).toBeGreaterThanOrEqual(20);
  expect(offenders).toEqual([]);
});
