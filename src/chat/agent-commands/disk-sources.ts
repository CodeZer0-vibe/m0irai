/**
 * @file src/chat/agent-commands/disk-sources.ts
 * @purpose Read a user's custom commands + skills off disk for the @agent palette — per agent, per format
 *   (claude/codex `.md`, gemini `.toml`; skills = `<dir>/SKILL.md`). HARDENED (codex P1 #4): every read is
 *   fail-soft (missing/malformed → skip, never throw); symlinks are NEVER followed (lstat + isFile/isDirectory);
 *   the readdir is count-bounded, each file size-bounded, the parse window byte-bounded; only NAME (validated
 *   via isSafeCommandName) + a clipped one-line description are extracted — raw contents never surface. All disk
 *   commands are `trusted: false` (rendered via AgentText, INV-13).
 * @exports loadDiskCommands
 * @depends node:fs, node:os, node:path, node:process, ../types, ./types
 */
import { type Dir, type Dirent, lstatSync, opendirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { AgentName } from "../types.js";
import { type AgentCommand, isSafeCommandName } from "./types.js";

const MAX_ENTRIES = 200; // cap the readdir of any one source dir (a flood of files can't hang the scan)
const MAX_FILE_BYTES = 65_536; // skip a file larger than this (a command/skill def is small; huge = hostile)
const MAX_PARSE_BYTES = 4_096; // only the head of a file is parsed for the description
const MAX_DESC = 120; // description display cap (also escaped at render — INV-13)

/** Injectable roots for tests; default to the real home + cwd. */
export interface DiskOpts {
  readonly home?: string;
  readonly cwd?: string;
}

type CmdFormat = "md" | "toml";
interface CmdDir {
  readonly path: string;
  readonly format: CmdFormat;
}

/** Custom-command dirs per agent (user home + project cwd), with the format each uses. */
function commandDirs(agent: AgentName, home: string, cwd: string): readonly CmdDir[] {
  if (agent === "claude") {
    return [
      { path: join(home, ".claude", "commands"), format: "md" },
      { path: join(cwd, ".claude", "commands"), format: "md" },
    ];
  }
  if (agent === "codex") {
    return [{ path: join(home, ".codex", "prompts"), format: "md" }];
  }
  return [
    { path: join(home, ".gemini", "commands"), format: "toml" },
    { path: join(cwd, ".gemini", "commands"), format: "toml" },
  ];
}

/** Skill dirs per agent (each holds `<name>/SKILL.md`). Antigravity moved its paths — read the CURRENT ones. */
function skillDirs(agent: AgentName, home: string, cwd: string): readonly string[] {
  if (agent === "claude") {
    return [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")];
  }
  if (agent === "codex") {
    return [
      join(home, ".agents", "skills"),
      join(home, ".codex", "skills"),
      join(cwd, ".agents", "skills"),
    ];
  }
  return [join(home, ".gemini", "antigravity-cli", "skills"), join(cwd, ".agents", "skills")];
}

/** Enumerate a dir, capped at MAX_ENTRIES entries actually READ — opendir STOPS early (codex P1 BLOCK: a
 *  readdirSync().slice() reads the WHOLE directory first, so a flood dir would still be fully enumerated +
 *  block the TUI). A missing/unreadable dir yields []. Symlinks stay visible (callers filter by isFile/isDir). */
function safeDirents(dir: string): Dirent[] {
  let handle: Dir;
  try {
    handle = opendirSync(dir);
  } catch {
    return []; // missing / unreadable dir
  }
  const out: Dirent[] = [];
  try {
    let entry = handle.readSync();
    while (entry !== null && out.length < MAX_ENTRIES) {
      out.push(entry);
      entry = handle.readSync();
    }
  } catch {
    // partial read — keep what we got
  } finally {
    try {
      handle.closeSync();
    } catch {
      /* already closed */
    }
  }
  return out;
}

/** True iff `path` is a REGULAR file (lstat, so a symlink reads as not-a-file → never followed) within the cap. */
function regularFileUnderCap(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

const clip = (s: string): string =>
  s
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_DESC);

/** Pull a one-line description from a file head; never throws, never returns raw content (only a clipped field). */
function describeFile(path: string, format: CmdFormat): string {
  if (!regularFileUnderCap(path)) {
    return "";
  }
  let head: string;
  try {
    head = readFileSync(path, "utf8").slice(0, MAX_PARSE_BYTES);
  } catch {
    return "";
  }
  if (format === "toml") {
    const m = /^\s*description\s*=\s*["'](.*?)["']/im.exec(head);
    return m?.[1] !== undefined ? clip(m[1]) : "";
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head); // YAML frontmatter block, if present
  const block = fm?.[1] ?? head.slice(0, 500);
  const m = /^description:\s*(.+)$/im.exec(block);
  return m?.[1] !== undefined ? clip(m[1]) : "";
}

/** Custom commands in one dir: files of the right extension, safe-named, each its own catch via the helpers. */
function readCommands(dir: string, format: CmdFormat): AgentCommand[] {
  const ext = format === "toml" ? ".toml" : ".md";
  const out: AgentCommand[] = [];
  for (const d of safeDirents(dir)) {
    if (!d.isFile() || !d.name.toLowerCase().endsWith(ext)) {
      continue; // isFile() is false for a symlink → never followed
    }
    const name = d.name.slice(0, -ext.length).toLowerCase();
    if (!isSafeCommandName(name)) {
      continue; // a name with an ESC/space/slash never reaches the trusted composer
    }
    out.push({
      name,
      description: describeFile(join(dir, d.name), format),
      kind: "custom",
      trusted: false,
    });
  }
  return out;
}

/** Skills in one dir: immediate subdirs holding a regular SKILL.md (no symlinked dirs, no deep recursion). */
function readSkills(dir: string): AgentCommand[] {
  const out: AgentCommand[] = [];
  for (const d of safeDirents(dir)) {
    if (!d.isDirectory()) {
      continue; // isDirectory() is false for a symlinked dir → never followed
    }
    const name = d.name.toLowerCase();
    const skillFile = join(dir, d.name, "SKILL.md");
    if (!isSafeCommandName(name) || !regularFileUnderCap(skillFile)) {
      continue;
    }
    out.push({ name, description: describeFile(skillFile, "md"), kind: "skill", trusted: false });
  }
  return out;
}

/**
 * Reads `agent`'s custom commands + skills from disk (user home + project cwd), hardened + fail-soft. Returns
 * [] when nothing is present (the common case today). `opts` injects the roots for tests.
 */
export function loadDiskCommands(agent: AgentName, opts: DiskOpts = {}): AgentCommand[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const out: AgentCommand[] = [];
  for (const dir of commandDirs(agent, home, cwd)) {
    out.push(...readCommands(dir.path, dir.format));
  }
  for (const dir of skillDirs(agent, home, cwd)) {
    out.push(...readSkills(dir));
  }
  return out;
}
