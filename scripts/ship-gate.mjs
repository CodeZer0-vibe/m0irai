/**
 * @file scripts/ship-gate.mjs
 * @purpose `npm run ship:gate` — fail-closed pre-push gate (plan v5 §5). Passes only when: the worktree is clean
 *   (no unstaged/untracked drift), the oracle registration matches the oracle on disk, and HEAD's tree has a GREEN
 *   external verification receipt (`npm run verify:staged` was run on exactly this tree). Release/acceptance receipts
 *   naming the current tree are added in Phase 6/7. The push itself remains a separate, operator-authorized action.
 * @exports shipGate
 * @depends node:child_process, node:path, node:url, ./gate-oracle-registration, ./verify-staged
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOracleRegistration } from "./gate-oracle-registration.mjs";
import { assertHeadReceipt } from "./verify-staged.mjs";

export function shipGate(root = process.cwd()) {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status.trim().length > 0) throw new Error(`SHIP GATE FAIL: worktree not clean:\n${status}`);
  const oracle = checkOracleRegistration(root);
  const { tree } = assertHeadReceipt(root);
  return { ok: true, tree, oracleSha: oracle.sha256 };
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    const r = shipGate(process.cwd());
    process.stdout.write(
      `ship gate PASSED for HEAD tree ${r.tree} (oracle ${r.oracleSha.slice(0, 12)}…) — push may proceed\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
