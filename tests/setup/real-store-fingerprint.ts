/**
 * @file tests/setup/real-store-fingerprint.ts
 * @purpose W4-R3a C1/RA-4: a LOGICAL, WAL-safe fingerprint of a checkout's REAL durable stores — the
 *   evidence DB's row content plus the `.zer0/blobs` and `.council/runs` trees — so the suite can prove
 *   it never wrote to any of them. Deliberately NOT a byte hash of the .db file: WAL mode moves committed
 *   bytes between the main file and `-wal` on any reader's whim (a passive checkpoint on the operator's
 *   own cockpit close, page reuse after a VACUUM), so a byte compare flakes RED on a DB nothing wrote to.
 *   Reads only: the DB is opened READONLY and is never checkpointed, migrated, or otherwise mutated to
 *   measure it (guarding the dogfood store must not damage the dogfood store).
 * @exports StoreFingerprint, fingerprintRealStore, describeFingerprintDrift
 * @depends node:crypto, node:fs, node:path, better-sqlite3
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** The three durable surfaces a stray test write lands in. `absent` when the checkout has none yet. */
export interface StoreFingerprint {
  readonly db: string;
  readonly blobs: string;
  readonly councilRuns: string;
}

const ABSENT: string = "absent";
const UNREADABLE_PREFIX: string = "unreadable:";
// A 128-bit accumulator: per-row digests are SUMMED (order-independent, so no ORDER BY is needed for a
// stable value across page layouts) rather than XOR'd — XOR would let two byte-identical rows cancel out.
const ACC_MASK: bigint = (1n << 128n) - 1n;
const ROW_DIGEST_HEX_CHARS: number = 32;
const TABLE_SQL: string =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/**
 * Fingerprints the real stores under `repoRoot`. Never throws: an unreadable surface fingerprints as a
 * stable `unreadable:<reason>` marker, so the guard reports a real change rather than exploding a run.
 */
export function fingerprintRealStore(repoRoot: string, dbPath: string): StoreFingerprint {
  return {
    db: fingerprintDb(path.resolve(repoRoot, dbPath)),
    blobs: fingerprintTree(path.join(repoRoot, ".zer0", "blobs")),
    councilRuns: fingerprintTree(path.join(repoRoot, ".council", "runs")),
  };
}

/** Human-readable list of which surfaces moved, or an empty array when the stores are untouched. */
export function describeFingerprintDrift(
  before: StoreFingerprint,
  after: StoreFingerprint,
): readonly string[] {
  const surfaces: readonly (keyof StoreFingerprint)[] = ["db", "blobs", "councilRuns"];
  return surfaces
    .filter((surface) => before[surface] !== after[surface])
    .map((surface) => `${surface}: ${before[surface]} -> ${after[surface]}`);
}

function fingerprintDb(absoluteDbPath: string): string {
  if (!existsSync(absoluteDbPath)) {
    return ABSENT;
  }
  let handle: Database.Database | undefined;
  try {
    // readonly + fileMustExist: no schema application, no migration, no checkpoint — this opener must
    // never be src/evidence/db.ts's openDb, which would MIGRATE the store it is supposed to observe.
    const db = new Database(absoluteDbPath, { readonly: true, fileMustExist: true });
    handle = db;
    const tables = (db.prepare(TABLE_SQL).all() as { readonly name: string }[]).map((r) => r.name);
    const perTable = tables.map((table) => `${table}=${tableDigest(db, table)}`);
    return createHash("sha256").update(perTable.join("\n")).digest("hex");
  } catch (error) {
    return `${UNREADABLE_PREFIX}${error instanceof Error ? error.message : String(error)}`;
  } finally {
    handle?.close();
  }
}

// Streams the table (iterate, not all) so a multi-hundred-MB store never materialises in memory.
function tableDigest(db: Database.Database, table: string): string {
  const statement = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`);
  let accumulator = 0n;
  let rows = 0;
  for (const row of statement.iterate() as IterableIterator<Record<string, unknown>>) {
    const digest = createHash("sha256")
      .update(serializeRow(row))
      .digest("hex")
      .slice(0, ROW_DIGEST_HEX_CHARS);
    accumulator = (accumulator + BigInt(`0x${digest}`)) & ACC_MASK;
    rows += 1;
  }
  return `${String(rows)}:${accumulator.toString(16)}`;
}

// Column order is stable for one table, so entry order needs no sort; BLOB columns arrive as Buffers,
// which JSON.stringify renders as a byte array — bulky but hashed immediately and never retained.
function serializeRow(row: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(row));
}

// path + size per file, sorted: catches a created file, a removed one, and any change in length. A blob
// store is content-addressed (a new body IS a new path), and a `.council/runs` write always grows or adds.
function fingerprintTree(root: string): string {
  if (!existsSync(root)) {
    return ABSENT;
  }
  try {
    const entries = collectTreeEntries(root, root);
    entries.sort();
    return createHash("sha256").update(entries.join("\n")).digest("hex");
  } catch (error) {
    return `${UNREADABLE_PREFIX}${error instanceof Error ? error.message : String(error)}`;
  }
}

function collectTreeEntries(root: string, dir: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectTreeEntries(root, full));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    collected.push(`${path.relative(root, full).replaceAll("\\", "/")}:${String(sizeOf(full))}`);
  }
  return collected;
}

// A file that vanished between readdir and stat (a concurrent cockpit's temp file) is reported as a
// stable marker rather than throwing the whole fingerprint away.
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}
