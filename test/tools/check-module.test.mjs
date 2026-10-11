// check-module against test/fixtures: the valid module passes, and each
// negative case fails (or warns) on exactly the check it targets.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  VALID_MODULE,
  checkModule,
  childEnv,
  materialize,
  negativeCases,
  parseReport,
} from "./helpers.mjs";

test("the valid fixture passes every check", () => {
  const res = checkModule([VALID_MODULE]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual([...r.fail], [], res.out);
  assert.deepEqual([...r.warn], [], res.out);
  assert.deepEqual([...r.pass].sort(), ["a", "b", "c", "d", "g", "h", "i", "j", "k"], res.out);
  assert.equal(r.summary, "check-module: 9 passed, 0 warnings, 0 failed");
  // It does not vendor core: [e] says so and [f] stays silent.
  assert.ok(r.lines.some((l) => l.startsWith("NOTICE [e]") && l.includes("module does not vendor baron-core")), res.out);
  assert.ok(!r.lines.some((l) => l.includes("[f]")), res.out);
  // One unused key, reported once as a count; the runtime-built Kind_* keys are not "unused".
  const unused = r.lines.filter((l) => l.startsWith("NOTICE [h]"));
  assert.equal(unused.length, 1, res.out);
  assert.match(unused[0], /1 of 6 en\.json key\(s\) have no static reference.*baron-fixture\.Unused$/);
  assert.ok(r.lines.some((l) => l.startsWith("PASS   [h]") && l.includes("6 static reference(s) to 3 key(s)")), res.out);
});

test("the fixture's traps do not fire: comments, strings and regexes are not imports", () => {
  const res = checkModule([VALID_MODULE]);
  assert.ok(res.out.includes("PASS   [g] imports: 2 import(s) checked"), res.out);
});

for (const { name, spec } of negativeCases()) {
  test(`negative fixture ${name}: ${spec.description}`, (t) => {
    const dir = materialize(t, spec);
    const res = checkModule([dir]);
    const r = parseReport(res.out);
    if (spec.fails) {
      assert.equal(res.status, 1, res.out);
      assert.deepEqual([...r.fail], [spec.fails], `only [${spec.fails}] may fail\n${res.out}`);
      const line = r.lines.find((l) => l.startsWith(`FAIL   [${spec.fails}]`) && l.includes(spec.message));
      assert.ok(line, `no FAIL [${spec.fails}] line containing ${JSON.stringify(spec.message)}\n${res.out}`);
      assert.match(r.summary ?? "", /, [1-9]\d* failed$/);
    } else {
      assert.equal(res.status, 0, res.out);
      assert.deepEqual([...r.fail], [], res.out);
      assert.deepEqual([...r.warn], [spec.warns], res.out);
      assert.ok(r.lines.some((l) => l.startsWith(`WARN   [${spec.warns}]`) && l.includes(spec.message)), res.out);
    }
  });
}

test("--parity warn and baron.json langParity warn downgrade a parity gap to a warning", (t) => {
  const spec = negativeCases().find((c) => c.name === "lang-parity").spec;
  const dir = materialize(t, spec);
  const flag = checkModule([dir, "--parity", "warn"]);
  assert.equal(flag.status, 0, flag.out);
  assert.deepEqual([...parseReport(flag.out).warn], ["d"], flag.out);

  const viaConfig = materialize(t, { ...spec, merge: { "baron.json": { langParity: "warn" } } });
  const cfg = checkModule([viaConfig]);
  assert.equal(cfg.status, 0, cfg.out);
  assert.deepEqual([...parseReport(cfg.out).warn], ["d"], cfg.out);

  // And --parity error wins over a lenient baron.json.
  const strict = checkModule([viaConfig, "--parity=error"]);
  assert.equal(strict.status, 1, strict.out);
});

test("a module without baron.json gets the defaults, with a notice", (t) => {
  const dir = materialize(t, { delete: ["baron.json"] });
  const res = checkModule([dir]);
  assert.equal(res.status, 0, res.out);
  const notice = parseReport(res.out).lines.find((l) => l.startsWith("NOTICE [c]"));
  assert.ok(notice, res.out);
  assert.ok(notice.includes('"mode":"public"') && notice.includes('"i18nPrefix":"baron-fixture"') && notice.includes('"langParity":"error"'), notice);
});

test("under GitHub Actions, findings become annotations with paths relative to the workspace", (t) => {
  const spec = negativeCases().find((c) => c.name === "missing-i18n-key").spec;
  const dir = materialize(t, spec);
  const res = checkModule(["."], { cwd: dir, env: childEnv({ GITHUB_ACTIONS: "true" }) });
  assert.equal(res.status, 1, res.out);
  const line = res.out.split(/\r?\n/).find((l) => l.startsWith("::error "));
  assert.equal(line, '::error file=scripts/lib/more.js,line=3,title=check-module [h] i18n keys::"baron-fixture.NotThere" is not in lang/en.json');
  assert.ok(res.out.includes("::notice title=check-module [e] vendored core::module does not vendor baron-core"), res.out);
  // PASS lines are never annotations.
  assert.ok(!/^::\w+ .*PASS/m.test(res.out));
});

test("CRLF sources (git archive on Windows with autocrlf) check the same as LF", (t) => {
  const dir = materialize(t);
  for (const rel of ["scripts/main.js", "scripts/lib/util.js", "templates/panel.hbs", "lang/en.json", "lang/es.json", "module.json"]) {
    const file = path.join(dir, rel);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"));
  }
  const res = checkModule([dir]);
  assert.equal(res.status, 0, res.out);
  assert.equal(parseReport(res.out).summary, "check-module: 9 passed, 0 warnings, 0 failed");
});

test("usage errors exit 1 with a message", () => {
  const bad = checkModule([VALID_MODULE, "--parity", "sometimes"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--parity takes warn or error/);
  const unknown = checkModule([VALID_MODULE, "--frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --frobnicate/);
  const missing = checkModule([path.join(VALID_MODULE, "does-not-exist")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not a folder/);
});
