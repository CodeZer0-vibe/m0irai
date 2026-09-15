/**
 * @file .dependency-cruiser.cjs
 * @purpose Mechanical anti-monolith enforcement — DAG direction, no cycles, workflow sandbox purity.
 * @authority The rules in THIS file are canonical. (Historically this cited docs/MODULE-MAP.md, which is
 *            SUPERSEDED — it maps the deleted src/temporal subsystem. See that file's banner.)
 *
 * Run: `npm run dep-check`
 * CI: failures here block builds with exit code 1.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependencies destroy testability and replace clean review boundaries with whack-a-mole. Scoped to RUNTIME cycles (viaOnly dependencyTypesNot type-only) since B3 turned on tsPreCompilationDeps: a cycle with ANY type-only edge is erased at compile time — no runtime cycle exists — so it is tolerated (e.g. the cockpit-turn-exec↔{receipt,triggers} TurnContext type back-edges). A cycle whose every edge survives compilation still errors.",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Orphaned modules (no incoming deps) usually indicate dead code or a missed wire-up.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)tests/.+\\.ts$",
          "\\.test\\.ts$",
          "\\.spec\\.ts$",
        ],
      },
      to: {},
    },
    {
      name: "no-upward-deps-evidence",
      severity: "error",
      comment:
        "src/evidence/** is the persistence layer. It may depend on src/shared/** only. NOT on adapters, security, gates, or any feature layer.",
      from: { path: "^src/evidence/" },
      to: {
        path: "^src/(?!(evidence|shared)/)",
        // B3 POLISH: runtime-only, matching this rule's pre-tsPreCompilationDeps behavior — a compile-time
        // type import (e.g. an evidence test referencing a chat type) is not a runtime persistence-layer breach.
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "no-upward-deps-adapters",
      severity: "error",
      comment:
        "src/adapters/** is a feature-layer sibling. May import only from src/adapters/** (intra-folder), src/evidence/**, or src/shared/**. Lateral feature-layer imports are forbidden (codex infra-review I-2).",
      from: { path: "^src/adapters/" },
      to: {
        path: "^src/(?!(adapters|evidence|shared)/)",
      },
    },
    {
      name: "no-prod-deps-on-test-files",
      severity: "error",
      comment: "Production code must never import test files.",
      from: { pathNot: "(^tests/|\\.(test|spec)\\.tsx?$)" },
      to: { path: "(^tests/|\\.(test|spec)\\.tsx?$)" },
    },
    {
      name: "no-deprecated-core",
      severity: "error",
      comment: "Don't use deprecated Node core APIs.",
      from: {},
      to: { dependencyTypes: ["core"], path: "^(punycode|sys|domain|constants)$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    // B3 POLISH: include type-only (`import type`) edges in the graph. Without this, dependency-cruiser drops
    // them at TS pre-compilation, so a layering rule could not see an `import type` line across a boundary —
    // type coupling is still architectural coupling and drags runtime deps later. no-circular is scoped to
    // runtime-only cycles (viaOnly below) so the harmless type-only exec↔{receipt,triggers} cycle stays green.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["main", "module"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
    includeOnly: "^(src|tests)/",
    progress: { type: "performance-log" },
  },
};
