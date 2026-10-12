// check-module against test/fixtures: the valid module passes, and each
// negative case fails (or warns) on exactly the check it targets.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  REPO,
  VALID_MODULE,
  checkModule,
  childEnv,
  materialize,
  negativeCases,
  parseReport,
  readText,
} from "./helpers.mjs";

test("the valid fixture passes every check", () => {
  const res = checkModule([VALID_MODULE]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual([...r.fail], [], res.out);
  assert.deepEqual([...r.warn], [], res.out);
  assert.deepEqual([...r.pass].sort(), ["a", "b", "c", "d", "g", "h", "i", "j", "k", "l", "n"], res.out);
  assert.equal(r.summary, "check-module: 11 passed, 0 warnings, 0 failed");
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
  assert.equal(parseReport(res.out).summary, "check-module: 11 passed, 0 warnings, 0 failed");
});

test("usage errors exit 1 with a message", () => {
  const bad = checkModule([VALID_MODULE, "--parity", "sometimes"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--parity takes warn or error/);
  const unknown = checkModule([VALID_MODULE, "--frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --frobnicate/);
  // --release is a plain switch: it takes no value.
  const valued = checkModule([VALID_MODULE, "--release=yes"]);
  assert.equal(valued.status, 1);
  assert.match(valued.stderr, /unknown option --release=yes/);
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

// What rule [m] asks of a protected module beyond [l]: a landing page in
// baron.json and its free base in relationships.requires (the fixture's own
// pf2e system relationship kept, since a merge replaces the whole key).
const LANDING_URL = "https://www.example.com/baron-fixture";
const PF2E_SYSTEM = { id: "pf2e", type: "system", compatibility: { minimum: "7.0.0" } };
const ADDON_RELATIONSHIPS = {
  relationships: { systems: [PF2E_SYSTEM], requires: [{ id: "baron-fixture-base", type: "module", compatibility: {} }] },
};

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
    'NOTICE [l] paizo license: baron.json does not declare "paizo" ("cup" or "orc"): the Paizo license is not checked and NOTICE.md is not required',
  ]);
  assert.equal(r.summary, "check-module: 10 passed, 0 warnings, 0 failed");
});

test("[l] a protected module without a paizo key still only notices, but is told it needs orc", (t) => {
  const dir = materialize(t, {
    write: { "baron.json": JSON.stringify({ mode: "protected", landingUrl: LANDING_URL, i18nPrefix: "baron-fixture", persisted: ["baron-fixture"] }) },
    merge: { "module.json": ADDON_RELATIONSHIPS },
  });
  const res = checkModule([dir]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.ok(!r.pass.has("l") && !r.fail.has("l") && !r.warn.has("l"), res.out);
  assert.deepEqual(lLines(r, "NOTICE"), [
    'NOTICE [l] paizo license: baron.json does not declare "paizo" ("cup" or "orc"): the Paizo license is not checked and NOTICE.md is not required; a protected (paid) module must declare "orc", the Community Use Policy forbids charging',
  ]);
});

test("[l] an ORC module with a complete notice passes, public (freemium base) or protected (paid add-on)", (t) => {
  for (const mode of ["public", "protected"]) {
    const dir = materialize(t, {
      merge: { "baron.json": { mode, paizo: "orc", landingUrl: LANDING_URL }, "module.json": ADDON_RELATIONSHIPS },
      write: { "NOTICE.md": ORC_FILLED_NOTICE },
    });
    const res = checkModule([dir]);
    const r = parseReport(res.out);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(lLines(r, "PASS"), ['PASS   [l] paizo license: paizo "orc", NOTICE.md carries the ORC Notice with every template field filled'], res.out);
    // Rule [m] only counts for the protected one.
    assert.equal(r.summary, `check-module: ${mode === "protected" ? 12 : 11} passed, 0 warnings, 0 failed`, res.out);
  }
});

test("[l] each unfilled field of the template's ORC block is reported on its line; quoted brackets and links are not fields", (t) => {
  const dir = materialize(t, { merge: { "baron.json": { paizo: "orc" } }, write: { "NOTICE.md": ORC_TEMPLATE_NOTICE } });
  const res = checkModule([dir]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual([...r.warn], ["l"], res.out);
  const lineOf = (s) => ORC_TEMPLATE_NOTICE.split("\n").findIndex((l) => l.includes(s)) + 1;
  const warn = (fields, at) => `WARN   [l] paizo license: unfilled template field(s) ${fields}: fill them before tagging, the release refuses them (NOTICE.md:${lineOf(at)})`;
  assert.deepEqual(lLines(r, "WARN"), [
    warn("[Title of Work], [Copyright Notice], [Author Credit Information]", "[Title of Work]"),
    warn("[Copyright Notice]", "Baron Fixture, [Copyright Notice]"),
    warn("[nombres, logos, arte e identidad comercial de Baron Fixture]", "[nombres,"),
    warn("[ninguno]", "[ninguno]"),
  ]);
  assert.equal(r.summary, "check-module: 10 passed, 1 warnings, 0 failed");

  // Under GitHub Actions each line becomes a warning annotation on NOTICE.md.
  const ci = checkModule(["."], { cwd: dir, env: childEnv({ GITHUB_ACTIONS: "true" }) });
  assert.ok(
    ci.out.includes(`::warning file=NOTICE.md,line=${lineOf("[ninguno]")},title=check-module [l] paizo license::unfilled template field(s) [ninguno]: fill them before tagging, the release refuses them`),
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
    const fields = warns.flatMap((l) => /unfilled template field\(s\) (.*): fill them before tagging/.exec(l)[1].split(/, (?=\[)/));
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
    assert.equal(parseReport(res.out).summary, "check-module: 11 passed, 0 warnings, 0 failed", `${name}\n${res.out}`);
  }
  const hidden = run(ORC_FILLED.replace(ORC_SENTENCE, `<!-- ${ORC_SENTENCE} -->`));
  assert.equal(hidden.status, 1, hidden.out);
  assert.ok(lLines(parseReport(hidden.out), "FAIL")[0]?.includes("lacks the ORC Notice"), hidden.out);
});

test("[l] a NOTICE.md with both notices fails whichever license is declared: a paid module must not say it is free", (t) => {
  const cupLine = fs.readFileSync(path.join(VALID_MODULE, "NOTICE.md"), "utf8").split(/\r?\n/).find((l) => l.includes("used under Paizo's"));
  const both = `${ORC_FILLED_NOTICE}\n## Community Use Policy\n\n${cupLine}\n`;
  for (const [baron, other] of [
    [{ mode: "protected", paizo: "orc", landingUrl: LANDING_URL }, "Community Use Policy notice"],
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
  assert.equal(parseReport(plain.out).summary, "check-module: 11 passed, 0 warnings, 0 failed", plain.out);

  const cup = checkModule([materialize(t, { merge: { "module.json": { id: "pf2e-fixture", title: "PF2e Baron Fixture" } } })]);
  assert.equal(cup.status, 0, cup.out);
  assert.equal(parseReport(cup.out).summary, "check-module: 11 passed, 0 warnings, 0 failed", cup.out);
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

test("[l] --release turns each unfilled ORC field into a failure on the same line", (t) => {
  const dir = materialize(t, { merge: { "baron.json": { paizo: "orc" } }, write: { "NOTICE.md": ORC_TEMPLATE_NOTICE } });
  const res = checkModule([dir, "--release"]);
  const r = parseReport(res.out);
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...r.fail], ["l"], res.out);
  assert.deepEqual(lLines(r, "WARN"), [], res.out);
  const lineOf = (s) => ORC_TEMPLATE_NOTICE.split("\n").findIndex((l) => l.includes(s)) + 1;
  const reason = "the release does not publish an incomplete ORC notice; fill them and tag again";
  const fail = (fields, at) => `FAIL   [l] paizo license: unfilled template field(s) ${fields}: ${reason} (NOTICE.md:${lineOf(at)})`;
  assert.deepEqual(lLines(r, "FAIL"), [
    fail("[Title of Work], [Copyright Notice], [Author Credit Information]", "[Title of Work]"),
    fail("[Copyright Notice]", "Baron Fixture, [Copyright Notice]"),
    fail("[nombres, logos, arte e identidad comercial de Baron Fixture]", "[nombres,"),
    fail("[ninguno]", "[ninguno]"),
  ]);
  assert.equal(r.summary, "check-module: 10 passed, 0 warnings, 1 failed");

  // Under GitHub Actions each line becomes an error annotation on NOTICE.md.
  const ci = checkModule([".", "--release"], { cwd: dir, env: childEnv({ GITHUB_ACTIONS: "true" }) });
  assert.equal(ci.status, 1, ci.out);
  assert.ok(ci.out.includes(`::error file=NOTICE.md,line=${lineOf("[ninguno]")},title=check-module [l] paizo license::unfilled template field(s) [ninguno]: ${reason}`), ci.out);
});

test("[l] --release keeps the trademark warning a warning: an open legal question, not a field to fill", (t) => {
  const dir = materialize(t, {
    merge: { "baron.json": { paizo: "orc" }, "module.json": { id: "pathfinder-fixture" } },
    write: { "NOTICE.md": ORC_FILLED_NOTICE },
  });
  const res = checkModule([dir, "--release"]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual([...r.fail], [], res.out);
  assert.deepEqual([...r.warn], ["l"], res.out);
  const warns = lLines(r, "WARN");
  assert.equal(warns.length, 1, res.out);
  assert.ok(warns[0].includes('module.json id "pathfinder-fixture" name(s) Paizo or one of its games'), res.out);
});

// The family marker for a legal field awaiting the author's sign-off, plain
// and as pf2e-simple-weapon-editor writes it (bold, naming who decides), plus
// one inside an HTML comment: GitHub hides it, the sign-off is still open.
const PENDING_REASON = "settle it and delete the marker before tagging, the release refuses it";
const PENDING_RELEASE_REASON = "and the release does not publish it; settle it, delete the marker and tag again";
const pendingLine = (level, marker, line) =>
  level === "FAIL"
    ? `FAIL   [l] paizo license: "${marker}" marker: a legal field awaits the author's sign-off ${PENDING_RELEASE_REASON} (NOTICE.md:${line})`
    : `WARN   [l] paizo license: "${marker}" marker: a legal field awaits the author's sign-off; ${PENDING_REASON} (NOTICE.md:${line})`;

test("[l] a PENDIENTE: line in NOTICE.md warns on a push and fails with --release, under either license", (t) => {
  const cupNotice = fs.readFileSync(path.join(VALID_MODULE, "NOTICE.md"), "utf8").replace(/\r\n/g, "\n").trimEnd();
  const cases = {
    cup: {
      baron: {},
      notice: `${cupNotice}\n\nPENDIENTE: confirm the product name with the author.\n`,
      markers: ["PENDIENTE:"],
    },
    orc: {
      baron: { paizo: "orc" },
      notice: ORC_FILLED_NOTICE.replace(
        "## Attribution Notice\n",
        "## Attribution Notice\n\n> **PENDIENTE (autor):** check each attribution against the book's own ORC notice.\n\n<!-- PENDIENTE: the designated material -->\n",
      ),
      markers: ["PENDIENTE (autor):", "PENDIENTE:"],
    },
  };
  for (const [license, { baron, notice, markers }] of Object.entries(cases)) {
    const lines = notice.split("\n").map((l, i) => [l, i + 1]).filter(([l]) => l.includes("PENDIENTE")).map(([, n]) => n);
    assert.equal(lines.length, markers.length, license);
    const dir = materialize(t, { merge: { "baron.json": baron }, write: { "NOTICE.md": notice } });

    const push = checkModule([dir]);
    const pr = parseReport(push.out);
    assert.equal(push.status, 0, `${license}\n${push.out}`);
    assert.deepEqual([...pr.warn], ["l"], push.out);
    assert.deepEqual(lLines(pr, "WARN"), markers.map((m, i) => pendingLine("WARN", m, lines[i])), push.out);

    const release = checkModule([dir, "--release"]);
    const rr = parseReport(release.out);
    assert.equal(release.status, 1, `${license}\n${release.out}`);
    assert.deepEqual([...rr.fail], ["l"], release.out);
    assert.deepEqual(lLines(rr, "WARN"), [], release.out);
    assert.deepEqual(lLines(rr, "FAIL"), markers.map((m, i) => pendingLine("FAIL", m, lines[i])), release.out);
  }
});

test("[l] only the upper-case PENDIENTE followed by a colon is the marker: prose that says pendiente is text", (t) => {
  const cupNotice = fs.readFileSync(path.join(VALID_MODULE, "NOTICE.md"), "utf8").replace(/\r\n/g, "\n").trimEnd();
  const prose = [
    "Nada queda pendiente: todo esta firmado.",
    "Estado: PENDIENTE de revisar en la siguiente version.",
    "PENDIENTES: ninguno.",
    "Clave XPENDIENTE: interna.",
    "Sin dos puntos: PENDIENTE (autor) revisa.",
  ];
  const dir = materialize(t, { write: { "NOTICE.md": `${cupNotice}\n\n${prose.join("\n\n")}\n` } });
  const res = checkModule([dir, "--release"]);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(lLines(parseReport(res.out), "PASS"), ['PASS   [l] paizo license: paizo "cup", NOTICE.md carries the Community Use Policy notice'], res.out);
});

// Emphasis around the word or the parenthetical, and spaces before the colon,
// still read as the marker; the report names it without them.
test("[l] the PENDIENTE: marker counts whatever emphasis or spacing wraps it", (t) => {
  const cupNotice = fs.readFileSync(path.join(VALID_MODULE, "NOTICE.md"), "utf8").replace(/\r\n/g, "\n").trimEnd();
  const spellings = [
    ["__PENDIENTE:__ x", "PENDIENTE:"],
    ["_PENDIENTE:_ x", "PENDIENTE:"],
    ["**PENDIENTE**: x", "PENDIENTE:"],
    ["*PENDIENTE*: x", "PENDIENTE:"],
    ["PENDIENTE : x", "PENDIENTE:"],
    ["**PENDIENTE (autor)**: x", "PENDIENTE (autor):"],
    ["**PENDIENTE** (autor): x", "PENDIENTE (autor):"],
  ];
  const head = cupNotice.split("\n").length + 2;
  const dir = materialize(t, { write: { "NOTICE.md": `${cupNotice}\n\n${spellings.map(([s]) => s).join("\n\n")}\n` } });

  const push = checkModule([dir]);
  const pr = parseReport(push.out);
  assert.equal(push.status, 0, push.out);
  assert.deepEqual(lLines(pr, "WARN"), spellings.map(([, m], i) => pendingLine("WARN", m, head + 2 * i)), push.out);

  const release = checkModule([dir, "--release"]);
  const rr = parseReport(release.out);
  assert.equal(release.status, 1, release.out);
  assert.deepEqual([...rr.fail], ["l"], release.out);
  assert.deepEqual(lLines(rr, "FAIL"), spellings.map(([, m], i) => pendingLine("FAIL", m, head + 2 * i)), release.out);
});

test("[l] without a paizo key a PENDIENTE: line is still reported: the release ships NOTICE.md whatever the license", (t) => {
  const dir = materialize(t, {
    write: {
      "baron.json": JSON.stringify({ mode: "public", i18nPrefix: "baron-fixture", persisted: ["baron-fixture"] }),
      "NOTICE.md": "# Legal notices\n\nPENDIENTE: choose the Paizo license.\n",
    },
  });
  const notice = 'NOTICE [l] paizo license: baron.json does not declare "paizo" ("cup" or "orc"): the Paizo license is not checked and NOTICE.md is not required';

  const push = checkModule([dir]);
  const pr = parseReport(push.out);
  assert.equal(push.status, 0, push.out);
  assert.deepEqual([...pr.warn], ["l"], push.out);
  assert.deepEqual(lLines(pr, "WARN"), [pendingLine("WARN", "PENDIENTE:", 3)], push.out);
  assert.deepEqual(lLines(pr, "NOTICE"), [notice], push.out);

  const release = checkModule([dir, "--release"]);
  const rr = parseReport(release.out);
  assert.equal(release.status, 1, release.out);
  assert.deepEqual([...rr.fail], ["l"], release.out);
  assert.deepEqual(lLines(rr, "FAIL"), [pendingLine("FAIL", "PENDIENTE:", 3)], release.out);
});

/* ----------------------------------------------------------------------------
 * [m] protected packaging. Only a protected (paid) module is checked; each
 * case below turns the public fixture into a complete paid add-on (ORC notice,
 * landing page, requires its base) and breaks one thing.
 * -------------------------------------------------------------------------- */

const mLines = (r, level) => r.lines.filter((l) => l.startsWith(`${level.padEnd(6)} [m]`));

// A merge replaces whole keys, and JSON drops undefined ones: baron
// { landingUrl: undefined } removes the field.
const paidAddon = (t, { baron = {}, moduleJson = {} } = {}) =>
  materialize(t, {
    merge: {
      "baron.json": { mode: "protected", paizo: "orc", landingUrl: LANDING_URL, ...baron },
      "module.json": { ...ADDON_RELATIONSHIPS, ...moduleJson },
    },
    write: { "NOTICE.md": ORC_FILLED_NOTICE },
  });

test("[m] a public module prints nothing for it and is not counted, whatever its landingUrl", (t) => {
  const valid = checkModule([VALID_MODULE]);
  assert.ok(!valid.out.includes("[m]"), valid.out);
  assert.equal(parseReport(valid.out).summary, "check-module: 11 passed, 0 warnings, 0 failed");
  // The template gives every module "landingUrl": "", and a public one never uses it.
  for (const landingUrl of ["", "http://www.example.com", "https://github.com/BaronHVC/baron-fixture"]) {
    const res = checkModule([materialize(t, { merge: { "baron.json": { landingUrl } } })]);
    assert.equal(res.status, 0, res.out);
    assert.ok(!res.out.includes("[m]"), res.out);
  }
});

test("[m] a paid add-on with an https landing page that requires its base passes", (t) => {
  const res = checkModule([paidAddon(t)]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(mLines(r, "PASS"), [`PASS   [m] protected packaging: landing page ${LANDING_URL}, requires baron-fixture-base`], res.out);
  assert.equal(r.summary, "check-module: 12 passed, 0 warnings, 0 failed", res.out);
});

test("[m] a missing, empty, malformed, non-https or GitHub landingUrl fails on baron.json", (t) => {
  for (const [landingUrl, reason] of [
    [undefined, "landingUrl is missing"],
    ["", "landingUrl is empty"],
    ["   ", "landingUrl is empty"],
    [42, "landingUrl must be a string"],
    ["www.patreon.com/baron", 'landingUrl "www.patreon.com/baron" is not a URL'],
    ["http://www.example.com/baron-fixture", 'landingUrl "http://www.example.com/baron-fixture" is not an https URL'],
    ["https://www.example.com/baron fixture", 'landingUrl "https://www.example.com/baron fixture" contains whitespace'],
    ["https://GitHub.com/BaronHVC/baron-fixture", 'landingUrl "https://GitHub.com/BaronHVC/baron-fixture" points at GitHub'],
    // Every GitHub host can name the private repo, percent-escaped too.
    ["https://raw.githubusercontent.com/BaronHVC/baron-fixture/main/README.md", 'landingUrl "https://raw.githubusercontent.com/BaronHVC/baron-fixture/main/README.md" points at GitHub'],
    ["https://baronhvc.github.io/baron-fixture", 'landingUrl "https://baronhvc.github.io/baron-fixture" points at GitHub'],
    ["https://github%2Ecom/BaronHVC/baron-fixture", 'landingUrl "https://github%2Ecom/BaronHVC/baron-fixture" points at GitHub'],
  ]) {
    const res = checkModule([paidAddon(t, { baron: { landingUrl } })]);
    const r = parseReport(res.out);
    assert.equal(res.status, 1, res.out);
    assert.deepEqual([...r.fail], ["m"], res.out);
    const fails = mLines(r, "FAIL");
    assert.equal(fails.length, 1, res.out);
    assert.ok(fails[0].startsWith(`FAIL   [m] protected packaging: ${reason}`) && fails[0].endsWith("(baron.json)"), `${reason}\n${res.out}`);
  }
});

test("[m] without a module in relationships.requires it only warns: a freemium add-on requires its base", (t) => {
  const warning = "WARN   [m] protected packaging: relationships.requires lists no module: a freemium add-on requires its free base";
  for (const relationships of [
    { systems: [PF2E_SYSTEM] },
    { systems: [PF2E_SYSTEM], requires: [] },
    { systems: [PF2E_SYSTEM], requires: [{ id: "pf2e", type: "system" }] },
    { systems: [PF2E_SYSTEM], requires: [null, { type: "module" }, { id: "" }] },
  ]) {
    const res = checkModule([paidAddon(t, { moduleJson: { relationships } })]);
    const r = parseReport(res.out);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual([...r.warn], ["m"], res.out);
    assert.ok(mLines(r, "WARN")[0]?.startsWith(warning) && mLines(r, "WARN")[0].endsWith("(module.json)"), res.out);
  }

  // The core is never the base: [j] fails it and [m] still finds no module.
  const core = checkModule([paidAddon(t, { moduleJson: { relationships: { systems: [PF2E_SYSTEM], requires: [{ id: "pf2e-baron-core", type: "module" }] } } })]);
  const rc = parseReport(core.out);
  assert.equal(core.status, 1, core.out);
  assert.deepEqual([...rc.fail], ["j"], core.out);
  assert.deepEqual([...rc.warn], ["m"], core.out);

  // Without "type" an entry is a module, Foundry's default.
  const untyped = checkModule([paidAddon(t, { moduleJson: { relationships: { requires: [{ id: "baron-fixture-base" }] } } })]);
  assert.equal(parseReport(untyped.out).summary, "check-module: 12 passed, 0 warnings, 0 failed", untyped.out);
});

test("[m] GitHub links the protected release would refuse fail with their JSON paths; url, manifest and download do not", (t) => {
  const res = checkModule([
    paidAddon(t, {
      moduleJson: {
        authors: [{ name: "BaronHVC", url: "https://GitHub.com/BaronHVC" }],
        bugs: "https://github.com/BaronHVC/baron-fixture/issues",
        readme: "https://raw.githubusercontent.com/BaronHVC/baron-fixture/main/README.md",
        changelog: "https://baronhvc.github.io/baron-fixture/changelog",
        flags: { "https://github.com/BaronHVC/baron-fixture": true },
      },
    }),
  ]);
  const r = parseReport(res.out);
  // The tag build would refuse them, so a push must not stay green.
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...r.fail], ["m"], res.out);
  assert.deepEqual([...r.warn], [], res.out);
  // authors comes first: a merge keeps an existing key where it was.
  assert.deepEqual(mLines(r, "FAIL"), [
    'FAIL   [m] protected packaging: authors[0].url, bugs, readme, changelog, flags["https://github.com/BaronHVC/baron-fixture"] (key) still link to GitHub: the protected release refuses them, since the repo is private; point them at a public page or remove them (module.json)',
  ]);
});

test("[m] the base's GitHub manifest in requires fails on its own terms: list the base on foundryvtt.com, not the private repo", (t) => {
  const base = { id: "baron-fixture-base", type: "module", manifest: "https://github.com/BaronHVC/baron-fixture-base/releases/latest/download/module.json" };
  const res = checkModule([paidAddon(t, { moduleJson: { relationships: { systems: [PF2E_SYSTEM], requires: [base] } } })]);
  const r = parseReport(res.out);
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...r.fail], ["m"], res.out);
  assert.deepEqual(mLines(r, "FAIL"), [
    "FAIL   [m] protected packaging: relationships.requires[0].manifest link to GitHub: the protected release refuses every GitHub link, a dependency's manifest included; remove it and list that module on foundryvtt.com, where Foundry finds a dependency by its id alone (module.json)",
  ]);
});

/* ----------------------------------------------------------------------------
 * [n] human text. Foundry's AI policy wants UI labels and listing text written
 * by a person: a Claude session leaves "TODO-HUMANO: <what it should say>" as
 * the value, every push warns and the tag build (--release) fails.
 * -------------------------------------------------------------------------- */

const nLines = (r, level) => r.lines.filter((l) => l.startsWith(`${level.padEnd(6)} [n]`));
const todo = (what) => `TODO-HUMANO: ${what}`;
const PUSH_REASON = "a person writes them before tagging, the release refuses them (Foundry's AI policy)";
const RELEASE_REASON = "Foundry's AI policy wants UI and listing text written by a person; write them and tag again";
const nLine = (level, count, keys, reason, file) =>
  `${level.padEnd(6)} [n] human text: ${count} value(s) still start with "TODO-HUMANO:" (${keys}): ${reason} (${file})`;

// Placeholders in both language files and in the listing fields, one of them
// indented and one after a newline and a tab: leading whitespace is trimmed.
const HUMAN_SPEC = {
  merge: {
    "module.json": { title: todo("module name"), description: `  ${todo("one-sentence summary for the package listing")}` },
    "lang/en.json": { "baron-fixture.Open": todo("label of the button that opens the panel"), "baron-fixture.Notice": `\n\t${todo("notice")}` },
    "lang/es.json": { "baron-fixture.Open": todo("traducir la etiqueta de en.json") },
  },
};

test("[n] a module without placeholders passes, with or without --release", () => {
  for (const args of [[VALID_MODULE], [VALID_MODULE, "--release"]]) {
    const res = checkModule(args);
    const r = parseReport(res.out);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(nLines(r, "PASS"), ["PASS   [n] human text: no TODO-HUMANO placeholders in 2 language file(s) or in module.json title and description"], res.out);
    assert.equal(r.summary, "check-module: 11 passed, 0 warnings, 0 failed", res.out);
  }
});

test("[n] placeholders in lang files and in module.json warn on a push, one line per file", (t) => {
  const res = checkModule([materialize(t, HUMAN_SPEC)]);
  const r = parseReport(res.out);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual([...r.fail], [], res.out);
  assert.deepEqual([...r.warn], ["n"], res.out);
  assert.deepEqual(nLines(r, "WARN"), [
    nLine("WARN", 2, "title, description", PUSH_REASON, "module.json"),
    nLine("WARN", 2, "baron-fixture.Open, baron-fixture.Notice", PUSH_REASON, "lang/en.json"),
    nLine("WARN", 1, "baron-fixture.Open", PUSH_REASON, "lang/es.json"),
  ]);
  assert.equal(r.summary, "check-module: 10 passed, 1 warnings, 0 failed", res.out);
});

test("[n] --release turns the same placeholders into failures", (t) => {
  const res = checkModule([materialize(t, HUMAN_SPEC), "--release"]);
  const r = parseReport(res.out);
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...r.fail], ["n"], res.out);
  assert.deepEqual([...r.warn], [], res.out);
  assert.deepEqual(nLines(r, "FAIL"), [
    nLine("FAIL", 2, "title, description", RELEASE_REASON, "module.json"),
    nLine("FAIL", 2, "baron-fixture.Open, baron-fixture.Notice", RELEASE_REASON, "lang/en.json"),
    nLine("FAIL", 1, "baron-fixture.Open", RELEASE_REASON, "lang/es.json"),
  ]);
  assert.equal(r.summary, "check-module: 10 passed, 0 warnings, 1 failed", res.out);
  assert.ok(r.lines[0].endsWith(" --release"), r.lines[0]);
});

test("[n] under GitHub Actions each file becomes a warning annotation on a push and an error with --release", (t) => {
  const dir = materialize(t, HUMAN_SPEC);
  const env = childEnv({ GITHUB_ACTIONS: "true" });
  const annotations = (out, command) => out.split(/\r?\n/).filter((l) => l.startsWith(`::${command} `) && l.includes("[n]"));

  const push = checkModule(["."], { cwd: dir, env });
  assert.equal(push.status, 0, push.out);
  assert.deepEqual(annotations(push.out, "warning"), [
    `::warning file=module.json,title=check-module [n] human text::2 value(s) still start with "TODO-HUMANO:" (title, description): ${PUSH_REASON}`,
    `::warning file=lang/en.json,title=check-module [n] human text::2 value(s) still start with "TODO-HUMANO:" (baron-fixture.Open, baron-fixture.Notice): ${PUSH_REASON}`,
    `::warning file=lang/es.json,title=check-module [n] human text::1 value(s) still start with "TODO-HUMANO:" (baron-fixture.Open): ${PUSH_REASON}`,
  ]);

  const release = checkModule([".", "--release"], { cwd: dir, env });
  assert.equal(release.status, 1, release.out);
  assert.equal(annotations(release.out, "error").length, 3, release.out);
  assert.ok(annotations(release.out, "error")[0].startsWith("::error file=module.json,title=check-module [n] human text::2 value(s)"), release.out);
  assert.deepEqual(annotations(release.out, "warning"), [], release.out);
});

test("[n] nested language objects are scanned and report the dotted key Foundry flattens them to", (t) => {
  const nested = (open, line) =>
    JSON.stringify(
      {
        "baron-fixture": {
          Title: "Baron Fixture",
          Open: open,
          Notice: "Notice",
          Kind_a: "Kind A",
          Kind_b: "Kind B",
          Unused: "Never referenced",
          Help: { Deep: { Line: line } },
        },
      },
      null,
      2,
    ) + "\n";
  const dir = materialize(t, { write: { "lang/en.json": nested(todo("button label"), todo("help line")), "lang/es.json": nested("Abrir", "Ayuda") } });
  const res = checkModule([dir, "--release"]);
  const r = parseReport(res.out);
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...r.fail], ["n"], res.out);
  assert.deepEqual(nLines(r, "FAIL"), [nLine("FAIL", 2, "baron-fixture.Open, baron-fixture.Help.Deep.Line", RELEASE_REASON, "lang/en.json")]);
});

test("[n] only a value that starts with the marker counts: mid-text or lowercase is real text", (t) => {
  const dir = materialize(t, {
    merge: {
      "module.json": { description: `Leave ${todo("what it should say")} as the value and a person writes it.` },
      "lang/en.json": { "baron-fixture.Open": "todo-humano: lowercase is not the marker", "baron-fixture.Notice": `Notice ${todo("quoted")}` },
    },
  });
  for (const args of [[dir], [dir, "--release"]]) {
    const res = checkModule(args);
    const r = parseReport(res.out);
    assert.equal(res.status, 0, res.out);
    assert.equal(nLines(r, "PASS").length, 1, res.out);
    assert.equal(r.summary, "check-module: 11 passed, 0 warnings, 0 failed", res.out);
  }
});

test("[n] a file with more than five placeholders names five keys and counts the rest", (t) => {
  const keys = ["A", "B", "C", "D", "E", "F", "G"].map((k) => `baron-fixture.Extra${k}`);
  const dir = materialize(t, {
    merge: {
      "lang/en.json": Object.fromEntries(keys.map((k) => [k, todo(k)])),
      "lang/es.json": Object.fromEntries(keys.map((k) => [k, "Texto"])),
    },
  });
  const res = checkModule([dir]);
  const sample = `${keys.slice(0, 5).join(", ")}, ... +2 more`;
  assert.deepEqual(nLines(parseReport(res.out), "WARN"), [nLine("WARN", 7, sample, PUSH_REASON, "lang/en.json")], res.out);
});

test("[n] a key with a line break prints escaped, so it cannot forge a workflow command", (t) => {
  const key = "baron-fixture.Nl\n::error file=x::forged";
  const dir = materialize(t, { merge: { "lang/en.json": { [key]: todo("newline key") }, "lang/es.json": { [key]: todo("newline key") } } });
  const res = checkModule(["."], { cwd: dir, env: childEnv({ GITHUB_ACTIONS: "true" }) });
  const lines = res.out.split(/\r?\n/);
  assert.equal(res.status, 0, res.out);
  // The key stays inside the report lines of [n] and [h] (which echoes it too) and their escaped annotations.
  assert.deepEqual(lines.filter((l) => l.startsWith("::error")), [], res.out);
  assert.deepEqual(lines.filter((l) => l.includes("forged") && !/^(?:WARN {3}\[n\]|NOTICE \[h\]|::warning |::notice )/.test(l)), [], res.out);
  const shown = "baron-fixture.Nl\\n::error file=x::forged";
  assert.deepEqual(nLines(parseReport(res.out), "WARN"), [
    nLine("WARN", 1, shown, PUSH_REASON, "lang/en.json"),
    nLine("WARN", 1, shown, PUSH_REASON, "lang/es.json"),
  ]);
});

test("[n] the release workflow runs check-module with --release, the push workflow without it", () => {
  const runs = (wf) => readText(REPO, ".github", "workflows", wf).split(/\r?\n/).filter((l) => /^\s*run:.*\/check-module\.mjs\b/.test(l));
  const release = runs("module-release.yml");
  assert.ok(release.length && release.every((l) => /\s--release(?:\s|$)/.test(l)), release.join("\n"));
  const push = runs("module-check.yml");
  assert.ok(push.length && push.every((l) => !l.includes("--release")), push.join("\n"));
});
