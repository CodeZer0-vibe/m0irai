// FL-077 round 3 (codex finding 2) — THE VERSION KEY IS ONLY AS TRUSTWORTHY AS ITS STORAGE CLASS.
//
// The old reader did `rows.map((row) => row.version).join(",")` with no validation, so ONE text
// row "14,15" in a sculpted `_schema_version(version TEXT)` impersonated the accepted {14,15} set:
// every opener skipped both migration chains and passed the final assertion on a database with no
// tables at all. The strict reader reads each row WITH SQLite's typeof(version), requires storage
// class `integer` AND a safe JS integer, and throws EvidenceSchemaDrift BEFORE any migration write.
// These tests pin that at the public seam: sculpt the table, reopen, expect the throw.
//
// HOW THE THROW'S POSITION IS PINNED (r3b finding 7): end-state assertions alone cannot tell
// "threw before any write" from "wrote the whole chain, then rolled back" — whole-tier rollback
// restores exactly the one-table state those assertions check (the NULL and BLOB cases stayed
// green under the stripped-reader mutation for precisely this reason). So expectStorageClassDrift
// instruments the opener with a prototype-seam counter over prepare/exec (same classifier the race
// proof uses) and asserts ZERO write-class statements ran: the strict reader sits in the UNLOCKED
// readiness read, before runGlobalTier can begin its first transaction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import { type Db, closeDb, openDb, openMemoryDb } from "./db.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  }
});

function tempDbPath(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-schema-version-storage-"));
  return join(root, "evidence.db");
}

type SculptValue = string | number | null | Uint8Array;

// Builds a database whose ONLY object is a `_schema_version` table declared with the given
// column affinity, holding exactly one row of the given value. `TEXT`/no-affinity declarations
// are required for the non-integer cases: an INTEGER PRIMARY KEY column is the rowid alias and
// SQLite refuses non-integer storage in it outright (SQLITE_MISMATCH).
function sculptVersionTable(dbPath: string, declaration: string, value: SculptValue): void {
  const sculptor = new Database(dbPath);
  try {
    sculptor.exec(`CREATE TABLE _schema_version (${declaration})`);
    if (value === null) {
      sculptor.exec("INSERT INTO _schema_version(version) VALUES (NULL)");
    } else if (value instanceof Uint8Array) {
      sculptor.prepare("INSERT INTO _schema_version(version) VALUES (?)").run(value);
    } else {
      sculptor.prepare("INSERT INTO _schema_version(version) VALUES (?)").run(value);
    }
  } finally {
    sculptor.close();
  }
}

function tableNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function rawStorageClasses(dbPath: string): Array<{ version: unknown; t: string }> {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare("SELECT version, typeof(version) AS t FROM _schema_version ORDER BY rowid")
      .all() as Array<{ version: unknown; t: string }>;
  } finally {
    raw.close();
  }
}

// A write-class statement is anything whose FIRST token is not a read, a pragma, or transaction
// control (better-sqlite3's internal BEGIN/COMMIT/SAVEPOINT come through prepare and are
// excluded explicitly — same classifier the race proof uses).
const NON_WRITE_PREFIXES = /^(SELECT|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i;

const ORIGINAL_PREPARE_DESCRIPTOR = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
const ORIGINAL_EXEC_DESCRIPTOR = Object.getOwnPropertyDescriptor(Database.prototype, "exec");

interface OpenerWriteTrace {
  /** Every write-class statement executed while installed, in order. */
  readonly statements: string[];
  /** Restores the pristine prototypes; must run before any later assertion can throw. */
  stop(): void;
}

// Counts write-class statements issued through Database.prototype prepare/exec while installed,
// scoped strictly around ONE opener call so the sculptor/probe helpers stay outside the window.
// Instance-level patching silently no-ops on better-sqlite3 (methods are defined non-writable),
// so this lives on the PROTOTYPE exactly like the race proof's seams.
function traceOpenerWrites(): OpenerWriteTrace {
  const statements: string[] = [];
  const record = (sql: unknown): void => {
    if (typeof sql === "string" && !NON_WRITE_PREFIXES.test(sql.trim())) {
      statements.push(sql);
    }
  };
  const patches: Array<readonly [string, PropertyDescriptor | undefined]> = [
    ["prepare", ORIGINAL_PREPARE_DESCRIPTOR],
    ["exec", ORIGINAL_EXEC_DESCRIPTOR],
  ];
  for (const [method, descriptor] of patches) {
    if (descriptor?.value === undefined) {
      throw new Error(
        `Database.prototype.${method} not found — the write tracer cannot be installed safely`,
      );
    }
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(Database.prototype, method, {
      value: function traced(this: Database.Database, ...args: unknown[]) {
        record(args[0]);
        return original.apply(this, args);
      },
      writable: true,
      configurable: true,
    });
  }
  return {
    statements,
    stop(): void {
      if (ORIGINAL_PREPARE_DESCRIPTOR !== undefined) {
        Object.defineProperty(Database.prototype, "prepare", ORIGINAL_PREPARE_DESCRIPTOR);
      }
      if (ORIGINAL_EXEC_DESCRIPTOR !== undefined) {
        Object.defineProperty(Database.prototype, "exec", ORIGINAL_EXEC_DESCRIPTOR);
      }
    },
  };
}

// Shared shape: the opener must execute ZERO write-class statements before drifting (the strict
// reader sits in the UNLOCKED readiness read, before any tier transaction), then throw
// EvidenceSchemaDrift (as ConfigError), leaving nothing but the sculpted _schema_version table.
// The zero-writes pin is what distinguishes "threw before any write" from "wrote the whole chain,
// then rolled back" — whole-tier rollback restores the one-table end state either way (r3b
// finding 7).
function expectStorageClassDrift(dbPath: string, opener: typeof openDb): void {
  const surface = traceOpenerWrites();
  let opened: Db | undefined;
  let threw: unknown;
  try {
    opened = opener(dbPath);
  } catch (err) {
    threw = err;
  } finally {
    surface.stop();
  }
  // If a mutation ever lets the opener succeed, close the returned handle immediately so
  // afterEach can still delete the temp directory on Windows instead of dying behind an open
  // file handle.
  if (opened !== undefined) closeDb(opened);

  expect(surface.statements).toEqual([]);
  expect(threw).toBeInstanceOf(ConfigError);
  expect((threw as ConfigError).message).toMatch(/SCHEMA_DRIFT/);
  expect((threw as ConfigError).code).toBe("ZER0_EVIDENCE_SCHEMA_DRIFT");

  const probe = new Database(dbPath);
  try {
    // Positive control FIRST: the sculpted table must be readable, or an empty result below
    // would mean a broken probe rather than an unmigrated database.
    const classes = probe
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'")
      .get() as { c: number };
    expect(classes.c).toBeGreaterThanOrEqual(1);
    expect(tableNames(probe)).toEqual(["_schema_version"]);
  } finally {
    probe.close();
  }
}

it("a TEXT row '14,15' impersonating the accepted memory set throws EvidenceSchemaDrift before any write", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version TEXT", "14,15");
  expect(rawStorageClasses(dbPath)).toEqual([{ version: "14,15", t: "text" }]);
  expectStorageClassDrift(dbPath, openDb);
});

it("the same TEXT spoof does not let openMemoryDb skip both chains either", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version TEXT", "14,15");
  expectStorageClassDrift(dbPath, openMemoryDb);
});

it("an integral REAL version (14.0) throws EvidenceSchemaDrift", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version BLOB", 14.0); // BLOB affinity keeps REAL storage class
  expect(rawStorageClasses(dbPath)).toEqual([{ version: 14, t: "real" }]);
  expectStorageClassDrift(dbPath, openDb);
});

it("a NULL version row throws EvidenceSchemaDrift", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version BLOB", null);
  expect(rawStorageClasses(dbPath)).toEqual([{ version: null, t: "null" }]);
  expectStorageClassDrift(dbPath, openDb);
});

it("a BLOB version row throws EvidenceSchemaDrift", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version BLOB", new Uint8Array([14]));
  expect(rawStorageClasses(dbPath)).toEqual([{ version: Buffer.from([14]), t: "blob" }]);
  expectStorageClassDrift(dbPath, openDb);
});

it("a delimiter-bearing digit TEXT row ('14') throws EvidenceSchemaDrift like its multi-row cousin", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version TEXT", "14");
  expect(rawStorageClasses(dbPath)).toEqual([{ version: "14", t: "text" }]);
  expectStorageClassDrift(dbPath, openDb);
});

// The honest-datatype case on the NATURAL table shape: integer storage, safe value, but not an
// accepted set — drift as always, and the failed tier leaves the entry state untouched instead
// of committing a hybrid {14,99} set behind the caller's back.
it("integer version 99 on the natural table still drifts, and rolls back to the entry set", () => {
  const dbPath = tempDbPath();
  sculptVersionTable(dbPath, "version INTEGER PRIMARY KEY", 99);

  let threw: unknown;
  try {
    openDb(dbPath);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(ConfigError);
  expect((threw as ConfigError).message).toMatch(/SCHEMA_DRIFT/);

  const raw = new Database(dbPath);
  try {
    const versions = raw
      .prepare("SELECT version FROM _schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual([99]);
  } finally {
    raw.close();
  }
});
