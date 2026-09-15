/**
 * @file scripts/clean-dist.mjs
 * @purpose Remove the generated TypeScript output before every production build so deleted or renamed source
 *   modules cannot survive in a packaged sidecar as stale executable JavaScript.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await rm(path.join(repoRoot, "dist"), { force: true, recursive: true });
