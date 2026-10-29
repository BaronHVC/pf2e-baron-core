// tools/sign-text.mjs and the human-text helpers of tools/shared.mjs: how the
// texts are found and keyed, how a value is hashed, the shape of
// human-text.json, and the listing and the signing with a fake terminal (the
// TTY flag and the answers are injected, so nothing here needs a real one).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  HUMAN_TEXT_FILE,
  flattenLang,
  hashText,
  humanTexts,
  readSignatures,
  signatureStatus,
  signaturesProblem,
  signaturesText,
  staleSignatures,
} from "../../tools/shared.mjs";
import { LEGEND, NO_TTY_MESSAGE, QUESTION, SignTextError, noTtyMessage, signTexts } from "../../tools/sign-text.mjs";
import { REPO, TOOLS, childEnv, materialize, readJson, readText, runNode, tempDir } from "./helpers.mjs";

// Independent oracle: sha256 of the exact UTF-8 bytes.
const oracle = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const SIGN_TEXT = path.join(TOOLS, "sign-text.mjs");
const NL = String.fromCharCode(10);
// The next step names who signs (the person who attests) and how the author is named (decision 28).
const nextLine = (command) =>
  `next: once a person has written each of these from scratch, the person who attests them (BaronHVC) signs them at a terminal, naming who wrote them: ${command} --sign --sheet textos-hoja.csv (the author of each row) or ${command} --sign --author <name>`;
const NEXT = nextLine("node ../pf2e-baron-core/tools/sign-text.mjs .");
// Texts still to write: a person writes them (decision 28), never "yourself" to whoever reads the listing.
const toWrite = (n) => `info: ${n} text(s) still to write (empty or TODO-HUMANO:): BaronHVC or IAR18 writes each one from scratch (in the sheet), then BaronHVC signs it naming its author`;

/** The valid fixture with baron.json "humanText": "signed" plus `spec` (see helpers.materialize). */
const signedModule = (t, spec = {}) =>
  materialize(t, { ...spec, merge: { "baron.json": { humanText: "signed" }, ...(spec.merge ?? {}) } });

/** Every text of the fixture as { file: { key: value } }, read from the files themselves. */
function fixtureTexts(dir) {
  const m = readJson(dir, "module.json");
  return {
    "module.json": { title: m.title, description: m.description },
    "lang/en.json": readJson(dir, "lang", "en.json"),
    "lang/es.json": readJson(dir, "lang", "es.json"),
  };
}

/** { file: { key: value } } -> { file: { key: sha256 } }, by the oracle. */
const hashesOf = (texts) => Object.fromEntries(Object.entries(texts).map(([f, keys]) => [f, Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, oracle(v)]))]));

const writeSignatures = (dir, signed) => fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), JSON.stringify({ version: 1, signed }, null, 2) + "\n");
const readSigned = (dir) => readJson(dir, HUMAN_TEXT_FILE).signed;

/** A fake terminal: answers in order; an Error in the list is thrown (Ctrl+C). */
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

/** Runs signTexts with captured output. */
async function run(dir, opts = {}) {
  const lines = [];
  const errors = [];
  const res = await signTexts({ dir, log: (l) => lines.push(l), logError: (l) => errors.push(l), ...opts });
  return { ...res, lines, errors, out: lines.join("\n") };
}

/* ----------------------------------------------------------------------------
 * Keys, hashes and the file format
 * -------------------------------------------------------------------------- */

test("flattenLang keys nested objects with dots, as Foundry flattens them, and keeps every leaf in file order", () => {
  const data = { a: { b: "x", c: { d: "y" } }, "a.e": "z", list: ["p", "q"], n: 3, empty: "", nil: null };
  assert.deepEqual(flattenLang(data), [
    ["a.b", "x"],
    ["a.c.d", "y"],
    ["a.e", "z"],
    ["list", ["p", "q"]],
    ["n", 3],
    ["empty", ""],
    ["nil", null],
  ]);
  assert.deepEqual(flattenLang(null), []);
  assert.deepEqual(flattenLang({}), []);
});

test("hashText is the sha256 of the exact UTF-8 string: no trim, no line-ending or Unicode normalization", () => {
  const accented = `Espa${String.fromCharCode(0xf1)}ol`;
  const decomposed = `Espan${String.fromCharCode(0x303)}ol`;
  for (const s of ["Open", "", " Open", "Open ", "a\r\nb", "a\nb", accented, decomposed]) {
    assert.equal(hashText(s), oracle(s), JSON.stringify(s));
    assert.match(hashText(s), /^[0-9a-f]{64}$/);
  }
  assert.notEqual(hashText("Open"), hashText(" Open"));
  assert.notEqual(hashText("Open"), hashText("Open "));
  assert.notEqual(hashText("a\r\nb"), hashText("a\nb"));
  assert.notEqual(hashText(accented), hashText(decomposed));
});

test("humanTexts takes the module.json title and description and every string of the language files", () => {
  const module = { id: "x", title: "Title", description: "Desc", version: "1.0.0", authors: [{ name: "BaronHVC" }] };
  const texts = humanTexts(module, [
    { rel: "lang/en.json", data: { x: { Open: "Open", Deep: { Line: "Line" } }, "x.Count": 3, "x.List": ["a", 1], "x.Nums": [1, 2], "x.Empty": "" } },
    // The same key and value both nested and dotted is one text.
    { rel: "lang/es.json", data: { x: { Open: "Abrir" }, "x.Open": "Abrir" } },
  ]);
  assert.deepEqual(texts, [
    { file: "module.json", key: "title", value: "Title" },
    { file: "module.json", key: "description", value: "Desc" },
    { file: "lang/en.json", key: "x.Open", value: "Open" },
    { file: "lang/en.json", key: "x.Deep.Line", value: "Line" },
    { file: "lang/en.json", key: "x.List", value: ["a", 1] },
    { file: "lang/en.json", key: "x.Empty", value: "" },
    { file: "lang/es.json", key: "x.Open", value: "Abrir" },
  ]);
  // A title that is not a string, or no module.json, is not a text.
  assert.deepEqual(humanTexts({ title: 7 }, []), []);
  assert.deepEqual(humanTexts(null, []), []);
});

test("signatureStatus tells signed, unsigned, changed, still to write, conflicting and list values apart", () => {
  const texts = [
    { file: "lang/en.json", key: "a", value: "Signed" },
    { file: "lang/en.json", key: "b", value: "New" },
    { file: "lang/en.json", key: "c", value: "Edited" },
    { file: "lang/en.json", key: "d", value: "" },
    { file: "lang/en.json", key: "e", value: "   " },
    { file: "lang/en.json", key: "f", value: "  TODO-HUMANO: write me" },
    { file: "lang/en.json", key: "g", value: "One" },
    { file: "lang/en.json", key: "g", value: "Two" },
    { file: "lang/en.json", key: "h", value: ["List"] },
    { file: "lang/en.json", key: "constructor", value: "Proto" },
    { file: "lang/es.json", key: "a", value: "Signed" },
  ];
  const signed = { "lang/en.json": { a: oracle("Signed"), c: oracle("Original"), d: oracle(""), f: oracle("  TODO-HUMANO: write me") } };
  assert.deepEqual(
    signatureStatus(texts, signed).map((t) => `${t.file} ${t.key} ${t.status}`),
    [
      "lang/en.json a signed",
      "lang/en.json b unsigned",
      "lang/en.json c changed",
      // Never signed, even when a hand-edited file carries their hash.
      "lang/en.json d unwritten",
      "lang/en.json e unwritten",
      "lang/en.json f unwritten",
      "lang/en.json g conflict",
      "lang/en.json g conflict",
      "lang/en.json h list",
      // A key named like an Object.prototype member is just a key.
      "lang/en.json constructor unsigned",
      // A signature belongs to its file.
      "lang/es.json a unsigned",
    ],
  );
});

test("signatureStatus never counts a string with a lone UTF-16 surrogate as signed: its UTF-8 hash is not its own", () => {
  const ch = (...codes) => String.fromCharCode(...codes);
  const high = `Open${ch(0xd800)}`;
  const low = `Open${ch(0xdfff)}`;
  const replacement = `Open${ch(0xfffd)}`;
  const pair = `Open ${ch(0xd83d, 0xde00)}`;
  // UTF-8 turns every lone surrogate into U+FFFD: three strings, one hash.
  assert.equal(hashText(high), hashText(low));
  assert.equal(hashText(high), hashText(replacement));
  const texts = [
    { file: "lang/en.json", key: "a", value: low },
    { file: "lang/en.json", key: "b", value: ch(0xdbff) },
    { file: "lang/en.json", key: "c", value: replacement },
    { file: "lang/en.json", key: "d", value: pair },
  ];
  const signed = { "lang/en.json": { a: hashText(high), b: hashText(ch(0xfffd)), c: hashText(replacement), d: hashText(pair) } };
  assert.deepEqual(
    signatureStatus(texts, signed).map((t) => `${t.key} ${t.status}`),
    // U+FFFD itself and a whole surrogate pair are ordinary text.
    ["a illformed", "b illformed", "c signed", "d signed"],
  );
});

test("staleSignatures lists the signed keys and files that no longer hold a text", () => {
  const texts = [{ file: "lang/en.json", key: "a" }, { file: "module.json", key: "title" }];
  const h = oracle("x");
  const signed = { "lang/en.json": { a: h, gone: h }, "lang/fr.json": { a: h }, "module.json": { title: h, version: h } };
  assert.deepEqual(staleSignatures(texts, signed), [
    { file: "lang/en.json", key: "gone" },
    { file: "lang/fr.json", key: "a" },
    { file: "module.json", key: "version" },
  ]);
});

test("signaturesText sorts the keys at every level, indents by two, ends with LF and round-trips", (t) => {
  const h1 = oracle("1");
  const h2 = oracle("2");
  // "__proto__" from a parsed file is an ordinary own key, and stays one; a
  // key that looks like an array index sorts as text, like any other.
  const parsed = JSON.parse(`{"module.json":{"title":"${h1}","description":"${h2}"},"lang/es.json":{"x.B":"${h2}","__proto__":"${h1}","x.A":"${h1}","2":"${h2}","10":"${h1}"}}`);
  const text = signaturesText(parsed);
  assert.equal(
    text,
    [
      "{",
      '  "signed": {',
      '    "lang/es.json": {',
      `      "10": "${h1}",`,
      `      "2": "${h2}",`,
      `      "__proto__": "${h1}",`,
      `      "x.A": "${h1}",`,
      `      "x.B": "${h2}"`,
      "    },",
      '    "module.json": {',
      `      "description": "${h2}",`,
      `      "title": "${h1}"`,
      "    }",
      "  },",
      '  "version": 1',
      "}",
      "",
    ].join("\n"),
  );
  assert.ok(!text.includes("\r"));
  const dir = materialize(t);
  fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), text);
  const read = readSignatures(dir);
  assert.equal(read.error, undefined);
  assert.equal(signaturesText(read.signed), text);
  assert.deepEqual(readSignatures(materialize(t)), { missing: true, signed: {} });
});

test("signaturesProblem refuses every other shape of human-text.json", () => {
  const h = oracle("x");
  assert.equal(signaturesProblem({ version: 1, signed: {} }), null);
  assert.equal(signaturesProblem({ version: 1, signed: { "lang/en.json": { a: h } } }), null);
  for (const [data, reason] of [
    [[], "must hold a JSON object"],
    [null, "must hold a JSON object"],
    ["x", "must hold a JSON object"],
    [{ signed: {} }, 'has "version" undefined: it must be 1'],
    [{ version: 2, signed: {} }, 'has "version" 2: it must be 1'],
    [{ version: "1", signed: {} }, 'has "version" "1": it must be 1'],
    [{ version: 1 }, 'needs "signed" to be an object of files'],
    [{ version: 1, signed: [] }, 'needs "signed" to be an object of files'],
    [{ version: 1, signed: {}, note: "x" }, 'has unknown key(s) "note": only "version" and "signed" are allowed'],
    [{ version: 1, signed: { "lang/en.json": "x" } }, 'has signed["lang/en.json"] that is not an object of keys'],
    [{ version: 1, signed: { "lang/en.json": { a: h.toUpperCase() } } }, 'has signed["lang/en.json"]["a"] that is not a sha256'],
    [{ version: 1, signed: { "lang/en.json": { a: h.slice(1) } } }, 'has signed["lang/en.json"]["a"] that is not a sha256'],
    [{ version: 1, signed: { "lang/en.json": { a: 1 } } }, 'has signed["lang/en.json"]["a"] that is not a sha256'],
  ]) {
    const problem = signaturesProblem(data);
    assert.ok(problem?.startsWith(reason), `${JSON.stringify(data)}: ${problem}`);
  }
});

/* ----------------------------------------------------------------------------
 * Listing (no --sign)
 * -------------------------------------------------------------------------- */

test("without --sign it lists each unsigned or changed text with file, key and value, counts them and exits 0", async (t) => {
  const dir = signedModule(t);
  const signed = hashesOf(fixtureTexts(dir));
  signed["lang/es.json"]["baron-fixture.Open"] = oracle("Abre");
  delete signed["lang/en.json"]["baron-fixture.Notice"];
  signed["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
  writeSignatures(dir, signed);
  const before = readText(dir, HUMAN_TEXT_FILE);

  const res = await run(dir);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.pending, 2);
  assert.equal(res.stale, 1);
  assert.deepEqual(res.lines.slice(1), [
    "unsigned  lang/en.json  baron-fixture.Notice",
    '          "Notice"',
    "changed   lang/es.json  baron-fixture.Open",
    '          "Abrir"',
    "sign-text: 2 text(s) need a signature (1 unsigned, 1 changed since signed); 12 of 14 signed",
    "info: 1 signature(s) for keys that no longer exist; --sign removes them:",
    "stale     lang/en.json  baron-fixture.Gone",
    // The last line says what to do next.
    NEXT,
  ]);
  assert.ok(res.lines[0].startsWith("sign-text: baron-fixture ("), res.lines[0]);
  // Listing never writes.
  assert.equal(readText(dir, HUMAN_TEXT_FILE), before);
});

test("the listing shows empty and TODO-HUMANO values as still to write, and works without human-text.json", async (t) => {
  const dir = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Open": "", "baron-fixture.Notice": "TODO-HUMANO: notice" } } });
  const res = await run(dir);
  assert.equal(res.code, 0, res.out);
  assert.ok(res.lines.includes("note: there is no human-text.json yet: every text counts as unsigned"), res.out);
  assert.ok(res.out.includes('to write  lang/en.json  baron-fixture.Open\n          ""'), res.out);
  assert.ok(res.out.includes('to write  lang/en.json  baron-fixture.Notice\n          "TODO-HUMANO: notice"'), res.out);
  assert.ok(res.lines.includes("sign-text: 12 text(s) need a signature (12 unsigned, 0 changed since signed); 0 of 14 signed"), res.out);
  assert.ok(res.lines.includes(toWrite(2)), res.out);
  assert.ok(!res.out.includes("write them yourself"), res.out);
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));
});

test("the listing says so when baron.json has not opted in, and when its humanText is not a valid value", async (t) => {
  const OFF = 'note: baron.json does not say "humanText": "signed", so check-module does not ask for these signatures yet';
  for (const merge of [{}, { "baron.json": { humanText: "markers" } }]) {
    const res = await run(materialize(t, { merge }));
    assert.equal(res.code, 0);
    assert.ok(res.lines.includes(OFF), res.out);
  }
  assert.ok(!(await run(signedModule(t))).lines.some((l) => l.startsWith("note: baron.json")));
  // A typo does not switch check-module's lock off, so the note must not say it is off.
  const typo = await run(materialize(t, { merge: { "baron.json": { humanText: "Signed" } } }));
  assert.ok(!typo.lines.includes(OFF), typo.out);
  assert.ok(typo.lines.includes('note: baron.json "humanText" is "Signed", which check-module rejects (rule [c]); its lock still asks for these signatures'), typo.out);
});

test("the listing ends with the command that signs, and says when check-module does not ask for it yet", async (t) => {
  const on = await run(signedModule(t));
  assert.equal(on.lines.at(-1), NEXT, on.out);
  const off = await run(materialize(t));
  assert.equal(off.lines.at(-1), `${NEXT} (check-module asks for them once baron.json says "humanText": "signed")`, off.out);
  // The CLI passes the command as the person typed it.
  const typed = await run(signedModule(t), { command: "node tools/sign-text.mjs mod" });
  assert.equal(typed.lines.at(-1), nextLine("node tools/sign-text.mjs mod"), typed.out);
  // Never the old hint that sent the person who signs to rewrite every text alone, and record no author.
  assert.ok(!on.out.includes("rewrite each of these yourself"), on.out);
  // Nothing to sign: no next step.
  const dir = signedModule(t);
  writeSignatures(dir, hashesOf(fixtureTexts(dir)));
  const done = await run(dir);
  assert.ok(!done.lines.some((l) => l.startsWith("next:")), done.out);
});

test("the listing shows stale signatures one per line, ten at most", async (t) => {
  const dir = signedModule(t);
  const signed = hashesOf(fixtureTexts(dir));
  for (let i = 0; i < 300; i++) signed["lang/en.json"][`OLD-PREFIX.SomeSettingNameHint${i}`] = oracle(String(i));
  writeSignatures(dir, signed);
  const res = await run(dir);
  assert.equal(res.stale, 300);
  const at = res.lines.indexOf("info: 300 signature(s) for keys that no longer exist; --sign removes them:");
  assert.ok(at > 0, res.out);
  assert.deepEqual(
    res.lines.slice(at + 1, at + 12),
    [...Array.from({ length: 10 }, (_, i) => `stale     lang/en.json  OLD-PREFIX.SomeSettingNameHint${i}`), "and 290 more"],
  );
  assert.ok(res.lines.every((l) => l.length < 200), "no line runs on");
});

/* ----------------------------------------------------------------------------
 * Signing (--sign)
 * -------------------------------------------------------------------------- */

test("--sign explains each answer, the translation case included, before the first question", async (t) => {
  const dir = signedModule(t);
  const res = await run(dir, { sign: true, isTTY: true, ask: fakeAsk("q").ask });
  const at = res.lines.indexOf(LEGEND[0]);
  const first = res.lines.findIndex((l) => l.startsWith("[1/14] "));
  assert.ok(at > 0 && at < first, res.out);
  assert.deepEqual(res.lines.slice(at, at + LEGEND.length), LEGEND);
  const legend = LEGEND.join(" ").replace(/ +/g, " ");
  for (const words of [
    "s you wrote this text yourself, from scratch",
    "for a translation: you are fluent in its language and checked it line by line against its human-written source",
    "N or Enter skip it",
    "q stop, and save the signatures given so far",
    "Ctrl+C stop without saving any signature of this run",
  ]) {
    assert.ok(legend.includes(words), words);
  }
  // With nothing to ask there is nothing to explain.
  writeSignatures(dir, hashesOf(fixtureTexts(dir)));
  const done = await run(dir, { sign: true, isTTY: true, ask: fakeAsk().ask });
  assert.ok(!done.lines.includes(LEGEND[0]), done.out);
});

test("--sign names the stream that is not a terminal, and needs both to be one", async (t) => {
  const dir = signedModule(t);
  for (const [tty, here] of [
    [{ stdin: true, stdout: false }, "Here stdout is not a terminal"],
    [{ stdin: false, stdout: true }, "Here stdin is not a terminal"],
    [{ stdin: false, stdout: false }, "Here stdin and stdout are not a terminal"],
  ]) {
    const fake = fakeAsk("s");
    const res = await run(dir, { sign: true, isTTY: tty, ask: fake.ask });
    assert.equal(res.code, 1, JSON.stringify(tty));
    assert.deepEqual(fake.asked, []);
    assert.deepEqual(res.errors, [noTtyMessage(tty)]);
    assert.ok(res.errors[0].includes(`${NL}${here}: run it without a pipe or a redirection (no |, <, >, Tee-Object or more).${NL}`), res.errors[0]);
  }
  const both = await run(dir, { sign: true, isTTY: { stdin: true, stdout: true }, ask: fakeAsk("q").ask });
  assert.equal(both.code, 0, both.out);
  // The suggested commands are the one the person typed.
  const lines = noTtyMessage({ stdout: false, command: "node x/sign-text.mjs mod" }).split(NL);
  assert.ok(lines.includes("  node x/sign-text.mjs mod --sign") && lines.includes("  winpty node x/sign-text.mjs mod --sign"), lines.join(NL));
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));
});

test("--sign never asks about a value with a lone UTF-16 surrogate and lists it as broken", async (t) => {
  const bad = `Open${String.fromCharCode(0xd800)}`;
  const dir = signedModule(t, { merge: { "lang/en.json": { "baron-fixture.Open": bad } } });
  const fake = fakeAsk(...Array(13).fill("s"));
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.equal(fake.asked.length, 13, res.out);
  assert.ok(!Object.hasOwn(readSigned(dir)["lang/en.json"], "baron-fixture.Open"));
  assert.ok(res.out.includes(`broken    lang/en.json  baron-fixture.Open${NL}          ${JSON.stringify(bad)}`), res.out);
  assert.ok(res.lines.includes("info: 1 value(s) hold a lone UTF-16 surrogate (half of an escaped pair, from a broken JSON escape): fix the value, then sign it"), res.out);
});

test("--sign: Ctrl+C tells the caller how many answers it threw away", async (t) => {
  const dir = signedModule(t);
  const interrupted = new Error("Ctrl+C");
  await assert.rejects(run(dir, { sign: true, isTTY: true, ask: fakeAsk("s", "n", "s", interrupted).ask }), interrupted);
  assert.equal(interrupted.signedBeforeStop, 2);
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));
});

test("--sign tries the rename again while another program holds human-text.json, and says plainly what was lost when it cannot", async (t) => {
  const dir = signedModule(t);
  const file = path.join(dir, HUMAN_TEXT_FILE);
  const realRename = fs.renameSync;
  const busy = (code) => Object.assign(new Error(`${code}: held by another program, rename`), { code });
  const tmps = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

  // Held for a moment: the third try goes through.
  let tries = 0;
  const brief = t.mock.method(fs, "renameSync", (...args) => {
    tries++;
    if (tries <= 2) throw busy("EPERM");
    return realRename(...args);
  });
  const first = await run(dir, { sign: true, isTTY: true, ask: fakeAsk("s", "q").ask });
  brief.mock.restore();
  assert.equal(tries, 3);
  assert.equal(first.wrote, true);
  assert.deepEqual(readSigned(dir), { "module.json": { title: oracle("Baron Fixture") } });
  assert.deepEqual(tmps(), []);

  // Held for good: the file stays as it was, no temporary file is left (one would mean nothing), and the message says to sign again.
  const before = readText(dir, HUMAN_TEXT_FILE);
  const held = t.mock.method(fs, "renameSync", () => {
    throw busy("EBUSY");
  });
  let message = "";
  await assert.rejects(run(dir, { sign: true, isTTY: true, ask: fakeAsk("s", "q").ask }), (err) => {
    message = err.message;
    return err instanceof SignTextError;
  });
  assert.equal(held.mock.callCount(), 10);
  held.mock.restore();
  assert.equal(readText(dir, HUMAN_TEXT_FILE), before);
  assert.deepEqual(tmps(), []);
  for (const words of [`could not replace ${file} (EBUSY: another program may have it open`, ": nothing was changed, and the 1 signature(s) given in this run were not saved; run --sign again"]) {
    assert.ok(message.includes(words), `${words}${NL}${message}`);
  }
  assert.ok(!message.includes(" rename "), message);

  // Any other error is not tried again.
  const other = t.mock.method(fs, "renameSync", () => {
    throw busy("EXDEV");
  });
  await assert.rejects(run(dir, { sign: true, isTTY: true, ask: fakeAsk("s", "q").ask }), SignTextError);
  assert.equal(other.mock.callCount(), 1);
  other.mock.restore();
  assert.equal(readText(dir, HUMAN_TEXT_FILE), before);
});

test("--sign refuses without a terminal, asks nothing and writes nothing", async (t) => {
  const dir = signedModule(t);
  const fake = fakeAsk("s");
  const res = await run(dir, { sign: true, isTTY: false, ask: fake.ask });
  assert.equal(res.code, 1);
  assert.deepEqual(fake.asked, []);
  assert.deepEqual(res.errors, [NO_TTY_MESSAGE]);
  const lines = NO_TTY_MESSAGE.split(NL);
  for (const words of ["by a person at a terminal", "(PowerShell, Windows Terminal or Git Bash)", "Only with Git for Windows older than 2.54 does Git Bash (mintty) not give node a TTY"]) {
    assert.ok(NO_TTY_MESSAGE.includes(words), words);
  }
  assert.ok(lines.includes("  node ../pf2e-baron-core/tools/sign-text.mjs . --sign"), NO_TTY_MESSAGE);
  assert.ok(lines.includes("  winpty node ../pf2e-baron-core/tools/sign-text.mjs . --sign"), NO_TTY_MESSAGE);
  // Without knowing which stream is not a terminal, it does not guess.
  assert.ok(!NO_TTY_MESSAGE.includes("Here "), NO_TTY_MESSAGE);
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));
  // isTTY must be true, not merely truthy-looking.
  assert.equal((await run(dir, { sign: true, ask: fake.ask })).code, 1);
});

test("--sign asks about each pending text in Spanish and records exactly the ones answered s", async (t) => {
  const dir = signedModule(t);
  const texts = fixtureTexts(dir);
  // module.json title, description, then en.json and es.json in file order.
  const answers = ["s", "", "S", "n", " s ", "N", "s", "s", "s", "s", "s", "s", "s", "s"];
  const fake = fakeAsk(...answers);
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.equal(res.code, 0, res.out);
  assert.equal(fake.asked.length, 14);
  assert.ok(fake.asked.every((q) => q === QUESTION));
  assert.equal(QUESTION, `${String.fromCharCode(0xbf)}Escribiste t${String.fromCharCode(0xfa)} este texto desde cero? [s/N/q] `);
  assert.deepEqual({ signed: res.signed, skipped: res.skipped, wrote: res.wrote }, { signed: 11, skipped: 3, wrote: true });
  // Each question comes after the file, the key and the full value.
  assert.ok(res.out.includes('[1/14] module.json  title\n  "Baron Fixture"'), res.out);
  assert.ok(res.out.includes('[14/14] lang/es.json  baron-fixture.Unused\n  "Nunca referida"'), res.out);

  const expected = hashesOf(texts);
  delete expected["module.json"].description;
  delete expected["lang/en.json"]["baron-fixture.Open"];
  delete expected["lang/en.json"]["baron-fixture.Kind_a"];
  assert.deepEqual(readSigned(dir), expected);
  assert.equal(readText(dir, HUMAN_TEXT_FILE), signaturesText(expected));
  assert.ok(res.lines.includes("sign-text: 11 signed, 3 skipped; wrote human-text.json"), res.out);
  // No temporary file is left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);

  // The next run asks only about the three it skipped.
  const again = fakeAsk("s", "s", "s");
  const second = await run(dir, { sign: true, isTTY: true, ask: again.ask });
  assert.equal(second.signed, 3);
  assert.deepEqual(readSigned(dir), hashesOf(texts));
  // And with everything signed it asks nothing and leaves the file alone.
  const before = readText(dir, HUMAN_TEXT_FILE);
  const third = await run(dir, { sign: true, isTTY: true, ask: fakeAsk().ask });
  assert.deepEqual({ signed: third.signed, wrote: third.wrote }, { signed: 0, wrote: false });
  assert.equal(readText(dir, HUMAN_TEXT_FILE), before);
});

test("--sign: q stops mid-way and keeps what was already signed", async (t) => {
  const dir = signedModule(t);
  const fake = fakeAsk("s", "n", "s", "q");
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.equal(res.code, 0, res.out);
  assert.equal(fake.asked.length, 4);
  assert.equal(fake.left(), 0);
  assert.deepEqual(readSigned(dir), { "module.json": { title: oracle("Baron Fixture") }, "lang/en.json": { "baron-fixture.Title": oracle("Baron Fixture") } });
  assert.ok(res.lines.includes("sign-text: 2 signed, 1 skipped, stopped with 11 left; wrote human-text.json"), res.out);
});

test("--sign: an answer that is not s, n, Enter or q asks again", async (t) => {
  const dir = signedModule(t);
  const fake = fakeAsk("yes", "si", "s", "q");
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.equal(fake.asked.length, 4);
  assert.equal(res.signed, 1);
  assert.equal(res.lines.filter((l) => l.includes('answer "s"')).length, 2, res.out);
  assert.deepEqual(readSigned(dir), { "module.json": { title: oracle("Baron Fixture") } });
});

test("--sign: Ctrl+C during a question leaves human-text.json exactly as it was", async (t) => {
  const dir = signedModule(t);
  const interrupted = new Error("Ctrl+C");
  // No file yet: it is not created.
  await assert.rejects(run(dir, { sign: true, isTTY: true, ask: fakeAsk("s", "s", interrupted).ask }), interrupted);
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));
  // An existing file, with a stale entry --sign would drop: byte for byte the same.
  const signed = { "lang/en.json": { "baron-fixture.Gone": oracle("Gone") } };
  fs.writeFileSync(path.join(dir, HUMAN_TEXT_FILE), JSON.stringify({ version: 1, signed }));
  const before = readText(dir, HUMAN_TEXT_FILE);
  await assert.rejects(run(dir, { sign: true, isTTY: true, ask: fakeAsk("s", interrupted).ask }), interrupted);
  assert.equal(readText(dir, HUMAN_TEXT_FILE), before);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
});

test("--sign never asks about an empty or TODO-HUMANO value and lists it as still to write", async (t) => {
  const dir = signedModule(t, {
    merge: { "lang/en.json": { "baron-fixture.Open": "", "baron-fixture.Notice": "  TODO-HUMANO: notice" }, "lang/es.json": { "baron-fixture.Open": " " } },
  });
  const fake = fakeAsk(...Array(11).fill("s"));
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.equal(fake.asked.length, 11, res.out);
  assert.equal(res.signed, 11);
  const signed = readSigned(dir);
  assert.ok(!Object.hasOwn(signed["lang/en.json"], "baron-fixture.Open"));
  assert.ok(!Object.hasOwn(signed["lang/en.json"], "baron-fixture.Notice"));
  assert.ok(!Object.hasOwn(signed["lang/es.json"], "baron-fixture.Open"));
  assert.ok(!res.out.includes('[1/11] lang/en.json  baron-fixture.Open'), res.out);
  assert.ok(res.out.includes('to write  lang/en.json  baron-fixture.Notice\n          "  TODO-HUMANO: notice"'), res.out);
  assert.ok(res.lines.includes(toWrite(3)), res.out);
});

test("--sign asks again about a text changed since it was signed and replaces its signature", async (t) => {
  const dir = signedModule(t, { merge: { "lang/es.json": { "baron-fixture.Open": "Abrir el panel" } } });
  const signed = hashesOf(fixtureTexts(materialize(t)));
  writeSignatures(dir, signed);
  const fake = fakeAsk("s");
  const res = await run(dir, { sign: true, isTTY: true, ask: fake.ask });
  assert.equal(fake.asked.length, 1);
  assert.ok(res.out.includes('[1/1] lang/es.json  baron-fixture.Open  (changed since it was signed)\n  "Abrir el panel"'), res.out);
  assert.equal(readSigned(dir)["lang/es.json"]["baron-fixture.Open"], oracle("Abrir el panel"));
});

test("--sign drops the signatures whose key or file is gone, even with nothing to ask", async (t) => {
  const dir = signedModule(t);
  const signed = hashesOf(fixtureTexts(dir));
  const kept = structuredClone(signed);
  signed["lang/en.json"]["baron-fixture.Gone"] = oracle("Gone");
  signed["lang/fr.json"] = { "baron-fixture.Open": oracle("Ouvrir") };
  signed["module.json"].version = oracle("1.0.0");
  writeSignatures(dir, signed);
  const res = await run(dir, { sign: true, isTTY: true, ask: fakeAsk().ask });
  assert.deepEqual({ code: res.code, stale: res.stale, wrote: res.wrote }, { code: 0, stale: 3, wrote: true });
  assert.deepEqual(readSigned(dir), kept);
  assert.ok(res.lines.includes("sign-text: 0 signed, 0 skipped, 3 stale signature(s) removed; wrote human-text.json"), res.out);
});

test("a malformed human-text.json or an unreadable language file stops the tool without touching anything", async (t) => {
  const dir = signedModule(t, { write: { [HUMAN_TEXT_FILE]: '{"version": 2, "signed": {}}\n' } });
  for (const sign of [false, true]) {
    await assert.rejects(run(dir, { sign, isTTY: true, ask: fakeAsk("s").ask }), (err) => err instanceof SignTextError && /has "version" 2: it must be 1/.test(err.message));
  }
  assert.equal(readText(dir, HUMAN_TEXT_FILE), '{"version": 2, "signed": {}}\n');

  // Its signatures would look stale and be dropped.
  const broken = signedModule(t, { write: { "lang/es.json": "{ not json" } });
  await assert.rejects(run(broken, { sign: true, isTTY: true, ask: fakeAsk("s").ask }), (err) => err instanceof SignTextError && /lang\/es\.json is not valid JSON/.test(err.message));
});

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

test("the CLI lists with exit 0 and refuses --sign when stdin is a pipe, with the Windows notes", (t) => {
  const dir = signedModule(t);
  const list = runNode(SIGN_TEXT, [dir]);
  assert.equal(list.status, 0, list.out);
  assert.ok(list.stdout.includes("sign-text: 14 text(s) need a signature (14 unsigned, 0 changed since signed); 0 of 14 signed"), list.out);

  // spawnSync gives the child pipes, never a TTY: exactly what an agent has.
  // The message says so, and repeats the command as it was typed (here from
  // the core folder, with the module folder as argument).
  const sign = runNode(SIGN_TEXT, [dir, "--sign"]);
  assert.equal(sign.status, 1, sign.out);
  const errLines = sign.stderr.split(/\r?\n/);
  assert.ok(errLines.includes("Here stdin and stdout are not a terminal: run it without a pipe or a redirection (no |, <, >, Tee-Object or more)."), sign.out);
  const typed = /[\s"'&|<>()^;$`\\]/.test(dir) ? `"${dir}"` : dir;
  assert.ok(errLines.includes(`  node tools/sign-text.mjs ${typed} --sign`), sign.out);
  assert.ok(errLines.includes(`  winpty node tools/sign-text.mjs ${typed} --sign`), sign.out);
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));

  // From the module folder, with no argument.
  const here = runNode(SIGN_TEXT, [], { cwd: dir });
  assert.equal(here.status, 0, here.out);
  assert.ok(here.stdout.startsWith("sign-text: baron-fixture ("), here.out);
});

test("the CLI has no way to sign without a person: unknown flags are errors", (t) => {
  const dir = signedModule(t);
  for (const flag of ["--yes", "-y", "--sign=yes", "--force"]) {
    const res = runNode(SIGN_TEXT, [dir, flag]);
    assert.equal(res.status, 1, `${flag}\n${res.out}`);
    assert.match(res.stderr, /unknown option/);
  }
  const extra = runNode(SIGN_TEXT, [dir, dir]);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /unexpected argument/);
  const missing = runNode(SIGN_TEXT, [path.join(dir, "nope")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not a folder/);
  assert.ok(!fs.existsSync(path.join(dir, HUMAN_TEXT_FILE)));
});

const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);

/**
 * Runs the CLI with stdin and stdout faked to be a terminal (a preload sets
 * their isTTY), typing the next of `keys` at each question. A child that is
 * still running after `timeoutMs` is killed and reported as timed out.
 */
async function runFakeTerminal(t, args, keys, { timeoutMs = 15000 } = {}) {
  const preload = path.join(tempDir(t, "tty"), "fake-tty.mjs");
  fs.writeFileSync(preload, 'for (const s of [process.stdin, process.stdout]) Object.defineProperty(s, "isTTY", { value: true, configurable: true });\n');
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, SIGN_TEXT, ...args], { cwd: REPO, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let typed = 0;
  const left = [...keys];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    stdout += d;
    const asked = stdout.split("[s/N/q]").length - 1;
    while (typed < asked && left.length) {
      typed++;
      child.stdin.write(left.shift());
    }
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  return { code, timedOut, stdout, stderr, out: `${stdout}${stderr}` };
}

test("the CLI at a terminal: q saves, Ctrl+C exits 130 and Ctrl+D exits 1, both without writing and saying what was lost", async (t) => {
  const dir = signedModule(t);
  const file = path.join(dir, HUMAN_TEXT_FILE);

  // Ctrl+D closes readline from inside its keypress handler: the process must still exit.
  const eof = await runFakeTerminal(t, [dir, "--sign"], [`s${CR}`, CTRL_D]);
  assert.equal(eof.timedOut, false, `Ctrl+D left the process running${NL}${eof.out}`);
  assert.equal(eof.code, 1, eof.out);
  assert.ok(eof.stderr.includes("sign-text: stopped (end of input): human-text.json is unchanged; the 1 signature(s) given in this run were not saved (answer q to stop and keep them)"), eof.out);
  assert.ok(!fs.existsSync(file));

  const interrupt = await runFakeTerminal(t, [dir, "--sign"], [`s${CR}`, `s${CR}`, CTRL_C]);
  assert.equal(interrupt.timedOut, false, interrupt.out);
  assert.equal(interrupt.code, 130, interrupt.out);
  assert.ok(interrupt.stderr.includes("sign-text: stopped (Ctrl+C): human-text.json is unchanged; the 2 signature(s) given in this run were not saved"), interrupt.out);
  assert.ok(!fs.existsSync(file));

  const quit = await runFakeTerminal(t, [dir, "--sign"], [`s${CR}`, `q${CR}`]);
  assert.equal(quit.timedOut, false, quit.out);
  assert.equal(quit.code, 0, quit.out);
  assert.ok(quit.stdout.includes(LEGEND.join(NL)), quit.out);
  assert.deepEqual(readSigned(dir), { "module.json": { title: oracle("Baron Fixture") } });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
});
