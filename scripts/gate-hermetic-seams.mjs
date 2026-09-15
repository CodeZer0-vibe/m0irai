#!/usr/bin/env node
/**
 * @file scripts/gate-hermetic-seams.mjs
 * @purpose Findings-become-gates (H1's readiness probe, FL-172's digest child; round 2 review confirmed
 *   the round-1 regex version could be defeated by an alias, a comment, or a cross-function guard — see
 *   B2/B3/I1/I2/I3 in the round-1 review). Parses every production TypeScript file under src/ (not
 *   `*.test.ts`, not `*.fixtures.ts`) with the TypeScript compiler API (`ts.createSourceFile`, per-file, no cross-file
 *   Program — the operating contract's routing rule: use the already-installed `typescript` devDependency
 *   rather than hand-roll a parser) and resolves, through local aliases (import specifiers incl. `as`,
 *   `const x = <resolved>`, a parameter default `= <resolved>`, and property access on a namespace import
 *   e.g. `cp.spawn`), every CallExpression whose callee traces to an export of `node:child_process` /
 *   `child_process` (spawn, spawnSync, execFile, execFileSync, fork, exec, execSync), `execa` (execa,
 *   execaSync, execaCommand, execaCommandSync, execaNode, plus `.command`/`.node`/`.sync`/`.commandSync`
 *   property calls on an `execa` binding), or `node-pty` (any `.spawn` property call on a namespace
 *   import). A seam is guarded only if a REAL CallExpression to `assertNotHermetic` — resolved through
 *   the SAME import-alias machinery as a spawn (N2, round 3: incl. `as` and namespace access; a
 *   same-named LOCAL function that never imports the guard's own module, `src/shared/hermetic.ts`, does
 *   NOT count) — exists in the seam's own function body or an ENCLOSING one (by lexical scope, computed
 *   from `.parent` pointers — never a sibling function) and appears earlier in the source than the seam —
 *   never a comment, a string, or textual proximity. Exemptions are keyed per FILE **and per COUNT**:
 *   `EXEMPT[file] = { reason, count }` — a file whose scanned seam count no longer equals `count`, in
 *   EITHER direction, fails by name, so an exempted file is never a blanket licence for a NEW unguarded
 *   seam added later (B2). Aliasing (both spawns and the guard) is resolved file-locally and
 *   FLOW-INSENSITIVELY (a fixed-point pass over the whole file, not per-branch control flow, and no CFG
 *   dominance analysis) — deliberately conservative in the safe direction: a guard call inside `if
 *   (false)`, an always-caught `try`, or a branch that never actually runs before the seam STILL counts
 *   as guarding it, and a coincidental same-named local that isn't really a spawn alias could over-flag
 *   and need an exemption — but a real spawn alias, or a real guard call reachable on SOME path, can
 *   never go undetected by scope. One dynamic-import shape IS resolved (round 3, N3): `const { execa:
 *   execaFn } = await import("execa")` — checked against the live tree first, NOT assumed theoretical:
 *   `src/chat/evidence.ts:475` uses exactly this shape and scanned as zero seams before the resolver was
 *   added (now EXEMPT, git-only, same reasoning as project-scope.ts). Accepted, named limits beyond that
 *   one shape (each because no production file in this tree uses it today — `git grep` reproduces each
 *   absence): a local re-export (`export { execa }` / `export { assertNotHermetic }` re-surfaced from
 *   another file), `require(...)` (this is an ESM-only codebase, gate-l5-mandates already assumes it), a
 *   non-awaited or `.then(...)`-chained dynamic import, a computed import specifier, an object-property
 *   alias (`const x = { run: execa }; x.run(...)`), an array destructure (`const [a] = [execa]`), and a
 *   default import (none of the three spawn modules nor the guard module has a default export). A future
 *   use of any of these needs either a real fix here or a documented exemption, not a silent pass.
 * @exports EXEMPT, findSeams, scanHermeticSeams, findOrphanedExemptions, listProductionFiles,
 *   checkHermeticSeams, MIN_FILES_CHECKED, MIN_SEAMS_SCANNED
 * @depends node:fs, node:path, node:url, typescript
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC_DIR = "src";
const SKIP_PARTS = new Set(["node_modules", "dist", ".zer0", ".agent-ci", ".git"]);
// N2: the guard is resolved through the same import-alias machinery as a spawn, never matched by bare
// identifier name — a local no-op `function assertNotHermetic(){}` must NOT satisfy it, and
// `import { assertNotHermetic as guard }` must. HERMETIC_MODULE is the repo-relative, extension-stripped
// path a relative import specifier must resolve to (`git grep -n "export function assertNotHermetic" src`
// -> src/shared/hermetic.ts, confirmed 2026-09-02).
const HERMETIC_MODULE = "src/shared/hermetic";
const GUARD_EXPORT = "assertNotHermetic";
export const MIN_FILES_CHECKED = 100; // measured 182 tracked src TS (gate-l5-mandates' own floor); a walk below this is broken, not a clean tree
export const MIN_SEAMS_SCANNED = 15; // measured 20 real call sites 2026-09-02, `node scripts/gate-hermetic-seams.mjs` printed count (N4: this comment must track that printed number, not a stale one — it drifted twice already: 19 after round 2's B3 rewrite, 20 again after round 3's N3 dynamic-import resolution added src/chat/evidence.ts:475); a scan below this is blind, not clean

// node:child_process / child_process spawning exports this gate treats as seams. `exec` and `execSync`
// are here because a property-access form (`cp.exec(`) was a documented false negative (round-1 I-list).
const CP_EXPORTS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "fork",
  "exec",
  "execSync",
]);
// execa's own spawning exports, plus its `.command`/`.node`/`.sync`/`.commandSync` call-chain forms.
const EXECA_EXPORTS = new Set([
  "execa",
  "execaSync",
  "execaCommand",
  "execaCommandSync",
  "execaNode",
]);
const EXECA_SUBCALLS = new Set(["command", "node", "sync", "commandSync"]);

/**
 * Every file the gate does NOT hold to the guard rule, each with the falsifiable reason it needs none,
 * AND the exact seam count the file must keep — a hit landing here without both is exactly the failure
 * this gate exists to catch (findings-become-gates, B2: an exemption is a licence for the SEAMS RECORDED,
 * never a blanket pass for whatever a file grows into later).
 */
export const EXEMPT = {
  // L2 round 2 (review I6): this entry used to sit on src/shared/kill-tree.ts and name taskkill alone,
  // which had gone stale — the seam had grown to four commands and, because the gate counts CALL SITES
  // rather than commands, it could not have noticed. The seam now lives in process-table.ts (kill-tree.ts
  // holds no child_process call at all any more), and the reason names every command it covers.
  "src/shared/process-table.ts": {
    count: 1,
    reason:
      "ONE execFile call site (runCommand) shared by taskkill, wmic, powershell and ps: it ENUMERATES or terminates processes through OS utilities by pid and never launches an agent CLI, so hermetic mode does not apply. A FIFTH command, or a second call site, must be re-justified here.",
  },
  "src/memory/project-scope.ts": {
    count: 1,
    reason:
      'execa("git", args, ...) (gitQuery) spawns git only, to resolve project identity; never an agent CLI.',
  },
  "src/chat/evidence.ts": {
    count: 1,
    reason:
      'execaFn("git", ["rev-parse", "HEAD"], ...) (headCommit) — the same git-only, never-an-agent-CLI shape as project-scope.ts\'s gitQuery, reached via `const { execa: execaFn } = await import("execa")` (round 3 N3: a live dynamic-import destructure, not a theoretical shape — this file scanned 0 seams before that resolution was added). Wrapped in a try/catch that returns undefined on any failure, never throws.',
  },
  "src/room/room-host-process.ts": {
    count: 1,
    reason:
      'declared test-support (scripts/gate-reachability.mjs DECLARED_TEST_SUPPORT: "spawns the real host for integration tests"): spawns THIS repo\'s own room-host entry under tsx for integration tests, never a third-party agent CLI; env is childEnvironment(options.env) = process.env + overrides, so a test that sets ZER0_HERMETIC passes it straight through by design — that IS the mechanism the oracle and integration suite rely on.',
  },
  "src/adapters/agy-mode-probe.ts": {
    count: 2,
    reason:
      'execa(agyExePath(), ...) (spawnWithRetry, x2) — agyExePath() (src/adapters/pty/agy-pty-spawn.ts:20) calls assertNotHermetic() as its FIRST statement, before returning a path or checking existsSync; JS evaluates a call argument before the outer call executes, so hermetic mode throws before execa ever runs. Checkable evidence: src/adapters/pty/agy-pty-spawn.test.ts\'s "agyExePath refuses under ZER0_HERMETIC=1 before it ever reaches LOCALAPPDATA/existsSync" test.',
  },
  "src/adapters/pty/agy-models-run.ts": {
    count: 1,
    reason:
      'pty.spawn(agyExePath(), ...) (runAgyModels) — same transitive guard as agy-mode-probe.ts (src/adapters/pty/agy-pty-spawn.ts:20), same checkable evidence (src/adapters/pty/agy-pty-spawn.test.ts). runAgyModels\' own try/catch resolves "" on the throw, its documented fail-soft path.',
  },
  "src/adapters/agy.ts": {
    count: 1,
    reason:
      'execa(agyExePath(), ...) (checkAgyHealth) — same transitive guard (src/adapters/pty/agy-pty-spawn.ts:20), same checkable evidence (src/adapters/pty/agy-pty-spawn.test.ts). checkAgyHealth\'s own try/catch turns the throw into {healthy:false, error:"...refusing to spawn..."}.',
  },
  "src/memory/digest-runner.ts": {
    count: 1,
    reason:
      "spawnImpl(process.execPath, [...argv], options) (createDetachedSpawn, line 219) forks THIS repo's OWN compiled digest-entry.js, never a third-party agent CLI. digestChildEnv() (line 113) deliberately forwards ZER0_HERMETIC through CHILD_PASSTHROUGH (line 104, comment cites FL-172) so the CHILD process's own inner seam (digest-extractor.ts's codexExec, which DOES call assertNotHermetic) refuses instead — guarding here would be double-guarding a spawn this file is supposed to make.",
  },
};

function relPosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function listProductionFilesFrom(dir, root, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_PARTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listProductionFilesFrom(full, root, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".fixtures.ts")) continue;
    out.push(relPosix(root, full));
  }
  return out;
}

/** Every production .ts file under src/ (repo-relative, forward-slashed), test and fixture files excluded. */
export function listProductionFiles(root = process.cwd()) {
  return listProductionFilesFrom(path.join(root, SRC_DIR), root, []).sort();
}

function normalizeModule(m) {
  return m === "node:child_process" ? "child_process" : m;
}

/** True if `{module, exportName}` names a spawn-shaped export this gate treats as a direct-call seam. */
function isSeamExport(module, exportName) {
  const mod = normalizeModule(module);
  if (mod === "child_process") return CP_EXPORTS.has(exportName);
  if (module === "execa") return EXECA_EXPORTS.has(exportName);
  return false;
}

/** True if `namespaceBinding.propName(...)` is a seam — a property call on a namespace-imported module. */
function isSeamNamespaceProperty(namespaceBinding, propName) {
  const mod = normalizeModule(namespaceBinding.module);
  if (mod === "child_process") return CP_EXPORTS.has(propName);
  if (namespaceBinding.module === "node-pty") return propName === "spawn";
  if (namespaceBinding.module === "execa")
    return EXECA_EXPORTS.has(propName) || EXECA_SUBCALLS.has(propName);
  return false;
}

/** Resolves a relative import specifier (`"../shared/hermetic.js"`) against the REPO-RELATIVE path of
 *  the file containing it, to a repo-relative, extension-stripped module path (`"src/shared/hermetic"`).
 *  Bare package specifiers (`"execa"`, `"node:child_process"`) are left untouched (returns undefined) —
 *  they resolve through node_modules, not this file's own directory, and none of them alias to the
 *  guard's module. */
function resolveRelativeSpecifier(fileRelPath, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const dir = path.posix.dirname(fileRelPath);
  const joined = path.posix.normalize(path.posix.join(dir, specifier));
  return joined.replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/, "");
}

/** Every import binding this file establishes from a spawn-relevant module (named incl. `as`, and
 *  namespace `import * as x`) OR from the guard's own module (N2: resolved the same way, through the
 *  relative specifier, never by bare identifier name — see resolveRelativeSpecifier). Default imports
 *  are not modeled — none of the three spawn modules, nor the guard module, are imported that way
 *  anywhere in this tree today. */
function collectImportBindings(sourceFile, fileRelPath) {
  const bindings = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const moduleName = stmt.moduleSpecifier.text;
    const resolvedModule = resolveRelativeSpecifier(fileRelPath, moduleName) ?? moduleName;
    const clause = stmt.importClause;
    if (!clause?.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, { module: resolvedModule, namespace: true });
      continue;
    }
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      const exportName = (element.propertyName ?? element.name).text;
      bindings.set(element.name.text, {
        module: moduleName,
        exportName,
        isSeam: isSeamExport(moduleName, exportName),
        isGuard: resolvedModule === HERMETIC_MODULE && exportName === GUARD_EXPORT,
      });
    }
  }
  return bindings;
}

/** The alias target for `namespaceBinding.propName` — a guard property (N2), a seam property, or
 *  undefined. Split out of resolveAliasTarget so that function stays under the complexity limit. */
function resolveNamespacePropertyAlias(namespaceBinding, propName) {
  if (namespaceBinding.module === HERMETIC_MODULE && propName === GUARD_EXPORT) {
    return { module: namespaceBinding.module, exportName: propName, isGuard: true };
  }
  if (!isSeamNamespaceProperty(namespaceBinding, propName)) return undefined;
  return { module: namespaceBinding.module, exportName: propName, isSeam: true };
}

/** Resolves one initializer expression (`const x = <expr>` / a parameter default) against the bindings
 *  known SO FAR, returning a new binding for the LHS name, or undefined if the expression is not
 *  resolvable to a spawn-relevant import. Handles a bare identifier alias and one level of property
 *  access on an already-known binding (covers `const x = execa;` and `const x = cp.spawn;` alike). */
function resolveAliasTarget(expr, bindings) {
  if (ts.isIdentifier(expr)) return bindings.get(expr.text);
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return undefined;
  const base = bindings.get(expr.expression.text);
  if (base === undefined) return undefined;
  const propName = expr.name.text;
  if (base.namespace) return resolveNamespacePropertyAlias(base, propName);
  if (base.exportName === "execa" && EXECA_SUBCALLS.has(propName)) {
    return { module: "execa", exportName: `execa.${propName}`, isSeam: true };
  }
  return undefined;
}

/** The string specifier of a dynamic `import("spec")` call, optionally `await`ed — undefined for anything
 *  else (a computed specifier, `.then(...)` chaining, no specifier at all). N3: this narrow shape is a
 *  REAL live case, not a theoretical one — `src/chat/evidence.ts:475`,
 *  `const { execa: execaFn } = await import("execa");`, was invisible to this gate before this was added
 *  (confirmed live: it scanned zero seams for that file). */
function dynamicImportSpecifier(expr) {
  const inner = ts.isAwaitExpression(expr) ? expr.expression : expr;
  if (!ts.isCallExpression(inner) || inner.expression.kind !== ts.SyntaxKind.ImportKeyword)
    return undefined;
  const arg = inner.arguments[0];
  return arg !== undefined && ts.isStringLiteral(arg) ? arg.text : undefined;
}

/** `const { execa: execaFn } = await import("execa");` — binds each destructured name exactly like a
 *  static named import would (same isSeam/isGuard resolution), for the one destructuring depth this
 *  shape uses in this tree today; a nested pattern element is skipped, not silently misread. */
function tryBindDynamicImportDestructure(node, bindings, fileRelPath) {
  if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return false;
  if (!ts.isObjectBindingPattern(node.name)) return false;
  const specifier = dynamicImportSpecifier(node.initializer);
  if (specifier === undefined) return false;
  const resolvedModule = resolveRelativeSpecifier(fileRelPath, specifier) ?? specifier;
  let changed = false;
  for (const element of node.name.elements) {
    if (!ts.isIdentifier(element.name)) continue; // a nested pattern element — not modeled, not guessed
    const localName = element.name.text;
    if (bindings.has(localName)) continue;
    const exportName =
      element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : localName;
    bindings.set(localName, {
      module: specifier,
      exportName,
      isSeam: isSeamExport(specifier, exportName),
      isGuard: resolvedModule === HERMETIC_MODULE && exportName === GUARD_EXPORT,
    });
    changed = true;
  }
  return changed;
}

/** Fixed-point pass: `const x = <resolvable>`, a parameter default `x = <resolvable>`, and a dynamic
 *  `await import(...)` destructure each add new bindings, file-wide (flow-insensitive on purpose — see
 *  @purpose). Bounded iteration count is a safety valve, not a real limit: a chain of aliases-of-aliases
 *  longer than 6 has never been seen here. */
function propagateAliasBindings(sourceFile, bindings, fileRelPath) {
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    const visit = (node) => {
      if (tryBindAlias(node, bindings)) changed = true;
      if (tryBindDynamicImportDestructure(node, bindings, fileRelPath)) changed = true;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!changed) break;
  }
}

/** `const x = <resolvable>` and a parameter default `x = <resolvable>` are the same shape once you have
 *  the LHS identifier and the initializer — this is that one shared path, pulled out so the tree walk
 *  above stays a simple dispatch (gate-clamps' complexity limit). Returns true iff it added a binding. */
function tryBindAlias(node, bindings) {
  const isAliasable =
    (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
    node.initializer !== undefined &&
    ts.isIdentifier(node.name);
  if (!isAliasable || bindings.has(node.name.text)) return false;
  const resolved = resolveAliasTarget(node.initializer, bindings);
  if (resolved === undefined) return false;
  bindings.set(node.name.text, resolved);
  return true;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** The nearest function-like ancestor of `node`, or the SourceFile if none encloses it (top-level scope). */
function nearestScope(node) {
  let cursor = node.parent;
  while (cursor !== undefined) {
    if (isFunctionLike(cursor)) return cursor;
    cursor = cursor.parent;
  }
  return node.getSourceFile();
}

/** [innermost enclosing scope, ..., outer scopes, SourceFile] — every scope a guard could sit in and
 *  still protect `node` (B3/I2: a guard in a SIBLING function is never in this chain). */
function scopeChain(node) {
  const chain = [];
  let scope = nearestScope(node);
  chain.push(scope);
  while (!ts.isSourceFile(scope)) {
    scope = nearestScope(scope);
    chain.push(scope);
  }
  return chain;
}

/** True if `callee.prop(...)` is a seam: either a property call on a namespace-imported module (e.g.
 *  `cp.spawn`, `pty.spawn`) or a `.command`/`.node`/`.sync`/`.commandSync` call on an `execa` value
 *  binding. `base` is the resolved binding for `callee`'s object expression, or undefined if unresolved. */
function isSeamPropertyCallee(base, propName) {
  if (base === undefined) return false;
  if (base.namespace === true) return isSeamNamespaceProperty(base, propName);
  return base.exportName === "execa" && EXECA_SUBCALLS.has(propName);
}

/** Classifies one CallExpression as the guard, a seam, or neither — pulled out of the tree walk so the
 *  walk itself stays a simple dispatch (gate-clamps' complexity limit). N2: the guard is recognized only
 *  through a resolved binding (`isGuard`), never by the bare identifier text `assertNotHermetic` — a
 *  local no-op function of that name does not resolve to one and is correctly not a guard. */
function classifyCall(node, bindings) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    const binding = bindings.get(callee.text);
    if (binding?.isGuard === true) return "guard";
    return binding?.isSeam === true ? "seam" : undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const base = bindings.get(callee.expression.text);
    if (
      base?.namespace === true &&
      base.module === HERMETIC_MODULE &&
      callee.name.text === GUARD_EXPORT
    )
      return "guard";
    return isSeamPropertyCallee(base, callee.name.text) ? "seam" : undefined;
  }
  return undefined;
}

/** Every CallExpression to a spawn-relevant seam and every CallExpression to the guard, each tagged with
 *  its own nearest enclosing scope (for guards) or full scope chain (for seams). */
function collectCalls(sourceFile, bindings) {
  const seams = [];
  const guards = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = classifyCall(node, bindings);
      if (kind === "guard")
        guards.push({ start: node.getStart(sourceFile), scope: nearestScope(node) });
      else if (kind === "seam") seams.push({ node, start: node.getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { seams, guards };
}

/** True if some guard call sits in `seam`'s own scope or an enclosing one, and appears earlier in the
 *  source than the seam (B3: real CallExpression, same-or-enclosing function body, never a sibling). */
function isGuarded(seam, guards) {
  const chain = scopeChain(seam.node);
  return guards.some((guard) => guard.start < seam.start && chain.includes(guard.scope));
}

/** Every seam call site in one file's text (1-based line, guarded flag), via the TypeScript AST — never
 *  a comment, a string, or a sibling function's guard (see @purpose). `fileName` is also the repo-relative
 *  path used to resolve relative import specifiers (round 3 N2/N3) — pass the real one for real files. */
export function findSeams(text, fileName = "file.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = collectImportBindings(sourceFile, fileName);
  propagateAliasBindings(sourceFile, bindings, fileName);
  const { seams, guards } = collectCalls(sourceFile, bindings);
  return seams.map((seam) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(seam.start);
    return { line: line + 1, guarded: isGuarded(seam, guards) };
  });
}

/**
 * The whole gate, over an injected `{ path: text }` file map so the sibling test never touches real disk.
 * Every seam in a non-exempt file must be guarded. An EXEMPT entry's `count` must equal the number of
 * seams actually found in that file — B2: a new seam in an exempted file, or a seam that disappeared,
 * both fail by name instead of silently passing through the old per-file license.
 */
export function scanHermeticSeams(files) {
  const unguarded = [];
  const exemptionMismatches = [];
  let seamsScanned = 0;
  const filesWithSeams = new Set();
  for (const [file, text] of Object.entries(files)) {
    const hits = findSeams(text, file);
    if (hits.length === 0) continue;
    filesWithSeams.add(file);
    seamsScanned += hits.length;
    const exempt = EXEMPT[file];
    if (exempt !== undefined) {
      if (hits.length !== exempt.count) {
        exemptionMismatches.push(
          `${file}: exemption recorded count=${String(exempt.count)}, found ${String(hits.length)} seam(s) at line(s) ${hits.map((h) => String(h.line)).join(",")}`,
        );
      }
      continue;
    }
    for (const hit of hits) {
      if (!hit.guarded) unguarded.push(`${file}:${String(hit.line)}`);
    }
  }
  const staleExemptions = Object.keys(EXEMPT).filter(
    (f) => Object.hasOwn(files, f) && !filesWithSeams.has(f),
  );
  return {
    ok: unguarded.length === 0 && staleExemptions.length === 0 && exemptionMismatches.length === 0,
    unguarded,
    staleExemptions,
    exemptionMismatches,
    seamsScanned,
    filesScanned: Object.keys(files).length,
  };
}

/** EXEMPT entries naming a path that is no longer a production file at all (deleted, renamed, or
 *  reclassified as *.test.ts/*.fixtures.ts) — distinct from scanHermeticSeams' staleExemptions, which
 *  needs the file's CONTENT and so only ever sees files the caller passed in. */
export function findOrphanedExemptions(presentFiles) {
  const present = new Set(presentFiles);
  return Object.keys(EXEMPT).filter((f) => !present.has(f));
}

function readAll(paths, root) {
  const out = {};
  for (const p of paths) out[p] = readFileSync(path.join(root, p), "utf8");
  return out;
}

export function checkHermeticSeams(root = process.cwd()) {
  const files = listProductionFiles(root);
  if (files.length < MIN_FILES_CHECKED) {
    throw new Error(
      `GATE FAIL hermetic-seams: only ${String(files.length)} src files scanned (< floor ${String(MIN_FILES_CHECKED)}) — broken file walk?`,
    );
  }
  const orphaned = findOrphanedExemptions(files);
  const result = scanHermeticSeams(readAll(files, root));
  if (result.seamsScanned < MIN_SEAMS_SCANNED) {
    throw new Error(
      `GATE FAIL hermetic-seams: only ${String(result.seamsScanned)} seam call(s) scanned (< floor ${String(MIN_SEAMS_SCANNED)}) — a checker that can pass on an empty match is not a checker.`,
    );
  }
  if (!result.ok || orphaned.length > 0) {
    const problems = [];
    if (result.unguarded.length > 0)
      problems.push(
        `unguarded agent-process spawn seam(s): ${String(result.unguarded.length)}\n  ${result.unguarded.join("\n  ")}`,
      );
    if (result.exemptionMismatches.length > 0)
      problems.push(
        `exemption count mismatch(es) (B2 — a new or removed seam in an exempted file): ${String(result.exemptionMismatches.length)}\n  ${result.exemptionMismatches.join("\n  ")}`,
      );
    if (result.staleExemptions.length > 0)
      problems.push(
        `stale EXEMPT entries (file exists but no matching seam found): ${String(result.staleExemptions.length)}\n  ${result.staleExemptions.join("\n  ")}`,
      );
    if (orphaned.length > 0)
      problems.push(
        `orphaned EXEMPT entries (file no longer a production src/*.ts): ${String(orphaned.length)}\n  ${orphaned.join("\n  ")}`,
      );
    throw new Error(`GATE FAIL hermetic-seams:\n${problems.join("\n")}`);
  }
  return {
    ok: true,
    filesScanned: files.length,
    seamsScanned: result.seamsScanned,
    exempted: Object.keys(EXEMPT).length,
  };
}

const invokedPath = path.resolve(process.argv[1] ?? "");
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    const r = checkHermeticSeams(process.cwd());
    process.stdout.write(
      `hermetic-seams gate passed: ${String(r.filesScanned)} files scanned, ${String(r.seamsScanned)} seam call(s) found, ${String(r.exempted)} exempted, no unguarded spawn\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
