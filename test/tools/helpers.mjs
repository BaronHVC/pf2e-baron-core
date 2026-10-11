// Shared by the tool tests: run a tool as a child process, materialize fixture
// modules and build throwaway core repos in temp folders. No side effects at
// import: a bare `node --test` loads every .mjs under test/, this one included.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const TOOLS = path.join(REPO, "tools");
export const FIXTURES = path.join(REPO, "test", "fixtures");
export const VALID_MODULE = path.join(FIXTURES, "valid-module");
export const ZERO_SHA = "0".repeat(40);

/** A temp folder removed when the test `t` ends. */
export function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `baron-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * Environment for child processes: without GITHUB_ACTIONS (so output is the
 * same locally and in CI unless a test asks for annotations) and without git
 * variables a hook could have set, which would point git at another repo.
 */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ["GITHUB_ACTIONS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS"]) delete env[k];
  return { ...env, ...extra };
}

/** Independent oracle for the lock hash: sha256 of the LF-normalized text. */
export function sha256Lf(text) {
  return createHash("sha256").update(Buffer.from(String(text).replace(/\r\n/g, "\n"), "utf8")).digest("hex");
}

export function runNode(script, args, { cwd = REPO, env = childEnv() } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Runs check-module from this repo (or from `core`, a throwaway core repo). */
export function checkModule(args, { core = REPO, ...opts } = {}) {
  return runNode(path.join(core, "tools", "check-module.mjs"), args, opts);
}

export function syncCore(core, args, opts) {
  return runNode(path.join(core, "tools", "sync-core.mjs"), args, opts);
}

/**
 * Parses check-module output into the ids reported at each level.
 * @returns {{ fail: Set<string>, warn: Set<string>, pass: Set<string>, notice: Set<string>, lines: string[], summary: string|undefined }}
 */
export function parseReport(out) {
  const lines = out.split(/\r?\n/);
  const ids = (level) => new Set(lines.filter((l) => l.startsWith(`${level} `)).map((l) => /\[(\w)\]/.exec(l)?.[1]));
  return {
    fail: ids("FAIL"),
    warn: ids("WARN"),
    pass: ids("PASS"),
    notice: ids("NOTICE"),
    lines,
    summary: lines.find((l) => /^check-module: \d+ passed, \d+ warnings, \d+ failed$/.test(l)),
  };
}

/** Negative case specs under test/fixtures/negative, by file name. */
export function negativeCases() {
  const dir = path.join(FIXTURES, "negative");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), spec: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

/**
 * Copies the valid fixture module to a temp folder and applies one negative
 * spec (see test/fixtures/negative/README.md).
 * @returns {string} the module folder
 */
export function materialize(t, spec = {}) {
  const dir = path.join(tempDir(t, "module"), "baron-fixture");
  fs.cpSync(VALID_MODULE, dir, { recursive: true });
  for (const [rel, patch] of Object.entries(spec.merge ?? {})) {
    const file = path.join(dir, rel);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...data, ...patch }, null, 2) + "\n");
  }
  for (const [rel, text] of Object.entries(spec.write ?? {})) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  for (const rel of spec.delete ?? []) fs.rmSync(path.join(dir, rel), { force: true });
  if (spec.lock) {
    const lock = { ...spec.lock };
    if (lock.sha256 === "auto") lock.sha256 = sha256Lf(fs.readFileSync(path.join(dir, "scripts", "baron-core.js"), "utf8"));
    fs.writeFileSync(path.join(dir, "baron-core.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  }
  return dir;
}

/** git with a fixed identity and no signing, hooks or line-ending conversion. */
export function git(cwd, ...args) {
  const res = spawnSync(
    "git",
    [
      "-c", "user.name=Baron Test",
      "-c", "user.email=baron-test@example.invalid",
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", "core.autocrlf=false",
      "-c", `core.hooksPath=${path.join(os.tmpdir(), "baron-test-no-hooks")}`,
      ...args,
    ],
    { cwd, env: childEnv(), encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Text of a fake baron-core.js with the given CORE_VERSION. */
export function fakeCore(version, { eol = "\n", extra = "" } = {}) {
  return [
    "// Fake baron-core for the tool tests.",
    `export const CORE_VERSION = "${version}";`,
    "",
    "export const answer = 42;",
    extra,
  ].join(eol);
}

/**
 * Commits `text` as baron-core.js in the throwaway core repo, optionally with
 * an annotated tag (real core releases are annotated tags).
 * @returns {string} the commit sha
 */
export function commitCore(core, text, tag) {
  fs.writeFileSync(path.join(core, "baron-core.js"), text);
  git(core, "add", "-A");
  git(core, "commit", "-q", "-m", `core ${tag ?? "untagged"}`);
  if (tag) git(core, "tag", "-a", tag, "-m", tag);
  return git(core, "rev-parse", "HEAD");
}

/**
 * A throwaway core repo: this repo's tools copied into tools/ (they locate the
 * core as their parent folder) and a fake baron-core.js tagged v<version>.
 * @returns {{ core: string, commit: string }}
 */
export function makeCoreRepo(t, version = "1.2.3") {
  const core = path.join(tempDir(t, "core"), "pf2e-baron-core");
  fs.mkdirSync(path.join(core, "tools"), { recursive: true });
  for (const f of ["shared.mjs", "sync-core.mjs", "check-module.mjs"]) {
    fs.copyFileSync(path.join(TOOLS, f), path.join(core, "tools", f));
  }
  git(core, "init", "-q");
  git(core, "checkout", "-q", "-b", "main");
  const commit = commitCore(core, fakeCore(version), `v${version}`);
  return { core, commit };
}

export const CI_WORKFLOW = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  check:",
  "    if: github.repository != 'BaronHVC/pf2e-module-template'",
  `    uses: BaronHVC/pf2e-baron-core/.github/workflows/module-check.yml@${ZERO_SHA}`,
  "  other:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      # uses: BaronHVC/pf2e-baron-core/.github/workflows/module-check.yml@commented-out",
  "",
].join("\n");

// CRLF and a quoted pin: autocrlf checkouts and hand-edited YAML both happen.
export const RELEASE_WORKFLOW = [
  "name: Release",
  "on:",
  "  push:",
  '    tags: ["v*"]',
  "permissions:",
  "  contents: write",
  "jobs:",
  "  release:",
  '    uses: "baronhvc/pf2e-baron-core/.github/workflows/module-release.yml@main"',
  "",
].join("\r\n");

/**
 * A minimal module that imports the vendored core, with two workflow files
 * pinning the core repo.
 */
export function makeConsumer(t) {
  const dir = path.join(tempDir(t, "consumer"), "sync-fixture");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "module.json"),
    JSON.stringify({ id: "sync-fixture", title: "Sync Fixture", version: "0.0.0", esmodules: ["scripts/main.js"] }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(dir, "scripts", "main.js"), 'import { CORE_VERSION } from "./baron-core.js";\n\nexport const coreVersion = CORE_VERSION;\n');
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), CI_WORKFLOW);
  fs.writeFileSync(path.join(dir, ".github", "workflows", "release.yml"), RELEASE_WORKFLOW);
  return dir;
}

export const readText = (...p) => fs.readFileSync(path.join(...p), "utf8");
export const readJson = (...p) => JSON.parse(readText(...p));

/** Polls `pred` until it returns true or `ms` elapse. */
export async function waitFor(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (pred()) return true;
    } catch {
      // the file may be mid-write; try again
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Starts a long-running tool; returns the child and a stop() that awaits its exit. */
export function startNode(script, args, { cwd = REPO } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: childEnv(), windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return {
    child,
    output: () => out,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  };
}
