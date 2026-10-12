// Runs a module's own node tests. module-check.yml (every push) and
// module-release.yml (every tag, before module.json is rewritten or the ZIP is
// built) call it from the module checkout right after check-module, so a
// release never ships with failing tests.
//
//   node .baron-core/.github/scripts/run-module-tests.mjs [<module dir>] [--tap <file>]
//
// What runs, first match wins:
//   1. package.json with a non-empty "test" script: `npm test`. Before it,
//      only when package.json declares dependencies or devDependencies:
//      `npm ci` with a lockfile, `npm install --no-audit --no-fund` without.
//   2. Files named *.test.mjs or *.test.js anywhere under test/ or tests/:
//      `node --test` with that explicit list. A bare `node --test` would also
//      load fixtures and helpers.
//   3. Neither: a ::notice:: and exit 0.
//
// Tests run in the module folder, so `../scripts/*.js` imports (the vendored
// core included) resolve as they do locally. A failure exits non-zero. With
// node --test, a second TAP reporter feeds tap-annotate.mjs (next to this
// file), which turns each failed test into a public annotation: job logs can
// only be downloaded by the repository's admins. The TAP file goes to
// RUNNER_TEMP (or the OS temp folder), never into the module, which the
// release packs afterwards. Node built-ins only; no npm install for this.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRS = ["test", "tests"];
const TEST_FILE = /\.test\.m?js$/;
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];
const TITLE = "module tests";

// Workflow commands treat %, CR and LF specially in the message part.
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/**
 * Test files under test/ and tests/ of `root`, as sorted forward-slash paths
 * relative to it. Skips node_modules and dot folders; follows no symlinks.
 */
export function findTestFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(child);
      } else if (e.isFile() && TEST_FILE.test(e.name)) {
        out.push(child);
      }
    }
  };
  for (const dir of TEST_DIRS) {
    if (fs.statSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory()) walk(dir);
  }
  return out.sort();
}

const hasEntries = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;

/**
 * What to run for the module in `root`:
 *   { kind: "npm", install: null | string[] }  npm test, after `npm <install>`
 *   { kind: "node", files: string[] }          node --test <files>
 *   { kind: "none" }
 * Throws when package.json exists but is not a JSON object: without reading it
 * there is no way to know whether the module declares its own test command.
 */
export function planTests(root) {
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      throw new Error(`cannot parse package.json: ${err.message}`);
    }
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("package.json is not a JSON object");
    const script = pkg.scripts?.test;
    if (typeof script === "string" && script.trim() !== "") {
      let install = null;
      if (hasEntries(pkg.dependencies) || hasEntries(pkg.devDependencies)) {
        install = LOCKFILES.some((f) => fs.existsSync(path.join(root, f))) ? ["ci"] : ["install", "--no-audit", "--no-fund"];
      }
      return { kind: "npm", install };
    }
  }
  const files = findTestFiles(root);
  return files.length ? { kind: "node", files } : { kind: "none" };
}

/**
 * Environment for the children. NODE_TEST_CONTEXT is how a node:test runner
 * tells a test file it is a child; a `node --test` that inherits it skips its
 * files, so it never passes through (it is only set when this script itself
 * runs inside a test).
 */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// npm is npm.cmd on Windows, which spawn only starts through a shell. The
// arguments are fixed words, so the shell sees nothing from the module; they
// go in the command string because Node deprecates args next to shell: true.
function npm(args, cwd, env) {
  const opts = { cwd, env, stdio: "inherit", windowsHide: true };
  const res =
    process.platform === "win32" ? spawnSync(`npm ${args.join(" ")}`, { ...opts, shell: true }) : spawnSync("npm", args, opts);
  if (res.error) console.log(`::error title=${TITLE}::cannot start npm: ${esc(res.error.message)}`);
  return res.status ?? 1;
}

/** Runs `plan` in `root` and returns the exit code. */
export function runPlan(plan, root, { tap } = {}) {
  const env = childEnv();
  if (plan.kind === "none") {
    console.log(`::notice title=${TITLE}::no tests found: package.json has no "test" script and there is no *.test.mjs or *.test.js under test/ or tests/`);
    return 0;
  }
  if (plan.kind === "npm") {
    if (plan.install) {
      console.log(`run-module-tests: npm ${plan.install.join(" ")} (package.json declares dependencies)`);
      const status = npm(plan.install, root, env);
      if (status !== 0) {
        console.log(`::error file=package.json,title=${TITLE}::npm ${esc(plan.install[0])} failed with exit code ${status}; the tests did not run`);
        return status;
      }
    }
    console.log('run-module-tests: npm test (the "test" script of package.json)');
    const status = npm(["test"], root, env);
    if (status !== 0) console.log(`::error file=package.json,title=${TITLE}::npm test failed with exit code ${status}`);
    return status;
  }
  const own = !tap;
  const tapFile = tap ?? path.join(process.env.RUNNER_TEMP || os.tmpdir(), `module-tests-${process.pid}.tap`);
  console.log(`run-module-tests: node --test on ${plan.files.length} file(s): ${plan.files.join(" ")}`);
  try {
    const res = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=tap",
        `--test-reporter-destination=${tapFile}`,
        ...plan.files,
      ],
      { cwd: root, env, stdio: "inherit", windowsHide: true },
    );
    if (res.error) console.log(`::error title=${TITLE}::cannot start node --test: ${esc(res.error.message)}`);
    const status = res.status ?? 1;
    if (status !== 0) {
      const annotate = fileURLToPath(new URL("./tap-annotate.mjs", import.meta.url));
      spawnSync(process.execPath, [annotate, tapFile], { cwd: root, env, stdio: "inherit", windowsHide: true });
    }
    return status;
  } finally {
    if (own) fs.rmSync(tapFile, { force: true });
  }
}

function main(argv) {
  let dir = ".";
  let tap;
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tap" && i + 1 < argv.length) tap = path.resolve(argv[++i]);
    else if (!a.startsWith("-") && positional++ === 0) dir = a;
    else {
      console.log(`::error title=${TITLE}::run-module-tests: unexpected argument ${esc(JSON.stringify(a))}; usage: run-module-tests.mjs [<module dir>] [--tap <file>]`);
      return 2;
    }
  }
  const root = path.resolve(dir);
  let plan;
  try {
    plan = planTests(root);
  } catch (err) {
    console.log(`::error file=package.json,title=${TITLE}::${esc(err.message)}`);
    return 1;
  }
  return runPlan(plan, root, { tap });
}

// Main only when run as a script, not when a test imports the functions. Both
// sides go through realpath so a short (8.3) or symlinked path still matches.
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
