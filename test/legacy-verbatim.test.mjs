// The legacy copies the parity tests run must be SWE v0.12.0 exactly. The
// comparison needs the SWE checkout next to this repo (or $SWE_REPO); where it
// is absent, as in this repo's CI, those tests skip and the parser tests still
// run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEGACY_FILE,
  REQUIRED,
  SWE_COMMIT,
  defaultSweRepo,
  dedent,
  findBlock,
  parseRegions,
  sweAvailability,
  verifyLegacy
} from "./legacy/verify-legacy.mjs";

const REPO = defaultSweRepo();
const AVAIL = sweAvailability(REPO);
const NEEDS_SWE = { skip: AVAIL.ok ? false : AVAIL.reason };
const LEGACY = readFileSync(LEGACY_FILE, "utf8");

/* ------------------------------------------------------- against the release */

test("every legacy region is SWE v0.12.0 line for line", NEEDS_SWE, () => {
  const { regions, failures } = verifyLegacy({ repo: REPO });
  assert.deepEqual(failures, []);
  assert.ok(regions.length > 0 && REQUIRED.length > 0);
  for (const r of regions) for (const f of r.files) assert.ok(r.found[f] > 0, `line ${r.line} in ${f}`);
});

test("a one-character change inside a region is caught", NEEDS_SWE, () => {
  const changed = LEGACY.replace("  app._sweGuard = g;\n", "  app._sweGuard = g; \n");
  assert.notEqual(changed, LEGACY);
  const { failures } = verifyLegacy({ repo: REPO, legacyText: changed });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /A field's change event fires/);
});

test("a changed statement is caught even though its indentation is free", NEEDS_SWE, () => {
  const changed = LEGACY.replace("globalThis.FormDataExtended;", "globalThis.FormDataExtended ;");
  assert.notEqual(changed, LEGACY);
  const { failures } = verifyLegacy({ repo: REPO, legacyText: changed });
  assert.equal(failures.length, 2, failures.join("\n")); // main.js and armor.js
});

test("dropping a region is caught by the required list", NEEDS_SWE, () => {
  const start = LEGACY.indexOf("// @verbatim main.js\nfunction escHTML(");
  const end = LEGACY.indexOf("// @end\n", start) + "// @end\n".length;
  assert.ok(start > 0 && end > start);
  const changed = LEGACY.slice(0, start) + LEGACY.slice(start + "// @verbatim main.js\n".length, end - "// @end\n".length) + LEGACY.slice(end);
  const { failures } = verifyLegacy({ repo: REPO, legacyText: changed });
  assert.deepEqual(failures, ['no @verbatim region holds "function escHTML("']);
});

test("a missing checkout skips instead of failing", () => {
  const out = verifyLegacy({ repo: `${REPO}-definitely-not-here` });
  assert.match(out.skipped, /not found/);
});

/* -------------------------------------------------------------- the parser */

test("the legacy file parses, and every region names main.js or armor.js", () => {
  const regions = parseRegions(LEGACY);
  assert.ok(regions.length > 0);
  for (const r of regions) for (const f of r.files) assert.ok(["main.js", "armor.js"].includes(f), f);
  assert.equal(regions.filter((r) => r.statements).length, 3);
  assert.equal(SWE_COMMIT.length, 40);
});

test("parseRegions reads files, the statements flag and CRLF input", () => {
  const text = ["x", "// @verbatim a.js b.js", "one", "// @end", "  // @verbatim-statements c.js", "    two", "  // @end", ""].join("\r\n");
  assert.deepEqual(parseRegions(text), [
    { line: 2, files: ["a.js", "b.js"], statements: false, lines: ["one"] },
    { line: 5, files: ["c.js"], statements: true, lines: ["    two"] }
  ]);
});

test("parseRegions rejects malformed regions", () => {
  const bad = {
    unclosed: "// @verbatim a.js\nx\n",
    nested: "// @verbatim a.js\n// @verbatim b.js\nx\n// @end\n",
    "stray end": "x\n// @end\n",
    "no file": "// @verbatim\nx\n// @end\n",
    empty: "// @verbatim a.js\n\n// @end\n",
    "near miss": "// @verbatim: a.js\nx\n// @end\n",
    "not a script": "// @verbatim a.json\nx\n// @end\n"
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseRegions(text), Error, name);
  // Prose that mentions a marker is not a marker.
  assert.deepEqual(parseRegions('// every "@verbatim" region\n'), []);
});

test("findBlock is exact by default and indentation-free for statements", () => {
  const src = ["a", "  const x = 1;", "  const y = 2;", "b"];
  assert.equal(findBlock(src, ["  const x = 1;", "  const y = 2;"]), 1);
  assert.equal(findBlock(src, ["const x = 1;", "const y = 2;"]), -1);
  assert.equal(findBlock(src, ["      const x = 1;", "      const y = 2;"], { statements: true }), 1);
  assert.equal(findBlock(src, ["const x = 1;", "  const y = 2;"], { statements: true }), -1, "relative indentation still counts");
  assert.equal(findBlock(src, ["const x = 1; "], { statements: true }), -1);
  assert.deepEqual(dedent(["    a", "", "      b"]), ["a", "", "  b"]);
});
