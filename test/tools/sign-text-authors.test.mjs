// Who wrote each signed text: sign-text --sign --author <name>, the
// human-text-authors.json file next to human-text.json, and what an older
// core's check-module makes of a module that has one. The terminal is faked
// as in sign-text.test.mjs: the TTY flag and the answers are injected.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
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

test("the two files change in one step: a failed rename puts back the authors file and keeps both new contents", async (t) => {
  const dir = signedModule(t);
  writeSignatures(dir, { "module.json": { title: oracle("Baron Fixture") } });
  writeAuthors(dir, { "module.json": { title: "IAR18" } });
  const before = [fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE)), fs.readFileSync(path.join(dir, HUMAN_TEXT_AUTHORS_FILE))];
  const realRename = fs.renameSync;
  const busy = Object.assign(new Error("EBUSY: held"), { code: "EBUSY" });
  const order = [];
  // The authors file goes first and gets through; human-text.json stays held.
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
  assert.deepEqual(order, [HUMAN_TEXT_AUTHORS_FILE, ...Array(10).fill(HUMAN_TEXT_FILE)]);
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
    "rename each of those files over its target (human-text-authors.json and human-text.json), or run --sign again",
  ]) {
    assert.ok(message.includes(words), `${words}${NL}${message}`);
  }
  fs.rmSync(tmpH);
  fs.rmSync(tmpA);

  // A new authors file that cannot land is removed again, not left half done.
  const fresh = signedModule(t);
  const held2 = t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(to) === HUMAN_TEXT_FILE) throw busy;
    return realRename(from, to);
  });
  await assert.rejects(run(fresh, { sign: true, author: "IAR18", isTTY: true, ask: fakeAsk("s", "q").ask }), SignTextError);
  held2.mock.restore();
  assert.ok(!exists(fresh, HUMAN_TEXT_FILE) && !exists(fresh, HUMAN_TEXT_AUTHORS_FILE));
  assert.equal(tmps(fresh).length, 2);

  // A temporary file that cannot be written: nothing changes and nothing is left behind.
  const realWrite = fs.writeFileSync;
  const full = t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).endsWith(`.${HUMAN_TEXT_FILE}.${process.pid}.tmp`)) throw Object.assign(new Error("ENOSPC: full"), { code: "ENOSPC" });
    return realWrite(file, ...rest);
  });
  await assert.rejects(run(dir, { sign: true, author: "BaronHVC", isTTY: true, ask: fakeAsk("s", "q").ask }), (err) => err instanceof SignTextError && /human-text-authors\.json and human-text\.json are unchanged, and the 1 signature\(s\) given in this run were not saved/.test(err.message));
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
