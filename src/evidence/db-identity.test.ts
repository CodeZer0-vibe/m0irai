// W4-R3a RA-1: the identity primitive every conversation-message writer now compares through
// (persistenceOwnerFor). Its end-to-end effect is falsified in evidence-db-identity.test.ts; these pin the
// properties that make it correct rather than merely convenient — most importantly that a db file which
// does NOT EXIST YET still gets a stable identity, since the very first write to a fresh
// `.zer0/evidence.db` must compare equal to the second or the leak simply reappears on day one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { canonicalDbIdentity } from "./db-identity.js";

const dirs: string[] = [];
let savedCwd: string | undefined;

afterEach(() => {
  if (savedCwd !== undefined) {
    process.chdir(savedCwd);
    savedCwd = undefined;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "db-identity-"));
  dirs.push(dir);
  return dir;
}

it("a relative and an absolute spelling of the SAME EXISTING file share one identity", () => {
  const root = tempDir();
  const dbPath = path.join(root, "evidence.db");
  writeFileSync(dbPath, "");
  savedCwd = process.cwd();
  process.chdir(root);

  expect(canonicalDbIdentity("evidence.db")).toBe(canonicalDbIdentity(dbPath));
  expect(canonicalDbIdentity("./evidence.db")).toBe(canonicalDbIdentity(dbPath));
  expect(canonicalDbIdentity(path.join(".", "sub", "..", "evidence.db"))).toBe(
    canonicalDbIdentity(dbPath),
  );
});

it("a file that does NOT EXIST YET still gets a stable identity (the first write to a fresh store)", () => {
  const root = tempDir();
  mkdirSync(path.join(root, ".zer0"), { recursive: true });
  const dbPath = path.join(root, ".zer0", "evidence.db"); // deliberately not created
  savedCwd = process.cwd();
  process.chdir(root);

  const viaRelative = canonicalDbIdentity(path.join(".zer0", "evidence.db"));
  expect(viaRelative).toBe(canonicalDbIdentity(dbPath));
  expect(viaRelative.length).toBeGreaterThan(0);
  // Identity is computed, never created — asking must not materialise the store.
  expect(canonicalDbIdentity(dbPath)).toBe(viaRelative);
});

it("a whole missing subtree resolves too — identity never depends on a directory existing", () => {
  const root = tempDir();
  const deep = path.join(root, "does", "not", "exist", "evidence.db");
  // The existing ancestor is realpath'd and the missing segments are re-joined BENEATH it, in order —
  // so the identity is a real absolute path, not a truncation at the deepest thing that happened to exist.
  const identity = canonicalDbIdentity(deep);
  expect(path.isAbsolute(identity)).toBe(true);
  expect(identity.endsWith(path.join("does", "not", "exist", "evidence.db"))).toBe(true);
  expect(identity).toBe(canonicalDbIdentity(deep)); // and it is stable across calls
});

it("two genuinely different files never collide", () => {
  const root = tempDir();
  expect(canonicalDbIdentity(path.join(root, "a.db"))).not.toBe(
    canonicalDbIdentity(path.join(root, "b.db")),
  );
});

it.runIf(process.platform === "win32")(
  "case differences are one identity on win32, where the filesystem itself is case-insensitive",
  () => {
    const root = tempDir();
    const dbPath = path.join(root, "Evidence.DB");
    writeFileSync(dbPath, "");
    expect(canonicalDbIdentity(dbPath.toUpperCase())).toBe(canonicalDbIdentity(dbPath));
    expect(canonicalDbIdentity(dbPath.toLowerCase())).toBe(canonicalDbIdentity(dbPath));
  },
);
