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
// declares (every lang/*.json when it declares none, as rules [d] and [h] read
// them).
//
// Without --sign it only lists: every text that is unsigned or changed since it
// was signed, with its file, key and value, then a count and the command that
// signs them; texts still to write (empty or TODO-HUMANO:) and signatures whose
// key is gone, as information. Exits 0.
//
// --sign asks a person at a terminal about each of those texts: "s" signs it,
// "n" or Enter skips it, "q" stops and keeps what was signed so far. For a
// translation, "s" means the signer is fluent in its language and checked it
// line by line against its human-written source. It refuses to run unless
// stdin and stdout are a TTY, and there is no flag that answers for the
// person. human-text.json is written once, at the end or on "q", through a
// temporary file and a rename, without the signatures whose key is gone;
// Ctrl+C or the end of input before that leaves it untouched.

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

/** How the tool is run from the module folder, as the docs write it. */
export const DEFAULT_COMMAND = "node ../pf2e-baron-core/tools/sign-text.mjs .";

/**
 * Why --sign refuses, and where it works.
 * @param {{ stdin?: boolean, stdout?: boolean, command?: string }} [tty]
 *   which stream is a terminal, when known, and the command that ran the tool
 */
export function noTtyMessage({ stdin, stdout, command = DEFAULT_COMMAND } = {}) {
  const lines = [
    "sign-text: --sign must be run by a person at a terminal: each signature says that you wrote that text yourself, from scratch, so nothing may answer for you (stdin and stdout must both be a TTY).",
  ];
  const notTty = [stdin === false && "stdin", stdout === false && "stdout"].filter(Boolean);
  if (notTty.length) {
    lines.push(`Here ${notTty.join(" and ")} ${notTty.length > 1 ? "are" : "is"} not a terminal: run it without a pipe or a redirection (no |, <, >, Tee-Object or more).`);
  }
  lines.push(
    "Run it yourself in a terminal window (PowerShell, Windows Terminal or Git Bash):",
    `  ${command} --sign`,
    "Only with Git for Windows older than 2.54 does Git Bash (mintty) not give node a TTY; there, run it as:",
    `  winpty ${command} --sign`,
  );
  return lines.join("\n");
}
export const NO_TTY_MESSAGE = noTtyMessage();

/** Printed before the first question: what each answer does. */
export const LEGEND = [
  "Answer each question yourself:",
  "  s           you wrote this text yourself, from scratch; for a translation: you are fluent in its",
  "              language and checked it line by line against its human-written source",
  "  N or Enter  skip it",
  "  q           stop, and save the signatures given so far",
  "  Ctrl+C      stop without saving any signature of this run",
];

// How each status reads in the listing; the first two are what --sign asks about.
const LABELS = {
  unsigned: "unsigned",
  changed: "changed",
  unwritten: "to write",
  conflict: "conflict",
  list: "list",
  illformed: "broken",
};
const TO_SIGN = new Set(["unsigned", "changed"]);
// The listing shows at most this many stale signatures, as check-module caps its lines.
const STALE_CAP = 10;
// On Windows an editor, a sync client or an antivirus scan may hold
// human-text.json open for a moment; the rename is tried again before giving up.
const RENAME_RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 200;

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

/** Whether `isTTY` (a boolean, or { stdin, stdout }) says both streams are a terminal. */
const bothTty = (isTTY) => (isTTY !== null && typeof isTTY === "object" ? isTTY.stdin === true && isTTY.stdout === true : isTTY === true);

/** Renames the temporary file over the target, trying again while another program holds it. */
async function replaceFile(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!RENAME_RETRY.has(err?.code) || attempt >= RENAME_TRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_WAIT_MS));
    }
  }
}

/**
 * Lists the texts that need a signature or, with `sign`, asks about each one
 * and writes human-text.json. The CLI wraps it; tests pass `isTTY` and `ask`.
 * @param {{
 *   dir?: string,
 *   sign?: boolean,
 *   isTTY?: boolean | { stdin: boolean, stdout: boolean },  stdin and stdout are both a terminal
 *   ask?: (question: string) => Promise<string>,  one answer per call; a rejection (Ctrl+C) aborts without
 *                                                 writing, and gets `signedBeforeStop`, the answers it threw away
 *   command?: string,                        how the person ran the tool, for the hints
 *   log?: (line: string) => void,
 *   logError?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ code: number, pending: number, signed: number, skipped: number, stale: number, wrote: boolean }>}
 * @throws {SignTextError} when the module cannot be read, or human-text.json cannot be written
 */
export async function signTexts({ dir = process.cwd(), sign = false, isTTY = false, ask, command = DEFAULT_COMMAND, log = console.log, logError = console.error } = {}) {
  const result = { code: 0, pending: 0, signed: 0, skipped: 0, stale: 0, wrote: false };
  if (sign && !bothTty(isTTY)) {
    logError(noTtyMessage({ ...(isTTY !== null && typeof isTTY === "object" ? isTTY : {}), command }));
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
  const off = mode === undefined || mode === "markers";
  if (off) {
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
      log(`info: ${stale.length} signature(s) for keys that no longer exist; --sign removes them:`);
      for (const s of stale.slice(0, STALE_CAP)) log(`${"stale".padEnd(9)} ${s.file}  ${s.key}`);
      if (stale.length > STALE_CAP) log(`and ${stale.length - STALE_CAP} more`);
    }
    if (pending.length) {
      log(`next: rewrite each of these yourself, from scratch, then sign them in your terminal: ${command} --sign${off ? ' (check-module asks for them once baron.json says "humanText": "signed")' : ""}`);
    }
    return result;
  }

  const next = copySigned(signed);
  for (const { file, key } of stale) {
    delete next[file][key];
    if (!Object.keys(next[file]).length) delete next[file];
  }
  if (pending.length) {
    log("");
    for (const line of LEGEND) log(line);
  }
  let stopped = false;
  for (const [i, t] of pending.entries()) {
    log("");
    log(`[${i + 1}/${pending.length}] ${t.file}  ${t.key}${t.status === "changed" ? "  (changed since it was signed)" : ""}`);
    log(`  ${JSON.stringify(t.value)}`);
    let answer;
    for (;;) {
      try {
        answer = String(await ask(QUESTION)).trim().toLowerCase();
      } catch (err) {
        // Ctrl+C or the end of input: nothing is written, so say what is lost.
        if (err !== null && typeof err === "object") err.signedBeforeStop = result.signed;
        throw err;
      }
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
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // the message below is what matters
      }
      throw new SignTextError(`could not write ${tmp} (${err.code ?? err.message}): ${HUMAN_TEXT_FILE} is unchanged, and the ${result.signed} signature(s) given in this run were not saved`);
    }
    try {
      await replaceFile(tmp, file);
    } catch (err) {
      // The answers are in the temporary file: keep it, so they are not lost.
      throw new SignTextError(
        `could not replace ${file} (${err.code ?? err.message}: another program may have it open, such as an editor, a sync client or an antivirus scan). ` +
          `The ${result.signed} signature(s) given in this run are in ${tmp}: close that program and rename that file over ${HUMAN_TEXT_FILE}, or run --sign again`,
      );
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
  if (count("illformed")) {
    log(`info: ${count("illformed")} value(s) hold a lone UTF-16 surrogate (half of an escaped pair, from a broken JSON escape): fix the value, then sign it`);
  }
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
      isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      ask: (question) => (term ??= terminal()).ask(question),
      command: commandLine(dir),
    });
    return code;
  } catch (err) {
    if (err instanceof Interrupted) {
      const n = err.signedBeforeStop ?? 0;
      const lost = n ? `; the ${n} signature(s) given in this run were not saved (answer q to stop and keep them)` : "";
      console.error(`\nsign-text: stopped (${err.message}): ${HUMAN_TEXT_FILE} is unchanged${lost}`);
      return err.code;
    }
    if (err instanceof SignTextError) {
      console.error(`sign-text: ERROR: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    if (term) {
      term.close();
      // Ctrl+D closes readline from inside its own keypress handler, and stdin
      // starts reading again afterwards: without this the process never exits.
      process.stdin.destroy();
    }
  }
}

/**
 * The command as the person typed it, for the hints: this script relative to
 * the current folder (forward slashes work in PowerShell and in Git Bash) and
 * the module folder argument.
 */
function commandLine(dir) {
  const quote = (s) => (/[\s"'&|<>()^;$`\\]/.test(s) ? `"${s}"` : s);
  const script = process.argv[1] ? path.relative(process.cwd(), process.argv[1]).split(path.sep).join("/") : "";
  if (!script) return DEFAULT_COMMAND;
  return `node ${quote(script)} ${quote(dir ?? ".")}`;
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
