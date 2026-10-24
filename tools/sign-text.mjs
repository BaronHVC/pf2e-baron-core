#!/usr/bin/env node
// sign-text: the author's signature on the texts of a module, for baron.json
// "humanText": "signed" (check-module rule [n]). Run it from the module folder:
//
//   node ../pf2e-baron-core/tools/sign-text.mjs [moduleDir=cwd]          list what needs a signature
//   node ../pf2e-baron-core/tools/sign-text.mjs [moduleDir=cwd] --sign   sign, one question per text
//
// Foundry's AI policy (publisher handbook 4.1) wants UI labels and prepared
// text written by a person. A signature records, per file and key, the sha256
// of the exact value the author says he wrote from scratch, so any later change
// to that value needs a new one. The texts are the module.json title and
// description and every string value of the language files module.json
// declares.
//
// Without --sign it only lists: every text that is unsigned or changed since it
// was signed, with its file, key and value, then a count; texts still to write
// (empty or TODO-HUMANO:) and signatures whose key is gone, as information.
// Exits 0.
//
// --sign asks a person at a terminal about each of those texts: "s" signs it,
// "n" or Enter skips it, "q" stops and keeps what was signed so far. It refuses
// to run unless stdin and stdout are a TTY, and there is no flag that answers
// for the person. human-text.json is written once, at the end or on "q",
// through a temporary file and a rename, without the signatures whose key is
// gone; Ctrl+C before that leaves it untouched.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HUMAN_TEXT_FILE,
  hashText,
  humanTexts,
  languageEntries,
  readSignatures,
  signatureStatus,
  signaturesText,
  staleSignatures,
} from "./shared.mjs";

const USAGE = "usage: node sign-text.mjs [moduleDir] [--sign]";

// The one line in Spanish, for the author. Built from char codes so this file
// stays ASCII: the inverted question mark and the accented u.
export const QUESTION = `${String.fromCharCode(0xbf)}Escribiste t${String.fromCharCode(0xfa)} este texto desde cero? [s/N/q] `;

export const NO_TTY_MESSAGE = [
  "sign-text: --sign must be run by a person at a terminal: each signature says that you wrote that text yourself, from scratch, so nothing may answer for you (stdin and stdout must both be a TTY).",
  "Run it in PowerShell or Windows Terminal, from the module folder:",
  "  node ../pf2e-baron-core/tools/sign-text.mjs . --sign",
  "Git Bash (mintty) does not give node a TTY; there, run it as:",
  "  winpty node ../pf2e-baron-core/tools/sign-text.mjs . --sign",
].join("\n");

// How each status reads in the listing; the first two are what --sign asks about.
const LABELS = {
  unsigned: "unsigned",
  changed: "changed",
  unwritten: "to write",
  conflict: "conflict",
  list: "list",
};
const TO_SIGN = new Set(["unsigned", "changed"]);

/** A problem with the module that stops the tool (exit 1), never a crash. */
export class SignTextError extends Error {}

function readModuleJson(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new SignTextError(`${rel} does not exist in ${root}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const bom = fs.readFileSync(file, "utf8").charCodeAt(0) === 0xfeff ? " (the file starts with a UTF-8 BOM)" : "";
    throw new SignTextError(`${rel} is not valid JSON: ${err.message}${bom}`);
  }
}

/**
 * Everything the listing and the questions need. A language file that cannot
 * be read stops the tool: its signatures would look stale and be dropped.
 */
function load(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new SignTextError(`${root} is not a folder`);
  const module = readModuleJson(root, "module.json");
  const rels = [...new Set(languageEntries(root, module).map((l) => l.rel))];
  const langFiles = rels.map((rel) => ({ rel, data: readModuleJson(root, rel) }));
  const read = readSignatures(root);
  if (read.error) {
    throw new SignTextError(`${HUMAN_TEXT_FILE} ${read.error}: restore it from git, or delete it and sign every text again`);
  }
  // baron.json "humanText", read as check-module reads it; only for a note.
  let mode;
  try {
    const baron = JSON.parse(fs.readFileSync(path.join(root, "baron.json"), "utf8"));
    if (baron && typeof baron === "object") mode = baron.humanText;
  } catch {
    // no baron.json, or one check-module reports
  }
  const texts = signatureStatus(humanTexts(module, langFiles), read.signed);
  return { module, texts, signed: read.signed, missing: !!read.missing, stale: staleSignatures(texts, read.signed), mode };
}

const show = (t, log) => {
  log(`${LABELS[t.status].padEnd(9)} ${t.file}  ${t.key}`);
  log(`          ${JSON.stringify(t.value)}`);
};

/** The signatures as they will be written: null-prototype objects, so no key is special. */
function copySigned(signed) {
  const out = Object.create(null);
  for (const [file, keys] of Object.entries(signed)) out[file] = Object.assign(Object.create(null), keys);
  return out;
}

/**
 * Lists the texts that need a signature or, with `sign`, asks about each one
 * and writes human-text.json. The CLI wraps it; tests pass `isTTY` and `ask`.
 * @param {{
 *   dir?: string,
 *   sign?: boolean,
 *   isTTY?: boolean,                         stdin and stdout are both a terminal
 *   ask?: (question: string) => Promise<string>,  one answer per call; a rejection (Ctrl+C) aborts without writing
 *   log?: (line: string) => void,
 *   logError?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ code: number, pending: number, signed: number, skipped: number, stale: number, wrote: boolean }>}
 * @throws {SignTextError} when the module cannot be read
 */
export async function signTexts({ dir = process.cwd(), sign = false, isTTY = false, ask, log = console.log, logError = console.error } = {}) {
  const result = { code: 0, pending: 0, signed: 0, skipped: 0, stale: 0, wrote: false };
  if (sign && !isTTY) {
    logError(NO_TTY_MESSAGE);
    return { ...result, code: 1 };
  }
  if (sign && typeof ask !== "function") throw new TypeError("signTexts: --sign needs an ask() function");
  const root = path.resolve(dir);
  const { module, texts, signed, missing, stale, mode } = load(root);
  const pending = texts.filter((t) => TO_SIGN.has(t.status));
  const blocked = texts.filter((t) => !TO_SIGN.has(t.status) && t.status !== "signed");
  const done = texts.length - pending.length - blocked.length;
  result.pending = pending.length;
  result.stale = stale.length;

  log(`sign-text: ${module?.id ?? path.basename(root)} (${root})${sign ? " --sign" : ""}`);
  if (mode === undefined || mode === "markers") {
    log('note: baron.json does not say "humanText": "signed", so check-module does not ask for these signatures yet');
  } else if (mode !== "signed") {
    // check-module fails the value in [c] and keeps the lock on: a typo never switches it off.
    log(`note: baron.json "humanText" is ${JSON.stringify(mode)}, which check-module rejects (rule [c]); its lock still asks for these signatures`);
  }
  if (missing) log(`note: there is no ${HUMAN_TEXT_FILE} yet: every text counts as unsigned`);

  if (!sign) {
    for (const t of pending) show(t, log);
    for (const t of blocked) show(t, log);
    const unsigned = pending.filter((t) => t.status === "unsigned").length;
    log(`sign-text: ${pending.length} text(s) need a signature (${unsigned} unsigned, ${pending.length - unsigned} changed since signed); ${done} of ${texts.length} signed`);
    reportBlocked(blocked, log);
    if (stale.length) {
      log(`info: ${stale.length} signature(s) for keys that no longer exist; --sign removes them: ${stale.map((s) => `${s.file} ${s.key}`).join(", ")}`);
    }
    return result;
  }

  const next = copySigned(signed);
  for (const { file, key } of stale) {
    delete next[file][key];
    if (!Object.keys(next[file]).length) delete next[file];
  }
  let stopped = false;
  for (const [i, t] of pending.entries()) {
    log("");
    log(`[${i + 1}/${pending.length}] ${t.file}  ${t.key}${t.status === "changed" ? "  (changed since it was signed)" : ""}`);
    log(`  ${JSON.stringify(t.value)}`);
    let answer;
    for (;;) {
      answer = String(await ask(QUESTION)).trim().toLowerCase();
      if (["s", "n", "", "q"].includes(answer)) break;
      log('  answer "s" (you wrote it from scratch: sign it), "n" or Enter (skip it) or "q" (stop and keep what you signed)');
    }
    if (answer === "q") {
      stopped = true;
      break;
    }
    if (answer === "s") {
      next[t.file] ??= Object.create(null);
      next[t.file][t.key] = hashText(t.value);
      result.signed++;
    } else result.skipped++;
  }

  const file = path.join(root, HUMAN_TEXT_FILE);
  const text = signaturesText(next);
  const before = missing ? null : fs.readFileSync(file, "utf8");
  if (before === null ? Object.keys(next).length > 0 : before !== text) {
    // Written next to the target and renamed over it: a reader never sees half a file.
    const tmp = path.join(root, `.${HUMAN_TEXT_FILE}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    result.wrote = true;
  }
  log("");
  log(
    `sign-text: ${result.signed} signed, ${result.skipped} skipped${stopped ? `, stopped with ${pending.length - result.signed - result.skipped} left` : ""}` +
      `${stale.length ? `, ${stale.length} stale signature(s) removed` : ""}; ` +
      (result.wrote ? `wrote ${HUMAN_TEXT_FILE}` : `${HUMAN_TEXT_FILE} unchanged`),
  );
  for (const t of blocked) show(t, log);
  reportBlocked(blocked, log);
  return result;
}

/** Texts no answer can sign yet, as information after the count. */
function reportBlocked(blocked, log) {
  const count = (status) => blocked.filter((t) => t.status === status).length;
  if (count("unwritten")) log(`info: ${count("unwritten")} text(s) still to write (empty or TODO-HUMANO:): write them yourself, then sign them`);
  if (count("conflict")) log(`info: ${count("conflict")} value(s) of keys defined twice with different values (nested and dotted): keep one, then sign it`);
  if (count("list")) log(`info: ${count("list")} list value(s): only a string value can be signed`);
}

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

/** Ctrl+C or the end of input during a question: nothing is written. */
class Interrupted extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function terminal() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pending = null;
  // Once the person pressed Ctrl+C or the input ended, every later question
  // fails too, so nothing is ever signed after it.
  let stopped = null;
  const abort = (why, code) => {
    stopped ??= new Interrupted(why, code);
    if (!pending) return;
    const { reject } = pending;
    pending = null;
    reject(stopped);
  };
  rl.on("SIGINT", () => abort("Ctrl+C", 130));
  rl.on("close", () => abort("end of input", 1));
  return {
    ask: (question) =>
      new Promise((resolve, reject) => {
        if (stopped) return reject(stopped);
        pending = { reject };
        rl.question(question, (answer) => {
          pending = null;
          resolve(answer);
        });
      }),
    close: () => rl.close(),
  };
}

async function main(argv) {
  let dir = null;
  let sign = false;
  for (const a of argv) {
    if (a === "--sign") sign = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      console.error(`sign-text: ERROR: unknown option ${a}\n${USAGE}`);
      return 1;
    } else if (dir === null) dir = a;
    else {
      console.error(`sign-text: ERROR: unexpected argument ${a}\n${USAGE}`);
      return 1;
    }
  }
  let term = null;
  try {
    const { code } = await signTexts({
      dir: dir ?? process.cwd(),
      sign,
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ask: (question) => (term ??= terminal()).ask(question),
    });
    return code;
  } catch (err) {
    if (err instanceof Interrupted) {
      console.error(`\nsign-text: stopped (${err.message}): ${HUMAN_TEXT_FILE} is unchanged`);
      return err.code;
    }
    if (err instanceof SignTextError) {
      console.error(`sign-text: ERROR: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    term?.close();
  }
}

// Imported by the tests, run by a person: only the latter parses argv.
// realpath on both sides, since Windows may hand argv[1] over as an 8.3 short
// path or with another drive-letter case.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
