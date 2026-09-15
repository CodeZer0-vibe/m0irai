/**
 * @file src/evidence/migrations-v21.ts
 * @purpose SQL + one-shot applier for the lazy v15→v21 file-projection step: journal_entry_files mirrors
 *   journal_entries.touched_files as normalized (entry_id, file_key) rows so exact-file recall is an indexed
 *   lookup over ALL rows instead of a 5,000-row JSON scan. Applied ONLY inside applyMemoryMigration's
 *   transaction, behind a version-21 + physical-BODY probe, so the backfill runs ONCE and steady-state
 *   opens stay read-only (FL-077); a drifted DB repairs in-tier on its next memory open.
 * @exports MIGRATION_V15_TO_V21, applyFileProjectionStep, FileProjectionStepResult, fileProjectionObjectsPresent
 * @depends ./db
 *
 * The probe reads BODIES, not just names: round 4 found the version row alone missed DROPPED objects
 * (codex r1-C), and the rebase round found (type, name) matching missed ALTERED ones (review R4-F1).
 *
 * WHAT THE INDEX IS WORTH — measured on this branch, not quoted from the research doc (numbers re-measured
 * in round 3 on this machine, 2026-08-24; every run quoted in m4-report ROUND 3): the one-key read that
 * DRIVES idx_journal_entry_files_lookup runs 0.108 ms p50 through the real seam at 100,000 rows, where the
 * JSON scan it replaces still runs 17.373 ms p50 AND misses the target fact entirely (rows=0 — it sits
 * outside the scan's 5,000-row window). The index only earns that if the READ drives from it: round 1
 * shipped a journal-first shape that never opened this index and measured 74.585 ms p50 at 100,000 rows.
 * The query plans are pinned in src/memory/journal-store.test.ts — one statement for EVERY requested-key
 * count since round 4 (run once per key, merged newest-first in JS; see journal-store.ts ROUND 4) — so the
 * shape cannot regress silently.
 *
 * SKIPPED ROWS ARE NEVER RE-EXAMINED. The backfill is one-shot behind the version-21 probe, so a row whose
 * touched_files is not a JSON array is projected on this open or never — no later open looks at it again.
 * The count comes back to applyMemoryMigration, which logs it at debug level; that sink reaches no disk in
 * the packaged app (see the FL-150 note in migrations.ts), so the number is an observation for whoever is
 * watching stderr at migration time, NOT a durable record. Recovering such rows needs a maintenance pass
 * that re-projects them — a named follow-up, not a silent repair, and not a new table (schema.sql is
 * frozen). Measured on a copy of the operator's real database, 2026-08-23: 44 journal rows, 1 with
 * touched_files NOT NULL, 0 malformed — nothing is being lost there today.
 *
 * WRITE PATH (M4 engineering call): an AFTER INSERT trigger owns the invariant — every insert path into
 * journal_entries lands its projection rows in the SAME statement transaction, so journal row + projection
 * commit or roll back together with zero changes to appendEntry's autocommit retry unit. The research doc's
 * own boundary blesses triggers for exactly this ("local projection synchronization"). ROUND 4 (codex r1-B)
 * closes the other write: retiring an entry (superseded_by, the ONLY column ever UPDATEd — journal-store.ts
 * supersede) now DELETES that entry's projection rows in the same transaction, so a retired history stops
 * existing in the projection at all. Before this, every superseded match stayed projected and the read had
 * to join-and-reject each one before LIMIT could see an active row — measured 145.366 ms vs 0.078 ms cold
 * on one hot key carrying 100,000 retired rows (2026-08-25, codex's corpus shape, fresh tip build); the
 * WHERE guard alone cannot bound that walk. Symmetrically, the AFTER INSERT trigger and the backfill skip
 * rows BORN retired (NEW.superseded_by IS NOT NULL), so the projection invariant is "active entries only"
 * at every write; the read-side je.superseded_by IS NULL filter stays as the defense for rows written
 * before this migration ran, and the migration itself PURGES those legacy rows after the backfill, so an
 * upgraded DB starts clean too. One-way by design (J5 has no resurrection path):
 * setting superseded_by back to NULL does not re-project; recovery is a maintenance pass, like skipped
 * backfill rows.
 * HOSTILE INPUT: json_type('not json') THROWS (SQLite 3.53.1 probe), so the guard must never reach
 * json_type for a value json_valid has not already accepted. Round 1 wrote that as ONE WHEN clause —
 * `json_valid(COL) AND json_type(COL) = 'array'` — which is protected only by AND declining to evaluate
 * its right operand, and SQLite documents lazy evaluation for CASE, not for AND (review F2: grepping
 * "short.circuit" across lang_expr.html, quirks.html and optoverview.html returns exactly one hit, the
 * CASE paragraph). Round 2 NESTS the two tests so the protection is the documented one: json_type is
 * reached only from inside the branch json_valid already selected.
 * https://www.sqlite.org/lang_expr.html section 7 "The CASE expression": "each WHEN expression is
 * evaluated ... starting with the leftmost and continuing to the right. The result of the CASE expression
 * is the evaluation of the THEN expression that corresponds to the first WHEN expression that evaluates
 * to true" and "Both forms of the CASE expression use lazy, or short-circuit, evaluation."
 * Malformed / NULL / non-array values degrade to '[]' (zero projection rows), matching the old read edge
 * where parseTags treated them as null. This SQL is PERSISTED per database in sqlite_master (the trigger),
 * so editing the text below changes what NEW databases get while old ones keep the old body. That used to
 * be safe only because version 21 has never shipped; since the rebase round the body-drift probe closes it
 * properly — an existing object whose stored text no longer matches these constants is dropped and
 * rebuilt on the next memory open (R4-F1). Editing the text in place is therefore a supported correction
 * now, but it is NOT free: every memory-on database pays one rebuild-and-rebackfill on its next open.
 */
import type { Db } from "./db.js";

// The array guard appears three times (trigger, backfill, skip count) so all three agree on what counts
// as a projectable touched_files value, and all three get the NESTED shape: json_type THROWS on malformed
// input and only CASE branch evaluation is documented lazy (see the HOSTILE INPUT note in the header).
// json_each over '[]' yields zero rows, so a rejected value simply projects nothing.
function arrayGuard(column: string, whenArray: string, otherwise: string): string {
  return (
    `CASE WHEN json_valid(${column}) ` +
    `THEN CASE WHEN json_type(${column}) = 'array' THEN ${whenArray} ELSE ${otherwise} END ` +
    `ELSE ${otherwise} END`
  );
}
const TOUCHED_GUARD: string = arrayGuard("NEW.touched_files", "NEW.touched_files", "'[]'");
const STORED_GUARD: string = arrayGuard("e.touched_files", "e.touched_files", "'[]'");
// Same guard, different payload: 1 marks a row the backfill will skip, 0 one it will project.
const SKIPPABLE_GUARD: string = arrayGuard("touched_files", "0", "1");

// Each object's DDL is written WITHOUT `IF NOT EXISTS`, because that is EXACTLY the text SQLite stores
// back in sqlite_master.sql — measured on this build (better-sqlite3 12.10.0), where executing
// `CREATE TABLE IF NOT EXISTS journal_entry_files (\n  entry_id ...\n);` stores
// `"CREATE TABLE journal_entry_files (\n  entry_id ...\n)"`: the clause and the trailing semicolon are
// dropped and every other byte, newline and space included, survives. So these constants ARE the expected
// bodies the drift probe below compares against — no snapshot file, no scratch database, no parser. The
// executed form puts the clause back via {@link idempotent}.
const CREATE_PROJECTION_TABLE: string = `CREATE TABLE journal_entry_files (
  entry_id   TEXT NOT NULL REFERENCES journal_entries(entry_id),
  project_id TEXT NOT NULL,
  file_key   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (entry_id, file_key)
)`;
const CREATE_PROJECTION_INDEX: string = `CREATE INDEX idx_journal_entry_files_lookup
  ON journal_entry_files(project_id, file_key, seq DESC)`;
const CREATE_AFTER_INSERT_TRIGGER: string = `CREATE TRIGGER journal_entry_files_after_insert
AFTER INSERT ON journal_entries
WHEN NEW.superseded_by IS NULL
BEGIN
  INSERT OR IGNORE INTO journal_entry_files (entry_id, project_id, file_key, seq)
  SELECT NEW.entry_id, NEW.project_id, j.value, NEW.seq
  FROM json_each(${TOUCHED_GUARD}) j;
END`;
const CREATE_SUPERSEDE_CLEANUP_TRIGGER: string = `CREATE TRIGGER journal_entry_files_supersede_cleanup
AFTER UPDATE OF superseded_by ON journal_entries
WHEN NEW.superseded_by IS NOT NULL
BEGIN
  DELETE FROM journal_entry_files WHERE entry_id = NEW.entry_id;
END`;

const CREATE_OBJECT_KEYWORD = /^CREATE (TABLE|INDEX|TRIGGER) /;

/** The executable form of a stored-body constant: the same text with `IF NOT EXISTS` put back. */
function idempotent(ddl: string): string {
  return ddl.replace(CREATE_OBJECT_KEYWORD, "CREATE $1 IF NOT EXISTS ");
}

export const MIGRATION_V15_TO_V21: string = `
${idempotent(CREATE_PROJECTION_TABLE)};
${idempotent(CREATE_PROJECTION_INDEX)};
${idempotent(CREATE_AFTER_INSERT_TRIGGER)};
${idempotent(CREATE_SUPERSEDE_CLEANUP_TRIGGER)};
INSERT OR IGNORE INTO journal_entry_files (entry_id, project_id, file_key, seq)
SELECT e.entry_id, e.project_id, j.value, e.seq
FROM journal_entries e, json_each(${STORED_GUARD}) j
WHERE e.touched_files IS NOT NULL AND e.superseded_by IS NULL;
DELETE FROM journal_entry_files
WHERE entry_id IN (SELECT entry_id FROM journal_entries WHERE superseded_by IS NOT NULL);
INSERT OR IGNORE INTO _schema_version(version) VALUES (21);
`;

// Counted BEFORE the backfill so skipped rows surface in the applier's result instead of vanishing
// (a silent skip would look identical to "had no files"). Same proven CASE shape as the backfill.
const SKIPPED_SELECT: string = `SELECT COUNT(*) AS skipped FROM journal_entries WHERE touched_files IS NOT NULL AND ${SKIPPABLE_GUARD}`;

const PROJECTION_PROBE: string = "SELECT 1 FROM _schema_version WHERE version = 21 LIMIT 1";

// M4 ROUND 4 (codex r1-C): the version row alone cannot prove the step happened — a DB that lost a v21
// object (sculpted probe: DROP TRIGGER journal_entry_files_after_insert on an accepted {14,15,21} DB)
// read as fully migrated forever while appends projected nothing and recall silently missed them
// (DRIFT memoryComplete:true projectionRows:0 recalled:[], reproduced at tip 2026-08-25).
// M4 REBASE ROUND (review r4 finding R4-F1): matching on (type, name) alone closed only HALF of that —
// an object REPLACED by a same-name body of different text still read healthy, and `CREATE ... IF NOT
// EXISTS` cannot overwrite it, so codex's exact symptom (memoryComplete:true, projectionRows:0,
// recalled:[]) reproduced through an inert trigger of the right name. The footprint below therefore
// carries each object's EXPECTED BODY and the probe compares the stored text. chainReadiness shares the
// check so an open's read-only fast path cannot skip the repair.
interface ProjectionObject {
  /** sqlite_master.type — also the DROP keyword once upper-cased. */
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  /** The exact text SQLite stores for this object; see the constants above for why it matches. */
  readonly sql: string;
}
const PROJECTION_OBJECTS: readonly ProjectionObject[] = [
  { type: "table", name: "journal_entry_files", sql: CREATE_PROJECTION_TABLE },
  { type: "index", name: "idx_journal_entry_files_lookup", sql: CREATE_PROJECTION_INDEX },
  { type: "trigger", name: "journal_entry_files_after_insert", sql: CREATE_AFTER_INSERT_TRIGGER },
  {
    type: "trigger",
    name: "journal_entry_files_supersede_cleanup",
    sql: CREATE_SUPERSEDE_CLEANUP_TRIGGER,
  },
];
const PROJECTION_OBJECTS_PROBE: string = `SELECT type, name, sql FROM sqlite_master WHERE name IN (${PROJECTION_OBJECTS.map(
  () => "?",
).join(", ")})`;
const PROJECTION_OBJECT_NAMES: readonly string[] = PROJECTION_OBJECTS.map((object) => object.name);

interface StoredObjectRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/** Why an object counts as drifted. Carried out to the open path so the repair log can say WHY. */
type DriftReason = "missing" | "body-changed" | "wrong-type";

interface DriftedObject {
  readonly expected: ProjectionObject;
  readonly reason: DriftReason;
  /** The sqlite_master type actually occupying the name, when anything does. */
  readonly storedType?: string;
}

function classifyDrift(
  expected: ProjectionObject,
  row: StoredObjectRow | undefined,
): DriftedObject | undefined {
  if (row === undefined) return { expected, reason: "missing" };
  if (row.type !== expected.type) {
    return { expected, reason: "wrong-type", storedType: row.type };
  }
  if (row.sql !== expected.sql) {
    return { expected, reason: "body-changed", storedType: row.type };
  }
  return undefined;
}

/**
 * The v21 objects that are MISSING, occupied by a different TYPE, or carry a body other than the one
 * this module defines. Read-only — it is called from chainReadiness's no-writes steady-state probe, so
 * it may not write.
 *
 * @param db - an open evidence DB (any version; sqlite_master always exists)
 * @returns the drifted objects with the reason each one drifted, empty when the footprint matches exactly
 */
function driftedProjectionObjects(db: Db): DriftedObject[] {
  const rows = db
    .prepare(PROJECTION_OBJECTS_PROBE)
    .all(...PROJECTION_OBJECT_NAMES) as StoredObjectRow[];
  const stored = new Map(rows.map((row) => [row.name, row]));
  const drifted: DriftedObject[] = [];
  for (const expected of PROJECTION_OBJECTS) {
    const found = classifyDrift(expected, stored.get(expected.name));
    if (found !== undefined) drifted.push(found);
  }
  return drifted;
}

/** One drifted object as a line an operator can read: `trigger x (missing)`. */
function describeDrift(object: DriftedObject): string {
  const found =
    object.storedType !== undefined && object.storedType !== object.expected.type
      ? ` found ${object.storedType}`
      : "";
  return `${object.expected.type} ${object.expected.name} (${object.reason}${found})`;
}

/**
 * True when every v21 physical object exists in sqlite_master under the TYPE and with the BODY this
 * module defines — so all three drift kinds read as false: missing, wrong-type, and body-changed
 * (compile-time constant names and bodies — nothing is interpolated from data). Read-only, so it is safe
 * inside chainReadiness's no-writes steady-state probe.
 */
export function fileProjectionObjectsPresent(db: Db): boolean {
  return driftedProjectionObjects(db).length === 0;
}

// The DROP keyword for each sqlite_master type. An ALLOWLIST, not a case conversion, because the
// stored type is DATA read back from the database and this value is interpolated into SQL: an entry
// that is not in this map cannot reach the statement. Every value here is a compile-time constant.
const DROP_KEYWORD: Readonly<Record<string, string>> = {
  table: "TABLE",
  index: "INDEX",
  trigger: "TRIGGER",
  view: "VIEW",
};

/**
 * Drops the drifted objects so the migration body below can re-create them. `CREATE ... IF NOT EXISTS`
 * is a no-op against a same-name object, which is exactly why detection alone would have left an
 * altered body in place forever (R4-F1). Dropping the TABLE discards its rows, and that is safe by
 * construction: every projection row is derived from journal_entries, and the backfill three statements
 * later re-derives all of them.
 *
 * ROUND 2 (review R5-F4): the drop uses the type ACTUALLY stored, not the expected one. Dropping by the
 * expected type left one corner where the repair could not converge and the database became unopenable
 * memory-on: a v21 NAME occupied by an object of another kind. Measured on this build —
 * `DROP TABLE` over a VIEW throws "use DROP VIEW to delete view journal_entry_files", while
 * `DROP INDEX IF EXISTS` over a TABLE silently does nothing and the follow-on
 * `CREATE INDEX IF NOT EXISTS` then throws "there is already a table named
 * idx_journal_entry_files_lookup". Either way the tier rolled back, and because the offending object
 * stayed on disk EVERY later open failed identically. Reading the type back removes that corner, so the
 * module header's convergence claim holds without an exception.
 */
function dropDriftedObjects(db: Db, drifted: readonly DriftedObject[]): void {
  for (const object of drifted) {
    // A missing object has no stored type and nothing to drop; the expected keyword makes the
    // statement a harmless no-op under IF EXISTS.
    const keyword = DROP_KEYWORD[object.storedType ?? object.expected.type];
    if (keyword === undefined) {
      continue;
    }
    db.exec(`DROP ${keyword} IF EXISTS ${object.expected.name}`);
  }
}

const PROJECTION_TABLE_PROBE: string =
  "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'journal_entry_files'";

// 0 when the table does not exist yet, which is the intended pre-migration state — the "before" side of
// the written-row count has to work before CREATE TABLE has run.
function countProjectionRows(db: Db): number {
  const present = db.prepare(PROJECTION_TABLE_PROBE).get() as { c: number };
  if (present.c === 0) {
    return 0;
  }
  const rows = db.prepare("SELECT COUNT(*) AS c FROM journal_entry_files").get() as { c: number };
  return rows.c;
}

export interface FileProjectionStepResult {
  /** Projection rows this backfill WROTE — counted before/after, not read off the table total. */
  readonly backfilledRows: number;
  /** Rows whose touched_files could not be projected (malformed / non-array JSON) — skipped, counted. */
  readonly skippedRows: number;
  /**
   * The v21 objects this step DROPPED AND REBUILT, one readable line each, EMPTY on a clean first
   * migration. M4 rebase round 2 (review R5-F6): the headline repair this module exists for — a
   * dropped or body-drifted TRIGGER over an intact projection TABLE — writes ZERO rows, because the
   * backfill's INSERT OR IGNORE finds every row already there. Reporting only row counts made a
   * four-object schema rewrite under a writer lock completely silent. This is what the open path
   * logs so it stops being silent.
   */
  readonly repairedObjects: readonly string[];
  /**
   * Objects that were ALREADY STANDING under a v21 name on a database that had never reached version
   * 21, and were therefore DROPPED to make room. Round 3 (review R6-F3): the first-migration branch
   * suppresses the repair line, correctly for MISSING objects and wrongly for existing ones — the drop
   * is a destructive write and it was as silent as the repair R5-F6 fixed. Kept separate from
   * repairedObjects because it is a different fact: not "your schema drifted and I restored it" but
   * "something was standing where v21 goes and I removed it".
   */
  readonly displacedObjects: readonly string[];
}

const STEADY_STATE: FileProjectionStepResult = {
  backfilledRows: 0,
  skippedRows: 0,
  repairedObjects: [],
  displacedObjects: [],
};

/**
 * Applies the v21 file-projection step behind its version + PHYSICAL-BODY probe. MUST run inside
 * applyMemoryMigration's BEGIN IMMEDIATE transaction (the probes and every write share it); a throw rolls
 * the whole memory segment — v15 tables included — back to the prior schema. Idempotent: version 21
 * present AND every footprint object intact means the steady state performs ZERO writes. Version present
 * but an object missing, occupied by another TYPE, or carrying a different body (drift — codex r1-C,
 * then R4-F1, then R5-F4) re-runs the body as a REPAIR-IN-TIER: the drifted objects are dropped first
 * BY THEIR STORED TYPE (IF NOT EXISTS cannot replace a same-name object, and the wrong DROP keyword
 * cannot remove one), the CREATEs rebuild all four, INSERT OR IGNORE re-backfills from journal_entries,
 * and the retired-row purge re-cleans — all inside this one transaction. The repair CONVERGES for all
 * three drift kinds: afterwards the stored bodies equal the constants, so the next readiness read is
 * true and the next open writes nothing.
 */
export function applyFileProjectionStep(db: Db): FileProjectionStepResult {
  const projected = db.prepare(PROJECTION_PROBE).get();
  const drifted = driftedProjectionObjects(db);
  if (projected !== undefined && drifted.length === 0) {
    return STEADY_STATE;
  }
  const skipped = db.prepare(SKIPPED_SELECT).get() as { skipped: number };
  // A REPAIR is a drift found on a database that already carries version 21. On a first migration the
  // same objects are "missing" and nothing is being repaired — that is just the step doing its job, and
  // calling it a repair in the log would cry wolf on every fresh database.
  const repairedObjects = projected === undefined ? [] : drifted.map(describeDrift);
  // ROUND 3 (review R6-F3, reported unconfirmed and CONFIRMED by building it). The branch above is
  // right about MISSING objects and wrong about existing ones: something already occupying a v21 name
  // on a pre-v21 database is DROPPED by the next line. Probe — a hand-made
  // `journal_entry_files (mine TEXT)` holding a row on a {14,15} database came back as v21's four
  // columns with nothing whatsoever in the log.
  const displacedObjects =
    projected === undefined
      ? drifted.filter((object) => object.reason !== "missing").map(describeDrift)
      : [];
  dropDriftedObjects(db, drifted);
  // Counted AFTER the drop and before the backfill, not off the table total: the drop may have taken the
  // table with it, and this number must be the rows THIS backfill wrote, never rows it inherited.
  const before = countProjectionRows(db);
  db.exec(MIGRATION_V15_TO_V21);
  return {
    backfilledRows: countProjectionRows(db) - before,
    skippedRows: skipped.skipped,
    repairedObjects,
    displacedObjects,
  };
}
