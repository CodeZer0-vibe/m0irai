/**
 * @file tests/helpers/mint-seq-child.mts
 * @purpose Child-process half of the T5 acceptance-10 two-process test: opens the SAME evidence DB file
 *   as the parent (a genuinely separate OS process + sqlite connection) and mints one ledger seq through
 *   the REAL mintSeq — proving seq allocation is open to a second cockpit (F-16) across process
 *   boundaries, not just across connections. argv[2] = db path, argv[3] = message id.
 * @exports (none — script)
 * @depends ../../src/evidence/db, ../../src/memory/ledger
 */
import { closeDb, openLaneStateDb } from "../../src/evidence/db.js";
import { mintSeq } from "../../src/memory/ledger.js";

const dbPath = process.argv[2];
const messageId = process.argv[3];
if (dbPath === undefined || messageId === undefined) {
  console.error("usage: mint-seq-child <dbPath> <messageId>");
  process.exit(2);
}
const db = openLaneStateDb(dbPath);
try {
  const seq = mintSeq(db, "p1", messageId);
  process.stdout.write(`minted:${seq}\n`); // the parent test's assertion channel, not debug logging
} finally {
  closeDb(db);
}
