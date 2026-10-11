// baron-core must import cleanly with no Foundry, browser or test stubs in
// sight: the vendored copy is evaluated by every module that imports it, at
// whatever point the browser reaches it, possibly before Foundry's globals
// exist. Each check runs in a fresh Node process so nothing another test
// installed on globalThis can hide a problem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE_URL = new URL("../baron-core.js", import.meta.url).href;

// Globals a Foundry module could reach for at import. Each becomes a getter
// that records the access and throws, and a setter that records the write.
const WATCHED = [
  "game", "CONFIG", "foundry", "Hooks", "ui", "Handlebars", "canvas", "libWrapper", "socketlib",
  "fromUuid", "FormDataExtended", "TextEditor", "document", "window", "customElements", "CSS",
  "HTMLElement", "jQuery", "$", "setTimeout", "setInterval", "queueMicrotask"
];

// Runs as an ES module in the child: argv[1] is the core URL, argv[2] the
// watched names as JSON. Plain strings on purpose (no template literals), so
// nothing here is interpolated by this file.
const PROBE = [
  "const watched = JSON.parse(process.argv[2]);",
  "const touched = [];",
  "for (const name of watched) {",
  "  Object.defineProperty(globalThis, name, {",
  "    configurable: true,",
  "    get() { touched.push(name); throw new ReferenceError(name + ' read at import'); },",
  "    set(v) { touched.push(name + '='); }",
  "  });",
  "}",
  "const before = new Set(Reflect.ownKeys(globalThis).map(String));",
  "const resources = process.getActiveResourcesInfo().length;",
  "const core = await import(process.argv[1]);",
  "console.log(JSON.stringify({",
  "  touched,",
  "  added: Reflect.ownKeys(globalThis).map(String).filter((k) => !before.has(k)),",
  "  newResources: process.getActiveResourcesInfo().length - resources,",
  "  exports: Object.keys(core).length",
  "}));"
].join("\n");

function runNode(args) {
  const env = { ...process.env };
  // The child is a plain script, not a test file, and must not preload anything.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", env, windowsHide: true, timeout: 120000 });
}

test("the CI one-liner imports it with no Foundry globals", () => {
  const r = runNode(["-e", "import('./baron-core.js')"]);
  assert.equal(r.status, 0, r.stderr);
});

test("importing reads and writes no Foundry or browser global, and leaves nothing behind", () => {
  const r = runNode(["--input-type=module", "-e", PROBE, CORE_URL, JSON.stringify(WATCHED)]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.deepEqual(out.touched, [], "globals touched at import");
  assert.deepEqual(out.added, [], "globals added at import");
  assert.equal(out.newResources, 0, "timers or handles left running");
  assert.equal(out.exports, 23);
});

test("the probe does catch a module that reads a global at import", () => {
  const bad = "data:text/javascript," + encodeURIComponent("export const lang = game.i18n.lang;");
  const r = runNode(["--input-type=module", "-e", PROBE, bad, JSON.stringify(WATCHED)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /game read at import/);
});

test("no top-level await: the module loads synchronously through require()", (t) => {
  // require() of an ES module only works when its graph has no top-level
  // await; Node reports ERR_REQUIRE_ASYNC_MODULE otherwise. Older Node lines
  // without require(esm) cannot tell, so the test skips there.
  const r = runNode(["-e", "const m = require('./baron-core.js'); console.log(typeof m.injectSheetButton)"]);
  if (r.status !== 0 && /ERR_REQUIRE_ESM\b/.test(r.stderr)) return t.skip(`Node ${process.version} cannot require() ES modules`);
  assert.doesNotMatch(r.stderr, /ERR_REQUIRE_ASYNC_MODULE/, "top-level await in baron-core.js");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "function");
});

test("the require() check does catch top-level await", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "baron-core-tla-"));
  try {
    const file = join(dir, "tla.mjs");
    writeFileSync(file, "await Promise.resolve();\nexport const x = 1;\n");
    const r = runNode(["-e", `require(${JSON.stringify(file)})`]);
    if (/ERR_REQUIRE_ESM\b/.test(r.stderr)) return t.skip(`Node ${process.version} cannot require() ES modules`);
    assert.match(r.stderr, /ERR_REQUIRE_ASYNC_MODULE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
