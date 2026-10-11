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
  assert.deepEqual([...r.pass].sort(), ["a", "b", "c", "d", "g", "h", "i", "j", "k", "l"], res.out);
  assert.equal(r.summary, "check-module: 10 passed, 0 warnings, 0 failed");
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

test("a relative import of the module's own modules/ subfolder stays inside the module", (t) => {
  const dir = materialize(t, {
    write: {
      "scripts/modules/helper.js": "export const helper = 1;\n",
      "scripts/lib/uses-helper.js": 'import { helper } from "../modules/helper.js";\nimport "./util.js";\n\nexport const twice = helper * 2;\n',
    },
  });
  const res = checkModule([dir]);
  assert.equal(res.status, 0, res.out);
  assert.ok(res.out.includes("PASS   [g] imports: 4 import(s) checked"), res.out);
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
  for (const rel of ["scripts/main.js", "scripts/lib/util.js", "templates/panel.hbs", "lang/en.json", "lang/es.json", "module.json", "NOTICE.md"]) {
    const file = path.join(dir, rel);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"));
  }
  const res = checkModule([dir]);
  assert.equal(res.status, 0, res.out);
  assert.equal(parseReport(res.out).summary, "check-module: 10 passed, 0 warnings, 0 failed");
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

/* ----------------------------------------------------------------------------
 * [l] Paizo license. The valid fixture is a CUP module; the single-change
 * failures live in ../fixtures/negative/paizo-*.json, the cases below need
 * more than one change or a closer look at the output.
 * -------------------------------------------------------------------------- */

const ORC_SENTENCE =
  "This product is licensed under the ORC License located at the Library of Congress at TX 9-307-067 and available online at various locations. All warranties are disclaimed as set forth therein.";

const ORC_FILLED_NOTICE = [
  "# Legal notices",
  "",
  "## ORC Notice",
  "",
  ORC_SENTENCE,
  "",
  "## Attribution Notice",
  "",
  "This product is based on the following Licensed Material:",
  "",
  "Example Work, (c) 2023 Example Publisher, Example Author.",
  "",
].join("\n");

// The ORC block of pf2e-module-template's NOTICE.md as init leaves it for
// "Baron Fixture" (abridged prose, every bracketed field kept), plus the
// brackets a finished notice may hold: quoted `[ ]`, inline and reference links.
const ORC_TEMPLATE_NOTICE = [
  "# Legal notices",
  "",
  "- Rellena todo lo que esta entre corchetes `[ ]` y borra estas notas antes de publicar.",
  "- Fuente: [ORC License](https://paizo.com/orclicense), su [Copyright Notice](https://paizo.com/orclicense) y [Copyright Notice][axe].",
  "",
  "### ORC Notice",
  "",
  ORC_SENTENCE,
  "",
  "### Attribution Notice",
  "",
  "This product is based on the following Licensed Material:",
  "",
  "[Title of Work], [Copyright Notice], [Author Credit Information].",
  "",
  "If you use our Licensed Material in your own published works, please credit us as follows:",
  "",
  "Baron Fixture, [Copyright Notice], BaronHVC.",
  "",
  "### Reserved Material Notice",
  "",
  "Reserved Material elements in this product include, but may not be limited to: [nombres, logos, arte e identidad comercial de Baron Fixture], and all elements designated as Reserved Material under the ORC License.",
  "",
  "### Expressly Designated Licensed Material",
  "",
  "The following elements are owned by the Licensor and would otherwise constitute Reserved Material and are hereby designated as Licensed Material: [ninguno].",
  "",
  "[axe]: https://paizo.com/orclicense",
  "",
].join("\n");

const lLines = (r, level) => r.lines.filter((l) => l.startsWith(`${level.padEnd(6)} [l]`));

test("[l] without a paizo key only notices, needs no NOTICE.md and is not counted", (t) => {
  const dir = materialize(t, {
    write: { "baron.json": JSON.stringify({ mode: "public", i18nPrefix: "baron-fixture", persisted: ["baron-fixture"] }) },
    delete: ["NOTICE.md"],
  });
  const res = checkModule([dir]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.ok(!r.pass.has("l") && !r.fail.has("l") && !r.warn.has("l"), res.out);
  assert.deepEqual(lLines(r, "NOTICE"), [
    'NOTICE [l] paizo license: baron.json does not declare "paizo" ("cup" or "orc"): the Paizo license and NOTICE.md are not checked',
  ]);
  assert.equal(r.summary, "check-module: 9 passed, 0 warnings, 0 failed");
});

test("[l] a protected module without a paizo key still only notices, but is told it needs orc", (t) => {
  const dir = materialize(t, {
    write: { "baron.json": JSON.stringify({ mode: "protected", i18nPrefix: "baron-fixture", persisted: ["baron-fixture"] }) },
  });
  const res = checkModule([dir]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.ok(!r.pass.has("l") && !r.fail.has("l") && !r.warn.has("l"), res.out);
  assert.deepEqual(lLines(r, "NOTICE"), [
    'NOTICE [l] paizo license: baron.json does not declare "paizo" ("cup" or "orc"): the Paizo license and NOTICE.md are not checked; a protected (paid) module must declare "orc", the Community Use Policy forbids charging',
  ]);
});

test("[l] an ORC module with a complete notice passes, public (freemium base) or protected (paid add-on)", (t) => {
  for (const mode of ["public", "protected"]) {
    const dir = materialize(t, { merge: { "baron.json": { mode, paizo: "orc" } }, write: { "NOTICE.md": ORC_FILLED_NOTICE } });
    const res = checkModule([dir]);
    const r = parseReport(res.out);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(lLines(r, "PASS"), ['PASS   [l] paizo license: paizo "orc", NOTICE.md carries the ORC Notice with every template field filled'], res.out);
    assert.equal(r.summary, "check-module: 10 passed, 0 warnings, 0 failed", res.out);
  }
});

test("[l] each unfilled field of the template's ORC block is reported on its line; quoted brackets and links are not fields", (t) => {
  const dir = materialize(t, { merge: { "baron.json": { paizo: "orc" } }, write: { "NOTICE.md": ORC_TEMPLATE_NOTICE } });
  const res = checkModule([dir]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual([...r.warn], ["l"], res.out);
  const lineOf = (s) => ORC_TEMPLATE_NOTICE.split("\n").findIndex((l) => l.includes(s)) + 1;
  const warn = (fields, at) => `WARN   [l] paizo license: unfilled template field(s) ${fields}: fill before publishing (NOTICE.md:${lineOf(at)})`;
  assert.deepEqual(lLines(r, "WARN"), [
    warn("[Title of Work], [Copyright Notice], [Author Credit Information]", "[Title of Work]"),
    warn("[Copyright Notice]", "Baron Fixture, [Copyright Notice]"),
    warn("[nombres, logos, arte e identidad comercial de Baron Fixture]", "[nombres,"),
    warn("[ninguno]", "[ninguno]"),
  ]);
  assert.equal(r.summary, "check-module: 9 passed, 1 warnings, 0 failed");

  // Under GitHub Actions each line becomes a warning annotation on NOTICE.md.
  const ci = checkModule(["."], { cwd: dir, env: childEnv({ GITHUB_ACTIONS: "true" }) });
  assert.ok(
    ci.out.includes(`::warning file=NOTICE.md,line=${lineOf("[ninguno]")},title=check-module [l] paizo license::unfilled template field(s) [ninguno]: fill before publishing`),
    ci.out,
  );
});

test("[l] a hard-wrapped or quoted notice still has every unfilled field reported, on the line where it starts", (t) => {
  // Word-wraps every line at 40 columns, as an editor or Prettier's proseWrap
  // would, so the long fields end up split across lines.
  const wrap = (text, quote) =>
    text
      .split("\n")
      .flatMap((line) => {
        const out = [];
        let cur = "";
        for (const w of line.split(" ")) {
          if (cur && `${cur} ${w}`.length > 40) {
            out.push(cur);
            cur = w;
          } else cur = cur ? `${cur} ${w}` : w;
        }
        out.push(cur);
        return out;
      })
      .map((l) => (quote && l ? `> ${l}` : l))
      .join("\n");
  const expected = [
    "[Title of Work]",
    "[Copyright Notice]",
    "[Author Credit Information]",
    "[Copyright Notice]",
    "[nombres, logos, arte e identidad comercial de Baron Fixture]",
    "[ninguno]",
  ];
  for (const quote of [false, true]) {
    const notice = wrap(ORC_TEMPLATE_NOTICE, quote);
    const dir = materialize(t, { merge: { "baron.json": { paizo: "orc" } }, write: { "NOTICE.md": notice } });
    const res = checkModule([dir]);
    assert.equal(res.status, 0, res.out);
    const warns = lLines(parseReport(res.out), "WARN");
    const fields = warns.flatMap((l) => /unfilled template field\(s\) (.*): fill before publishing/.exec(l)[1].split(/, (?=\[)/));
    assert.deepEqual(fields, expected, res.out);
    const lines = notice.split("\n");
    for (const l of warns) {
      const [, first, at] = /field\(s\) (\[[^,\]]*).*NOTICE\.md:(\d+)\)$/.exec(l);
      assert.ok(lines[at - 1].includes(first.split(" ")[0]), `${l}\n${lines[at - 1]}`);
    }
  }
});

test("[l] the notice is matched as GitHub shows it: quote markers, emphasis and links do not hide it, an HTML comment does", (t) => {
  const ORC_FILLED = ORC_FILLED_NOTICE;
  assert.ok(ORC_FILLED.split("the ORC License").length === 2);
  const run = (notice) => checkModule([materialize(t, { merge: { "baron.json": { paizo: "orc" } }, write: { "NOTICE.md": notice } })]);
  const shown = {
    quoted: ORC_FILLED.replace(ORC_SENTENCE, `> This product is licensed under the\n> ORC License located at the Library of Congress at TX 9-307-067 and available\n> online at various locations. All warranties are disclaimed as set forth therein.`),
    bold: ORC_FILLED.replace("the ORC License", "the **ORC License**"),
    linked: ORC_FILLED.replace("the ORC License", "the [ORC License](https://paizo.com/orclicense)"),
  };
  for (const [name, notice] of Object.entries(shown)) {
    const res = run(notice);
    assert.equal(res.status, 0, `${name}\n${res.out}`);
    assert.equal(parseReport(res.out).summary, "check-module: 10 passed, 0 warnings, 0 failed", `${name}\n${res.out}`);
  }
  const hidden = run(ORC_FILLED.replace(ORC_SENTENCE, `<!-- ${ORC_SENTENCE} -->`));
  assert.equal(hidden.status, 1, hidden.out);
  assert.ok(lLines(parseReport(hidden.out), "FAIL")[0]?.includes("lacks the ORC Notice"), hidden.out);
});

test("[l] a NOTICE.md with both notices fails whichever license is declared: a paid module must not say it is free", (t) => {
  const cupLine = fs.readFileSync(path.join(VALID_MODULE, "NOTICE.md"), "utf8").split(/\r?\n/).find((l) => l.includes("used under Paizo's"));
  const both = `${ORC_FILLED_NOTICE}\n## Community Use Policy\n\n${cupLine}\n`;
  for (const [baron, other] of [
    [{ mode: "protected", paizo: "orc" }, "Community Use Policy notice"],
    [{ mode: "public", paizo: "orc" }, "Community Use Policy notice"],
    [{ mode: "public", paizo: "cup" }, "ORC Notice"],
  ]) {
    const res = checkModule([materialize(t, { merge: { "baron.json": baron }, write: { "NOTICE.md": both } })]);
    const r = parseReport(res.out);
    assert.equal(res.status, 1, res.out);
    assert.deepEqual([...r.fail], ["l"], res.out);
    const fails = lLines(r, "FAIL");
    assert.equal(fails.length, 1, res.out);
    assert.ok(fails[0].includes(`paizo is "${baron.paizo}" but NOTICE.md also carries the ${other}`) && fails[0].endsWith("(NOTICE.md)"), res.out);
  }
});

test("[l] a hard-wrapped notice with a typographic apostrophe still carries the CUP notice", (t) => {
  const apostrophe = String.fromCharCode(0x2019);
  const notice = `# Legal notices\n\nBaron Fixture uses trademarks and/or copyrights owned by Paizo Inc., used\nunder Paizo${apostrophe}s Community Use\n  Policy (paizo.com/licenses/communityuse).\n`;
  const dir = materialize(t, { write: { "NOTICE.md": notice } });
  const res = checkModule([dir]);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(lLines(parseReport(res.out), "PASS"), ['PASS   [l] paizo license: paizo "cup", NOTICE.md carries the Community Use Policy notice']);
});

test("[l] Paizo or one of its games in the id or title warns under orc, never under cup", (t) => {
  const orc = (moduleJson) =>
    checkModule([materialize(t, { merge: { "baron.json": { paizo: "orc" }, "module.json": moduleJson }, write: { "NOTICE.md": ORC_FILLED_NOTICE } })]);

  const byId = orc({ id: "pathfinder-fixture" });
  assert.equal(byId.status, 0, byId.out);
  assert.deepEqual([...parseReport(byId.out).warn], ["l"], byId.out);
  assert.match(lLines(parseReport(byId.out), "WARN").join("\n"), /^WARN {3}\[l\] paizo license: module\.json id "pathfinder-fixture" name\(s\) Paizo or one of its games \(PF2e, Pathfinder, Starfinder, Golarion\): the ORC License never licenses Paizo's trademarks.* \(module\.json\)$/);

  const both = orc({ id: "pf2e-fixture", title: "Pathfinder Fixture" });
  assert.equal(lLines(parseReport(both.out), "WARN").length, 1, both.out);
  assert.ok(both.out.includes('module.json id "pf2e-fixture" and title "Pathfinder Fixture" name(s) Paizo or one of its games'), both.out);

  for (const moduleJson of [{ title: "Paizo Trap Tools" }, { title: "Starfinder Trap Tools" }, { title: "Golarion Trap Tools" }, { id: "pf2-fixture" }, { id: "sf2e-fixture" }]) {
    const res = orc(moduleJson);
    const [k, v] = Object.entries(moduleJson)[0];
    assert.equal(lLines(parseReport(res.out), "WARN").length, 1, res.out);
    assert.ok(res.out.includes(`module.json ${k} ${JSON.stringify(v)} name(s) Paizo or one of its games`), res.out);
  }
  // Neither the fixture's own id and title nor a word that merely contains
  // the letters (Baron, Fixture) set it off.
  const plain = orc({});
  assert.equal(parseReport(plain.out).summary, "check-module: 10 passed, 0 warnings, 0 failed", plain.out);

  const cup = checkModule([materialize(t, { merge: { "module.json": { id: "pf2e-fixture", title: "PF2e Baron Fixture" } } })]);
  assert.equal(cup.status, 0, cup.out);
  assert.equal(parseReport(cup.out).summary, "check-module: 10 passed, 0 warnings, 0 failed", cup.out);
});

test("[l] NOTICE.md must have that exact name: Linux hosts and GitHub links are case-sensitive", (t) => {
  const dir = materialize(t);
  fs.renameSync(path.join(dir, "NOTICE.md"), path.join(dir, "notice.md"));
  const res = checkModule([dir]);
  const r = parseReport(res.out);
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...r.fail], ["l"], res.out);
  assert.ok(lLines(r, "FAIL")[0]?.includes('NOTICE.md does not exist (only "notice.md"'), res.out);
});

test("[l] protected with cup fails on the license and still checks the notice", (t) => {
  const dir = materialize(t, { merge: { "baron.json": { mode: "protected" } }, write: { "NOTICE.md": ORC_FILLED_NOTICE } });
  const res = checkModule([dir]);
  const fails = lLines(parseReport(res.out), "FAIL");
  assert.equal(res.status, 1, res.out);
  assert.equal(fails.length, 3, res.out);
  assert.ok(fails[0].includes('mode "protected" with paizo "cup"') && fails[0].endsWith("(baron.json)"), res.out);
  assert.ok(fails[1].includes("lacks the Community Use Policy notice") && fails[1].endsWith("(NOTICE.md)"), res.out);
  assert.ok(fails[2].includes("also carries the ORC Notice") && fails[2].endsWith("(NOTICE.md)"), res.out);
  // The way out names init's output, which keeps exactly one block filled in.
  assert.ok(fails[1].includes("tools/init-module.mjs --paizo cup"), res.out);
});
