// Who wrote each signed text: sign-text --sign --author <name> and --sheet
// <file.csv>, the human-text-authors.json file next to human-text.json, and
// what an older core's check-module makes of a module that has one. The terminal is faked
// as in sign-text.test.mjs: the TTY flag and the answers are injected.

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
const writeSignatures = (dir, signed) => fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), JSON.stringify({ version: 1, signed }, null, 2) + "\n");
const writeAuthors = (dir, authors) => fs.writeFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE), JSON.stringify({ version: 1, authors }, null, 2) + "\n");
const readSigned = (dir) => readJson(dir, HUMAN_TEXT_FILE).signed;
const readAuthorMap = (dir) => readJson(dir, HUMAN_TEXT_AUTHORS_FILE).authors;
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const tmps = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

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

/* ----------------------------------------------------------------------------
 * The file and the names
 * -------------------------------------------------------------------------- */

test("authorsText writes the authors like human-text.json: keys sorted at every level, two spaces, LF, a final newline", (t) => {
  const parsed = JSON.parse('{"module.json":{"title":"IAR18","description":"BaronHVC"},"lang/es.json":{"x.B":"IAR18","__proto__":"BaronHVC","2":"IAR18","10":"IAR18"}}');
  const text = authorsText(parsed);
  assert.equal(
    text,
    [
      "{",
      '  "authors": {',
      '    "lang/es.json": {',
      '      "10": "IAR18",',
      '      "2": "IAR18",',
      '      "__proto__": "BaronHVC",',
      '      "x.B": "IAR18"',
      "    },",
      '    "module.json": {',
      '      "description": "BaronHVC",',
      '      "title": "IAR18"',
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
  assert.ok(authorsText({ "lang/en.json": { a: accented } }).includes(`"a": "${accented}"`));
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
  assert.equal(authorsProblem({ version: 1, authors: {} }), null);
  assert.equal(authorsProblem({ version: 1, authors: { "lang/en.json": { a: "IAR18" } } }), null);
  for (const [data, reason] of [
    [[], "must hold a JSON object"],
    [null, "must hold a JSON object"],
    [{ authors: {} }, 'has "version" undefined: it must be 1'],
    [{ version: 2, authors: {} }, 'has "version" 2: it must be 1'],
    [{ version: 1 }, 'needs "authors" to be an object of files'],
    [{ version: 1, authors: [] }, 'needs "authors" to be an object of files'],
    [{ version: 1, authors: {}, signed: {} }, 'has unknown key(s) "signed"'],
    [{ version: 1, authors: { "lang/en.json": "IAR18" } }, 'has authors["lang/en.json"] that is not an object of keys'],
    [{ version: 1, authors: { "lang/en.json": { a: "" } } }, 'has authors["lang/en.json"]["a"] that is not an author name (is empty'],
    [{ version: 1, authors: { "lang/en.json": { a: " IAR18" } } }, 'has authors["lang/en.json"]["a"] that is not an author name (spaces at an end)'],
    [{ version: 1, authors: { "lang/en.json": { a: 18 } } }, 'has authors["lang/en.json"]["a"] that is not an author name (must be a name)'],
  ]) {
    const problem = authorsProblem(data);
    assert.ok(problem?.startsWith(reason), `${JSON.stringify(data)}: ${problem}`);
  }
});

/* ----------------------------------------------------------------------------
 * --author
 * -------------------------------------------------------------------------- */

test("--author asks whether that person wrote each text, and records the name with each signature it gives", async (t) => {
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

  const expected = { "module.json": { title: oracle("Baron Fixture") }, "lang/en.json": { "baron-fixture.Title": oracle("Baron Fixture") } };
  assert.deepEqual(readSigned(dir), expected);
  // human-text.json is the file plain --sign writes, byte for byte.
  assert.equal(readText(dir, HUMAN_TEXT_FILE), signaturesText(expected));
  assert.equal(
    readText(dir, HUMAN_TEXT_AUTHORS_FILE),
    ["{", '  "authors": {', '    "lang/en.json": {', '      "baron-fixture.Title": "IAR18"', "    },", '    "module.json": {', '      "title": "IAR18"', "    }", "  },", '  "version": 1', "}", ""].join(NL),
  );
  assert.deepEqual({ signed: res.signed, skipped: res.skipped, wrote: res.wrote, wroteAuthors: res.wroteAuthors }, { signed: 2, skipped: 1, wrote: true, wroteAuthors: true });
  assert.ok(res.lines.includes("sign-text: 2 signed, 1 skipped, stopped with 11 left; wrote human-text.json and human-text-authors.json"), res.out);
  assert.ok(res.lines.includes('sign-text: authors recorded with the signatures of this run: "IAR18" 2'), res.out);
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

test("plain --sign records no author, and drops the older author of a text it signs again", async (t) => {
  const dir = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel", "baron-fixture.Notice": "Aviso nuevo" } } });
  writeSignatures(dir, hashesOf(moduleTexts(materialize(t))));
  writeAuthors(dir, { "lang/es.json": { "baron-fixture.Open": "IAR18", "baron-fixture.Notice": "IAR18", "baron-fixture.Title": "IAR18" } });
  // es Open and es Notice changed since IAR18's signatures: plain --sign signs Open again, skips Notice.
  const fake = fakeAsk("s", "n");
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, [QUESTION, QUESTION]);
  assert.equal(readSigned(dir)["lang/es.json"]["baron-fixture.Open"], oracle("Abrir el panel"));
  // Open lost its author; Notice keeps the author of the signature it still has; Title is untouched.
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Notice": "IAR18", "baron-fixture.Title": "IAR18" } });
  assert.equal(res.wroteAuthors, true);
  assert.ok(res.lines.includes("sign-text: 1 signed, 1 skipped; wrote human-text.json and human-text-authors.json"), res.out);

  // --author on a changed text replaces the author of the older signature.
  const again = await run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(again.signed, 1, again.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Notice": "BaronHVC", "baron-fixture.Title": "IAR18" } });

  // When the last author entry goes, the file stays, with no authors.
  const solo = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel" } } });
  writeSignatures(solo, hashesOf(moduleTexts(materialize(t))));
  writeAuthors(solo, { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
  await run(solo, { sign: true, isTTY: true, ask: fakeAsk("s").ask });
  assert.equal(readText(solo, HUMAN_TEXT_AUTHORS_FILE), authorsText({}));
});

test("--sign drops the author entries of the stale signatures it drops, even with nothing to ask", async (t) => {
  const dir = signedModule(t);
  const signed = hashesOf(moduleTexts(dir));
  signed["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
  signed["lang/fr.json"] = { "baron-fixture.Open": oracle("Ouvrir") };
  writeSignatures(dir, signed);
  writeAuthors(dir, {
    "lang/en.json": { "baron-fixture.Gone": "IAR18", "baron-fixture.Open": "IAR18" },
    "lang/fr.json": { "baron-fixture.Open": "IAR18" },
    // An author entry with no signature at all describes nothing.
    "lang/es.json": { "baron-fixture.Never": "IAR18" },
  });
  const res = await run(dir, { sign: true, isTTY: true, ask: fakeAsk().ask });
  assert.deepEqual({ code: res.code, stale: res.stale, wrote: res.wrote, wroteAuthors: res.wroteAuthors }, { code: 0, stale: 2, wrote: true, wroteAuthors: true });
  assert.deepEqual(readSigned(dir), hashesOf(moduleTexts(dir)));
  assert.deepEqual(readAuthorMap(dir), { "lang/en.json": { "baron-fixture.Open": "IAR18" } });
  assert.ok(res.lines.includes("sign-text: 0 signed, 0 skipped, 2 stale signature(s) removed; wrote human-text.json and human-text-authors.json"), res.out);

  // Nothing to sign and nothing stale: neither file is touched, an orphan entry included.
  writeAuthors(dir, { "lang/en.json": { "baron-fixture.Open": "IAR18" }, "lang/es.json": { "baron-fixture.Never": "IAR18" } });
  const before = [readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)];
  const idle = await run(dir, { sign: true, isTTY: true, ask: fakeAsk().ask });
  assert.deepEqual({ wrote: idle.wrote, wroteAuthors: idle.wroteAuthors }, { wrote: false, wroteAuthors: false });
  assert.deepEqual([readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)], before);
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
  assert.deepEqual([readText(dir, HUMAN_TEXT_FILE), readText(dir, HUMAN_TEXT_AUTHORS_FILE)], before);
  assert.deepEqual(tmps(dir), []);
});

test("the two files change in one step: a failed rename puts back what was replaced and keeps both new contents", async (t) => {
  const dir = signedModule(t);
  writeSignatures(dir, { "module.json": { title: oracle("Baron Fixture") } });
  writeAuthors(dir, { "module.json": { title: "IAR18" } });
  const before = [fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE)), fs.readFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE))];
  const realRename = fs.renameSync;
  const busy = Object.assign(new Error("EBUSY: held"), { code: "EBUSY" });
  const order = [];
  // Only an entry is added: human-text.json goes first, and stays held.
  const held = t.mock.method(fs, "renameSync", (from, to) => {
    order.push(path.basename(to));
    if (path.basename(to) === HUMAN_TEXT_FILE) throw busy;
    return realRename(from, to);
  });
  let message = "";
  await assert.rejects(run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s", "q").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  held.mock.restore();
  assert.deepEqual(order, Array(10).fill(HUMAN_TEXT_FILE));
  // Both files are as they were, and both new contents wait next to them.
  assert.ok(fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE)).equals(before[0]));
  assert.ok(fs.readFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE)).equals(before[1]));
  const tmpH = path.join(dir, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`);
  const tmpA = path.join(dir, `.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`);
  assert.deepEqual(tmps(dir).sort(), [path.basename(tmpA), path.basename(tmpH)].sort());
  const description = readJson(dir, "module.json").description;
  assert.deepEqual(JSON.parse(fs.readFileSync(tmpH, "utf8")).signed, { "module.json": { title: oracle("Baron Fixture"), description: oracle(description) } });
  assert.deepEqual(JSON.parse(fs.readFileSync(tmpA, "utf8")).authors, { "module.json": { title: "IAR18", description: "BaronHVC" } });
  for (const words of [
    `could not replace ${path.join(dir, HUMAN_TEXT_FILE)} (EBUSY: another program may have it open`,
    `Nothing was changed: the 1 signature(s) given in this run are in ${tmpH}, and their authors in ${tmpA}`,
    "rename each of those files over its target (human-text.json and human-text-authors.json), or run --sign again",
  ]) {
    assert.ok(message.includes(words), `${words}${NL}${message}`);
  }
  fs.rmSync(tmpH);
  fs.rmSync(tmpA);

  // The authors file held after human-text.json landed: human-text.json is put back (here: removed again).
  const fresh = signedModule(t);
  const held2 = t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(to) === HUMAN_TEXT_AUTHORS_FILE) throw busy;
    return realRename(from, to);
  });
  await assert.rejects(run(fresh, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask }), (err) => err instanceof SignTextError && /^could not replace .*human-text-authors\.json .*Nothing was changed/.test(err.message));
  held2.mock.restore();
  assert.ok(!exists(fresh, HUMAN_TEXT_FILE) && !exists(fresh, HUMAN_TEXT_AUTHORS_FILE));
  assert.deepEqual(tmps(fresh).sort(), [`.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`]);
  assert.deepEqual(JSON.parse(readText(fresh, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`)).signed, { "module.json": { title: oracle("Baron Fixture") } });

  // Three steps (an author replaced): the authors file without that entry, human-text.json, the new entry.
  // human-text.json held: the authors file is put back, and the intermediate content goes.
  const three = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Open": "Open now" } } });
  writeSignatures(three, hashesOf(moduleTexts(signedModule(t))));
  writeAuthors(three, { "lang/en.json": { "baron-fixture.Open": "BaronHVC", "baron-fixture.Title": "IAR18" } });
  const before3 = [fs.readFileSync(path.join(three, HUMAN_TEXT_FILE)), fs.readFileSync(path.join(three, HUMAN_TEXT_AUTHORS_FILE))];
  const order3 = [];
  const held3 = t.mock.method(fs, "renameSync", (from, to) => {
    order3.push(`${path.basename(from).includes(".part.") ? "part " : ""}${path.basename(to)}`);
    if (path.basename(to) === HUMAN_TEXT_FILE) throw busy;
    return realRename(from, to);
  });
  await assert.rejects(run(three, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask }), SignTextError);
  held3.mock.restore();
  assert.deepEqual(order3, [`part ${HUMAN_TEXT_AUTHORS_FILE}`, ...Array(10).fill(HUMAN_TEXT_FILE)]);
  assert.ok(fs.readFileSync(path.join(three, HUMAN_TEXT_FILE)).equals(before3[0]));
  assert.ok(fs.readFileSync(path.join(three, HUMAN_TEXT_AUTHORS_FILE)).equals(before3[1]));
  assert.deepEqual(tmps(three).sort(), [`.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`]);
  assert.deepEqual(JSON.parse(readText(three, `.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`)).authors, { "lang/en.json": { "baron-fixture.Open": "IAR18", "baron-fixture.Title": "IAR18" } });
  // The first rename itself held: its intermediate content goes, nothing changed, the last contents wait.
  fs.rmSync(path.join(three, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`));
  fs.rmSync(path.join(three, `.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`));
  const held4 = t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(from).includes(".part.")) throw busy;
    return realRename(from, to);
  });
  await assert.rejects(run(three, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s").ask }), SignTextError);
  held4.mock.restore();
  assert.ok(fs.readFileSync(path.join(three, HUMAN_TEXT_FILE)).equals(before3[0]));
  assert.ok(fs.readFileSync(path.join(three, HUMAN_TEXT_AUTHORS_FILE)).equals(before3[1]));
  assert.deepEqual(tmps(three).sort(), [`.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`]);

  // A temporary file that cannot be written: nothing changes and nothing is left behind.
  const realWrite = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).endsWith(`.${HUMAN_TEXT_FILE}.${process.pid}.tmp`)) throw Object.assign(new Error("ENOSPC: full"), { code: "ENOSPC" });
    return realWrite(file, ...rest);
  });
  await assert.rejects(run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s", "q").ask }), (err) => err instanceof SignTextError && /human-text\.json and human-text-authors\.json are unchanged, and the 1 signature\(s\) given in this run were not saved/.test(err.message));
  full.mock.restore();
  assert.ok(fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE)).equals(before[0]));
  assert.ok(fs.readFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE)).equals(before[1]));
  assert.deepEqual(tmps(dir), []);
});

test("a malformed human-text-authors.json stops the tool, listing too, without touching anything", async (t) => {
  for (const text of ['{"version": 1, "authors": {"lang/en.json": {"a": ""}}}\n', "{ not json", '{"version": 2, "authors": {}}']) {
    const dir = signedModule(t, { write: { [HUMAN_TEXT_AUTHORS_FILE]: text } });
    for (const sign of [false, true]) {
      await assert.rejects(run(dir, { sign, isTTY: true, ask: fakeAsk("s").ask }), (err) => err instanceof SignTextError && err.message.startsWith(`${HUMAN_TEXT_AUTHORS_FILE} `) && /restore it from git/.test(err.message));
    }
    assert.equal(readText(dir, HUMAN_TEXT_AUTHORS_FILE), text);
    assert.ok(!exists(dir, HUMAN_TEXT_FILE));
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
    // Changed since IAR18 signed it: not a signed text, so not listed with an author.
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
  assert.ok(res.lines.includes(`info: 1 author record(s) in ${HUMAN_TEXT_AUTHORS_FILE} have no signature in ${HUMAN_TEXT_FILE}; --sign removes them`), res.out);

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
    const withFile = check([dir, "--release"]);
    assert.equal(withFile.status, 0, `${tag}${NL}${withFile.out}`);
    assert.match(withFile.stdout, /^PASS {3}\[n\] human text/m, `${tag}${NL}${withFile.out}`);
    // The same output without the file: it reads it nowhere.
    fs.rmSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE));
    const without = check([dir, "--release"]);
    fs.writeFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE), sidecar);
    assert.equal(without.out, withFile.out, tag);
    // Its sign-text reads the human-text.json this one wrote: nothing left to sign.
    const listing = runNode(path.join(core, "tools", "sign-text.mjs"), [dir], { cwd: REPO });
    assert.equal(listing.status, 0, listing.out);
    assert.ok(listing.stdout.includes("sign-text: 0 text(s) need a signature (0 unsigned, 0 changed since signed); 14 of 14 signed"), `${tag}${NL}${listing.out}`);
    // This core's check-module is v1.6.0's, byte for byte in what it prints.
    if (tag === "v1.6.0") assert.equal(current.out, withFile.out);
  }
});

/* ----------------------------------------------------------------------------
 * --sheet
 * -------------------------------------------------------------------------- */

const SHEET_HEADER = ["key", "en", "es", "author"];

/** Writes `rows` (after SHEET_HEADER, unless `header` says otherwise) as a CSV the way text-sheet export writes it. */
function writeSheet(dir, rows, { name = "hoja.csv", header = SHEET_HEADER } = {}) {
  fs.writeFileSync(path.join(dir, name), csvWrite([header, ...rows]));
  return name;
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
  const fake = fakeAsk("s", "s", "s", "n", "s");
  const res = await run(dir, { sign: true, sheet, cwd: dir, isTTY: true, ask: fake.ask });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(fake.asked, [authorQuestion("IAR18"), authorQuestion("BaronHVC"), authorQuestion("IAR18"), authorQuestion("IAR18"), authorQuestion("BaronHVC")]);
  assert.ok(res.lines[0].endsWith(" --sign --sheet hoja.csv"), res.lines[0]);
  for (const line of [
    'sheet: hoja.csv: 5 text(s) to ask about, each for the author of its row ("IAR18" 3, "BaronHVC" 2)',
    "info: 2 cell(s) that text-sheet import writes nowhere (no key, a key that is not in the files of that language, or a module.json row outside the first language column); not asked:",
    "  row 7  es  module.json:title",
    "  row 8  en  baron-fixture.Nope",
    "info: 1 cell(s) not imported yet or changed since: the value in the module is not the sheet's text (import the sheet first); not asked:",
    "  row 3  es  baron-fixture.Notice -> lang/es.json",
    // Signed before by plain --sign: the record names nobody, the row names IAR18.
    "info: 1 cell(s) already validly signed whose recorded author is not their row's: the record keeps its author (sign-text never changes the author of a valid signature); not asked:",
    '  row 5  en  baron-fixture.Kind_b  (sheet "IAR18", none recorded)',
    'info: 1 cell(s) in rows without an author: write in "author" the name of the person who wrote each one, save the sheet and run this again; not asked:',
    "  row 4  en  baron-fixture.Kind_a",
    "info: 1 cell(s) whose author is not a valid name (1 to 60 characters, none of them a control character or one that prints nothing); not asked:",
    `  row 9  en  baron-fixture.Unused  (${JSON.stringify("x".repeat(61))})`,
    "info: 2 cell(s) that give one text with different authors: keep one row for it; not asked:",
    '  row 2  en  baron-fixture.Open  ("IAR18")',
    '  row 12  en  baron-fixture.Open  ("BaronHVC")',
    "info: 4 other text(s) need a signature and are not asked about from this sheet; sign-text without --sign lists them",
    "[1/5] lang/es.json  baron-fixture.Open  (sheet row 2)",
    "[2/5] lang/en.json  baron-fixture.Notice  (sheet row 3)",
    "[3/5] module.json  description  (sheet row 6)",
    "[4/5] lang/es.json  baron-fixture.Unused  (sheet row 10)",
    "[5/5] lang/es.json  baron-fixture.Kind_a  (sheet row 11)",
    "sign-text: 4 signed, 1 skipped; wrote human-text.json and human-text-authors.json",
    'sign-text: authors recorded with the signatures of this run: "BaronHVC" 2, "IAR18" 2',
  ]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  // The legend of --author, before the first question.
  assert.ok(res.lines.indexOf(AUTHOR_LEGEND[0]) < res.lines.indexOf("[1/5] lang/es.json  baron-fixture.Open  (sheet row 2)"), res.out);
  // A value that differs is never printed: it may be an AI working text.
  assert.ok(!res.out.includes('"Aviso"'), res.out);
  assert.deepEqual(readAuthorMap(dir), {
    "lang/en.json": { "baron-fixture.Notice": "BaronHVC" },
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

  // Run again: what it signed is now reported as signed, and only the skipped text is asked about.
  const again = fakeAsk("s");
  const second = await run(dir, { sign: true, sheet: path.join(dir, sheet), isTTY: true, ask: again.ask });
  assert.deepEqual(again.asked, [authorQuestion("IAR18")]);
  assert.ok(second.lines.includes("info: 4 cell(s) already validly signed: not asked"), second.out);
  assert.ok(second.lines.includes('  row 5  en  baron-fixture.Kind_b  (sheet "IAR18", none recorded)'), second.out);
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
  assert.ok(early.lines.includes("info: 3 cell(s) not imported yet or changed since: the value in the module is not the sheet's text (import the sheet first); not asked:"), early.out);
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
 * What --sheet never asks about, names that only look alike, and records
 * that a stop or a second sheet could make wrong
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
  const looksAlike = [`IAR18${ZWSP}`, `IAR${ch(0xad)}18`, `${ch(0x202e)}81RAI${ch(0x202c)}`, `IAR${ch(0x2028)}18`, `IAR${ch(0x2029)}18`, `IAR${ch(0xe000)}18`, `IAR${ch(0xfdd0)}18`, `IAR${ch(0xd83f, 0xdffe)}18`, `IAR18${ch(0x200e)}`, `I${ch(0x2060)}AR18`];
  for (const name of looksAlike) assert.match(String(authorNameProblem(name)), /holds a character that prints nothing/, JSON.stringify(name));
  // The message shows the hidden character as its escape.
  assert.ok(authorNameProblem(`IAR18${ZWSP}`).startsWith(`"IAR18${BS}u200b" holds`), authorNameProblem(`IAR18${ZWSP}`));
  // A precomposed and a combining accent are one name, recorded in NFC; the file holds names only in NFC.
  const nfd = `Jos${"e"}${ch(0x301)}`;
  const nfc = `Jos${ch(0xe9)}`;
  assert.equal(authorNameProblem(nfd), null);
  assert.equal(shared.authorName(`  ${nfd} `), nfc);
  assert.match(String(authorsProblem({ version: 1, authors: { "lang/en.json": { a: nfd } } })), /not an author name \(not in Unicode NFC/);
  assert.match(String(authorsProblem({ version: 1, authors: { "lang/en.json": { a: `IAR18${ZWSP}` } } })), /prints nothing/);

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
  const fake = fakeAsk();
  const res = await run(dir, { sign: true, sheet: other, cwd: dir, isTTY: true, ask: fake.ask });
  assert.deepEqual(fake.asked, []);
  for (const line of [
    "info: 2 cell(s) already validly signed whose recorded author is not their row's: the record keeps its author (sign-text never changes the author of a valid signature); not asked:",
    '  row 2  es  baron-fixture.Open  (sheet "BaronHVC", recorded "IAR18")',
    '  row 3  es  baron-fixture.Notice  (sheet "BaronHVC", none recorded)',
  ]) {
    assert.ok(res.lines.includes(line), `${line}${NL}${res.out}`);
  }
  assert.ok(!res.lines.some((l) => l.startsWith("info: 2 cell(s) already validly signed: not asked")), res.out);
  assert.deepEqual(readAuthorMap(dir), { "lang/es.json": { "baron-fixture.Open": "IAR18" } });
  // The row that names the recorded author is only counted.
  const same = writeSheet(dir, [["baron-fixture.Open", "", "Abrir", "IAR18"]], { name: "misma.csv" });
  const ok = await run(dir, { sign: true, sheet: same, cwd: dir, isTTY: true, ask: fakeAsk().ask });
  assert.ok(ok.lines.includes("info: 1 cell(s) already validly signed: not asked"), ok.out);
  assert.ok(!ok.out.includes("recorded author is not"), ok.out);
});

test("a stop between the renames can leave a signature without its author, never with another one's", async (t) => {
  // The run is cut, as by a closed window, right before its n-th rename: process.exit, no rollback.
  const script = path.join(tempDir(t, "stop"), "stop.mjs");
  fs.writeFileSync(
    script,
    [
      'import fs from "node:fs";',
      `import { signTexts } from ${JSON.stringify(pathToFileURL(SIGN_TEXT).href)};`,
      "const [dir, author, stopAt, ...answers] = process.argv.slice(2);",
      "const rename = fs.renameSync;",
      "let n = 0;",
      "fs.renameSync = (from, to) => (++n === Number(stopAt) ? process.exit(137) : rename(from, to));",
      'await signTexts({ dir, sign: true, author: author || undefined, isTTY: true, ask: async () => answers.shift() ?? "q", log: () => {} });',
      "",
    ].join(NL),
  );
  const OPEN = "baron-fixture.Open";
  for (const [label, older] of [["no author recorded", null], ["another author recorded", "BaronHVC"]]) {
    for (const stopAt of [1, 2, 3, 0]) {
      // en Open was signed as "Open", by `older` (or by plain --sign); it now reads "Open now", and IAR18 signs it.
      const dir = signedModule(t, { merge: { "lang/en.json": { [OPEN]: "Open now" } } });
      writeSignatures(dir, hashesOf(moduleTexts(materialize(t))));
      if (older) writeAuthors(dir, { "lang/en.json": { [OPEN]: older } });
      const res = runNode(script, [dir, "IAR18", String(stopAt), "s"]);
      assert.equal(res.status, stopAt && stopAt <= (older ? 3 : 2) ? 137 : 0, `${label} ${stopAt}${NL}${res.out}`);
      const hash = readSigned(dir)["lang/en.json"][OPEN];
      const author = exists(dir, HUMAN_TEXT_AUTHORS_FILE) ? (readAuthorMap(dir)["lang/en.json"]?.[OPEN] ?? null) : null;
      // The old signature keeps its own author or none; the new one has IAR18 or none.
      if (hash === oracle("Open")) assert.ok(author === null || author === older, `${label}, stop at ${stopAt}: the old signature is credited to ${author}`);
      else assert.ok(hash === oracle("Open now") && (author === null || author === "IAR18"), `${label}, stop at ${stopAt}: ${hash} by ${author}`);
      // With the old value back, the listing never credits IAR18 with a signature someone else gave.
      fs.writeFileSync(path.join(dir, "lang", "en.json"), JSON.stringify({ ...readJson(dir, "lang", "en.json"), [OPEN]: "Open" }, null, 2) + "\n");
      const listing = await run(dir);
      assert.ok(!listing.out.includes(`${OPEN}  by "IAR18"`), `${label}, stop at ${stopAt}${NL}${listing.out}`);
      if (stopAt === 0) assert.equal(author, "IAR18", label);
      // What the stopped run left behind is reported, never silent.
      if (res.status === 137) assert.ok(listing.lines.some((l) => /^info: \d temporary file\(s\) left by a --sign that did not finish \(\.human-text/.test(l)), listing.out);
    }
  }
});

test("a long run says how many answers Ctrl+C would lose, q says how to continue, and a sheet run counts the module's other texts", async (t) => {
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`baron-fixture.K${i}`, `Text ${i}`]));
  const dir = signedModule(t, { merge: { "lang/en.json": many } });
  const res = await run(dir, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk(...Array(55).fill("s"), "q").ask });
  const REMIND = "(50 signature(s) of this run not saved yet: q saves them and stops, Ctrl+C throws them away)";
  assert.deepEqual(res.lines.filter((l) => l.includes("not saved yet")), [REMIND], res.out);
  assert.ok(res.lines[res.lines.indexOf(REMIND) + 1].startsWith("[51/"), res.out);
  assert.ok(res.lines.includes("to continue: node ../pf2e-baron-core/tools/sign-text.mjs . --sign --author IAR18 (a text signed now is not asked again; a skipped one is)"), res.out);
  // A run that ends on its own needs no such line.
  const whole = signedModule(t);
  assert.ok(!(await run(whole, { sign: true, isTTY: true, ask: fakeAsk(...Array(14).fill("n")).ask })).out.includes("to continue:"));

  // A sheet run shows only the sheet's texts: the module's texts still to write are counted.
  const todo = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Notice": "TODO-HUMANO: a notice" } } });
  const sheet = writeSheet(todo, [["baron-fixture.Open", "Open", "", "IAR18"]]);
  const s = await run(todo, { sign: true, sheet, cwd: todo, isTTY: true, ask: fakeAsk("q").ask });
  assert.ok(!s.out.includes("TODO-HUMANO: a notice"), s.out);
  assert.ok(s.lines.includes("info: 1 text(s) still to write (empty or TODO-HUMANO:): write them yourself, then sign them"), s.out);
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
