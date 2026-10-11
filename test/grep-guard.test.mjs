// Static guard over baron-core.js for the rules a runtime test cannot see:
// the library registers nothing, writes no shared state, names no module, and
// keeps the shape the sync and check tools rely on. Code checks run on a
// skeleton without comments or literals (test/helpers/js-scan.mjs), so prose
// such as "Hooks fire on every client" is allowed while Hooks.on() is not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../baron-core.js";
import { scanJs, stripComments, codeSkeleton, topLevelIdentifiers } from "./helpers/js-scan.mjs";

const SRC = readFileSync(new URL("../baron-core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LINES = SRC.split("\n");
const SKELETON = codeSkeleton(SRC);

const ASSIGN = String.raw`\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|&&|\|\|)?=(?!=)`;
const MEMBER = String.raw`(?:\s*\??\.\s*[\w$]+|\s*\[[^\]]*\])+`;

// [rule, pattern over the code skeleton, an example the pattern must catch]
const FORBIDDEN_CODE = [
  ["no Hooks at all (core neither registers nor calls hooks)", /\bHooks\b/, "Hooks.on('ready', f)"],
  ["no settings or keybindings registration", /\b(?:settings|keybindings)\s*\.\s*register(?:Menu)?\b/, "game.settings.register(id, k, {})"],
  ["no Handlebars helpers or partials", /\bHandlebars\b/, "Handlebars.registerHelper('x', f)"],
  ["no template preloading", /\bloadTemplates\b/, "loadTemplates([p])"],
  ["no sockets", /\bsocket\b|\bsocketlib\b/, "game.socket.on(n, f)"],
  ["no custom elements", /\bcustomElements\b/, "customElements.define('x-y', C)"],
  ["no libWrapper", /\blibWrapper\b/, "libWrapper.register(id, t, f)"],
  [
    "no CONFIG writes",
    new RegExp(String.raw`\bCONFIG${MEMBER}${ASSIGN}|\b(?:assign|mergeObject|setProperty)\s*\(\s*CONFIG\b|\bdelete\s+CONFIG\b`),
    "CONFIG.PF2E.x = 1"
  ],
  ["no writes to globalThis/window/self", new RegExp(String.raw`\b(?:globalThis|window|self)${MEMBER}${ASSIGN}`), "globalThis.x ??= 1"],
  ["no module api writes", new RegExp(String.raw`\.\s*api${ASSIGN}`), "mod.api = {}"],
  ["no global Symbol registry (v1 keeps state per copy)", /\bSymbol\s*\.\s*for\b/, "Symbol.for('k')"],
  ["no HTML parsing of text", /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\s*\.\s*write\b/, "el.innerHTML = s"],
  ["no eval", /\beval\s*\(|\bnew\s+Function\b/, "new Function('x')"],
  ["no imports (single self-contained file)", /\bimport\b/, "import x from 'y'"],
  ["no require", /\brequire\s*\(/, "require('x')"],
  ["named exports only", /\bexport\s+default\b/, "export default f"]
];

// Globals that must not be reached while the module is evaluated.
const FORBIDDEN_TOP = [
  "game", "CONFIG", "foundry", "Hooks", "ui", "Handlebars", "canvas", "document", "window", "self",
  "globalThis", "libWrapper", "customElements", "CSS", "HTMLElement", "setTimeout", "setInterval",
  "queueMicrotask", "console", "fetch", "process", "await", "import", "require"
];

/* ----------------------------------------------------------------- scanner */

test("the scanner is lossless and its comment-free output imports with the same exports", async () => {
  const segments = scanJs(SRC);
  assert.equal(segments.map((s) => s.text).join(""), SRC);
  assert.ok(segments.some((s) => s.type === "regex" && s.text.includes('"')), "the escHTML regex is read as a regex");
  const stripped = stripComments(SRC);
  assert.ok(!/\/\*|\/\/ /.test(codeSkeleton(stripped)), "comment markers left in code");
  const copy = await import("data:text/javascript;base64," + Buffer.from(stripped).toString("base64"));
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(core).sort());
  assert.equal(copy.escHTML(`<&>"'`), core.escHTML(`<&>"'`));
  assert.equal(copy.slugOf("Long Sword"), "long-sword");
});

test("the scanner tells comments, strings, templates and regexes apart", () => {
  const sample = [
    'const a = "// not a comment"; // one',
    "const b = '/* nor this */';",
    "const r = x.replace(/[/*\"']+/g, \"\"); /* two */",
    "const t = `${a + `in ${b}`}// still text`;",
    "const d = (a) / 2 / (b);"
  ].join("\n");
  const segs = scanJs(sample);
  assert.equal(segs.map((s) => s.text).join(""), sample);
  const of = (type) => segs.filter((s) => s.type === type).map((s) => s.text);
  assert.deepEqual(of("comment"), ["// one", "/* two */"]);
  assert.deepEqual(of("regex"), ["/[/*\"']+/g"]);
  assert.deepEqual(of("string"), ['"// not a comment"', "'/* nor this */'", '""']);
  assert.deepEqual(of("template"), ["`${", "`in ${", "}`", "}// still text`"]);
  assert.ok(of("code").join("").includes("(a) / 2 / (b)"), "division stays code");
  assert.deepEqual([...topLevelIdentifiers(codeSkeleton("const x = 1e3; foo.bar(baz);"))], ["const", "x", "foo"]);
});

/* -------------------------------------------------------------------- code */

test("registers nothing and writes no shared state", () => {
  for (const [rule, pattern, example] of FORBIDDEN_CODE) {
    assert.ok(pattern.test(codeSkeleton(example)), `pattern for "${rule}" misses its own example`);
    const hit = pattern.exec(SKELETON);
    assert.equal(hit, null, `${rule}: found "${hit?.[0]}"`);
  }
});

test("nothing at the top level touches a Foundry, browser or runtime global", () => {
  const top = topLevelIdentifiers(SKELETON);
  for (const name of FORBIDDEN_TOP) assert.ok(!top.has(name), `${name} at the top level`);
  // Allow-list: besides keywords and the file's own declarations, only these
  // side-effect-free constructors may run at import.
  const declared = new Set([...SRC.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([\w$]+)/gm)].map((m) => m[1]));
  const keywords = new Set(["export", "const", "function", "new"]);
  const rest = [...top].filter((t) => !declared.has(t) && !keywords.has(t)).sort();
  assert.deepEqual(rest, ["Map", "Symbol"]);
});

test("no top-level await (the check-module heuristic agrees)", () => {
  for (const [i, line] of LINES.entries()) {
    assert.ok(!/^await\s/.test(line), `line ${i + 1}`);
    assert.ok(!/^(?:const|let|var)\s+[\w$]+\s*=\s*await\b/.test(line), `line ${i + 1}`);
  }
});

/* -------------------------------------------------------------------- text */

test("names no module: forbidden literals appear nowhere, comments included", () => {
  for (const literal of ["pf2e-simple-weapon-editor", "SWE", "swe-", "_swe"]) {
    const at = SRC.indexOf(literal);
    assert.equal(at, -1, `"${literal}" on line ${SRC.slice(0, at).split("\n").length}`);
  }
});

test("pure ASCII", () => {
  for (const [i, line] of LINES.entries()) assert.ok(!/[^\x00-\x7f]/.test(line), `non-ASCII on line ${i + 1}`);
});

test("the header says where the file comes from and how copies are updated", () => {
  assert.ok(SRC.startsWith("/**"));
  const header = SRC.slice(0, SRC.indexOf("*/"));
  assert.match(header, /Vendored from BaronHVC\/pf2e-baron-core/);
  assert.match(header, /Do not edit copies by hand/);
  assert.match(header, /tools\/sync-core\.mjs/);
});

test("CORE_VERSION is declared once, on the line the sync tool reads", () => {
  const found = [...SRC.matchAll(/^export const CORE_VERSION = "([^"]+)";$/gm)];
  assert.equal(found.length, 1);
  assert.equal(found[0][1], core.CORE_VERSION);
  assert.equal((SRC.match(/CORE_VERSION\s*=/g) ?? []).length, 1);
});

test("every export carries a JSDoc block right above it", () => {
  let exportsSeen = 0;
  LINES.forEach((line, i) => {
    if (!line.startsWith("export ")) return;
    exportsSeen++;
    assert.equal(LINES[i - 1]?.trim(), "*/", `line ${i + 1}: ${line}`);
    let k = i - 2;
    while (k >= 0 && LINES[k].startsWith(" *")) k--;
    assert.ok(LINES[k]?.startsWith("/**"), `line ${i + 1}: comment above is not JSDoc`);
  });
  assert.equal(exportsSeen, Object.keys(core).length);
});

test("sections follow the contract order", () => {
  const titles = [];
  LINES.forEach((line, i) => {
    if (!/^\/\* -{20,} \*\/$/.test(line)) return;
    const m = /^\/\*  (\S.*?)\s*\*\/$/.exec(LINES[i + 1] ?? "");
    if (m) titles.push(m[1]);
  });
  assert.deepEqual(titles, [
    "Version",
    "i18n",
    "Labels",
    "Values",
    "PF2e",
    "Permissions and executor",
    "Foundry compatibility",
    "Packs",
    "UI"
  ]);
});
