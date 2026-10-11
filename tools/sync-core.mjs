#!/usr/bin/env node
// sync-core: vendors baron-core.js into a module and pins it.
//
//   node <core>/tools/sync-core.mjs [moduleDir=cwd] --ref <tag|sha>
//   node <core>/tools/sync-core.mjs [moduleDir=cwd] --watch
//
// --ref reads the file from the core's object database (git show), so the
// tag never has to be checked out, and writes scripts/baron-core.js, the lock
// and every workflow pin to the core repo in one go: the three can only ever
// move together. --watch is for the junction + F5 loop: it copies the core
// WORKING TREE on every save and marks the lock "dev", which check-module
// rejects, so a dev copy can never be committed or released unnoticed.

import fs from "node:fs";
import path from "node:path";
import {
  CORE_DIR,
  CORE_FILE,
  LOCK_FILE,
  USES_PIN_RE,
  VENDORED_PATH,
  coreFileAt,
  gitTry,
  lockText,
  readCoreVersion,
  sha256Lf,
  toLf,
  workflowFiles,
} from "./shared.mjs";

const USAGE = `usage:
  node ${path.relative(process.cwd(), process.argv[1]) || "sync-core.mjs"} [moduleDir] --ref <tag|sha>
  node ${path.relative(process.cwd(), process.argv[1]) || "sync-core.mjs"} [moduleDir] --watch`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { moduleDir: null, ref: null, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") {
      opts.ref = argv[++i];
      if (!opts.ref || opts.ref.startsWith("--")) throw new UsageError("--ref needs a tag or a commit sha");
    } else if (a.startsWith("--ref=")) opts.ref = a.slice(6);
    else if (a === "--watch") opts.watch = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (opts.moduleDir === null) opts.moduleDir = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  // A ref is handed to git as an argument; one starting with "-" would be
  // read as an option.
  if (opts.ref !== null && !/^[\w][\w./-]*$/.test(opts.ref)) throw new UsageError(`invalid ref "${opts.ref}"`);
  if (opts.watch && opts.ref) throw new UsageError("--ref and --watch are exclusive");
  if (!opts.watch && !opts.ref) throw new UsageError("pass --ref <tag|sha> (or --watch for live development)");
  return opts;
}

function fail(message) {
  console.error(`sync-core: ERROR: ${message}`);
  process.exit(1);
}

function resolveModuleDir(dir) {
  const moduleDir = path.resolve(dir ?? process.cwd());
  if (!fs.existsSync(path.join(moduleDir, "module.json"))) {
    fail(`${moduleDir} has no module.json: run it from a module folder or pass the folder as first argument`);
  }
  if (path.resolve(moduleDir) === path.resolve(CORE_DIR)) fail("the module folder is the core repo itself");
  return moduleDir;
}

function writeLf(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toLf(text), "utf8");
}

/**
 * Rewrites every core pin under .github/workflows to `commit`, keeping the
 * file's own line endings (autocrlf may have checked it out as CRLF).
 */
function rewritePins(moduleDir, commit) {
  const changes = [];
  for (const rel of workflowFiles(moduleDir)) {
    const file = path.join(moduleDir, rel);
    const text = fs.readFileSync(file, "utf8");
    let count = 0;
    const next = text.replace(USES_PIN_RE, (_, lead) => {
      count++;
      return lead + commit;
    });
    if (count === 0) continue;
    if (next !== text) fs.writeFileSync(file, next, "utf8");
    changes.push({ rel, count, changed: next !== text });
  }
  return changes;
}

function syncRef(moduleDir, ref) {
  if (!gitTry(CORE_DIR, ["rev-parse", "--git-dir"])) fail(`${CORE_DIR} is not a git repository`);
  const commit = gitTry(CORE_DIR, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!commit) fail(`ref "${ref}" does not resolve to a commit in ${CORE_DIR} (fetch tags with: git -C "${CORE_DIR}" fetch --tags)`);

  const tagName = ref.replace(/^refs\/tags\//, "");
  const isTag = gitTry(CORE_DIR, ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`]) !== null;

  let text;
  try {
    text = coreFileAt(CORE_DIR, commit);
  } catch {
    fail(`${CORE_FILE} does not exist at ${commit}`);
  }
  const version = readCoreVersion(text);
  if (!version) fail(`${CORE_FILE} at ${commit} has no 'export const CORE_VERSION = "..."' line`);
  if (isTag && tagName !== `v${version}`) {
    fail(`tag ${tagName} does not match CORE_VERSION ${version} (expected tag v${version}); refusing to vendor a mislabeled release`);
  }

  const sha256 = sha256Lf(text);
  writeLf(path.join(moduleDir, VENDORED_PATH), text);
  writeLf(path.join(moduleDir, LOCK_FILE), lockText({ version, commit, sha256 }));
  const pins = rewritePins(moduleDir, commit);

  console.log(`sync-core: pf2e-baron-core ${version} @ ${commit}${isTag ? ` (tag ${tagName})` : ""}`);
  console.log(`  ${VENDORED_PATH.padEnd(34)} ${Buffer.byteLength(text)} bytes, sha256 ${sha256}`);
  console.log(`  ${LOCK_FILE.padEnd(34)} version ${version}`);
  if (!pins.length) console.log("  (no workflow calls BaronHVC/pf2e-baron-core: no pins to rewrite)");
  for (const p of pins) {
    console.log(`  ${p.rel.padEnd(34)} ${p.count} pin(s) ${p.changed ? "->" : "already at"} ${commit}`);
  }
  if (!isTag) {
    // check-module --online demands that tag v<version> peels to the locked
    // commit; say so now rather than at release time.
    const tagged = gitTry(CORE_DIR, ["rev-parse", "--verify", "--quiet", `v${version}^{commit}`]);
    if (tagged !== commit) {
      console.log(`  WARNING: ${ref} is not tag v${version}; check-module --online will fail until the lock points at that tag's commit`);
    }
  }
}

function watch(moduleDir) {
  const src = path.join(CORE_DIR, CORE_FILE);
  if (!fs.existsSync(src)) fail(`${src} does not exist`);
  const dest = path.join(moduleDir, VENDORED_PATH);
  const lockFile = path.join(moduleDir, LOCK_FILE);
  const stamp = () => new Date().toTimeString().slice(0, 8);

  const copy = (force = false) => {
    let text;
    try {
      text = toLf(fs.readFileSync(src, "utf8"));
    } catch (err) {
      // Editors save by delete + rename; the next event brings the file back.
      console.error(`[${stamp()}] cannot read ${src}: ${err.code ?? err.message}`);
      return;
    }
    const current = fs.existsSync(dest) ? toLf(fs.readFileSync(dest, "utf8")) : null;
    if (!force && current === text) return;
    const sha256 = sha256Lf(text);
    writeLf(dest, text);
    writeLf(lockFile, lockText({ version: "dev", commit: "dev", sha256 }));
    const version = readCoreVersion(text);
    console.log(`[${stamp()}] copied ${CORE_FILE} (CORE_VERSION ${version ?? "MISSING"}, sha256 ${sha256.slice(0, 12)}...)`);
  };

  console.log(`sync-core --watch: ${src}`);
  console.log(`                -> ${dest}`);
  console.log(`The lock now says "dev": run sync-core --ref <tag> before committing. Ctrl+C to stop.`);

  // Watch the folder, not the file: an atomic save replaces the inode and a
  // file watcher would go silent after the first save. Long real path: on
  // Windows, libuv aborts the process when the watched folder is given as an
  // 8.3 short name (C:\Users\NOMBRE~1\...), which is what %TEMP% often is.
  let watchDir = CORE_DIR;
  try {
    watchDir = fs.realpathSync.native(CORE_DIR);
  } catch {
    // keep CORE_DIR; fs.watch reports its own error if it is unusable
  }
  let timer = null;
  const watcher = fs.watch(watchDir, (_event, filename) => {
    if (filename && filename !== CORE_FILE) return;
    clearTimeout(timer);
    timer = setTimeout(copy, 150);
  });
  // The first copy comes only once the watcher is armed: an edit saved right
  // after that copy appears would otherwise land before anything listens and
  // never be mirrored (reproduced 40 times out of 40 by editing the moment the
  // lock appeared). Forced even when the module already holds identical text
  // (right after a --ref sync): from here on the copy follows the working
  // tree, so the lock must stop vouching for a release the moment watching starts.
  copy(true);
  const stop = () => {
    watcher.close();
    clearTimeout(timer);
    console.log("sync-core --watch: stopped (the lock still says dev)");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`sync-core: ERROR: ${err.message}\n${USAGE}`);
      process.exit(1);
    }
    throw err;
  }
  const moduleDir = resolveModuleDir(opts.moduleDir);
  if (opts.watch) watch(moduleDir);
  else syncRef(moduleDir, opts.ref);
}

main();
