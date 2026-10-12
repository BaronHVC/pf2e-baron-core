// .github/scripts/run-module-tests.mjs: what it finds in a module and what it
// runs, against throwaway modules in temp folders, plus where module-check.yml
// and module-release.yml call it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findTestFiles, planTests } from "../../.github/scripts/run-module-tests.mjs";
import { REPO, childEnv, readText, runNode, tempDir } from "./helpers.mjs";

const SCRIPT = path.join(REPO, ".github", "scripts", "run-module-tests.mjs");

/** A module folder with `files` ({ "rel/path": text }) written into it. */
function makeModule(t, files) {
  const dir = tempDir(t, "modtests");
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

/**
 * Runs the script the way the workflows do: from the module checkout, with ".".
 * NODE_TEST_CONTEXT is set on purpose: under `npm test` this file is itself a
 * test child, and a `node --test` that inherited it would skip its files.
 */
function runIn(t, dir, args = ["."]) {
  const runnerTemp = tempDir(t, "runner");
  const res = runNode(SCRIPT, args, { cwd: dir, env: childEnv({ NODE_TEST_CONTEXT: "child-v8", RUNNER_TEMP: runnerTemp }) });
  return { ...res, runnerTemp };
}

const PASSING = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "../scripts/math.js";',
  'import { CORE_VERSION } from "../scripts/baron-core.js";',
  'test("add sums", () => assert.equal(add(2, 3), 5));',
  'test("the vendored core imports", () => assert.equal(CORE_VERSION, "9.9.9"));',
  "",
].join("\n");

const FAILING = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "../scripts/math.js";',
  'test("add sums", () => assert.equal(add(2, 3), 5));',
  'test("add is wrong on purpose", () => assert.equal(add(2, 2), 5));',
  "",
].join("\n");

const SCRIPTS = {
  "module.json": '{ "id": "fixture-mod" }\n',
  "scripts/math.js": "export const add = (a, b) => a + b;\n",
  "scripts/baron-core.js": 'export const CORE_VERSION = "9.9.9";\n',
};

// A file that throws when loaded: if discovery picked it up, the run fails.
const BOOBY_TRAP = 'throw new Error("this file is not a test and must never be loaded");\n';

test("findTestFiles lists *.test.mjs and *.test.js under test/ and tests/, at any depth, sorted", (t) => {
  const dir = makeModule(t, {
    "test/b.test.mjs": "",
    "test/a.test.js": "",
    "test/unit/deep/c.test.mjs": "",
    "tests/d.test.mjs": "",
    "tests/fixtures/sample.test.mjs": "",
    // Not tests: wrong suffix, helpers, fixtures, other folders, dependencies.
    "test/helpers/h.mjs": "",
    "test/fixtures/data.json": "",
    "test/fixtures/case.js": "",
    "test/e.spec.mjs": "",
    "test/f.test.cjs": "",
    "test/g.test.mjs.bak": "",
    "test/node_modules/dep/x.test.mjs": "",
    "test/.cache/y.test.mjs": "",
    "scripts/z.test.mjs": "",
    "root.test.mjs": "",
    "spec/w.test.mjs": "",
  });
  assert.deepEqual(findTestFiles(dir), [
    "test/a.test.js",
    "test/b.test.mjs",
    "test/unit/deep/c.test.mjs",
    "tests/d.test.mjs",
    "tests/fixtures/sample.test.mjs",
  ]);
});

test("findTestFiles: a folder named like a test file, or test/ as a file, is not picked up", (t) => {
  const dir = makeModule(t, { test: "not a folder\n", "tests/x.test.mjs/keep.txt": "" });
  assert.deepEqual(findTestFiles(dir), []);
});

test("planTests: no package.json and no test files means nothing to run", (t) => {
  assert.deepEqual(planTests(makeModule(t, SCRIPTS)), { kind: "none" });
});

test("planTests: a package.json test script wins over test files", (t) => {
  const dir = makeModule(t, { "package.json": '{ "scripts": { "test": "node x.mjs" } }', "test/a.test.mjs": "" });
  assert.deepEqual(planTests(dir), { kind: "npm", install: null });
});

test("planTests: npm installs only when package.json declares dependencies", (t) => {
  const pkg = (extra) => JSON.stringify({ scripts: { test: "node --test" }, ...extra });
  const plan = (files) => planTests(makeModule(t, files));
  // --ignore-scripts always: a dependency's install script never runs in CI.
  assert.deepEqual(plan({ "package.json": pkg({ devDependencies: { x: "1.0.0" } }), "package-lock.json": "{}" }), { kind: "npm", install: ["ci", "--ignore-scripts"] });
  assert.deepEqual(plan({ "package.json": pkg({ dependencies: { x: "1.0.0" } }), "npm-shrinkwrap.json": "{}" }), { kind: "npm", install: ["ci", "--ignore-scripts"] });
  assert.deepEqual(plan({ "package.json": pkg({ dependencies: { x: "1.0.0" } }) }), {
    kind: "npm",
    install: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
  });
  // A lockfile alone, or empty dependency maps, install nothing.
  assert.deepEqual(plan({ "package.json": pkg({ dependencies: {}, devDependencies: {} }), "package-lock.json": "{}" }), { kind: "npm", install: null });
  // A BOM in package.json is fine.
  assert.deepEqual(plan({ "package.json": `\uFEFF${pkg({})}` }), { kind: "npm", install: null });
});

test("planTests: a package.json without a usable test script falls back to the test files", (t) => {
  for (const pkg of ['{ "name": "m" }', '{ "scripts": { "build": "x" } }', '{ "scripts": { "test": "  " } }', '{ "scripts": { "test": 1 } }']) {
    const dir = makeModule(t, { "package.json": pkg, "tests/a.test.mjs": "" });
    assert.deepEqual(planTests(dir), { kind: "node", files: ["tests/a.test.mjs"] }, pkg);
  }
});

test("planTests: the placeholder test script of npm init counts as no script", (t) => {
  const pkg = (test) => JSON.stringify({ name: "m", scripts: { test } });
  const npmInit = 'echo "Error: no test specified" && exit 1';
  assert.deepEqual(planTests(makeModule(t, { "package.json": pkg(npmInit), "test/a.test.mjs": "" })), {
    kind: "node",
    files: ["test/a.test.mjs"],
    placeholder: true,
  });
  assert.deepEqual(planTests(makeModule(t, { "package.json": pkg(` ${npmInit} `) })), { kind: "none", placeholder: true });
  // Anything else is the module's own command, even if it echoes and exits.
  assert.deepEqual(planTests(makeModule(t, { "package.json": pkg('echo "no tests yet" && exit 1') })), { kind: "npm", install: null });
});

test("planTests: an unreadable package.json is an error, not a silent skip", (t) => {
  assert.throws(() => planTests(makeModule(t, { "package.json": "{ nope" })), /cannot parse package\.json/);
  assert.throws(() => planTests(makeModule(t, { "package.json": "[]" })), /not a JSON object/);
});

test("a module without tests gets a notice and passes", (t) => {
  const dir = makeModule(t, SCRIPTS);
  const res = runIn(t, dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /^::notice title=module tests::no tests found/m);
});

test("test files only under test/fixtures (no .test. suffix) are not picked up", (t) => {
  const dir = makeModule(t, {
    ...SCRIPTS,
    "test/fixtures/case.js": BOOBY_TRAP,
    "test/fixtures/module.mjs": BOOBY_TRAP,
    "test/helpers/stubs.mjs": BOOBY_TRAP,
  });
  const res = runIn(t, dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /^::notice title=module tests::no tests found/m);
});

test("passing test/*.test.mjs run from the module folder, with ../scripts imports, and never load fixtures or helpers", (t) => {
  const dir = makeModule(t, {
    ...SCRIPTS,
    "test/math.test.mjs": PASSING,
    "test/fixtures/case.js": BOOBY_TRAP,
    "test/helpers/stubs.mjs": BOOBY_TRAP,
  });
  const res = runIn(t, dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /node --test on 1 file\(s\): test\/math\.test\.mjs/);
  assert.match(res.stdout, /add sums/);
  assert.match(res.stdout, /the vendored core imports/);
  assert.doesNotMatch(res.out, /never be loaded/);
  assert.doesNotMatch(res.stdout, /^::error/m);
  // The TAP report lives in RUNNER_TEMP and is removed; nothing lands in the module.
  assert.deepEqual(fs.readdirSync(res.runnerTemp), []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["module.json", "scripts", "test"]);
});

test("a failing test fails the run and becomes an annotation", (t) => {
  const dir = makeModule(t, { ...SCRIPTS, "test/math.test.mjs": FAILING });
  const res = runIn(t, dir);
  assert.equal(res.status, 1, res.out);
  const errors = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.equal(errors.length, 1, res.stdout);
  assert.match(errors[0], /^::error title=FAIL add is wrong on purpose::/);
  assert.match(errors[0], /test\/math\.test\.mjs/);
  // Only that test's YAML block: not the TAP plan or summary after it.
  assert.doesNotMatch(errors[0], /%0A1\.\.\d|# tests \d/);
  assert.deepEqual(fs.readdirSync(res.runnerTemp), []);
});

test("a test file that does not load fails the run, and the annotation says why", (t) => {
  const dir = makeModule(t, { ...SCRIPTS, "test/broken.test.mjs": 'import { nope } from "../scripts/missing.js";\n' });
  const res = runIn(t, dir);
  assert.equal(res.status, 1, res.out);
  const errors = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.equal(errors.length, 1, res.stdout);
  assert.match(errors[0], /^::error title=FAIL test.+broken\.test\.mjs::/);
  assert.match(errors[0], /ERR_MODULE_NOT_FOUND/);
  assert.match(errors[0], /missing\.js/);
  assert.doesNotMatch(errors[0], /node:internal\/modules\/esm\/loader|# tests \d/);
});

test("a *.test.mjs under test/fixtures does run, and a throw outside any test shows in the annotation", (t) => {
  const dir = makeModule(t, { ...SCRIPTS, "test/fixtures/sample.test.mjs": 'throw new Error("fixture loaded as a test");\n' });
  const res = runIn(t, dir);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stdout, /node --test on 1 file\(s\): test\/fixtures\/sample\.test\.mjs/);
  assert.match(res.stdout, /^::error title=FAIL .*fixture loaded as a test/m);
});

test("a test file whose path node --test would read as a glob fails the run instead of passing with 0 tests", (t) => {
  // Node 22+ globs each argument: test/x+(y).test.mjs matches nothing, so the
  // failing test inside would never run and the run would pass.
  for (const name of ["test/x+(y).test.mjs", "test/@(x).test.mjs", "test/[a].test.mjs", "test/{a,b}.test.mjs", "test/old (1)/a.test.mjs"]) {
    const dir = makeModule(t, { ...SCRIPTS, "test/math.test.mjs": PASSING, [name]: FAILING });
    const res = runIn(t, dir);
    assert.equal(res.status, 1, `${name}\n${res.out}`);
    assert.doesNotMatch(res.stdout, /node --test on/, name);
    const errors = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("::error"));
    assert.equal(errors.length, 1, `${name}\n${res.stdout}`);
    assert.ok(errors[0].startsWith(`::error file=${name.replace(/,/g, "%2C")},title=module tests::`), errors[0]);
    assert.match(errors[0], /rename it/);
  }
});

test("--tap keeps the TAP report where asked", (t) => {
  const dir = makeModule(t, { ...SCRIPTS, "test/math.test.mjs": FAILING });
  const tap = path.join(tempDir(t, "tap"), "out.tap");
  const res = runIn(t, dir, [".", "--tap", tap]);
  assert.equal(res.status, 1, res.out);
  assert.match(fs.readFileSync(tap, "utf8"), /^not ok \d+ - add is wrong on purpose/m);
});

test("SWE's layout: tests/*.test.mjs reading tests/fixtures through import.meta.url", (t) => {
  // pf2e-simple-weapon-editor 0.15.0: tests/retired-runes.test.mjs imports
  // ../scripts/*.js and reads ./fixtures/rune-rules-0.12-0.14.json.
  const dir = makeModule(t, {
    ...SCRIPTS,
    "scripts/retired-runes.js": 'export const RETIRED_RUNES = ["dread"];\n',
    "tests/fixtures/rune-rules-0.12-0.14.json": '{ "rules": { "dread": 1, "fortification": 1 } }\n',
    "tests/retired-runes.test.mjs": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { RETIRED_RUNES } from "../scripts/retired-runes.js";',
      'const OLD = JSON.parse(readFileSync(new URL("./fixtures/rune-rules-0.12-0.14.json", import.meta.url), "utf8")).rules;',
      'test("retired runes are a subset of the old rules", () => {',
      "  for (const r of RETIRED_RUNES) assert.ok(r in OLD, r);",
      "});",
      "",
    ].join("\n"),
  });
  const res = runIn(t, dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /node --test on 1 file\(s\): tests\/retired-runes\.test\.mjs/);
  assert.match(res.stdout, /retired runes are a subset of the old rules/);
});

test("a package.json test script runs with npm test, instead of the test files", (t) => {
  const dir = makeModule(t, {
    ...SCRIPTS,
    "package.json": JSON.stringify({ name: "fixture-mod", private: true, scripts: { test: "node check.mjs" } }),
    "check.mjs": 'import fs from "node:fs"; fs.writeFileSync("ran.txt", "yes");\n',
    "test/math.test.mjs": FAILING,
  });
  const res = runIn(t, dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /run-module-tests: npm test/);
  assert.equal(fs.readFileSync(path.join(dir, "ran.txt"), "utf8"), "yes");
  assert.doesNotMatch(res.stdout, /node --test on/);
});

test("the placeholder test script of npm init is ignored with a notice, and the test files run", (t) => {
  const dir = makeModule(t, {
    ...SCRIPTS,
    "package.json": JSON.stringify({ name: "fixture-mod", scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    "test/math.test.mjs": PASSING,
  });
  const res = runIn(t, dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /^::notice file=package\.json,title=module tests::the "test" script of package\.json is the placeholder npm init writes/m);
  assert.match(res.stdout, /node --test on 1 file\(s\): test\/math\.test\.mjs/);
  assert.doesNotMatch(res.stdout, /run-module-tests: npm test|^::error/m);
});

test("a failing npm test fails the run with an annotation", (t) => {
  const dir = makeModule(t, {
    ...SCRIPTS,
    "package.json": JSON.stringify({ name: "fixture-mod", private: true, scripts: { test: "node check.mjs" } }),
    "check.mjs": "process.exit(3);\n",
  });
  const res = runIn(t, dir);
  assert.notEqual(res.status, 0, res.out);
  assert.match(res.stdout, /^::error file=package\.json,title=module tests::npm test failed with exit code \d+$/m);
});

test("an unparseable package.json fails the run", (t) => {
  const res = runIn(t, makeModule(t, { ...SCRIPTS, "package.json": "{ nope", "test/math.test.mjs": PASSING }));
  assert.equal(res.status, 1, res.out);
  assert.match(res.stdout, /^::error file=package\.json,title=module tests::cannot parse package\.json/m);
});

test("unexpected arguments are refused", (t) => {
  const dir = makeModule(t, SCRIPTS);
  for (const args of [[".", "extra"], ["--nope"], [".", "--tap"]]) {
    const res = runIn(t, dir, args);
    assert.equal(res.status, 2, `${args.join(" ")}\n${res.out}`);
  }
});

// The two reusable workflows, as lists of steps (each starts at "      - ").
function steps(wf) {
  const out = [];
  for (const line of readText(REPO, ".github", "workflows", wf).split(/\r?\n/)) {
    if (/^ {6}- /.test(line)) out.push([]);
    out.at(-1)?.push(line);
  }
  return out.map((s) => s.join("\n"));
}
const RUN_TESTS = /^ {8}run: node \.baron-core\/\.github\/scripts\/run-module-tests\.mjs \.$/m;
const indexOf = (list, re) => list.findIndex((s) => re.test(s));

test("module-check.yml runs the module tests right after check-module, with the same guard", () => {
  const list = steps("module-check.yml");
  const check = indexOf(list, /run: node \.baron-core\/tools\/check-module\.mjs /);
  const tests = indexOf(list, RUN_TESTS);
  assert.ok(check >= 0 && tests === check + 1, `check-module step ${check}, tests step ${tests}`);
  assert.match(list[tests], /^ {8}if: steps\.lock\.outputs\.run == 'true'$/m);
  assert.match(list[tests], /^ {8}timeout-minutes: 15$/m);
  assert.doesNotMatch(list[tests], /continue-on-error/);
});

test("module-release.yml runs the module tests after check-module and before module.json is touched or anything is packed", () => {
  const list = steps("module-release.yml");
  const check = indexOf(list, /run: node \.baron-core\/tools\/check-module\.mjs .*--release/);
  const tests = indexOf(list, RUN_TESTS);
  assert.ok(check >= 0 && tests === check + 1, `check-module step ${check}, tests step ${tests}`);
  // Unconditional: public and protected alike, and never allowed to fail.
  assert.doesNotMatch(list[tests], /^ {8}if:|continue-on-error/m);
  // A test that leaves a handle open ends here, not at GitHub's 6 h.
  assert.match(list[tests], /^ {8}timeout-minutes: 15$/m);
  for (const later of [/release-manifest\.mjs/, /zip -r/, /gh release/, /GITHUB_REF_NAME/]) {
    const at = indexOf(list, later);
    assert.ok(at > tests, `${later} at step ${at}, tests at ${tests}`);
  }
});

test("the module checkout keeps no token, and module-release stops if the tests touched what it packs", () => {
  for (const wf of ["module-check.yml", "module-release.yml"]) {
    const list = steps(wf);
    const checkout = indexOf(list, /uses: actions\/checkout@v4/);
    assert.match(list[checkout], /^ {10}persist-credentials: false$/m, wf);
  }
  const list = steps("module-release.yml");
  const PACKED = "module.json scripts styles templates lang packs LICENSE NOTICE.md";
  const tests = indexOf(list, RUN_TESTS);
  const guard = indexOf(list, /git status --porcelain --untracked-files=all --ignored -- /);
  assert.equal(guard, tests + 1, `guard step ${guard}, tests step ${tests}`);
  assert.ok(list[guard].includes(`--ignored -- ${PACKED})`), "the guard checks the same paths the ZIP packs");
  assert.ok(list[indexOf(list, /zip -r/)].includes(`for p in ${PACKED}; do`), "the ZIP step packs that list");
  assert.doesNotMatch(list[guard], /^ {8}if:|continue-on-error/m);
});
