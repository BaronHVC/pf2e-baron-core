// Unit tests for tools/shared.mjs: the version regex, the workflow pin regex,
// the lock format and the JavaScript scanner the static checks rely on.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findUsesPins,
  lockText,
  readCoreVersion,
  scanJs,
  sha256Lf,
  toLf,
} from "../../tools/shared.mjs";
import { sha256Lf as oracle } from "./helpers.mjs";

test("readCoreVersion reads the export line, with either quote and any line ending", () => {
  assert.equal(readCoreVersion('// x\nexport const CORE_VERSION = "1.0.0-rc.1";\n'), "1.0.0-rc.1");
  assert.equal(readCoreVersion("export const CORE_VERSION = '2.3.4';\r\nexport const x = 1;\r\n"), "2.3.4");
  assert.equal(readCoreVersion('export const CORE_VERSION = "1.0.0"'), "1.0.0");
  // Only the real export line counts, not a comment or another binding.
  assert.equal(readCoreVersion('// export const CORE_VERSION = "9.9.9";\n'), null);
  assert.equal(readCoreVersion('  export const CORE_VERSION = "9.9.9";\n'), null);
  assert.equal(readCoreVersion('export const CORE_VERSION = "1.0.0\';\n'), null);
  assert.equal(readCoreVersion("export const OTHER = 1;\n"), null);
});

test("toLf and sha256Lf ignore CRLF versus LF", () => {
  assert.equal(toLf("a\r\nb\r\n"), "a\nb\n");
  assert.equal(toLf("a\rb"), "a\rb");
  assert.equal(sha256Lf("x\r\ny\r\n"), sha256Lf("x\ny\n"));
  assert.equal(sha256Lf("x\ny\n"), oracle("x\ny\n"));
  assert.match(sha256Lf(""), /^[0-9a-f]{64}$/);
});

test("lockText is 2-space JSON with a fixed key order and a trailing newline", () => {
  const text = lockText({ sha256: "s", commit: "c", version: "v" });
  assert.equal(text, '{\n  "version": "v",\n  "commit": "c",\n  "sha256": "s"\n}\n');
});

test("findUsesPins finds core pins only, case-insensitively, with their line", () => {
  const yml = [
    "jobs:",
    "  a:",
    "    uses: BaronHVC/pf2e-baron-core/.github/workflows/module-check.yml@abc123",
    "  b:",
    '    uses: "baronhvc/PF2E-BARON-CORE/.github/workflows/module-release.yml@v1.0.0"',
    "  c:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: BaronHVC/pf2e-baron-core/.github/workflows/x.yml@def456 # trailing comment",
    "#   uses: BaronHVC/pf2e-baron-core/.github/workflows/module-check.yml@commented",
    "    uses: BaronHVC/other-repo/.github/workflows/module-check.yml@nope",
  ].join("\r\n");
  assert.deepEqual(findUsesPins(yml), [
    { workflow: ".github/workflows/module-check.yml", ref: "abc123", line: 3 },
    { workflow: ".github/workflows/module-release.yml", ref: "v1.0.0", line: 5 },
    { workflow: ".github/workflows/x.yml", ref: "def456", line: 9 },
  ]);
});

test("scanJs blanks comments but keeps offsets and newlines", () => {
  const src = 'const a = 1; // tail "not a string"\n/* block\n "still comment" */ const b = "s";\n';
  const { code, strings, lineOf } = scanJs(src);
  assert.equal(code.length, src.length);
  assert.equal(code.split("\n").length, src.split("\n").length);
  assert.ok(!code.includes("tail"));
  assert.ok(!code.includes("still comment"));
  assert.deepEqual(strings.map((s) => s.value), ["s"]);
  assert.equal(lineOf(src.indexOf('"s"')), 3);
  assert.equal(lineOf(0), 1);
});

test("scanJs resolves escapes and reads template heads", () => {
  const src = 'f("a\\"b"); g(\'c\\\'d\'); h(`plain`); k(`Key_${x}.${y}`); m(`${z}`);';
  const { strings } = scanJs(src);
  assert.deepEqual(
    strings.map((s) => [s.quote, s.value, s.head, s.interpolated]),
    [
      ['"', 'a"b', 'a"b', false],
      ["'", "c'd", "c'd", false],
      ["`", "plain", "plain", false],
      ["`", null, "Key_", true],
      ["`", null, "", true],
    ],
  );
});

test("scanJs collects strings nested in template expressions and resumes the template", () => {
  const src = 'const t = `a${ fn({ k: "inner" }) }b${ `nested${"deep"}` }c`; const after = "after";';
  const values = scanJs(src).strings.map((s) => s.value ?? `<${s.head}>`);
  assert.deepEqual(values, ["<a>", "inner", "<nested>", "deep", "after"]);
});

test("scanJs does not mistake quotes inside a regex for strings, nor a division for a regex", () => {
  const src = "const r = /[\"'`]/g; const half = total / 2 / count; const s = \"real\";\nif (x) return /\\/\"/.test(y);";
  const { strings } = scanJs(src);
  assert.deepEqual(strings.map((s) => s.value), ["real"]);
});

test("scanJs bare view blanks literal text but keeps code and ${} expressions", () => {
  const src = 'import x from "./x.js";\nconst s = "import \'/modules/a.js\'";\nconst t = `await ${call("v")} text`;\nconst r = /import "y"/;\n';
  const { code, bare } = scanJs(src);
  assert.equal(bare.length, src.length);
  assert.equal(code, src);
  assert.ok(bare.startsWith('import x from "      ";'));
  assert.ok(!bare.includes("/modules/"));
  assert.ok(!bare.includes("await"));
  assert.ok(bare.includes("${call(\" \")}"));
  assert.ok(!bare.includes('import "y"'));
  assert.equal(bare.split("\n").length, src.split("\n").length);
});
