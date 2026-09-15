/**
 * @file src/chat/statusline-emit.cjs
 * @purpose The command claude's statusLine runs: read the status JSON from stdin and write it
 *   ATOMICALLY (temp + rename) to the path given as argv[2], so a concurrent post-turn read never
 *   sees a torn file. Dependency-free CommonJS — claude invokes it as `node statusline-emit.cjs <path>`.
 *   Prints a short marker so claude has a status line to show.
 * @exports (none — executable script)
 * @depends node:fs, node:path
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const target = process.argv[2];
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  if (typeof target === "string" && target.length > 0 && data.length > 0) {
    const tmp = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target); // atomic on same volume; replaces any prior payload
    } catch (error) {
      recordWriteFailure(target, error);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* leave no torn temp; ignore */
      }
    }
  }
  process.stdout.write("ctx");
});

function recordWriteFailure(targetPath, error) {
  const payload = {
    kind: "statusline-emit.write-failed",
    path: targetPath,
    reason: error instanceof Error ? error.message : String(error),
    ts: new Date().toISOString(),
  };
  for (const dir of debugDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "statusline-failures.ndjson"),
        `${JSON.stringify(payload)}\n`,
      );
      return;
    } catch {
      /* try fallback */
    }
  }
}

function debugDirs() {
  const configured = process.env.ZER0_STATUSLINE_DIR;
  const fallback = path.join(os.tmpdir(), "zer0-statusline");
  return configured && configured.length > 0 && configured !== fallback
    ? [configured, fallback]
    : [fallback];
}
