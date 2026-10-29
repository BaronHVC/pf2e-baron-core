// Who wrote each signed text: sign-text --sign --author <name> and --sheet
// <file.csv>, the human-text-authors.json file next to human-text.json (each
// entry bound to the hash of the signature it was recorded for), and what an
// older core makes of a module that has one. The terminal is faked as in
// sign-text.test.mjs: the TTY flag and the answers are injected.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
// Namespace import: the names added with the review fixes (authorName) are read from it.
import * as shared from "../../tools/shared.mjs";
import {
  AUTHOR_NAME_MAX,
  HUMAN_TEXT_AUTHORS_FILE,
  HUMAN_TEXT_FILE,
  authorNameProblem,
  authorsProblem,
  authorsText,
  readAuthors,
  signaturesText,
} from "../../tools/shared.mjs";
import { AUTHOR_LEGEND, LEGEND, QUESTION, SignTextError, authorQuestion, signTexts } from "../../tools/sign-text.mjs";
import { SHEET_FILE, csvParse, csvWrite, decodeSheet, exportSheet, importSheet } from "../../tools/text-sheet.mjs";
import { REPO, TOOLS, childEnv, materialize, readJson, readText, runNode, tempDir } from "./helpers.mjs";

const ch = (...codes) => String.fromCharCode(...codes);
const NL = ch(10);
const oracle = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const SIGN_TEXT = path.join(TOOLS, "sign-text.mjs");
const OPEN = "baron-fixture.Open";

const signedModule = (t, spec = {}) => materialize(t, { ...spec, merge: { "baron.json": { humanText: "signed" }, ...(spec.merge ?? {}) } });

/** Every text of the module as { file: { key: value } }, read from its files. */
function moduleTexts(dir) {
  const m = readJson(dir, "module.json");
  return {
    "module.json": { title: m.title, description: m.description },
    "lang/en.json": readJson(dir, "lang", "en.json"),
    "lang/es.json": readJson(dir, "lang", "es.json"),
  };
}
const hashesOf = (texts) => Object.fromEntries(Object.entries(texts).map(([f, keys]) => [f, Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, oracle(v)]))]));
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const tmps = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const writeSignatures = (dir, signed) => fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), JSON.stringify({ version: 1, signed }, null, 2) + "\n");
const readSigned = (dir) => readJson(dir, HUMAN_TEXT_FILE).signed;
/** human-text-authors.json as given: file -> key -> { name, sha256 }. */
const writeAuthorEntries = (dir, authors) => fs.writeFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE), JSON.stringify({ version: 1, authors }, null, 2) + "\n");
const readAuthorEntries = (dir) => readJson(dir, HUMAN_TEXT_AUTHORS_FILE).authors;

/** Each name of `names` (file -> key -> name) bound to the signature human-text.json holds now for its text; a text it does not sign, to the hash of another value. */
function writeAuthors(dir, names) {
  const signed = exists(dir, HUMAN_TEXT_FILE) ? readSigned(dir) : {};
  const sha = (f, k) => signed[f]?.[k] ?? oracle(`never signed: ${f} ${k}`);
  writeAuthorEntries(dir, Object.fromEntries(Object.entries(names).map(([f, keys]) => [f, Object.fromEntries(Object.entries(keys).map(([k, name]) => [k, { name, sha256: sha(f, k) }]))])));
}

/** The names of human-text-authors.json as file -> key -> name, each checked to be bound to the signature human-text.json holds now. */
function readAuthorMap(dir) {
  const signed = exists(dir, HUMAN_TEXT_FILE) ? readSigned(dir) : {};
  const out = {};
  for (const [f, keys] of Object.entries(readAuthorEntries(dir))) {
    out[f] = {};
    for (const [k, e] of Object.entries(keys)) {
      assert.deepEqual(Object.keys(e), ["name", "sha256"], `${f} ${k}`);
      assert.equal(e.sha256, signed[f]?.[k], `${f} ${k}: an entry written for another signature than the one human-text.json holds`);
      out[f][k] = e.name;
    }
  }
  return out;
}

function fakeAsk(...answers) {
  const asked = [];
  const ask = async (question) => {
    asked.push(question);
    if (!answers.length) throw new Error("asked more questions than the test answers");
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a;
  };
  return { ask, asked, left: () => answers.length };
}

async function run(dir, opts = {}) {
  const lines = [];
  const errors = [];
  const res = await signTexts({ dir, log: (l) => lines.push(l), logError: (l) => errors.push(l), ...opts });
  return { ...res, lines, errors, out: [...lines, ...errors].join(NL) };
}

/** Every text signed for the fixture's values (human-text.json as sign-text writes it), and recorded as `older`'s when given; en Open now reads `now`. */
function reSignModule(t, now = "Open now", older = "BaronHVC") {
  const dir = signedModule(t, { merge: { "lang/en.json": { [OPEN]: now } } });
  const old = moduleTexts(materialize(t));
  fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), signaturesText(hashesOf(old)));
  if (older) writeAuthors(dir, Object.fromEntries(Object.entries(old).map(([f, keys]) => [f, Object.fromEntries(Object.keys(keys).map((k) => [k, older]))])));
  return dir;
}

/** The author the listing names for a text, or null. */
const listedAuthor = (listing, file, key) => {
  const line = listing.lines.find((l) => l.startsWith(`signed    ${file}  ${key}  by `));
  return line ? JSON.parse(line.slice(line.indexOf("  by ") + 5)) : null;
};
// What the listing says of the author records that name nobody.
const IDLE = (n) =>
  `info: ${n} author record(s) in ${HUMAN_TEXT_AUTHORS_FILE} name nobody: the signature each one was recorded for changed, is gone, or was never saved (a --sign that did not finish); the next --sign that writes that file drops them`;

/* ----------------------------------------------------------------------------
 * The file and the names
 * -------------------------------------------------------------------------- */

test("authorsText writes each entry as name and sha256, keys sorted at every level, two spaces, LF, a final newline", (t) => {
  const H = oracle("x");
  const e = (name) => ({ sha256: H, name });
  const parsed = { "module.json": { title: e("IAR18"), description: e("BaronHVC") }, "lang/es.json": JSON.parse(`{"x.B":{"name":"IAR18","sha256":"${H}"},"__proto__":{"name":"BaronHVC","sha256":"${H}"},"2":{"name":"IAR18","sha256":"${H}"},"10":{"name":"IAR18","sha256":"${H}"}}`) };
  const text = authorsText(parsed);
  const entry = (indent, key, name, last) => [`${indent}"${key}": {`, `${indent}  "name": "${name}",`, `${indent}  "sha256": "${H}"`, `${indent}}${last ? "" : ","}`];
  assert.equal(
    text,
    [
      "{",
      '  "authors": {',
      '    "lang/es.json": {',
      ...entry("      ", "10", "IAR18"),
      ...entry("      ", "2", "IAR18"),
      ...entry("      ", "__proto__", "BaronHVC"),
      ...entry("      ", "x.B", "IAR18", true),
      "    },",
      '    "module.json": {',
      ...entry("      ", "description", "BaronHVC"),
      ...entry("      ", "title", "IAR18", true),
      "    }",
      "  },",
      '  "version": 1',
      "}",
      "",
    ].join(NL),
  );
  assert.ok(!text.includes(ch(13)));
  // A name outside ASCII is written as it is, in UTF-8.
  const accented = `Iv${ch(0xe1)}n`;
  assert.ok(authorsText({ "lang/en.json": { a: { name: accented, sha256: H } } }).includes(`"name": "${accented}"`));
  assert.equal(authorsText({}), `{${NL}  "authors": {},${NL}  "version": 1${NL}}${NL}`);
  const dir = materialize(t);
  fs.writeFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE), text);
  const read = readAuthors(dir);
  assert.equal(read.error, undefined);
  assert.equal(authorsText(read.authors), text);
  assert.deepEqual(readAuthors(materialize(t)), { missing: true, authors: {} });
});

test("an author name is trimmed and has 1 to 60 characters, none of them a control character", () => {
  for (const ok of ["IAR18", "BaronHVC", "  IAR18  ", "x".repeat(AUTHOR_NAME_MAX), ch(0xd83d, 0xde00).repeat(AUTHOR_NAME_MAX), `Iv${ch(0xe1)}n Ruiz`, "-x"]) {
    assert.equal(authorNameProblem(ok), null, JSON.stringify(ok));
  }
  assert.equal(AUTHOR_NAME_MAX, 60);
  for (const [bad, why] of [
    ["", /^is empty/],
    ["   ", /^is empty/],
    [`${ch(9)}${ch(10)}`, /^is empty/],
    ["x".repeat(61), /^is 61 characters long: an author name has 60 at most$/],
    [`${ch(0xd83d, 0xde00).repeat(61)}`, /^is 61 characters long/],
    [`IAR${ch(9)}18`, /holds a control character/],
    [`IAR${ch(10)}18`, /holds a control character/],
    [`IAR${ch(0)}18`, /holds a control character/],
    [`IAR${ch(0x7f)}18`, /holds a control character/],
    [`IAR${ch(0x85)}18`, /holds a control character/],
    [`IAR${ch(0xd800)}`, /lone UTF-16 surrogate/],
    [undefined, /must be a name/],
    [18, /must be a name/],
  ]) {
    assert.match(String(authorNameProblem(bad)), why, JSON.stringify(bad));
  }
});

test("authorsProblem refuses every other shape of human-text-authors.json", () => {
  const H = oracle("x");
  const one = (entry) => ({ version: 1, authors: { "lang/en.json": { a: entry } } });
  assert.equal(authorsProblem({ version: 1, authors: {} }), null);
  assert.equal(authorsProblem(one({ name: "IAR18", sha256: H })), null);
  assert.equal(authorsProblem(one({ sha256: H, name: "IAR18" })), null);
  const AT = 'has authors["lang/en.json"]["a"]';
  for (const [data, reason] of [
    [[], "must hold a JSON object"],
    [null, "must hold a JSON object"],
    [{ authors: {} }, 'has "version" undefined: it must be 1'],
    [{ version: 2, authors: {} }, 'has "version" 2: it must be 1'],
    [{ version: 1 }, 'needs "authors" to be an object of files'],
    [{ version: 1, authors: [] }, 'needs "authors" to be an object of files'],
    [{ version: 1, authors: {}, signed: {} }, 'has unknown key(s) "signed"'],
    [{ version: 1, authors: { "lang/en.json": "IAR18" } }, 'has authors["lang/en.json"] that is not an object of keys'],
    // The format before the entries were bound to their signature: a bare name.
    [one("IAR18"), `${AT} that is not an object with exactly "name" and "sha256"`],
    [one(null), `${AT} that is not an object with exactly "name" and "sha256"`],
    [one([]), `${AT} that is not an object with exactly "name" and "sha256"`],
    [one({ name: "IAR18" }), `${AT} that is not an object with exactly "name" and "sha256"`],
    [one({ sha256: H }), `${AT} that is not an object with exactly "name" and "sha256"`],
    [one({ name: "IAR18", sha256: H, at: "2026" }), `${AT} that is not an object with exactly "name" and "sha256"`],
    [one({ name: "", sha256: H }), `${AT}.name that is not an author name (is empty`],
    [one({ name: " IAR18", sha256: H }), `${AT}.name that is not an author name (spaces at an end)`],
    [one({ name: 18, sha256: H }), `${AT}.name that is not an author name (must be a name)`],
    [one({ name: "IAR18", sha256: H.toUpperCase() }), `${AT}.sha256 that is not a sha256 (64 lowercase hex characters)`],
    [one({ name: "IAR18", sha256: H.slice(1) }), `${AT}.sha256 that is not a sha256`],
    [one({ name: "IAR18", sha256: `${H}0` }), `${AT}.sha256 that is not a sha256`],
    [one({ name: "IAR18", sha256: null }), `${AT}.sha256 that is not a sha256`],
  ]) {
    const problem = authorsProblem(data);
    assert.ok(problem?.startsWith(reason), `${JSON.stringify(data)}: ${problem}`);
  }
});

/* ----------------------------------------------------------------------------
 * --author
 * -------------------------------------------------------------------------- */

test("--author asks whether that person wrote each text, and records the name with each signature it gives, bound to its hash", async (t) => {
  const dir = signedModule(t);
  const fake = fakeAsk("s", "n", "S", "q");
  const res = await run(dir, { sign: true, author: "  IAR18 ", isTTY: true, ask: fake.ask });
  assert.equal(res.code, 0, res.out);
  // The question names the author, in Spanish, with its accents.
  assert.equal(authorQuestion("IAR18"), `${ch(0xbf)}IAR18 escribi${ch(0xf3)} este texto desde cero? [s/N/q] `);
  assert.deepEqual(fake.asked, Array(4).fill(authorQuestion("IAR18")));
  assert.ok(res.lines[0].endsWith(" --sign --author IAR18"), res.lines[0]);
  // The legend says whom each answer is for.
  const at = res.lines.indexOf(AUTHOR_LEGEND[0]);
  assert.ok(at > 0, res.out);
  assert.deepEqual(res.lines.slice(at, at + AUTHOR_LEGEND.length), AUTHOR_LEGEND);
  assert.ok(!res.lines.includes(LEGEND[0]), res.out);

  const H = oracle("Baron Fixture");
  const expected = { "module.json": { title: H }, "lang/en.json": { "baron-fixture.Title": H } };
  assert.deepEqual(readSigned(dir), expected);
  // human-text.json is the file plain --sign writes, byte for byte.
  assert.equal(readText(dir, HUMAN_TEXT_FILE), signaturesText(expected));
  assert.equal(
    readText(dir, HUMAN_TEXT_AUTHORS_FILE),
    [
      "{",
      '  "authors": {',
      '    "lang/en.json": {',
      '      "baron-fixture.Title": {',
      '        "name": "IAR18",',
      `        "sha256": "${H}"`,
      "      }",
      "    },",
      '    "module.json": {',
      '      "title": {',
      '        "name": "IAR18",',
      `        "sha256": "${H}"`,
      "      }",
      "    }",
      "  },",
      '  "version": 1',
      "}",
      "",
    ].join(NL),
  );
  assert.deepEqual({ signed: res.signed, recorded: res.recorded, skipped: res.skipped, wrote: res.wrote, wroteAuthors: res.wroteAuthors }, { signed: 2, recorded: 0, skipped: 1, wrote: true, wroteAuthors: true });
  assert.ok(res.lines.includes("sign-text: 2 signed, 1 skipped, stopped with 11 left; wrote human-text.json and human-text-authors.json"), res.out);
  assert.ok(res.lines.includes('sign-text: authors recorded in this run: "IAR18" 2'), res.out);
  assert.deepEqual(tmps(dir), []);

  // A plain run in a twin module writes the same human-text.json, and no authors file.
  const twin = signedModule(t);
  const plain = await run(twin, { sign: true, isTTY: true, ask: fakeAsk("s", "n", "s", "q").ask });
  assert.equal(readText(twin, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_FILE));
  assert.equal(plain.wroteAuthors, false);
  assert.ok(!exists(twin, HUMAN_TEXT_AUTHORS_FILE));
  assert.ok(plain.lines.includes("sign-text: 2 signed, 1 skipped, stopped with 11 left; wrote human-text.json"), plain.out);
  assert.ok(!plain.lines.some((l) => l.startsWith("sign-text: authors recorded")), plain.out);

  // A second author signs the rest; the first one's entries stay.
  const rest = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk(...Array(12).fill("s")).ask });
  assert.equal(rest.signed, 12, rest.out);
  const authors = readAuthorMap(dir);
  assert.equal(authors["module.json"].title, "IAR18");
  assert.equal(authors["module.json"].description, "BaronHVC");
  assert.equal(authors["lang/en.json"]["baron-fixture.Title"], "IAR18");
  assert.equal(Object.values(authors).flatMap((k) => Object.values(k)).filter((n) => n === "BaronHVC").length, 12);
});

test("--author: a wrong answer asks again, naming the author", async (t) => {
  const dir = signedModule(t);
  const fake = fakeAsk("si", "s", "q");
  const res = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fake.ask });
  assert.ok(res.lines.includes('  answer "s" (IAR18 wrote it from scratch: sign it), "n" or Enter (skip it) or "q" (stop and keep what you signed)'), res.out);
  assert.deepEqual(readAuthorMap(dir), { "module.json": { title: "IAR18" } });
});

test("plain --sign records no author: a text it signs again loses the author of its older signature", async (t) => {
  const dir = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel", "baron-fixture.Notice": "Aviso nuevo" } } });
  writeSignatures(dir, hashesOf(moduleTexts(materialize(t))));
  writeAuthors(dir, { "lang/es.json": { "baron-fixture.Open": "IAR18", "baron-fixture.Notice": "IAR18", "baron-fixture.Title": "IAR18" } });
  // es Open and es Notice changed since IAR18's signatures: plain --sign signs Open again, skips Notice.
  const fake = fakeAsk("s", "n");
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [QUESTION, QUESTION]);
  assert.equal(readSigned(dir)["lang/es.json"]["baron-fixture.Open"], oracle("Abrir el panel"));
  // Open lost its author; Notice's entry named nobody (its signature is not valid) and goes with the write; Title stays.
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Title": "IAR18" } });
  assert.equal(res.wroteAuthors, true);
  assert.ok(res.lines.includes("sign-text: 1 signed, 1 skipped; wrote human-text.json and human-text-authors.json"), res.out);

  // --author on a changed text records the new author for the new signature.
  const again = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s", "q").ask });
  assert.equal(again.signed, 1, again.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Notice": "BaronHVC", "baron-fixture.Title": "IAR18" } });

  // When the last author entry goes, the file stays, with no authors.
  const solo = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel" } } });
  writeSignatures(solo, hashesOf(moduleTexts(materialize(t))));
  writeAuthors(solo, { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
  await run(solo, { sign: true, isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(readText(solo, HUMAN_TEXT_AUTHORS_FILE), authorsText({}));
});

test("a run that writes human-text.json drops the author entries that name nobody; a run that gives nothing writes nothing", async (t) => {
  const dir = signedModule(t);
  const signed = hashesOf(moduleTexts(dir));
  signed["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
  signed["lang/fr.json"] = { "baron-fixture.Open": oracle("Ouvrir") };
  writeSignatures(dir, signed);
  writeAuthors(dir, {
    "lang/en.json": { "baron-fixture.Gone": "IAR18", "baron-fixture.Open": "IAR18" },
    "lang/fr.json": { "baron-fixture.Open": "IAR18" },
    // An author entry with no signature at all names nobody.
    "lang/es.json": { "baron-fixture.Never": "IAR18" },
  });
  const res = await run(dir, { sign: true, isTTY: true, ask: fakeAsk().ask });
  assert.deepEqual({ code: res.code, stale: res.stale, wrote: res.wrote, wroteAuthors: res.wroteAuthors }, { code: 0, stale: 2, wrote: true, wroteAuthors: true });
  assert.deepEqual(readSigned(dir), hashesOf(moduleTexts(dir)));
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Open": "IAR18" } });
  assert.ok(res.lines.includes("sign-text: 0 signed, 0 skipped, 2 stale signature(s) removed; wrote human-text.json and human-text-authors.json"), res.out);

  // Nothing to sign and nothing stale: neither file is touched, and the entry that names nobody stays until a write.
  writeAuthors(dir, { "lang/en.json": { "baron-fixture.Open": "IAR18" }, "lang/es.json": { "baron-fixture.Never": "IAR18" } });
  const listed = await run(dir);
  assert.ok(listed.lines.includes(IDLE(1)), listed.out);
  const both = [readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)];
  for (const answers of [[], ["q"]]) {
    const idle = await run(dir, { sign: true, isTTY: true, ask: fakeAsk(...answers).ask });
    assert.deepEqual({ wrote: idle.wrote, wroteAuthors: idle.wroteAuthors }, { wrote: false, wroteAuthors: false });
    assert.ok(idle.lines.includes("sign-text: 0 signed, 0 skipped; human-text.json unchanged"), idle.out);
  }
  // --author with every answer "n" writes nothing either.
  const skipped = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk(...Array(14).fill("n")).ask });
  assert.equal(skipped.skipped, 13, skipped.out);
  assert.deepEqual([readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)], both);
  assert.deepEqual(tmps(dir), []);

  // Without human-text.json (it may be lost) no entry counts, the listing says so, and an idle --sign touches nothing.
  fs.rmSync(path.join(dir, HUMAN_TEXT_FILE));
  const noFile = await run(dir);
  assert.ok(noFile.lines.includes(`${IDLE(2)} (if ${HUMAN_TEXT_FILE} was lost rather than never saved, restore it from git first)`), noFile.out);
  assert.ok(!noFile.out.includes("  by "), noFile.out);
  assert.ok(!noFile.out.includes("warn: without"), noFile.out);
  // --sign says so before its first question: a save would drop them all, and stopping right away keeps them.
  const WARN =
    `warn: without ${HUMAN_TEXT_FILE}, the 2 author record(s) in ${HUMAN_TEXT_AUTHORS_FILE} name nobody, and this run drops them when it saves; ` +
    `if ${HUMAN_TEXT_FILE} was lost rather than never saved, stop now (q or Ctrl+C), restore it from git and run this again`;
  const stopNow = await run(dir, { sign: true, isTTY: true, ask: fakeAsk("q").ask });
  assert.ok(stopNow.lines.includes(WARN), stopNow.out);
  assert.ok(stopNow.lines.indexOf(WARN) < stopNow.lines.findIndex((l) => l.startsWith("[1/")), stopNow.out);
  assert.equal(readText(dir, HUMAN_TEXT_AUTHORS_FILE), both[1]);
  // A run that saves drops them, as it said; with human-text.json back there is nothing to warn about.
  const saves = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask });
  assert.ok(saves.lines.includes(WARN), saves.out);
  assert.equal(Object.values(readAuthorMap(dir)).flatMap((keys) => Object.values(keys)).join(), "IAR18");
  assert.ok(!(await run(dir, { sign: true, isTTY: true, ask: fakeAsk("q").ask })).out.includes("warn: without"));
  // Without an authors file there is nothing to drop, and nothing to warn about.
  const fresh = signedModule(t);
  assert.ok(!(await run(fresh, { sign: true, isTTY: true, ask: fakeAsk("q").ask })).out.includes("warn: without"));
});

test("--sign never creates the authors file when no signature records an author", async (t) => {
  const dir = signedModule(t);
  const res = await run(dir, { sign: true, isTTY: true, ask: fakeAsk(...Array(14).fill("s")).ask });
  assert.equal(res.signed, 14);
  assert.ok(!exists(dir, HUMAN_TEXT_AUTHORS_FILE));
  // --author with every answer "n" signs nothing and writes nothing.
  const none = signedModule(t);
  const skipped = await run(none, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk(...Array(14).fill("n")).ask });
  assert.deepEqual({ signed: skipped.signed, wrote: skipped.wrote }, { signed: 0, wrote: false });
  assert.ok(!exists(none, HUMAN_TEXT_FILE) && !exists(none, HUMAN_TEXT_AUTHORS_FILE));
});

test("Ctrl+C leaves human-text.json and human-text-authors.json exactly as they were", async (t) => {
  const dir = signedModule(t);
  writeSignatures(dir, { "module.json": { title: oracle("Baron Fixture") } });
  writeAuthors(dir, { "module.json": { title: "IAR18" } });
  const before = [readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)];
  const interrupted = new Error("Ctrl+C");
  await assert.rejects(run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s", "s", interrupted).ask }), interrupted);
  assert.equal(interrupted.signedBeforeStop, 2);
  assert.equal(interrupted.recordedBeforeStop, 0);
  assert.deepEqual([readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)], before);
  assert.deepEqual(tmps(dir), []);
});

test("a malformed human-text-authors.json stops the tool, listing too, without touching anything", async (t) => {
  const H = oracle("x");
  for (const text of [
    '{"version": 1, "authors": {"lang/en.json": {"a": {"name": "", "sha256": "' + H + '"}}}}\n',
    // The format before the entries were bound to their signature.
    '{"version": 1, "authors": {"lang/en.json": {"a": "IAR18"}}}\n',
    "{ not json",
    '{"version": 2, "authors": {}}',
  ]) {
    const dir = signedModule(t, { write: { [HUMAN_TEXT_AUTHORS_FILE]: text } });
    for (const sign of [false, true]) {
      await assert.rejects(
        run(dir, { sign, isTTY: true, ask: fakeAsk("s").ask }),
        (err) => err instanceof SignTextError && err.message.startsWith(`${HUMAN_TEXT_AUTHORS_FILE} `) && err.message.endsWith(": restore it from git (deleting it forgets who wrote each signed text)"),
      );
    }
    assert.equal(readText(dir, HUMAN_TEXT_AUTHORS_FILE), text);
    assert.ok(!exists(dir, HUMAN_TEXT_FILE));
  }
  // A broken human-text.json says what v1.6.0 says: each file is restored on its own.
  const dir = reSignModule(t, "Open");
  fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), "{ not json");
  await assert.rejects(run(dir), (err) => err instanceof SignTextError && err.message.endsWith(": restore it from git, or delete it and sign every text again"));
});

/* ----------------------------------------------------------------------------
 * Which entries count
 * -------------------------------------------------------------------------- */

test("an entry counts only when its text is validly signed with the very hash it was recorded for: every reader ignores the others", async (t) => {
  // Everything signed for the fixture's values; en Open now reads "Open now", es Notice lost its signature.
  const dir = reSignModule(t, "Open now", null);
  const signed = readSigned(dir);
  delete signed["lang/es.json"]["baron-fixture.Notice"];
  signed["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
  writeSignatures(dir, signed);
  const H = (v) => oracle(v);
  writeAuthorEntries(dir, {
    // Counts: validly signed, with this hash.
    "lang/en.json": {
      "baron-fixture.Title": { name: "IAR18", sha256: H("Baron Fixture") },
      // A stale hash: the signature is valid, but for another value than the one this entry was recorded for.
      "baron-fixture.Notice": { name: "iar18", sha256: H("Notice, as it read before") },
      // The hash of the signature, but the signature is not valid: the text changed since.
      [OPEN]: { name: "BaronHVC", sha256: H("Open") },
      // Its key is gone, and so is the text.
      "baron-fixture.Gone": { name: "IAR18", sha256: H("Gone") },
      // Counts.
      "baron-fixture.Kind_b": { name: "BaronHVC", sha256: H("Kind B") },
      // A stale hash again.
      "baron-fixture.Kind_a": { name: "IAR18", sha256: H("Kind A, as it read before") },
    },
    // No signature at all.
    "lang/es.json": { "baron-fixture.Notice": { name: "BaronHVC", sha256: H("Aviso") } },
  });

  // The listing: two authors, a count of the rest, and one line for the entries that name nobody.
  const listing = await run(dir);
  assert.deepEqual(
    listing.lines.filter((l) => l.includes("  by ")),
    ['signed    lang/en.json  baron-fixture.Title  by "IAR18"', 'signed    lang/en.json  baron-fixture.Kind_b  by "BaronHVC"'],
  );
  assert.ok(listing.lines.includes('sign-text: authors of the 12 signed text(s): "BaronHVC" 1, "IAR18" 1; 10 with no author recorded'), listing.out);
  assert.ok(listing.lines.includes(IDLE(5)), listing.out);
  // Never a value or a name of an entry that names nobody.
  assert.ok(!listing.out.includes("iar18") && !listing.out.includes("as it read before"), listing.out);

  // --author: en Notice (stale hash) is asked about as a text with no author; Kind_b is BaronHVC's, so not asked;
  // the stale "iar18" is no recorded name, so no case warning.
  const fake = fakeAsk("q");
  const byAuthor = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fake.ask });
  assert.ok(byAuthor.lines.includes('info: 1 signed text(s) whose recorded author is not "IAR18": not asked (sign-text never changes the author of a valid signature)'), byAuthor.out);
  assert.ok(!byAuthor.out.includes("differ only in case"), byAuthor.out);
  // Pending first (en Open, es Notice), then each signed text with no author that counts (10 of them).
  assert.ok(byAuthor.lines.includes("[1/12] lang/en.json  baron-fixture.Open  (changed since it was signed)"), byAuthor.out);

  // --sheet: rows that would be "another author" or "replaces a text signed by" if those entries counted.
  const sheet = writeSheet(dir, [
    ["baron-fixture.Notice", "Notice", "", "BaronHVC"],
    ["baron-fixture.Kind_a", "Kind A, again", "", "IAR18"],
    ["baron-fixture.Kind_b", "Kind B", "", "IAR18"],
  ]);
  const bySheet = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fakeAsk("q").ask });
  for (const line of [
    'sheet: hoja.csv: 1 text(s) to ask about (1 of them signed with no author recorded: s records it), each for the author of its row ("BaronHVC" 1)',
    "[1/1] lang/en.json  baron-fixture.Notice  (signed, with no author recorded)  (sheet row 2)",
    REPLACES(1),
    "  row 3  en  baron-fixture.Kind_a -> lang/en.json  (no author recorded)",
    OTHER_AUTHOR(1),
    '  row 4  en  baron-fixture.Kind_b  (sheet "IAR18", recorded "BaronHVC")',
  ]) {
    assert.ok(bySheet.lines.includes(line), `${line}${NL}${bySheet.out}`);
  }

  // A run that writes the files keeps the two entries that count and drops the five others.
  const signs = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask });
  assert.equal(signs.signed, 1, signs.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Title": "IAR18", "baron-fixture.Kind_b": "BaronHVC", [OPEN]: "IAR18" } });
  assert.ok(!(await run(dir)).out.includes("name nobody"));
});

/* ----------------------------------------------------------------------------
 * Recording the author of a text already signed
 * -------------------------------------------------------------------------- */

test("--author asks about a validly signed text with no author after the texts to sign, and s records it without rewriting human-text.json", async (t) => {
  // Every text signed, with no author (plain --sign, or a core older than v1.7.0); en Open and en Notice recorded.
  const dir = reSignModule(t, "Open", null);
  writeAuthors(dir, { "lang/en.json": { [OPEN]: "IAR18", "baron-fixture.Notice": "BaronHVC" } });
  const signatures = fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE));
  const fake = fakeAsk("n", "s", "s", "q");
  const res = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fake.ask });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(fake.asked, Array(4).fill(authorQuestion("IAR18")));
  // The legend says what s does for such a text, and each question says it is signed.
  assert.ok(res.lines.includes(`Each signature records its author in ${HUMAN_TEXT_AUTHORS_FILE}; for a text already signed with no author, s records that author.`), res.out);
  for (const line of ["[1/12] module.json  title  (signed, with no author recorded)", "[2/12] module.json  description  (signed, with no author recorded)", "[3/12] lang/en.json  baron-fixture.Title  (signed, with no author recorded)"]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  // IAR18's own en Open is done; BaronHVC's en Notice is reported, never asked.
  assert.ok(!res.out.includes(`lang/en.json  ${OPEN}  (signed`) && !res.out.includes("baron-fixture.Notice  (signed"), res.out);
  assert.ok(res.lines.includes('info: 1 signed text(s) whose recorded author is not "IAR18": not asked (sign-text never changes the author of a valid signature)'), res.out);
  assert.deepEqual({ signed: res.signed, recorded: res.recorded, skipped: res.skipped, wrote: res.wrote, wroteAuthors: res.wroteAuthors }, { signed: 0, recorded: 2, skipped: 1, wrote: false, wroteAuthors: true });
  assert.ok(res.lines.includes("sign-text: 0 signed, 2 author(s) recorded for signed text(s), 1 skipped, stopped with 9 left; human-text.json unchanged; wrote human-text-authors.json"), res.out);
  assert.ok(res.lines.includes('sign-text: authors recorded in this run: "IAR18" 2'), res.out);
  // human-text.json is not rewritten: the same bytes.
  assert.ok(fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE)).equals(signatures));
  assert.deepEqual(readAuthorMap(dir), {
    "module.json": { description: "IAR18" },
    "lang/en.json": { [OPEN]: "IAR18", "baron-fixture.Notice": "BaronHVC", "baron-fixture.Title": "IAR18" },
  });
  assert.deepEqual(tmps(dir), []);

  // A pending text is asked before them; the summary counts both kinds.
  fs.writeFileSync(path.join(dir, "lang", "en.json"), JSON.stringify({ ...readJson(dir, "lang", "en.json"), "baron-fixture.Kind_a": "Kind A, rewritten" }, null, 2) + "\n");
  const mixed = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "s", "q").ask });
  assert.ok(mixed.lines.includes("[1/10] lang/en.json  baron-fixture.Kind_a  (changed since it was signed)"), mixed.out);
  assert.ok(mixed.lines.includes("[2/10] module.json  title  (signed, with no author recorded)"), mixed.out);
  assert.ok(mixed.lines.includes("sign-text: 1 signed, 1 author(s) recorded for signed text(s), 0 skipped, stopped with 8 left; wrote human-text.json and human-text-authors.json"), mixed.out);
  assert.equal(readAuthorMap(dir)["lang/en.json"]["baron-fixture.Kind_a"], "IAR18");

  // Plain --sign never asks about a validly signed text, as before.
  const plain = fakeAsk();
  assert.equal((await run(dir, { sign: true, isTTY: true, ask: plain.ask })).code, 0);
  assert.deepEqual(plain.asked, []);

  // Ctrl+C says how many records it threw away.
  const interrupted = new Error("Ctrl+C");
  await assert.rejects(run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", interrupted).ask }), interrupted);
  assert.deepEqual([interrupted.signedBeforeStop, interrupted.recordedBeforeStop], [0, 1]);
});

test("--sheet asks about a validly signed text with no author as about a pending one, only when its cell is the value and every row names the same valid author", async (t) => {
  const dir = reSignModule(t, "Open", null);
  writeAuthors(dir, { "lang/en.json": { "baron-fixture.Kind_b": "BaronHVC" } });
  const sheet = pageSheet(dir, "IAR18", {
    [OPEN]: { en: "Open" },
    "baron-fixture.Notice": { en: "Notice" },
    "baron-fixture.Title": { en: "Another title" },
    "baron-fixture.Kind_b": { en: "Kind B" },
  });
  const signatures = readText(dir, HUMAN_TEXT_FILE);
  const fake = fakeAsk("s", "s");
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [authorQuestion("IAR18"), authorQuestion("IAR18")], res.out);
  for (const line of [
    'sheet: textos-hoja-IAR18.csv: 2 text(s) to ask about (2 of them signed with no author recorded: s records it), each for the author of its row ("IAR18" 2)',
    "[1/2] lang/en.json  baron-fixture.Open  (signed, with no author recorded)  (sheet row 2)",
    "[2/2] lang/en.json  baron-fixture.Notice  (signed, with no author recorded)  (sheet row 3)",
    // A cell that is not the module's value is never asked about.
    REPLACES(1),
    "  row 4  en  baron-fixture.Title -> lang/en.json  (no author recorded)",
    OTHER_AUTHOR(1),
    '  row 5  en  baron-fixture.Kind_b  (sheet "IAR18", recorded "BaronHVC")',
    "sign-text: 0 signed, 2 author(s) recorded for signed text(s), 0 skipped; human-text.json unchanged; wrote human-text-authors.json",
  ]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  assert.equal(readText(dir, HUMAN_TEXT_FILE), signatures);
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { [OPEN]: "IAR18", "baron-fixture.Notice": "IAR18", "baron-fixture.Kind_b": "BaronHVC" } });
  // Run again: both are done now.
  const again = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fakeAsk().ask });
  assert.ok(again.lines.includes("info: 2 cell(s) already validly signed: not asked"), again.out);

  // Two rows with two authors for a text with no author, or a row without one: never asked.
  const mixed = reSignModule(t, "Open", null);
  writeSheet(mixed, [
    ["baron-fixture.Notice", "Notice", "", "BaronHVC"],
    ["baron-fixture.Notice", "Notice", "", "IAR18"],
    ["baron-fixture.Kind_a", "Kind A", "", ""],
  ]);
  const none = fakeAsk();
  const skip = await run(mixed, { sign: true, sheet: "hoja.csv", cwd: mixed, isTTY: true, ask: none.ask });
  assert.deepEqual(none.asked, [], skip.out);
  assert.ok(skip.out.includes("info: 2 cell(s) that give one text with different authors: keep one row for it; not asked:"), skip.out);
  assert.ok(skip.out.includes('info: 1 cell(s) in rows without an author: write in "author" the name of the person who wrote each one'), skip.out);
  assert.ok(!exists(mixed, HUMAN_TEXT_AUTHORS_FILE), skip.out);
});

/* ----------------------------------------------------------------------------
 * Writing the two files
 * -------------------------------------------------------------------------- */

test("each file is written on its own, the authors first; a rename that fails leaves no temporary file and says the signatures were not saved", async (t) => {
  const realRename = fs.renameSync;
  const busy = Object.assign(new Error("EBUSY: held"), { code: "EBUSY" });
  // en Open was signed as "Open" by BaronHVC; it now reads "Open now", and IAR18 signs it.
  const setup = () => {
    const dir = reSignModule(t);
    return { dir, before: [readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)] };
  };
  // The order: the authors file, then human-text.json.
  const ok = setup();
  const order = [];
  const watch = t.mock.method(fs, "renameSync", (from, to) => {
    order.push(path.basename(to));
    return realRename(from, to);
  });
  await run(ok.dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask });
  watch.mock.restore();
  assert.deepEqual(order, [HUMAN_TEXT_AUTHORS_FILE, HUMAN_TEXT_FILE]);

  // The authors file held: nothing changed.
  const a = setup();
  const heldA = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_AUTHORS_FILE ? (() => { throw busy; })() : realRename(from, to)));
  let message = "";
  await assert.rejects(run(a.dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  heldA.mock.restore();
  assert.equal(message, `could not replace ${path.join(a.dir, HUMAN_TEXT_AUTHORS_FILE)} (EBUSY: another program may have it open, such as an editor, a sync client or an antivirus scan): nothing was changed, and the 1 signature(s) given in this run were not saved; run --sign again`);
  assert.deepEqual([readText(a.dir, HUMAN_TEXT_FILE), readText(a.dir, HUMAN_TEXT_AUTHORS_FILE)], a.before);
  assert.deepEqual(tmps(a.dir), []);

  // human-text.json held after the authors landed: nothing is put back, and the new author names nobody.
  const h = setup();
  const heldH = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_FILE ? (() => { throw busy; })() : realRename(from, to)));
  await assert.rejects(run(h.dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  heldH.mock.restore();
  assert.equal(
    message,
    `could not replace ${path.join(h.dir, HUMAN_TEXT_FILE)} (EBUSY: another program may have it open, such as an editor, a sync client or an antivirus scan): ` +
      `${HUMAN_TEXT_FILE} is unchanged, so the 1 signature(s) given in this run were not saved (the authors written for them in ${HUMAN_TEXT_AUTHORS_FILE} do not count without them); run --sign again`,
  );
  assert.equal(readText(h.dir, HUMAN_TEXT_FILE), h.before[0]);
  assert.equal(readAuthorEntries(h.dir)["lang/en.json"][OPEN].name, "IAR18");
  assert.deepEqual(tmps(h.dir), []);
  const listing = await run(h.dir);
  assert.equal(listedAuthor(listing, "lang/en.json", OPEN), null);
  assert.ok(listing.lines.includes(IDLE(1)), listing.out);
  // As the message says: signing again saves it, with its author.
  assert.equal((await run(h.dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask })).signed, 1);
  assert.equal(listedAuthor(await run(h.dir), "lang/en.json", OPEN), "IAR18");

  // A temporary file that cannot be written: nothing changes and nothing is left behind.
  const w = setup();
  const realWrite = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).endsWith(".tmp")) throw Object.assign(new Error("ENOSPC: full"), { code: "ENOSPC" });
    return realWrite(file, ...rest);
  });
  await assert.rejects(run(w.dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  full.mock.restore();
  assert.equal(message, `could not write ${path.join(w.dir, `.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`)} (ENOSPC): nothing was changed, and the 1 signature(s) given in this run were not saved; run --sign again`);
  assert.deepEqual([readText(w.dir, HUMAN_TEXT_FILE), readText(w.dir, HUMAN_TEXT_AUTHORS_FILE)], w.before);
  assert.deepEqual(tmps(w.dir), []);

  // A run that also records an author for a text already signed: that record is saved, and the message says so.
  const r = setup();
  writeAuthors(r.dir, { "lang/en.json": { "baron-fixture.Title": "BaronHVC" } });
  const heldR = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_FILE ? (() => { throw busy; })() : realRename(from, to)));
  await assert.rejects(run(r.dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "s", "q").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  heldR.mock.restore();
  assert.ok(message.endsWith("do not count without them); the 1 author record(s) for texts already signed were saved; run --sign again"), message);
  assert.equal(listedAuthor(await run(r.dir), "module.json", "title"), "IAR18");

  // Only records, while a stale signature goes: no signature of this run is lost, so none is said to have authors
  // waiting; what human-text.json would have lost is the stale signature, which the next --sign removes.
  const withStale = (dir) => {
    const stale = readSigned(dir);
    stale["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
    fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), signaturesText(stale));
    return dir;
  };
  const s = withStale(reSignModule(t, "Open", null));
  const heldS = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_FILE ? (() => { throw busy; })() : realRename(from, to)));
  await assert.rejects(run(s, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  heldS.mock.restore();
  assert.equal(
    message,
    `could not replace ${path.join(s, HUMAN_TEXT_FILE)} (EBUSY: another program may have it open, such as an editor, a sync client or an antivirus scan): ` +
      `${HUMAN_TEXT_FILE} is unchanged, so the 1 stale signature(s) were not removed (the next --sign removes them); the 1 author record(s) for texts already signed were saved; run --sign again`,
  );
  assert.equal(listedAuthor(await run(s), "module.json", "title"), "IAR18");

  // A run that only prunes (a stale signature, an entry that names nobody): either rename held, it says what was not removed.
  for (const held of [HUMAN_TEXT_AUTHORS_FILE, HUMAN_TEXT_FILE]) {
    const prune = withStale(reSignModule(t, "Open now", "IAR18"));
    const before = [readText(prune, HUMAN_TEXT_FILE), readText(prune, HUMAN_TEXT_AUTHORS_FILE)];
    const heldU = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === held ? (() => { throw busy; })() : realRename(from, to)));
    await assert.rejects(run(prune, { sign: true, isTTY: true, ask: fakeAsk("n").ask }), (err) => {
      message = err.message;
      return err instanceof SignTextError;
    });
    heldU.mock.restore();
    const done = held === HUMAN_TEXT_FILE ? `${HUMAN_TEXT_FILE} is unchanged, so` : "nothing was changed, and";
    assert.equal(
      message,
      `could not replace ${path.join(prune, held)} (EBUSY: another program may have it open, such as an editor, a sync client or an antivirus scan): ` +
        `${done} the 1 stale signature(s) were not removed (the next --sign removes them); run --sign again`,
    );
    assert.equal(readText(prune, HUMAN_TEXT_FILE), before[0]);
    if (held === HUMAN_TEXT_AUTHORS_FILE) assert.equal(readText(prune, HUMAN_TEXT_AUTHORS_FILE), before[1]);
    assert.deepEqual(tmps(prune), []);
  }
  // Nothing given and nothing stale, only human-text.json put back in sign-text's own format: no stale signature is named.
  const fmt = signedModule(t);
  fs.writeFileSync(path.join(fmt, HUMAN_TEXT_FILE), JSON.stringify({ version: 1, signed: hashesOf(moduleTexts(fmt)) }) + NL);
  const heldF = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_FILE ? (() => { throw busy; })() : realRename(from, to)));
  await assert.rejects(run(fmt, { sign: true, isTTY: true, ask: fakeAsk().ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  heldF.mock.restore();
  assert.ok(message.endsWith(": nothing was changed, and the 0 signature(s) given in this run were not saved; run --sign again"), message);

  // Plain --sign: the authors file lost the entry that named nobody, and no author waits for the lost signature.
  const p = reSignModule(t, "Open now", "IAR18");
  const heldP = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_FILE ? (() => { throw busy; })() : realRename(from, to)));
  await assert.rejects(run(p, { sign: true, isTTY: true, ask: fakeAsk("s").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  heldP.mock.restore();
  assert.ok(message.endsWith(`: ${HUMAN_TEXT_FILE} is unchanged, so the 1 signature(s) given in this run were not saved; run --sign again`), message);
  assert.equal(readAuthorEntries(p)["lang/en.json"][OPEN], undefined);
});

test("a run cut at either rename never shows a wrong author, never leaves a broken file, and signing again recovers", async (t) => {
  // A child cut, as by a closed window, right before its n-th rename (0: never): process.exit, nothing runs after it.
  const script = path.join(tempDir(t, "cut"), "cut.mjs");
  fs.writeFileSync(
    script,
    [
      'import fs from "node:fs";',
      `import { signTexts } from ${JSON.stringify(pathToFileURL(SIGN_TEXT).href)};`,
      "const [dir, flag, value, stopAt, ...answers] = process.argv.slice(2);",
      "const rename = fs.renameSync;",
      "let n = 0;",
      "fs.renameSync = (from, to) => (++n === Number(stopAt) ? process.exit(137) : rename(from, to));",
      'await signTexts({ dir, cwd: dir, sign: true, ...(flag ? { [flag]: value } : {}), isTTY: true, ask: async () => answers.shift() ?? "q", log: () => {} });',
      "",
    ].join(NL),
  );
  // Each case: the module before the run, the run, and the author en Open may show for each of its values.
  const CASES = [
    // A text never signed: IAR18 signs it.
    ["a new key", () => {
      const dir = reSignModule(t, "Open now");
      const signed = readSigned(dir);
      delete signed["lang/en.json"][OPEN];
      writeSignatures(dir, signed);
      return dir;
    }, ["author", "IAR18"], { "Open now": "IAR18" }],
    // Signed as "Open" by BaronHVC; it reads "Open now", and IAR18 signs it.
    ["a key signed again with another author", () => reSignModule(t, "Open now", "BaronHVC"), ["author", "IAR18"], { Open: "BaronHVC", "Open now": "IAR18" }],
    ["a key signed again from a sheet", () => {
      const dir = reSignModule(t, "Open now", "BaronHVC");
      pageSheet(dir, "IAR18", { [OPEN]: { en: "Open now" } });
      return dir;
    }, ["sheet", "textos-hoja-IAR18.csv"], { Open: "BaronHVC", "Open now": "IAR18" }],
    // Signed as "Open" for IAR18; BaronHVC rewrote it, and signs it with plain --sign: no author.
    ["a key signed again by plain --sign", () => reSignModule(t, "Open now", "IAR18"), ["", ""], { Open: "IAR18", "Open now": null }],
    // Nothing to ask: a stale signature and entries that name nobody go.
    ["pruning", () => {
      const dir = reSignModule(t, "Open", "BaronHVC");
      const signed = readSigned(dir);
      signed["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
      writeSignatures(dir, signed);
      const entries = readAuthorEntries(dir);
      entries["lang/en.json"]["baron-fixture.Gone"] = { name: "IAR18", sha256: oracle("Gone") };
      entries["lang/en.json"]["baron-fixture.Title"] = { name: "IAR18", sha256: oracle("an older title") };
      writeAuthorEntries(dir, entries);
      return dir;
    }, ["", ""], { Open: "BaronHVC" }],
  ];
  const setValue = (dir, v) => fs.writeFileSync(path.join(dir, "lang", "en.json"), JSON.stringify({ ...readJson(dir, "lang", "en.json"), [OPEN]: v }, null, 2) + "\n");
  for (const [label, setup, [flag, value], allowed] of CASES) {
    for (const stopAt of [1, 2, 0]) {
      const at = `${label}, cut at rename ${stopAt}`;
      const dir = setup();
      const now = readJson(dir, "lang", "en.json")[OPEN];
      const before = { signed: readText(dir, HUMAN_TEXT_FILE), authors: readText(dir, HUMAN_TEXT_AUTHORS_FILE) };
      const res = runNode(script, [dir, flag, value, String(stopAt), "s"]);
      assert.equal(res.status, stopAt ? 137 : 0, `${at}${NL}${res.out}`);
      // Never a broken file.
      assert.equal(shared.readSignatures(dir).error, undefined, at);
      assert.equal(readAuthors(dir).error, undefined, at);
      // The authors land first: cut before the second rename, human-text.json is as it was.
      if (stopAt) assert.equal(readText(dir, HUMAN_TEXT_FILE), before.signed, at);
      if (stopAt === 1) assert.equal(readText(dir, HUMAN_TEXT_AUTHORS_FILE), before.authors, at);
      if (stopAt === 2) assert.notEqual(readText(dir, HUMAN_TEXT_AUTHORS_FILE), before.authors, at);
      // Whatever value en Open has, the listing names its own author or none.
      for (const v of Object.keys(allowed)) {
        setValue(dir, v);
        const shown = listedAuthor(await run(dir), "lang/en.json", OPEN);
        assert.ok(shown === null || shown === allowed[v], `${at}, en Open as ${JSON.stringify(v)}: shown as ${shown}'s`);
      }
      setValue(dir, now);
      // What a cut run left is reported as meaning nothing; --sign does not stop for it, and signing again recovers.
      const listing = await run(dir);
      const left = tmps(dir);
      assert.equal(left.length, stopAt ? 1 : 0, at);
      if (stopAt) {
        assert.ok(listing.lines.includes(`info: 1 temporary file(s) left by a --sign that did not finish (${left[0]}): nothing in it counts; delete it, and sign again what that run did not save`), `${at}${NL}${listing.out}`);
        assert.ok(!listing.out.includes("rename"), listing.out);
        const again = await run(dir, { sign: true, cwd: dir, ...(flag ? { [flag]: value } : {}), isTTY: true, ask: async () => "s" });
        assert.equal(again.code, 0, `${at}${NL}${again.out}`);
        fs.rmSync(path.join(dir, left[0]));
      }
      const final = await run(dir);
      assert.equal(listedAuthor(final, "lang/en.json", OPEN), allowed[now] ?? null, `${at}${NL}${final.out}`);
      assert.ok(!final.out.includes("temporary file") && !final.out.includes("name nobody"), `${at}${NL}${final.out}`);
    }
  }
});

test("a --sign never writes over what another --sign saved while it asked", async (t) => {
  for (const [label, answer, recordOnly] of [
    ["gave nothing", "q", false],
    ["signed", "s", false],
    ["only recorded an author", "s", true],
  ]) {
    // Every text signed but en and es Notice; P1 (IAR18) waits at its first question while P2 (BaronHVC) signs both.
    const dir = signedModule(t);
    const hashes = hashesOf(moduleTexts(dir));
    delete hashes["lang/en.json"]["baron-fixture.Notice"];
    delete hashes["lang/es.json"]["baron-fixture.Notice"];
    // As sign-text writes it: a run that gives nothing leaves it as it is.
    fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), signaturesText(hashes));
    // Signed already, with no author: P1 is asked about it only to record its author.
    if (recordOnly) writeSheet(dir, [["baron-fixture.Title", "Baron Fixture", "", "IAR18"]]);
    let other;
    const ask = async () => {
      if (other) return "q";
      other = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s", "s", "q").ask });
      return answer;
    };
    const p1 = { sign: true, isTTY: true, ask, ...(recordOnly ? { sheet: "hoja.csv", cwd: dir } : { author: "IAR18" }) };
    if (answer === "q") {
      // P1 gave nothing: it writes nothing, and P2's signatures and authors stay.
      const res = await run(dir, p1);
      assert.equal(other.signed, 2, other.out);
      assert.equal(res.wrote || res.wroteAuthors, false, res.out);
    } else {
      // P1 answered s: it stops without writing, and says why.
      const lost = recordOnly ? "the 0 signature(s) and 1 author record(s) given in this run" : "the 1 signature(s) given in this run";
      await assert.rejects(
        run(dir, p1),
        (err) =>
          err instanceof SignTextError &&
          err.message ===
            `${HUMAN_TEXT_FILE} and ${HUMAN_TEXT_AUTHORS_FILE} changed while this run asked (another --sign saved, or a program or git wrote them): ` +
              `nothing was written, so that change is kept and ${lost} were not saved; run --sign again, one --sign at a time`,
      );
    }
    assert.equal(readSigned(dir)["lang/en.json"]["baron-fixture.Notice"], oracle("Notice"), label);
    assert.equal(readSigned(dir)["lang/es.json"]["baron-fixture.Notice"], oracle("Aviso"), label);
    assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Notice": "BaronHVC" }, "lang/es.json": { "baron-fixture.Notice": "BaronHVC" } }, label);
    assert.deepEqual(tmps(dir), [], label);
  }
});

test("a --sign never writes over what another --sign saved while it saved: it checks both files again before each rename", async (t) => {
  const realRename = fs.renameSync;
  const held = Object.assign(new Error("EPERM: held"), { code: "EPERM" });
  const NOTICE = "baron-fixture.Notice";
  // Every text signed but en and es Notice. This run (IAR18) signs en Notice, skips es Notice and records the author
  // of the first signed text; meanwhile the other run (BaronHVC) signed both Notices, or one file alone changed.
  const all = (dir) => hashesOf(moduleTexts(dir));
  const without = (dir, ...langs) => {
    const signed = all(dir);
    for (const lang of langs) delete signed[`lang/${lang}.json`][NOTICE];
    return signed;
  };
  const BOTH = { signed: (dir) => all(dir), authors: { "lang/en.json": { [NOTICE]: "BaronHVC" }, "lang/es.json": { [NOTICE]: "BaronHVC" } } };
  for (const [label, at, other] of [
    // The other run saves both files right after this run's authors file lands, before its human-text.json.
    ["between the two renames", HUMAN_TEXT_AUTHORS_FILE, BOTH],
    // ... or while human-text.json is held, and its rename is tried again (about 2 s at most).
    ["while human-text.json is held", HUMAN_TEXT_FILE, BOTH],
    // One file alone changes in between: the authors file (a run that only recorded an author), or human-text.json (a program, git).
    ["the authors file alone, between the two renames", HUMAN_TEXT_AUTHORS_FILE, { signed: null, authors: { "lang/en.json": { "baron-fixture.Title": "BaronHVC" } } }],
    ["human-text.json alone, between the two renames", HUMAN_TEXT_AUTHORS_FILE, { signed: (dir) => without(dir, "en"), authors: null }],
  ]) {
    const dir = signedModule(t);
    const before = without(dir, "en", "es");
    fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), signaturesText(before));
    let saved = false;
    const otherSaves = () => {
      saved = true;
      if (other.signed) fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), signaturesText(other.signed(dir)));
      if (other.authors) writeAuthors(dir, other.authors);
    };
    const mock = t.mock.method(fs, "renameSync", (from, to) => {
      if (saved || path.basename(to) !== at) return realRename(from, to);
      if (at === HUMAN_TEXT_FILE) {
        otherSaves();
        throw held;
      }
      realRename(from, to);
      otherSaves();
    });
    let message = "";
    await assert.rejects(run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "n", "s", "q").ask }), (err) => {
      message = err.message;
      return err instanceof SignTextError;
    });
    mock.mock.restore();
    assert.ok(saved, label);
    const changed = [other.signed && HUMAN_TEXT_FILE, other.authors && HUMAN_TEXT_AUTHORS_FILE].filter(Boolean);
    assert.equal(
      message,
      `${changed.join(" and ")} changed while this run saved (another --sign saved, or a program or git wrote ${changed.length > 1 ? "them" : "it"}): ` +
        `this run did not write ${HUMAN_TEXT_FILE}, so that change is kept and the 1 signature(s) given in this run were not saved ` +
        `(the authors written for them in ${HUMAN_TEXT_AUTHORS_FILE} do not count without them)` +
        // Its author record is said to be saved only while the authors file still holds what this run wrote.
        `${other.authors ? "" : "; the 1 author record(s) for texts already signed were saved"}; run --sign again, one --sign at a time`,
      label,
    );
    // What the other saved is all there, the signature of this run is not, and nothing is left behind.
    assert.deepEqual(readSigned(dir), other.signed ? other.signed(dir) : before, label);
    if (other.authors) assert.deepEqual(readAuthorMap(dir), other.authors, label);
    else {
      const listing = await run(dir);
      assert.equal(listedAuthor(listing, "module.json", "title"), "IAR18", `${label}${NL}${listing.out}`);
      assert.equal(listedAuthor(listing, "lang/en.json", NOTICE), null, label);
    }
    assert.deepEqual(tmps(dir), [], label);
    // As the message says: signing again saves what this run lost.
    if (other !== BOTH) {
      assert.equal((await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask })).signed, 1, label);
      assert.equal(listedAuthor(await run(dir), "lang/en.json", NOTICE), "IAR18", label);
    }
  }
});

/* ----------------------------------------------------------------------------
 * Listing
 * -------------------------------------------------------------------------- */

test("the listing shows the author of each signed text that has one, and a count per author", async (t) => {
  const dir = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel" } } });
  const signed = hashesOf(moduleTexts(materialize(t)));
  delete signed["lang/en.json"]["baron-fixture.Notice"];
  writeSignatures(dir, signed);
  writeAuthors(dir, {
    "module.json": { title: "IAR18" },
    "lang/en.json": { "baron-fixture.Title": "IAR18", "baron-fixture.Open": "BaronHVC", "baron-fixture.Kind_a": "IAR18" },
    // Changed since IAR18 signed it, and a key that is gone: they name nobody.
    "lang/es.json": { "baron-fixture.Open": "IAR18", "baron-fixture.Gone": "IAR18" },
  });
  const res = await run(dir);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.lines.slice(1, 5), [
    'signed    module.json  title  by "IAR18"',
    'signed    lang/en.json  baron-fixture.Title  by "IAR18"',
    'signed    lang/en.json  baron-fixture.Open  by "BaronHVC"',
    'signed    lang/en.json  baron-fixture.Kind_a  by "IAR18"',
  ]);
  assert.ok(res.lines.includes("sign-text: 2 text(s) need a signature (1 unsigned, 1 changed since signed); 12 of 14 signed"), res.out);
  assert.ok(res.lines.includes('sign-text: authors of the 12 signed text(s): "IAR18" 3, "BaronHVC" 1; 8 with no author recorded'), res.out);
  assert.ok(res.lines.includes(IDLE(2)), res.out);

  // Without any author recorded the listing is what it always was: no new line.
  const bare = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel" } } });
  writeSignatures(bare, signed);
  const plain = await run(bare);
  writeAuthors(bare, {});
  const empty = await run(bare);
  assert.deepEqual(empty.lines.slice(1), plain.lines.slice(1));
  assert.ok(!plain.lines.some((l) => l.startsWith("signed ") || l.includes("authors of") || l.includes(HUMAN_TEXT_AUTHORS_FILE)), plain.out);
});

/* ----------------------------------------------------------------------------
 * Options and the CLI
 * -------------------------------------------------------------------------- */

test("--author refuses a name that is not valid with exit 2, before asking or writing anything", async (t) => {
  const dir = signedModule(t);
  for (const name of ["", "   ", "x".repeat(61), `IAR${ch(9)}18`, `IAR${ch(27)}[31m`]) {
    const fake = fakeAsk("s");
    const res = await run(dir, { sign: true, author: name, isTTY: true, ask: fake.ask });
    assert.equal(res.code, 2, JSON.stringify(name));
    assert.deepEqual(fake.asked, []);
    assert.ok(res.errors[0].startsWith("sign-text: ERROR: --author "), res.errors[0]);
    assert.ok(res.errors[0].includes("usage: node sign-text.mjs"), res.errors[0]);
  }
  // 60 characters is a name; --author without --sign is a mistake.
  assert.equal((await run(dir, { sign: true, author: "x".repeat(60), isTTY: true, ask: fakeAsk("q").ask })).code, 0);
  const listing = await run(dir, { author: "IAR18" });
  assert.equal(listing.code, 2);
  assert.match(listing.errors[0], /--author goes with --sign/);
  // The name is checked before the terminal: a bad one is exit 2 even without one.
  assert.equal((await run(dir, { sign: true, author: "", isTTY: false, ask: fakeAsk().ask })).code, 2);
  assert.ok(!exists(dir, HUMAN_TEXT_FILE) && !exists(dir, HUMAN_TEXT_AUTHORS_FILE));
});

test("the CLI: --author needs --sign, a valid name and a terminal; its mistakes exit 2", (t) => {
  const dir = signedModule(t);
  for (const args of [
    [dir, "--sign", "--author"],
    [dir, "--sign", "--author", ""],
    [dir, "--sign", "--author", "   "],
    [dir, "--sign", "--author="],
    [dir, "--sign", "--author", "--sign"],
    [dir, "--sign", "--author", "IAR18", "--author", "BaronHVC"],
    [dir, "--sign", `--author=${"x".repeat(61)}`],
    [dir, "--sign", "--author", `IAR${ch(9)}18`],
    [dir, "--author", "IAR18"],
  ]) {
    const res = runNode(SIGN_TEXT, args);
    assert.equal(res.status, 2, `${JSON.stringify(args.slice(1))}${NL}${res.out}`);
    assert.match(res.stderr, /sign-text: ERROR: --author/);
  }
  // A valid name still needs a person at a terminal; the hint repeats the name.
  const piped = runNode(SIGN_TEXT, [dir, "--sign", "--author", "Ana Ruiz"]);
  assert.equal(piped.status, 1, piped.out);
  const typed = /[\s"'&|<>()^;$`\\]/.test(dir) ? `"${dir}"` : dir;
  assert.ok(piped.stderr.split(/\r?\n/).includes(`  node tools/sign-text.mjs ${typed} --sign --author "Ana Ruiz"`), piped.out);
  const eq = runNode(SIGN_TEXT, [dir, "--author=IAR18", "--sign"]);
  assert.equal(eq.status, 1, eq.out);
  assert.ok(eq.stderr.includes(" --sign --author IAR18"), eq.out);
  assert.ok(!exists(dir, HUMAN_TEXT_FILE) && !exists(dir, HUMAN_TEXT_AUTHORS_FILE));
});

/* ----------------------------------------------------------------------------
 * Older cores
 * -------------------------------------------------------------------------- */

/** The tools/ folder of the core at `tag`, from this repo's git objects, or null without that tag. */
function oldCore(t, tag) {
  const has = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `${tag}^{commit}`], { env: childEnv(), encoding: "utf8", windowsHide: true });
  if (has.status !== 0) return null;
  const core = path.join(tempDir(t, `core-${tag}`), "pf2e-baron-core");
  const list = spawnSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", tag, "--", "tools"], { env: childEnv(), encoding: "utf8", windowsHide: true });
  assert.equal(list.status, 0, list.stderr);
  for (const rel of list.stdout.split("\n").filter(Boolean)) {
    const show = spawnSync("git", ["-C", REPO, "show", `${tag}:${rel}`], { env: childEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(show.status, 0, String(show.stderr));
    fs.mkdirSync(path.join(core, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(core, rel), show.stdout);
  }
  return core;
}

test("the check-module of an older core (v1.5.0, v1.6.0) still passes a module with human-text-authors.json, and reads it nowhere", async (t) => {
  const dir = signedModule(t);
  // Signed through the tool, as BaronHVC would: two authors, one file each.
  await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk(...Array(7).fill("s"), "q").ask });
  await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk(...Array(7).fill("s")).ask });
  assert.equal(Object.values(readAuthorMap(dir)).flatMap((k) => Object.values(k)).length, 14);
  const sidecar = readText(dir, HUMAN_TEXT_AUTHORS_FILE);
  const current = runNode(path.join(TOOLS, "check-module.mjs"), [dir, "--release"]);
  assert.equal(current.status, 0, current.out);
  assert.match(current.stdout, /^PASS {3}\[n\] human text/m);

  for (const tag of ["v1.5.0", "v1.6.0"]) {
    const core = oldCore(t, tag);
    if (!core) {
      t.diagnostic(`${tag} is not in this clone (a shallow checkout): skipped`);
      continue;
    }
    const check = (args) => runNode(path.join(core, "tools", "check-module.mjs"), args, { cwd: REPO });
    for (const args of [[dir], [dir, "--release"]]) {
      const withFile = check(args);
      assert.equal(withFile.status, 0, `${tag}${NL}${withFile.out}`);
      assert.match(withFile.stdout, /^PASS {3}\[n\] human text/m, `${tag}${NL}${withFile.out}`);
      // The same output without the file: it reads it nowhere.
      fs.rmSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE));
      const without = check(args);
      fs.writeFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE), sidecar);
      assert.equal(without.out, withFile.out, `${tag} ${args.join(" ")}`);
      // This core's check-module is v1.6.0's, byte for byte in what it prints.
      if (tag === "v1.6.0" && args.length > 1) assert.equal(current.out, withFile.out);
    }
    // Its sign-text reads the human-text.json this one wrote: nothing left to sign.
    const listing = runNode(path.join(core, "tools", "sign-text.mjs"), [dir], { cwd: REPO });
    assert.equal(listing.status, 0, listing.out);
    assert.ok(listing.stdout.includes("sign-text: 0 text(s) need a signature (0 unsigned, 0 changed since signed); 14 of 14 signed"), `${tag}${NL}${listing.out}`);
  }
});

test("v1.6.0's sign-text: a new value it signs keeps no author, the very value an entry was recorded for brings that author back", async (t) => {
  const core = oldCore(t, "v1.6.0");
  if (!core) return t.diagnostic("v1.6.0 is not in this clone (a shallow checkout): skipped");
  // Every text signed and recorded as IAR18's; BaronHVC rewrote en Open and signs it with v1.6.0, which knows no authors file.
  const dir = reSignModule(t, "Open now", "IAR18");
  const sidecar = readText(dir, HUMAN_TEXT_AUTHORS_FILE);
  const { signTexts: oldSign } = await import(pathToFileURL(path.join(core, "tools", "sign-text.mjs")).href);
  const old = await oldSign({ dir, sign: true, isTTY: true, ask: fakeAsk("s").ask, log: () => {}, logError: () => {} });
  assert.deepEqual({ signed: old.signed, wrote: old.wrote }, { signed: 1, wrote: true });
  assert.equal(readSigned(dir)["lang/en.json"][OPEN], oracle("Open now"));
  assert.equal(readText(dir, HUMAN_TEXT_AUTHORS_FILE), sidecar);
  // This core's listing: no author for en Open, never IAR18's; the others keep theirs.
  const listing = await run(dir);
  assert.equal(listedAuthor(listing, "lang/en.json", OPEN), null);
  assert.equal(listedAuthor(listing, "lang/en.json", "baron-fixture.Title"), "IAR18");
  assert.ok(listing.lines.includes('sign-text: authors of the 14 signed text(s): "IAR18" 13; 1 with no author recorded'), listing.out);
  assert.ok(listing.lines.includes(IDLE(1)), listing.out);
  // --author BaronHVC asks about it, a validly signed text with no author, and records him; IAR18's 13 are not asked.
  const fake = fakeAsk("s");
  const rec = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fake.ask });
  assert.equal(fake.asked.length, 1, rec.out);
  assert.ok(rec.lines.includes(`[1/1] lang/en.json  ${OPEN}  (signed, with no author recorded)`), rec.out);
  assert.ok(rec.lines.includes('info: 13 signed text(s) whose recorded author is not "BaronHVC": not asked (sign-text never changes the author of a valid signature)'), rec.out);
  assert.deepEqual({ recorded: rec.recorded, wrote: rec.wrote, wroteAuthors: rec.wroteAuthors }, { recorded: 1, wrote: false, wroteAuthors: true });
  assert.equal(readAuthorMap(dir)["lang/en.json"][OPEN], "BaronHVC");
  assert.ok(!(await run(dir)).out.includes("name nobody"));

  // v1.6.0 never touches the authors file: when it signs again the very value an entry was recorded for, that
  // entry counts again, whoever answered. The text put back ("Open now", then "Open" again, each signed by v1.6.0):
  const setOpen = (d, v) => fs.writeFileSync(path.join(d, "lang", "en.json"), JSON.stringify({ ...readJson(d, "lang", "en.json"), [OPEN]: v }, null, 2) + NL);
  const plain = (sign) => (d) => sign({ dir: d, sign: true, isTTY: true, ask: fakeAsk("s").ask, log: () => {}, logError: () => {} });
  const putBack = async (sign) => {
    const d = reSignModule(t, "Open now", "IAR18");
    await plain(sign)(d);
    assert.equal(listedAuthor(await run(d), "lang/en.json", OPEN), null);
    setOpen(d, "Open");
    await plain(sign)(d);
    assert.equal(readSigned(d)["lang/en.json"][OPEN], oracle("Open"));
    return listedAuthor(await run(d), "lang/en.json", OPEN);
  };
  assert.equal(await putBack(oldSign), "IAR18");
  // The same steps with this core's plain --sign: it writes the authors file, so the entry is gone before the value comes back.
  assert.equal(await putBack(signTexts), null);
  // A --author run that did not save human-text.json (cut or failed between its two renames), then v1.6.0 signs that text.
  const cut = reSignModule(t, "Open now", "BaronHVC");
  const realRename = fs.renameSync;
  const failed = t.mock.method(fs, "renameSync", (from, to) => (path.basename(to) === HUMAN_TEXT_FILE ? (() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); })() : realRename(from, to)));
  await assert.rejects(run(cut, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask }), SignTextError);
  failed.mock.restore();
  assert.equal(listedAuthor(await run(cut), "lang/en.json", OPEN), null);
  await plain(oldSign)(cut);
  assert.equal(listedAuthor(await run(cut), "lang/en.json", OPEN), "IAR18");
});

/* ----------------------------------------------------------------------------
 * --sheet
 * -------------------------------------------------------------------------- */

const SHEET_HEADER = ["key", "en", "es", "author"];
// How --sheet heads the cells it does not ask about, by reason (n cells).
const DIFFERS = (n) =>
  `info: ${n} cell(s) not imported yet, changed since, or replaced by another sheet's import: the value in the module is not the sheet's text (import the sheet first, if its text is the one to keep); not asked:`;
const REPLACES = (n) =>
  `info: ${n} cell(s) whose key holds another text, validly signed: importing this sheet would replace that signed text; keep one of the two texts (drop this row, or import the sheet and sign it); not asked:`;
const OTHER_AUTHOR = (n) =>
  `info: ${n} cell(s) already validly signed whose recorded author is not their row's: the record keeps its author (sign-text never changes the author of a valid signature); not asked:`;

/** Writes `rows` (after SHEET_HEADER, unless `header` says otherwise) as a CSV the way text-sheet export writes it. */
function writeSheet(dir, rows, { name = "hoja.csv", header = SHEET_HEADER } = {}) {
  fs.writeFileSync(path.join(dir, name), csvWrite([header, ...rows]));
  return name;
}

/** A sheet as the web page exports it for one person (textos-hoja-<name>.csv): header key,author,en,es, every cell quoted, CRLF, a UTF-8 BOM. */
function pageSheet(dir, name, cells) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["key", "author", "en", "es"].join(",")];
  for (const [k, c] of Object.entries(cells)) lines.push([q(k), q(name), q(c.en ?? ""), q(c.es ?? "")].join(","));
  const file = `textos-hoja-${name}.csv`;
  fs.writeFileSync(path.join(dir, file), ch(0xfeff) + lines.join(ch(13, 10)) + ch(13, 10));
  return file;
}

/** The module of the --sheet tests: five texts signed, the rest imported from a sheet and not signed yet. */
function sheetModule(t) {
  const dir = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Kind_a": `Tipo${NL}A` } } });
  const texts = moduleTexts(dir);
  writeSignatures(dir, {
    "module.json": { title: oracle(texts["module.json"].title) },
    "lang/en.json": { "baron-fixture.Title": oracle("Baron Fixture"), "baron-fixture.Kind_b": oracle("Kind B") },
    "lang/es.json": { "baron-fixture.Title": oracle("Baron Fixture"), "baron-fixture.Kind_b": oracle("Tipo B") },
  });
  return { dir, description: texts["module.json"].description };
}

test("--sheet asks only about the cells whose value in the module is the sheet's, each for the author of its row", async (t) => {
  const { dir, description } = sheetModule(t);
  const CRLF = `${ch(13)}${NL}`;
  const sheet = writeSheet(dir, [
    /* 2 */ ["baron-fixture.Open", "Open", "Abrir", "IAR18"],
    /* 3 */ ["baron-fixture.Notice", "Notice", "Aviso nuevo", "BaronHVC"],
    /* 4 */ ["baron-fixture.Kind_a", "Kind A", "", ""],
    /* 5 */ ["baron-fixture.Kind_b", "Kind B", "", "IAR18"],
    /* 6 */ ["module.json:description", description, "", " IAR18 "],
    /* 7 */ ["module.json:title", "", "Baron Fixture", "IAR18"],
    /* 8 */ ["baron-fixture.Nope", "x", "", "IAR18"],
    /* 9 */ ["baron-fixture.Unused", "Never referenced", "", "x".repeat(61)],
    /* 10 */ ["baron-fixture.Unused", "", "Nunca referida", "IAR18"],
    // A line break as Excel saves it: import writes it as LF, which is the module's value.
    /* 11 */ ["baron-fixture.Kind_a", "", `Tipo${CRLF}A`, "BaronHVC"],
    // The en Open of row 2 again, with another author: never asked.
    /* 12 */ ["baron-fixture.Open", "Open", "", "BaronHVC"],
  ]);
  const before = readText(dir, "lang", "en.json") + readText(dir, "lang", "es.json") + readText(dir, "module.json");
  const fake = fakeAsk("s", "s", "s", "s", "n", "s");
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(fake.asked, [authorQuestion("IAR18"), authorQuestion("BaronHVC"), authorQuestion("IAR18"), authorQuestion("IAR18"), authorQuestion("IAR18"), authorQuestion("BaronHVC")]);
  assert.ok(res.lines[0].endsWith(" --sign --sheet hoja.csv"), res.lines[0]);
  for (const line of [
    'sheet: hoja.csv: 6 text(s) to ask about (1 of them signed with no author recorded: s records it), each for the author of its row ("IAR18" 4, "BaronHVC" 2)',
    "info: 2 cell(s) that text-sheet import writes nowhere (no key, a key that is not in the files of that language, or a module.json row outside the first language column); not asked:",
    "  row 7  es  module.json:title",
    "  row 8  en  baron-fixture.Nope",
    DIFFERS(1),
    "  row 3  es  baron-fixture.Notice -> lang/es.json",
    'info: 1 cell(s) in rows without an author: write in "author" the name of the person who wrote each one, save the sheet and run this again; not asked:',
    "  row 4  en  baron-fixture.Kind_a",
    "info: 1 cell(s) whose author is not a valid name (1 to 60 characters, none of them a control character or one that prints nothing); not asked:",
    `  row 9  en  baron-fixture.Unused  (${JSON.stringify("x".repeat(61))})`,
    "info: 2 cell(s) that give one text with different authors: keep one row for it; not asked:",
    '  row 2  en  baron-fixture.Open  ("IAR18")',
    '  row 12  en  baron-fixture.Open  ("BaronHVC")',
    "info: 4 other text(s) need a signature and are not asked about from this sheet; sign-text without --sign lists them",
    "[1/6] lang/es.json  baron-fixture.Open  (sheet row 2)",
    "[2/6] lang/en.json  baron-fixture.Notice  (sheet row 3)",
    // Signed before by plain --sign, which records nobody: s records the row's author.
    "[3/6] lang/en.json  baron-fixture.Kind_b  (signed, with no author recorded)  (sheet row 5)",
    "[4/6] module.json  description  (sheet row 6)",
    "[5/6] lang/es.json  baron-fixture.Unused  (sheet row 10)",
    "[6/6] lang/es.json  baron-fixture.Kind_a  (sheet row 11)",
    "sign-text: 4 signed, 1 author(s) recorded for signed text(s), 1 skipped; wrote human-text.json and human-text-authors.json",
    'sign-text: authors recorded in this run: "IAR18" 3, "BaronHVC" 2',
  ]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  // The legend of --author, before the first question.
  assert.ok(res.lines.indexOf(AUTHOR_LEGEND[0]) < res.lines.indexOf("[1/6] lang/es.json  baron-fixture.Open  (sheet row 2)"), res.out);
  // A value that differs is never printed: it may be an AI working text.
  assert.ok(!res.out.includes('"Aviso"'), res.out);
  assert.deepEqual(readAuthorMap(dir), {
    "lang/en.json": { "baron-fixture.Kind_b": "IAR18", "baron-fixture.Notice": "BaronHVC" },
    "lang/es.json": { "baron-fixture.Kind_a": "BaronHVC", "baron-fixture.Open": "IAR18" },
    "module.json": { description: "IAR18" },
  });
  const signed = readSigned(dir);
  assert.equal(signed["lang/es.json"]["baron-fixture.Open"], oracle("Abrir"));
  assert.equal(signed["lang/es.json"]["baron-fixture.Kind_a"], oracle(`Tipo${NL}A`));
  assert.equal(signed["module.json"].description, oracle(description));
  assert.ok(!Object.hasOwn(signed["lang/es.json"], "baron-fixture.Unused"));
  assert.ok(!Object.hasOwn(signed["lang/en.json"], "baron-fixture.Open"));
  // It only signs: the module's texts are untouched.
  assert.equal(readText(dir, "lang", "en.json") + readText(dir, "lang", "es.json") + readText(dir, "module.json"), before);

  // Run again: what it signed or recorded is now reported as signed, and only the skipped text is asked about.
  const again = fakeAsk("s");
  const second = await run(dir, { sign: true, sheet: path.join(dir, sheet), isTTY: true, ask: again.ask });
  assert.deepEqual(again.asked, [authorQuestion("IAR18")]);
  assert.ok(second.lines.includes("info: 5 cell(s) already validly signed: not asked"), second.out);
  assert.ok(!second.out.includes("recorded author is not"), second.out);
  assert.equal(readAuthorMap(dir)["lang/es.json"]["baron-fixture.Unused"], "IAR18");
});

test("--sheet asks once about a text that several rows give with one author, and reads only the language columns", async (t) => {
  const { dir } = sheetModule(t);
  const sheet = writeSheet(
    dir,
    [
      ["", "baron-fixture.Open", "Open", "", "Open", "IAR18"],
      ["", "baron-fixture.Open", "Open", "", "", "IAR18"],
      // current_en is never read, whatever it holds.
      ["", "baron-fixture.Unused", "", "", "Never referenced", "IAR18"],
    ],
    { header: ["notas", "key", "en", "es", "current_en", "author"] },
  );
  const fake = fakeAsk("s");
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
  assert.equal(fake.asked.length, 1, res.out);
  assert.ok(res.lines.includes("[1/1] lang/en.json  baron-fixture.Open  (sheet rows 2, 3)"), res.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Open": "IAR18" } });
});

test("--sheet follows text-sheet's export and import: before the import nothing matches, after it every imported cell does", async (t) => {
  const dir = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Notice": "TODO-HUMANO: a notice" }, "lang/es.json": { "baron-fixture.Notice": "TODO-HUMANO: un aviso" } } });
  writeSignatures(dir, hashesOf({ "module.json": moduleTexts(dir)["module.json"] }));
  const quiet = { log: () => {}, logError: () => {}, cwd: dir, dir };
  await exportSheet(quiet);
  const { records } = csvParse(decodeSheet(fs.readFileSync(path.join(dir, SHEET_FILE))));
  const [header, ...rows] = records.map((r) => r.fields);
  const col = (name) => header.indexOf(name);
  const row = (key) => rows.find((r) => r[col("key")] === key);
  row("baron-fixture.Notice")[col("en")] = "A notice";
  row("baron-fixture.Notice")[col("es")] = "Un aviso";
  row("baron-fixture.Notice")[col("author")] = "IAR18";
  row("baron-fixture.Kind_a")[col("es")] = "Tipo A, escrito de nuevo";
  row("baron-fixture.Kind_a")[col("author")] = "BaronHVC";
  fs.writeFileSync(path.join(dir, SHEET_FILE), csvWrite([header, ...rows]));

  // Not imported yet: nothing to ask, each cell reported.
  const early = await run(dir, { sign: true, sheet: SHEET_FILE, cwd: dir, isTTY: true, ask: fakeAsk().ask });
  assert.equal(early.signed, 0);
  assert.ok(early.lines.includes(DIFFERS(3)), early.out);
  assert.ok(!exists(dir, HUMAN_TEXT_AUTHORS_FILE));

  assert.equal((await importSheet({ file: SHEET_FILE, ...quiet })).code, 0);
  const fake = fakeAsk("s", "s", "s");
  const res = await run(dir, { sign: true, sheet: SHEET_FILE, cwd: dir, isTTY: true, ask: fake.ask });
  assert.equal(res.signed, 3, res.out);
  assert.deepEqual(fake.asked, [authorQuestion("IAR18"), authorQuestion("IAR18"), authorQuestion("BaronHVC")]);
  assert.deepEqual(readAuthorMap(dir), {
    "lang/en.json": { "baron-fixture.Notice": "IAR18" },
    "lang/es.json": { "baron-fixture.Kind_a": "BaronHVC", "baron-fixture.Notice": "IAR18" },
  });
  // Every text the sheet held is signed, so a new export may take its place.
  await exportSheet(quiet);
});

test("--sheet: its mistakes exit 2, and a sheet it cannot read stops it before any question", async (t) => {
  const { dir } = sheetModule(t);
  const sheet = writeSheet(dir, [["baron-fixture.Open", "Open", "", "IAR18"]]);
  for (const [opts, why] of [
    [{ sign: true, sheet, author: "IAR18" }, /--author and --sheet do not go together/],
    [{ sheet }, /--sheet goes with --sign/],
    [{ sign: true, sheet: "" }, /--sheet needs the sheet file/],
  ]) {
    const fake = fakeAsk("s");
    const res = await run(dir, { cwd: dir, isTTY: true, ask: fake.ask, ...opts });
    assert.equal(res.code, 2, JSON.stringify(opts));
    assert.match(res.errors[0], why);
    assert.deepEqual(fake.asked, []);
  }
  fs.writeFileSync(path.join(dir, "nokey.csv"), "clave,en\r\nbaron-fixture.Open,Open\r\n");
  fs.writeFileSync(path.join(dir, "ansi.csv"), Buffer.from([0x6b, 0x65, 0x79, 0x2c, 0x65, 0x6e, 0x0d, 0x0a, 0x61, 0x2c, 0xe9, 0x0d, 0x0a]));
  fs.writeFileSync(path.join(dir, "twice.csv"), "key,en,EN,author\r\nbaron-fixture.Open,Open,,IAR18\r\n");
  for (const [file, why] of [
    ["missing.csv", /^missing\.csv does not exist in .+, the folder this runs in \(--sheet is read from there\)$/],
    ["nokey.csv", /^nokey\.csv has no header row with a "key" column/],
    ["ansi.csv", /^ansi\.csv: the sheet is not UTF-8 text/],
    ["twice.csv", /^twice\.csv has two "en" columns: keep one$/],
  ]) {
    const fake = fakeAsk("s");
    await assert.rejects(run(dir, { sign: true, sheet: file, cwd: dir, isTTY: true, ask: fake.ask }), (err) => err instanceof SignTextError && why.test(err.message), file);
    assert.deepEqual(fake.asked, []);
  }
  // A sheet another program holds open (a sync client, a program that locks it): a message, never a stack trace.
  const realRead = fs.readFileSync;
  const locked = t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (path.basename(String(file)) === sheet) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return realRead(file, ...rest);
  });
  const busy = fakeAsk("s");
  await assert.rejects(
    run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: busy.ask }),
    (err) => err instanceof SignTextError && err.message === `cannot read ${sheet} (EBUSY: another program may have it open): close it and run again`,
  );
  locked.mock.restore();
  assert.deepEqual(busy.asked, []);
  assert.ok(!exists(dir, HUMAN_TEXT_AUTHORS_FILE));

  // The CLI.
  for (const args of [
    [".", "--sign", "--sheet"],
    [".", "--sign", "--sheet", "--author", "IAR18"],
    [".", "--sign", "--sheet", sheet, "--author", "IAR18"],
    [".", "--sign", "--sheet", sheet, "--sheet", sheet],
    [".", "--sheet", sheet],
  ]) {
    const res = runNode(SIGN_TEXT, args, { cwd: dir });
    assert.equal(res.status, 2, `${JSON.stringify(args)}${NL}${res.out}`);
    assert.match(res.stderr, /sign-text: ERROR: --(sheet|author)/);
  }
  const piped = runNode(SIGN_TEXT, [".", "--sign", "--sheet", "mi hoja.csv"], { cwd: dir });
  assert.equal(piped.status, 1, piped.out);
  assert.ok(piped.stderr.includes(' . --sign --sheet "mi hoja.csv"'), piped.out);
  assert.ok(piped.stderr.includes("each signature says that its author wrote that text from scratch, as you attest"), piped.out);
});

/* ----------------------------------------------------------------------------
 * What --sheet never asks about, and names that only look alike
 * -------------------------------------------------------------------------- */

test("--sheet never asks about a cell that text-sheet import refuses: a placeholder it lacks, two rows with two texts for one key", async (t) => {
  const dir = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Notice": "{count} notices" } } });
  const sheet = writeSheet(dir, [
    // es "Aviso" is the module's value, but it lacks the {count} of en: import refuses it.
    /* 2 */ ["baron-fixture.Notice", "", "Aviso", "IAR18"],
    // "Abrir" is the module's value too, but row 4 gives the same key another text: import refuses both.
    /* 3 */ ["baron-fixture.Open", "", "Abrir", "IAR18"],
    /* 4 */ ["baron-fixture.Open", "", "Abrir otra vez", "IAR18"],
    /* 5 */ ["baron-fixture.Kind_b", "", "Tipo B", "IAR18"],
  ]);
  const dry = await importSheet({ file: sheet, dir, cwd: dir, dryRun: true, log: () => {}, logError: () => {} });
  assert.equal(dry.rejected, 3);
  const fake = fakeAsk("s");
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [authorQuestion("IAR18")], res.out);
  for (const line of [
    "info: 3 cell(s) that text-sheet import refuses, so it never wrote them from this sheet: fix them in the sheet and import it again; not asked:",
    "  row 2  es  baron-fixture.Notice: lacks {count}: it must keep exactly {count}",
    "  row 3  es  baron-fixture.Open: rows 3, 4 give it different texts: keep one",
    "  row 4  es  baron-fixture.Open: rows 3, 4 give it different texts: keep one",
    "[1/1] lang/es.json  baron-fixture.Kind_b  (sheet row 5)",
  ]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  // Importing again fixes nothing for row 4: it is never called "not imported yet".
  assert.ok(!res.out.includes("not imported yet"), res.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Kind_b": "IAR18" } });

  // A column import does not read, with text: import writes nothing from that sheet, and --sheet says why.
  const cols = writeSheet(dir, [["baron-fixture.Kind_a", "lo de antes", "", "Tipo A", "IAR18"]], { name: "cols.csv", header: ["key", "antes_en", "en", "es", "author"] });
  const c = await run(dir, { sign: true, sheet: cols, cwd: dir, isTTY: true, ask: fakeAsk("n").ask });
  assert.ok(
    c.lines.includes('info: text-sheet import refuses 1 column(s) of this sheet, which hold text it does not read (column B "antes_en"): it writes nothing from the sheet until they are renamed or emptied, or with --partial'),
    c.out,
  );
});

test("an author name that only looks like another is refused, and one name typed two ways is one author", async (t) => {
  const BS = ch(92);
  const ZWSP = ch(0x200b);
  const H = oracle("x");
  const looksAlike = [`IAR18${ZWSP}`, `IAR${ch(0xad)}18`, `${ch(0x202e)}81RAI${ch(0x202c)}`, `IAR${ch(0x2028)}18`, `IAR${ch(0x2029)}18`, `IAR${ch(0xe000)}18`, `IAR${ch(0xfdd0)}18`, `IAR${ch(0xd83f, 0xdffe)}18`, `IAR18${ch(0x200e)}`, `I${ch(0x2060)}AR18`];
  for (const name of looksAlike) assert.match(String(authorNameProblem(name)), /holds a character that prints nothing/, JSON.stringify(name));
  // The message shows the hidden character as its escape.
  assert.ok(authorNameProblem(`IAR18${ZWSP}`).startsWith(`"IAR18${BS}u200b" holds`), authorNameProblem(`IAR18${ZWSP}`));
  // A precomposed and a combining accent are one name, recorded in NFC; the file holds names only in NFC.
  const nfd = `Jos${"e"}${ch(0x301)}`;
  const nfc = `Jos${ch(0xe9)}`;
  assert.equal(authorNameProblem(nfd), null);
  assert.equal(shared.authorName(`  ${nfd} `), nfc);
  assert.match(String(authorsProblem({ version: 1, authors: { "lang/en.json": { a: { name: nfd, sha256: H } } } })), /not an author name \(not in Unicode NFC/);
  assert.match(String(authorsProblem({ version: 1, authors: { "lang/en.json": { a: { name: `IAR18${ZWSP}`, sha256: H } } } })), /prints nothing/);

  // --author: exit 2 before any question, the name escaped.
  const dir = signedModule(t);
  const bad = await run(dir, { sign: true, author: `IAR18${ZWSP}`, isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(bad.code, 2, bad.out);
  assert.ok(bad.errors[0].includes(`"IAR18${BS}u200b"`), bad.errors[0]);
  await run(dir, { sign: true, author: ` ${nfd} `, isTTY: true, ask: fakeAsk("s", "q").ask });
  assert.deepEqual(readAuthorMap(dir), { "module.json": { title: nfc } });

  // --sheet: such a row is reported with the escape, never asked; the same name in NFD is the NFC one.
  const other = signedModule(t);
  const sheet = writeSheet(other, [
    ["baron-fixture.Open", "Open", "", `IAR18${ZWSP}`],
    ["baron-fixture.Notice", "Notice", "", nfd],
    ["baron-fixture.Kind_a", "Kind A", "", nfc],
  ]);
  const fake = fakeAsk("s", "s");
  const res = await run(other, { sign: true, sheet, cwd: other, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [authorQuestion(nfc), authorQuestion(nfc)], res.out);
  assert.ok(res.lines.includes(`  row 2  en  baron-fixture.Open  ("IAR18${BS}u200b")`), res.out);
  assert.deepEqual(readAuthorMap(other), { "lang/en.json": { "baron-fixture.Kind_a": nfc, "baron-fixture.Notice": nfc } });
});

test("--sheet reports a signed text whose recorded author is not its row's, with both names, and leaves the record as it is", async (t) => {
  const dir = signedModule(t);
  writeSignatures(dir, { "lang/es.json": { "baron-fixture.Open": oracle("Abrir"), "baron-fixture.Notice": oracle("Aviso") } });
  // IAR18 signed Open through a sheet; Notice was signed with plain --sign, which records nobody.
  writeAuthors(dir, { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
  const other = writeSheet(dir, [["baron-fixture.Open", "", "Abrir", "BaronHVC"], ["baron-fixture.Notice", "", "Aviso", "BaronHVC"]], { name: "otra.csv" });
  // Notice has no author: asked, to record BaronHVC's; Open keeps IAR18 and is reported.
  const fake = fakeAsk("n");
  const res = await run(dir, { sign: true, sheet: other, cwd: dir, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [authorQuestion("BaronHVC")]);
  for (const line of [OTHER_AUTHOR(1), '  row 2  es  baron-fixture.Open  (sheet "BaronHVC", recorded "IAR18")', "[1/1] lang/es.json  baron-fixture.Notice  (signed, with no author recorded)  (sheet row 3)"]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  assert.ok(!res.lines.some((l) => l.startsWith("info: 2 cell(s) already validly signed")), res.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
  // The row that names the recorded author is only counted.
  const same = writeSheet(dir, [["baron-fixture.Open", "", "Abrir", "IAR18"]], { name: "misma.csv" });
  const ok = await run(dir, { sign: true, sheet: same, cwd: dir, isTTY: true, ask: fakeAsk().ask });
  assert.ok(ok.lines.includes("info: 1 cell(s) already validly signed: not asked"), ok.out);
  assert.ok(!ok.out.includes("recorded author is not"), ok.out);
  // --author never changes it either.
  const byAuthor = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("q").ask });
  assert.ok(byAuthor.lines.includes('info: 1 signed text(s) whose recorded author is not "BaronHVC": not asked (sign-text never changes the author of a valid signature)'), byAuthor.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
});

test("a long run says how many answers Ctrl+C would lose, q says how to continue, and a sheet run counts the module's other texts", async (t) => {
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`baron-fixture.K${i}`, `Text ${i}`]));
  const dir = signedModule(t, { merge: { "lang/en.json": many } });
  const res = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk(...Array(55).fill("s"), "q").ask });
  const REMIND = "(50 signature(s) of this run not saved yet: q saves them and stops, Ctrl+C throws them away)";
  assert.deepEqual(res.lines.filter((l) => l.includes("not saved yet")), [REMIND], res.out);
  assert.ok(res.lines[res.lines.indexOf(REMIND) + 1].startsWith("[51/"), res.out);
  assert.ok(res.lines.includes("to continue: node ../pf2e-baron-core/tools/sign-text.mjs . --sign --author IAR18 (a text signed now is not asked again; a skipped one is)"), res.out);
  // A run that only records authors for texts already signed counts them as author records, never as signatures.
  const signedAll = signedModule(t, { merge: { "lang/en.json": many } });
  fs.writeFileSync(path.join(signedAll, HUMAN_TEXT_FILE), signaturesText(hashesOf(moduleTexts(signedAll))));
  const rec = await run(signedAll, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk(...Array(55).fill("s"), "q").ask });
  assert.deepEqual(rec.lines.filter((l) => l.includes("not saved yet")), ["(0 signature(s) and 50 author record(s) of this run not saved yet: q saves them and stops, Ctrl+C throws them away)"], rec.out);
  assert.ok(rec.lines.some((l) => l.startsWith("sign-text: 0 signed, 55 author(s) recorded for signed text(s), 0 skipped, stopped with ")), rec.out);
  assert.ok(rec.lines.includes('sign-text: authors recorded in this run: "IAR18" 55'), rec.out);
  assert.ok(!rec.out.includes("signatures of this run"), rec.out);
  // Its legend says q saves the authors too, and Ctrl+C throws them away.
  const legend = AUTHOR_LEGEND.join(" ").replace(/\s+/g, " ");
  assert.ok(legend.includes("q stop, and save the signatures and authors given so far"), legend);
  assert.ok(legend.includes("Ctrl+C stop without saving any signature or author of this run"), legend);
  // A run that ends on its own needs no such line.
  const whole = signedModule(t);
  assert.ok(!(await run(whole, { sign: true, isTTY: true, ask: fakeAsk(...Array(14).fill("n")).ask })).out.includes("to continue:"));

  // A sheet run shows only the sheet's texts: the module's texts still to write are counted.
  const todo = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Notice": "TODO-HUMANO: a notice" } } });
  const sheet = writeSheet(todo, [["baron-fixture.Open", "Open", "", "IAR18"]]);
  const s = await run(todo, { sign: true, sheet, cwd: todo, isTTY: true, ask: fakeAsk("q").ask });
  assert.ok(!s.out.includes("TODO-HUMANO: a notice"), s.out);
  // Decision 28: a person writes them, and the person who attests signs them for their author.
  assert.ok(s.lines.includes("info: 1 text(s) still to write (empty or TODO-HUMANO:): BaronHVC or IAR18 writes each one from scratch (in the sheet), then BaronHVC signs it naming its author"), s.out);
  assert.ok(!s.out.includes("write them yourself"), s.out);
  assert.ok(s.lines.includes("to continue: node ../pf2e-baron-core/tools/sign-text.mjs . --sign --sheet hoja.csv (a text signed now is not asked again; a skipped one is)"), s.out);
  // Plain --sign still shows them, as it always did.
  assert.ok((await run(todo, { sign: true, isTTY: true, ask: fakeAsk("q").ask })).out.includes('"TODO-HUMANO: a notice"'));
});

test("--sheet counts the texts of each author before asking, and warns about names that differ only in case", async (t) => {
  const dir = signedModule(t);
  writeSignatures(dir, { "lang/en.json": { "baron-fixture.Title": oracle("Baron Fixture") } });
  writeAuthors(dir, { "lang/en.json": { "baron-fixture.Title": "IAR18" } });
  const sheet = writeSheet(dir, [
    ["baron-fixture.Open", "Open", "", "iar18"],
    ["baron-fixture.Notice", "Notice", "", "IAR18"],
    ["baron-fixture.Kind_a", "Kind A", "", "BaronHVC"],
  ]);
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fakeAsk("q").ask });
  const WARN = 'warn: author names that differ only in case are recorded as different authors: "iar18" (sheet row 2), "IAR18" (sheet row 3; 1 recorded); write one spelling, or answer q';
  assert.ok(res.lines.includes('sheet: hoja.csv: 3 text(s) to ask about, each for the author of its row ("BaronHVC" 1, "IAR18" 1, "iar18" 1)'), res.out);
  assert.ok(res.lines.includes(WARN), res.out);
  assert.ok(res.lines.indexOf(WARN) < res.lines.findIndex((l) => l.startsWith("[1/3]")), res.out);
  // One spelling throughout: no warning.
  const one = writeSheet(dir, [["baron-fixture.Open", "Open", "", "IAR18"]], { name: "una.csv" });
  assert.ok(!(await run(dir, { sign: true, sheet: one, cwd: dir, isTTY: true, ask: fakeAsk("q").ask })).out.includes("differ only in case"));
  // --author against the names already recorded.
  const author = await run(dir, { sign: true, author: "iar18", isTTY: true, ask: fakeAsk("q").ask });
  assert.ok(author.lines.includes('warn: author names that differ only in case are recorded as different authors: "iar18" (--author), "IAR18" (1 recorded); write one spelling, or answer q'), author.out);
});

test("--sheet: a sheet that is not where its path points says where it looked, and names the module's own", async (t) => {
  const dir = signedModule(t);
  writeSheet(dir, [["baron-fixture.Open", "Open", "", "IAR18"]], { name: "textos-hoja-IAR18.csv" });
  const parent = path.dirname(dir);
  await assert.rejects(
    run(dir, { sign: true, sheet: "textos-hoja-IAR18.csv", cwd: parent, isTTY: true, ask: fakeAsk().ask }),
    (err) =>
      err instanceof SignTextError &&
      err.message === `textos-hoja-IAR18.csv does not exist in ${parent}, the folder this runs in (--sheet is read from there); the module folder has one: --sheet baron-fixture/textos-hoja-IAR18.csv`,
  );
  // Given that way, it reads it.
  const res = await run(dir, { sign: true, sheet: "baron-fixture/textos-hoja-IAR18.csv", cwd: parent, isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(res.signed, 1, res.out);
});

/* ----------------------------------------------------------------------------
 * The real flow of one sheet per author
 * -------------------------------------------------------------------------- */

test("the listing and a --sheet that is not there name the sheets of the folder, one per author", async (t) => {
  const dir = signedModule(t);
  const COMMAND = "node ../pf2e-baron-core/tools/sign-text.mjs .";
  const nextOf = (res) => res.lines.find((l) => l.startsWith("next: ")) ?? "";
  // No sheet yet: the name export gives.
  assert.ok(nextOf(await run(dir, { cwd: dir })).includes(`: ${COMMAND} --sign --sheet textos-hoja.csv (the author of each row) or ${COMMAND} --sign --author <name>`));
  pageSheet(dir, "IAR18", { "baron-fixture.Open": { en: "Open", es: "Abrir" } });
  pageSheet(dir, "BaronHVC", { "baron-fixture.Notice": { en: "Notice" } });
  // Excel's lock file and other CSVs are not text sheets.
  fs.writeFileSync(path.join(dir, `~$textos-hoja-IAR18.csv`), "");
  fs.writeFileSync(path.join(dir, "otra.csv"), "key,en\r\n");
  const next = nextOf(await run(dir, { cwd: dir }));
  assert.ok(next.includes(`: ${COMMAND} --sign --sheet textos-hoja-BaronHVC.csv (the author of each row; the same for textos-hoja-IAR18.csv) or ${COMMAND} --sign --author <name>`), next);
  assert.ok(!next.includes("textos-hoja.csv"), next);
  // From the parent folder, as typed from there.
  const parent = path.dirname(dir);
  assert.ok(nextOf(await run(dir, { cwd: parent })).includes("--sheet baron-fixture/textos-hoja-BaronHVC.csv (the author of each row; the same for baron-fixture/textos-hoja-IAR18.csv)"));
  // The command it names reads the sheet.
  const signed = await run(dir, { sign: true, sheet: "textos-hoja-IAR18.csv", cwd: dir, isTTY: true, ask: fakeAsk("s", "s").ask });
  assert.equal(signed.signed, 2, signed.out);
  // The default name, missing: the error names the sheets that are there.
  await assert.rejects(
    run(dir, { sign: true, sheet: "textos-hoja.csv", cwd: dir, isTTY: true, ask: fakeAsk().ask }),
    (err) =>
      err instanceof SignTextError &&
      err.message === `textos-hoja.csv does not exist in ${dir}, the folder this runs in (--sheet is read from there); text sheets found: --sheet textos-hoja-BaronHVC.csv or --sheet textos-hoja-IAR18.csv`,
  );
  await assert.rejects(
    run(dir, { sign: true, sheet: "textos-hoja.csv", cwd: parent, isTTY: true, ask: fakeAsk().ask }),
    (err) => err instanceof SignTextError && err.message.endsWith("; text sheets found: --sheet baron-fixture/textos-hoja-BaronHVC.csv or --sheet baron-fixture/textos-hoja-IAR18.csv"),
  );
});

test("two sheets that give one key two texts: --sheet names the other sheet, and never says to import over a valid signature", async (t) => {
  const dir = signedModule(t);
  const quiet = { dir, cwd: dir, log: () => {}, logError: () => {} };
  const iar = pageSheet(dir, "IAR18", { "baron-fixture.Open": { en: "Open the panel", es: "Abrir el panel" } });
  const baron = pageSheet(dir, "BaronHVC", { "baron-fixture.Open": { en: "Open it" } });
  // IAR18's sheet is imported first, BaronHVC's last: the module holds BaronHVC's en text.
  assert.equal((await importSheet({ file: iar, ...quiet })).code, 0);
  assert.equal((await importSheet({ file: baron, ...quiet })).code, 0);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Open"], "Open it");

  const first = fakeAsk("s");
  const one = await run(dir, { sign: true, sheet: iar, cwd: dir, isTTY: true, ask: first.ask });
  assert.deepEqual(first.asked, [authorQuestion("IAR18")], one.out);
  for (const line of [DIFFERS(1), "  row 2  en  baron-fixture.Open -> lang/en.json  (the module holds the text of textos-hoja-BaronHVC.csv row 2)"]) {
    assert.ok(one.lines.includes(line), `${line}${NL}${one.out}`);
  }
  // BaronHVC signs his own text.
  const two = await run(dir, { sign: true, sheet: baron, cwd: dir, isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(two.signed, 1, two.out);
  // Now the module's text is BaronHVC's, validly signed: importing IAR18's sheet would replace that signature.
  const three = await run(dir, { sign: true, sheet: iar, cwd: dir, isTTY: true, ask: fakeAsk().ask });
  for (const line of [REPLACES(1), '  row 2  en  baron-fixture.Open -> lang/en.json  (recorded "BaronHVC"; the text of textos-hoja-BaronHVC.csv row 2)', "info: 1 cell(s) already validly signed: not asked"]) {
    assert.ok(three.lines.includes(line), `${line}${NL}${three.out}`);
  }
  assert.ok(!three.out.includes("import the sheet first"), three.out);
  // Never a value of the other sheet's row.
  assert.ok(!three.out.includes("Open the panel") && !one.out.includes("Open the panel"), three.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Open": "BaronHVC" }, "lang/es.json": { "baron-fixture.Open": "IAR18" } });

  // A signature with no author recorded is said as such.
  writeAuthors(dir, { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
  const four = await run(dir, { sign: true, sheet: iar, cwd: dir, isTTY: true, ask: fakeAsk().ask });
  assert.ok(four.lines.includes("  row 2  en  baron-fixture.Open -> lang/en.json  (no author recorded; the text of textos-hoja-BaronHVC.csv row 2)"), four.out);
});

test("--sheet never asks about a text that another row gives without a valid author", async (t) => {
  const MIXED = (n) => `info: ${n} cell(s) whose text another row gives without a valid author: write the same author in every row that gives it; not asked:`;
  const dir = signedModule(t);
  for (const other of ["", "x".repeat(61), `IAR18${ch(0x200b)}`]) {
    const sheet = writeSheet(dir, [["baron-fixture.Open", "Open", "", other], ["baron-fixture.Open", "Open", "", "BaronHVC"]]);
    const fake = fakeAsk("s");
    const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
    assert.deepEqual(fake.asked, [], `${JSON.stringify(other)}${NL}${res.out}`);
    assert.ok(res.lines.includes(MIXED(1)), res.out);
    assert.ok(res.lines.includes('  row 3  en  baron-fixture.Open  ("BaronHVC")'), res.out);
    assert.ok(res.lines.some((l) => l.startsWith("  row 2  en  baron-fixture.Open")), res.out);
    assert.ok(!exists(dir, HUMAN_TEXT_FILE), res.out);
  }
  // Another author in that row: two authors, still not asked; the same author: asked once.
  writeSheet(dir, [["baron-fixture.Open", "Open", "", "IAR18"], ["baron-fixture.Open", "Open", "", "BaronHVC"]]);
  assert.ok((await run(dir, { sign: true, sheet: "hoja.csv", cwd: dir, isTTY: true, ask: fakeAsk().ask })).out.includes("info: 2 cell(s) that give one text with different authors"));
  writeSheet(dir, [["baron-fixture.Open", "Open", "", "BaronHVC"], ["baron-fixture.Open", "Open", "", "BaronHVC"]]);
  const fake = fakeAsk("s");
  const res = await run(dir, { sign: true, sheet: "hoja.csv", cwd: dir, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [authorQuestion("BaronHVC")], res.out);
  assert.ok(res.lines.includes("[1/1] lang/en.json  baron-fixture.Open  (sheet rows 2, 3)"), res.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Open": "BaronHVC" } });
});

test("a name with a default-ignorable character is refused, and an astral character shows as its whole escape", async (t) => {
  const BS = ch(92);
  const esc = (unit) => `${BS}u${unit.toString(16).padStart(4, "0")}`;
  // Variation selectors, the combining grapheme joiner, the Hangul fillers, the Khmer inherent vowels, Mongolian selectors.
  for (const cp of [0x34f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x17b4, 0x17b5, 0x115f, 0x1160, 0x3164, 0xffa0, 0x180b]) {
    const name = `IAR18${String.fromCodePoint(cp)}`;
    assert.match(String(authorNameProblem(name)), /holds a character that prints nothing/, cp.toString(16));
    const shown = shared.showName(name);
    assert.ok(/^[ -~]*$/.test(shown), `${cp.toString(16)}: ${shown}`);
    assert.equal(JSON.parse(shown), name, cp.toString(16));
  }
  // Two astral characters never show alike, and the escape is the whole pair.
  const a = `IAR18${String.fromCodePoint(0xe0041)}`;
  const b = `IAR18${String.fromCodePoint(0xe0049)}`;
  assert.equal(shared.showName(a), `"IAR18${esc(0xdb40)}${esc(0xdc41)}"`);
  assert.notEqual(shared.showName(a), shared.showName(b));
  for (const name of [a, b, `IAR${String.fromCodePoint(0xf0000)}18`, `IAR${String.fromCodePoint(0x1fffe)}18`, `IAR${String.fromCodePoint(0x10ffff)}18`]) {
    assert.equal(JSON.parse(shared.showName(name)), name);
  }
  // A name that prints, astral or accented, is still a name, and shows as it is.
  for (const ok of [`Jos${ch(0xe9)}`, ch(0xd83d, 0xde00), `${ch(0x5d0)}${ch(0x5d1)}`]) {
    assert.equal(authorNameProblem(ok), null, ok);
    assert.equal(shared.showName(ok), JSON.stringify(ok));
  }

  // --sheet: such a row is reported with the escape and never asked; --author exits 2.
  const dir = signedModule(t);
  const sheet = writeSheet(dir, [["baron-fixture.Open", "Open", "", "IAR18"], ["baron-fixture.Notice", "Notice", "", `IAR18${ch(0x34f)}`]]);
  const fake = fakeAsk("s");
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [authorQuestion("IAR18")], res.out);
  assert.ok(res.lines.includes(`  row 3  en  baron-fixture.Notice  ("IAR18${esc(0x34f)}")`), res.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Open": "IAR18" } });
  const bad = await run(dir, { sign: true, author: `IAR18${ch(0xfe0f)}`, isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(bad.code, 2, bad.out);
  assert.ok(bad.errors[0].includes(`"IAR18${esc(0xfe0f)}"`), bad.errors[0]);
});

test("the commands sign-text prints keep $, a backtick and braces literal in PowerShell and in Git Bash", async (t) => {
  const dir = signedModule(t);
  const COMMAND = "node ../pf2e-baron-core/tools/sign-text.mjs .";
  for (const name of ["$IAR18", "IAR18 `1`", "{IAR18}"]) pageSheet(dir, name, { "baron-fixture.Open": { en: "Open" } });
  const next = (await run(dir, { cwd: dir })).lines.find((l) => l.startsWith("next: ")) ?? "";
  assert.ok(next.includes(`${COMMAND} --sign --sheet 'textos-hoja-$IAR18.csv' (the author of each row; the same for 'textos-hoja-IAR18 \`1\`.csv', 'textos-hoja-{IAR18}.csv')`), next);
  // to continue: after q, the same quoting.
  const stopped = await run(dir, { sign: true, sheet: "textos-hoja-$IAR18.csv", cwd: dir, isTTY: true, ask: fakeAsk("q").ask });
  assert.ok(stopped.lines.includes(`to continue: ${COMMAND} --sign --sheet 'textos-hoja-$IAR18.csv' (a text signed now is not asked again; a skipped one is)`), stopped.out);
  // A name that needs quotes and holds none of those keeps its double quotes.
  pageSheet(dir, "IAR18 (1)", { "baron-fixture.Open": { en: "Open" } });
  assert.ok(((await run(dir, { cwd: dir })).lines.find((l) => l.startsWith("next: ")) ?? "").includes('"textos-hoja-IAR18 (1).csv"'));
});

/* ----------------------------------------------------------------------------
 * Exports and the docs
 * -------------------------------------------------------------------------- */

const TEMPLATE = path.resolve(process.env.BARON_TEMPLATE_DIR ?? path.join(REPO, "..", "pf2e-module-template"));
/** A document as one line: its wording is checked, not where it wraps. */
const flat = (text) => text.replace(/\s+/g, " ");

test("text-sheet.mjs still exports what v1.6.0 exported, and the docs say which module exports the sheet reader", async (t) => {
  const TS = await import(pathToFileURL(path.join(TOOLS, "text-sheet.mjs")).href);
  // readSheet and AUTHOR_HEADERS are v1.6.0's private readSheet and AUTHOR_NAMES, exported only by shared.mjs.
  assert.equal("readSheet" in TS, false);
  assert.equal("AUTHOR_HEADERS" in TS, false);
  assert.equal(typeof shared.readSheet, "function");
  assert.deepEqual(shared.AUTHOR_HEADERS, ["author", "autor"]);
  const core = oldCore(t, "v1.6.0");
  if (core) {
    const old = await import(pathToFileURL(path.join(core, "tools", "text-sheet.mjs")).href);
    for (const name of Object.keys(old)) assert.ok(Object.hasOwn(TS, name), name);
  } else t.diagnostic("v1.6.0 is not in this clone (a shallow checkout): its exports not compared");
  const changelog = readText(REPO, "CHANGELOG.md");
  const unreleased = flat(changelog.slice(changelog.indexOf("## [Unreleased]"), changelog.indexOf("## [1.6.0]")));
  assert.ok(!unreleased.includes("`text-sheet.mjs` los sigue exportando."), unreleased);
  assert.ok(unreleased.includes("`readSheet` y `AUTHOR_HEADERS` solo los exporta `shared.mjs`"), unreleased);
  assert.ok(!readText(TOOLS, "text-sheet.mjs").includes("they are still this tool's exports"));
});

test("the docs: each author bound to the value it was recorded for, whichever core signs it, a leftover is deleted, one --sign at a time", (t) => {
  const readmeAll = readText(REPO, "README.md");
  const part = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
  // The sign-text sections of the README: the rest of it may rename and restore other things.
  const readme = flat(part(readmeAll, "## Firmar los textos humanos", "## Escribir los textos en la hoja") + part(readmeAll, "### Una hoja hecha en otra parte", "### `import`"));
  const header = flat(readText(TOOLS, "sign-text.mjs").split(`${NL}import `)[0].replace(/^\/\/ ?/gm, ""));
  const changelog = readText(REPO, "CHANGELOG.md");
  const unreleased = flat(changelog.slice(changelog.indexOf("## [Unreleased]"), changelog.indexOf("## [1.6.0]")));
  // What the leftover and rollback machinery of the third review said is gone everywhere.
  for (const [where, text] of Object.entries({ header, README: readme, CHANGELOG: unreleased })) {
    for (const gone of ["writeSteps", ".part.tmp", ".back.tmp", "restore human-text.json and it together", "older than v1.7.0 no more", "rename it", "del mismo commit", "en este orden", "se renombre", "renombrarlo", "no corre mientras"]) {
      assert.ok(!text.includes(gone), `${where} still says ${JSON.stringify(gone)}`);
    }
  }
  // One --sign at a time.
  assert.ok(header.includes("Run one --sign at a time per module"), header);
  assert.ok(readme.includes("Corre un solo `--sign` a la vez por"), "README: one --sign at a time");
  // Each entry is bound to its signature and counts whenever that very value is signed, whichever core signed it:
  // an older core that signs again the value an entry was recorded for brings that author back.
  assert.ok(header.includes("An author entry counts whenever human-text.json validly signs its text with that very hash, whichever core or run gave that signature"), header);
  assert.ok(header.includes("signs again the very value an entry was recorded for (a text put back, or one a cut run left unsigned), that entry counts again"), header);
  assert.ok(readme.includes(`el sha256 de la firma para la que se guard${ch(0xf3)}`), "README: the entry's sha256");
  for (const [where, text] of [
    ["README", readme],
    ["CHANGELOG", unreleased],
  ]) {
    assert.ok(text.includes(`el valor para el que se guard${ch(0xf3)} una entrada`) && text.includes("esa entrada vuelve a contar"), `${where}: an older core brings an author back`);
    for (const gone of ["deja su entrada vieja sin contar", "nunca con el de la firma anterior"]) assert.ok(!text.includes(gone), `${where} still says ${JSON.stringify(gone)}`);
  }
  assert.ok(!header.includes("by a core older than v1.7.0, or its signature is gone) names nobody"), header);
  // The listing differs from v1.6.0's in the leftover line too; the reminder counts authors apart; a lost human-text.json.
  assert.ok(readme.includes("y el aviso de los temporales que quedaron"), "README: what the listing adds to v1.6.0's");
  assert.ok(readme.includes(`cu${ch(0xe1)}ntas firmas (y, con \`--author\` o \`--sheet\`, cu${ch(0xe1)}ntos autores de textos ya firmados) lleva sin guardar`), "README: the reminder");
  assert.ok(unreleased.includes(`cu${ch(0xe1)}ntas firmas y cu${ch(0xe1)}ntos autores de textos ya firmados de la corrida siguen sin guardar`), "CHANGELOG: the reminder");
  assert.ok(readme.includes("Borrarlo (o perderlo) deja sin contar a todos los autores de `human-text-authors.json`"), "README: a lost human-text.json");
  // Both files are checked again before each rename, and who commits the authors file is reviewed as well.
  assert.ok(readme.includes(`antes de cada renombrado, tambi${ch(0xe9)}n en cada reintento, revisa`), "README: the check before each rename");
  assert.ok(header.includes("before each rename a run checks that its files still hold what it read (or wrote)"), header);
  assert.ok(readme.includes(`revisar qui${ch(0xe9)}n hace commit de esos tres archivos`) && readme.includes(`y tambi${ch(0xe9)}n \`human-text-authors.json\``), "README: the trust note");
  // A leftover is deleted, and --sign does not stop for it.
  assert.ok(readme.includes("el listado dice que se borre, y `--sign` no se detiene por"), "README: a leftover is deleted");
  assert.ok(header.includes("A temporary file a run left behind means nothing, and the listing says to delete it"), header);
  // The reviewer of a translation is the signature's author only with --author or --sheet.
  assert.ok(!readme.includes("el que contesta es el propio revisor"), "README: the reviewer answers with plain --sign");
  assert.ok(readme.includes("con `--author BaronHVC` o con su hoja y `--sheet`, para quedar como autor de la firma"), "README: the reviewer as author");
  // A signed text without an author that counts is asked about with --author and --sheet.
  assert.ok(readme.includes(`una firma v${ch(0xe1)}lida sin autor que cuente tambi${ch(0xe9)}n se pregunta`), "README: recording a missing author");
  // The page's own sheet, and the commands BaronHVC runs on it.
  for (const command of ["text-sheet.mjs import textos-hoja-IAR18.csv --dry-run", "sign-text.mjs . --sign --sheet textos-hoja-IAR18.csv"]) {
    assert.ok(readme.includes(command), `README: ${command}`);
  }
  if (!fs.existsSync(path.join(TEMPLATE, "README.md"))) return t.diagnostic(`no pf2e-module-template at ${TEMPLATE}: its docs not checked`);
  const template = flat(readText(TEMPLATE, "README.md"));
  const rule15 = flat(readText(TEMPLATE, "CLAUDE.md"));
  const init = flat(readText(TEMPLATE, "tools", "init-module.mjs"));
  for (const [where, text] of [
    ["template README", template],
    ["template CLAUDE.md", rule15],
    ["template init-module.mjs", init],
  ]) {
    assert.ok(!text.includes("del mismo commit") && !text.includes("el autor de la firma anterior junto a la nueva"), `${where}: the old rules of the authors file`);
    // An older core signing again the value an author was recorded for brings that author back: never "it stops counting".
    assert.ok(!text.includes("deja su autor sin contar") && !text.includes("ese autor deja de contar"), `${where}: an older core said to leave the author not counting`);
    assert.ok(text.includes("lo hace contar otra vez") || text.includes("lo hace contar de nuevo"), `${where}: an older core brings the author back`);
  }
  assert.ok(!template.includes("el que contesta es el propio revisor"), "template README: the reviewer answers with plain --sign");
  assert.ok(template.includes("con `--author BaronHVC` o con su hoja y `--sheet`, para quedar como autor de la firma"), "template README: the reviewer as author");
  assert.ok(template.includes("cuenta mientras `human-text.json` firme ese mismo valor, lo haya firmado el n" + ch(0xfa) + "cleo que sea"), "template README: an entry counts for its value");
  assert.ok(template.includes(`por eso se firma con un n${ch(0xfa)}cleo posterior a v1.6.0`), "template README: older cores");
  assert.ok(template.includes("se corre un solo `--sign` a la vez"), "template README: one at a time");
  assert.ok(rule15.includes("atado al sha256 de esa firma"), "template CLAUDE.md: each author bound to its signature");
});
