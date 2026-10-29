#!/usr/bin/env node
// sign-text: the author's signature on the texts of a module, for baron.json
// "humanText": "signed" (check-module rule [n]). Run it from the module folder:
//
//   node ../pf2e-baron-core/tools/sign-text.mjs [moduleDir=cwd]          list what needs a signature
//   node ../pf2e-baron-core/tools/sign-text.mjs [moduleDir=cwd] --sign   sign, one question per text
//   node ../pf2e-baron-core/tools/sign-text.mjs [moduleDir=cwd] --sign --author <name>
//                                                                        sign for <name>, who wrote them
//   node ../pf2e-baron-core/tools/sign-text.mjs [moduleDir=cwd] --sign --sheet <file.csv>
//                                                                        sign for the author of each row
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
//
// The person who attests the texts to Foundry signs too for an author who has
// no terminal. --author <name> asks "did <name> write this text from scratch?"
// instead, and records <name> as the author of each signature it gives, in
// human-text-authors.json next to human-text.json. Plain --sign records no
// author, and drops the one an earlier signature of that text had. That file
// is written with human-text.json, in the same step, and loses the entries of
// the signatures --sign drops; check-module never reads it, and the listing
// shows the author of each signed text that has one, and a count per author.
//
// --sheet <file.csv> reads a text sheet with text-sheet import's own reader
// and asks only about its language cells with text (the module.json title and
// description too, from the first language column), mapped to the module as
// import maps them, whose value in the module is byte for byte the cell (line
// breaks as import writes them) and needs a signature: "did <author> write
// this text from scratch?", <author> being the row's "author" column, which
// each signature records. A row without an author, a cell whose value in the
// module differs (not imported yet, or changed since), a text already signed
// and a text that rows with two authors give are reported, never asked about.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HUMAN_TEXT_AUTHORS_FILE,
  HUMAN_TEXT_FILE,
  LISTING_FIELDS,
  LISTING_PREFIX,
  TextSheetError,
  authorNameProblem,
  authorsText,
  hashText,
  humanTexts,
  languageEntries,
  readAuthors,
  readSheet,
  readSignatures,
  signatureStatus,
  signaturesText,
  staleSignatures,
} from "./shared.mjs";

const USAGE = "usage: node sign-text.mjs [moduleDir] [--sign [--author <name> | --sheet <file.csv>]]";

// The lines in Spanish, for the person who signs. Built from char codes so
// this file stays ASCII: the inverted question mark and the accented u and o.
const INVERTED_QUESTION = String.fromCharCode(0xbf);
export const QUESTION = `${INVERTED_QUESTION}Escribiste t${String.fromCharCode(0xfa)} este texto desde cero? [s/N/q] `;

/**
 * The question of --author: whether `name` wrote the text from scratch.
 * @param {string} name a valid author name, trimmed
 * @returns {string}
 */
export const authorQuestion = (name) => `${INVERTED_QUESTION}${name} escribi${String.fromCharCode(0xf3)} este texto desde cero? [s/N/q] `;

/** How the tool is run from the module folder, as the docs write it. */
export const DEFAULT_COMMAND = "node ../pf2e-baron-core/tools/sign-text.mjs .";

/**
 * Why --sign refuses, and where it works.
 * @param {{ stdin?: boolean, stdout?: boolean, command?: string, flags?: string }} [tty]
 *   which stream is a terminal, when known, the command that ran the tool and
 *   the signing flags it was given (by default "--sign")
 */
export function noTtyMessage({ stdin, stdout, command = DEFAULT_COMMAND, flags = "--sign" } = {}) {
  const says = flags === "--sign" ? "that you wrote that text yourself, from scratch" : "that its author wrote that text from scratch, as you attest";
  const lines = [`sign-text: --sign must be run by a person at a terminal: each signature says ${says}, so nothing may answer for you (stdin and stdout must both be a TTY).`];
  const notTty = [stdin === false && "stdin", stdout === false && "stdout"].filter(Boolean);
  if (notTty.length) {
    lines.push(`Here ${notTty.join(" and ")} ${notTty.length > 1 ? "are" : "is"} not a terminal: run it without a pipe or a redirection (no |, <, >, Tee-Object or more).`);
  }
  lines.push(
    "Run it yourself in a terminal window (PowerShell, Windows Terminal or Git Bash):",
    `  ${command} ${flags}`,
    "Only with Git for Windows older than 2.54 does Git Bash (mintty) not give node a TTY; there, run it as:",
    `  winpty ${command} ${flags}`,
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

/** The legend of --author (and --sheet): you answer for the author each question names. */
export const AUTHOR_LEGEND = [
  "Answer each question yourself, for the author it names, as the person who attests these texts:",
  "  s           that author wrote this text, from scratch; for a translation: that author is fluent in",
  "              its language and checked it line by line against its human-written source",
  "  N or Enter  skip it, also when you are not sure",
  "  q           stop, and save the signatures given so far",
  "  Ctrl+C      stop without saving any signature of this run",
  `Each signature records its author in ${HUMAN_TEXT_AUTHORS_FILE}.`,
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
  const entries = languageEntries(root, module);
  const rels = [...new Set(entries.map((l) => l.rel))];
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
  const who = readAuthors(root);
  if (who.error) {
    throw new SignTextError(`${HUMAN_TEXT_AUTHORS_FILE} ${who.error}: restore it from git (deleting it forgets who wrote each signed text)`);
  }
  const texts = signatureStatus(humanTexts(module, langFiles), read.signed);
  return {
    module,
    entries,
    texts,
    signed: read.signed,
    missing: !!read.missing,
    stale: staleSignatures(texts, read.signed),
    mode,
    authors: who.authors,
    authorsMissing: !!who.missing,
  };
}

/** The recorded author of a file and key, or null. */
const authorOf = (authors, file, key) => (Object.hasOwn(authors, file) && Object.hasOwn(authors[file], key) ? authors[file][key] : null);

/** Author entries without a signature in `signed`: nothing they describe. */
const unsignedAuthors = (authors, signed) =>
  Object.entries(authors).flatMap(([file, keys]) => Object.keys(keys).filter((key) => authorOf(signed, file, key) === null).map((key) => ({ file, key })));

/** "IAR18" 12, "BaronHVC" 3: each author and how many, most first. */
function authorCounts(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([n, c]) => `${JSON.stringify(n)} ${c}`)
    .join(", ");
}

// As commandLine() quotes the folder: forward slashes work in PowerShell and in Git Bash.
const quoteArg = (s) => (/[\s"'&|<>()^;$`\\]/.test(s) ? `"${s}"` : s);

const show = (t, log) => {
  log(`${LABELS[t.status].padEnd(9)} ${t.file}  ${t.key}`);
  log(`          ${JSON.stringify(t.value)}`);
};

/** A file -> key map as it will be written: null-prototype objects, so no key is special. */
function copyByFile(map) {
  const out = Object.create(null);
  for (const [file, keys] of Object.entries(map)) out[file] = Object.assign(Object.create(null), keys);
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

const removeQuietly = (file) => {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // the message of the caller is what matters
  }
};

/**
 * Writes human-text.json and, when it changes too, human-text-authors.json,
 * as one step: each goes to a temporary file next to it, then each temporary
 * file is renamed over its target, the authors first (an author entry ahead
 * of its signature describes a text that is not signed yet; a signature
 * ahead of its author entry would show the previous author). When a rename
 * fails, the file already replaced is put back as it was, and every new
 * content stays in its temporary file, so no answer is lost.
 * @param {{ file: string, rel: string, text: string, before: string|null }[]} writes
 * @param {number} signed the signatures given in this run, for the messages
 */
async function writeTogether(writes, signed) {
  const names = writes.map((w) => w.rel).join(" and ");
  const are = writes.length > 1 ? "are" : "is";
  const staged = [];
  for (const w of writes) {
    // Written next to the target and renamed over it: a reader never sees half a file.
    const tmp = path.join(path.dirname(w.file), `.${w.rel}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, w.text);
      staged.push({ ...w, tmp });
    } catch (err) {
      for (const s of staged) removeQuietly(s.tmp);
      removeQuietly(tmp);
      throw new SignTextError(`could not write ${tmp} (${err.code ?? err.message}): ${names} ${are} unchanged, and the ${signed} signature(s) given in this run were not saved`);
    }
  }
  const done = [];
  for (const s of staged) {
    try {
      await replaceFile(s.tmp, s.file);
      done.push(s);
    } catch (err) {
      // Put back what was replaced, and keep its new content next to it again.
      const lost = [];
      for (const d of done) {
        try {
          fs.writeFileSync(d.tmp, d.text);
          if (d.before === null) fs.rmSync(d.file, { force: true });
          else fs.writeFileSync(d.file, d.before);
        } catch {
          lost.push(d.rel);
        }
      }
      const tmpOf = (rel) => staged.find((x) => x.rel === rel)?.tmp;
      const where =
        staged.length > 1
          ? `${lost.length ? "The" : "Nothing was changed: the"} ${signed} signature(s) given in this run are in ${tmpOf(HUMAN_TEXT_FILE)}, and their authors in ${tmpOf(HUMAN_TEXT_AUTHORS_FILE)}`
          : `The ${signed} signature(s) given in this run are in ${s.tmp}`;
      const rename = staged.length > 1 ? `rename each of those files over its target (${names})` : `rename that file over ${s.rel}`;
      throw new SignTextError(
        `could not replace ${s.file} (${err.code ?? err.message}: another program may have it open, such as an editor, a sync client or an antivirus scan). ` +
          `${where}: close that program and ${rename}, or run --sign again` +
          (lost.length ? `. ${lost.join(", ")} could not be put back as it was: restore it from git` : ""),
      );
    }
  }
}

// What --sheet reports instead of asking, in this order; "signed" only as a count.
const SHEET_SKIPS = [
  ["unmapped", "cell(s) that text-sheet import writes nowhere (no key, a key that is not in the files of that language, or a module.json row outside the first language column)"],
  ["differs", "cell(s) not imported yet or changed since: the value in the module is not the sheet's text (import the sheet first; a cell that import refuses is never signed)"],
  ["signed", "cell(s) already validly signed"],
  ["blocked", "cell(s) whose text cannot be signed yet (still to write, a list, a key defined twice or a broken string)"],
  ["noAuthor", 'cell(s) in rows without an author: write in "author" the name of the person who wrote each one, save the sheet and run this again'],
  ["badAuthor", "cell(s) whose author is not a valid name (1 to 60 characters, no control character)"],
  ["twoAuthors", "cell(s) that give one text with different authors: keep one row for it"],
];

/**
 * What --sheet asks about: each language cell with text of the sheet (the
 * module.json title and description from the first language column), mapped
 * as text-sheet import maps it, whose value in the module is byte for byte the
 * cell and needs a signature, once per text, with the author of its row. Every
 * other cell goes to `skips`, by SHEET_SKIPS reason. Values are never kept for
 * the report: a value that differs may be an AI working text.
 * @returns {{ queue: { t: object, author: string, rows: number[] }[], skips: Record<string, object[]> }}
 */
function sheetPlan({ sheetPath, shown, entries, texts }) {
  if (!fs.existsSync(sheetPath) || !fs.statSync(sheetPath).isFile()) throw new SignTextError(`${shown} does not exist`);
  const langs = [...new Set(entries.map((e) => e.lang))];
  let sheet;
  try {
    sheet = readSheet(fs.readFileSync(sheetPath), langs);
  } catch (err) {
    if (err instanceof TextSheetError) throw new SignTextError(`${shown}: ${err.message}`);
    throw err;
  }
  if (!sheet.header || sheet.keyIdx < 0) throw new SignTextError(`${shown} has no header row with a "key" column: --sheet reads the sheet that text-sheet export wrote and import read`);
  if (!sheet.langCols.length) throw new SignTextError(`${shown} has no language column: the module declares ${langs.join(", ")}`);
  const twice = sheet.langCols.find((c, i) => sheet.langCols.findIndex((d) => d.lang === c.lang) !== i);
  if (twice) throw new SignTextError(`${shown} has two "${twice.lang}" columns: keep one`);

  const skips = Object.fromEntries(SHEET_SKIPS.map(([id]) => [id, []]));
  const asked = new Map(); // text -> the cells that give it
  for (const r of sheet.records) {
    const key = (r.fields[sheet.keyIdx] ?? "").trim();
    const author = sheet.authorIdx < 0 ? "" : (r.fields[sheet.authorIdx] ?? "").trim();
    for (const c of sheet.langCols) {
      const cell = r.fields[c.idx] ?? "";
      if (cell === "") continue;
      // What import writes: the cell with its line breaks as LF.
      const value = cell.replace(/\r\n?/g, "\n");
      const at = { row: r.row, lang: c.lang, key: key || "(no key)" };
      let targets = [];
      if (key.startsWith(LISTING_PREFIX)) {
        const field = key.slice(LISTING_PREFIX.length);
        if (LISTING_FIELDS.includes(field) && c.lang === langs[0]) targets = texts.filter((t) => t.file === "module.json" && t.key === field);
      } else if (key) {
        const rels = entries.filter((e) => e.lang === c.lang).map((e) => e.rel);
        targets = texts.filter((t) => rels.includes(t.file) && t.key === key);
      }
      if (!targets.length) {
        skips.unmapped.push(at);
        continue;
      }
      if (targets.some((t) => t.value !== value)) {
        skips.differs.push({ ...at, files: [...new Set(targets.map((t) => t.file))] });
        continue;
      }
      for (const t of targets) {
        const one = targets.length > 1 ? { ...at, files: [t.file] } : at;
        if (t.status === "signed") skips.signed.push(one);
        else if (!TO_SIGN.has(t.status)) skips.blocked.push(one);
        else if (!author) skips.noAuthor.push(one);
        else if (authorNameProblem(author)) skips.badAuthor.push({ ...one, author });
        else {
          if (!asked.has(t)) asked.set(t, []);
          asked.get(t).push({ ...one, author });
        }
      }
    }
  }
  const queue = [];
  for (const [t, cells] of asked) {
    if (new Set(cells.map((x) => x.author)).size > 1) skips.twoAuthors.push(...cells);
    else queue.push({ t, author: cells[0].author, rows: [...new Set(cells.map((x) => x.row))] });
  }
  return { queue, skips };
}

/** What --sheet does not ask about, by reason: rows, columns and keys, never values. */
function reportSheet(skips, log) {
  for (const [id, what] of SHEET_SKIPS) {
    const list = skips[id];
    if (!list.length) continue;
    if (id === "signed") {
      log(`info: ${list.length} ${what}: not asked`);
      continue;
    }
    log(`info: ${list.length} ${what}; not asked:`);
    for (const x of list.slice(0, STALE_CAP)) {
      log(`  row ${x.row}  ${x.lang}  ${x.key}${x.files ? ` -> ${x.files.join(", ")}` : ""}${x.author ? `  (${JSON.stringify(x.author)})` : ""}`);
    }
    if (list.length > STALE_CAP) log(`  and ${list.length - STALE_CAP} more`);
  }
}

/**
 * Lists the texts that need a signature or, with `sign`, asks about each one
 * and writes human-text.json (and human-text-authors.json). The CLI wraps it;
 * tests pass `isTTY` and `ask`.
 * @param {{
 *   dir?: string,
 *   sign?: boolean,
 *   author?: string,                         with `sign`: who wrote the texts (--author); each signature records it
 *   sheet?: string,                          with `sign`, not with `author`: the text sheet (--sheet), from `cwd`;
 *                                            each row's "author" wrote its cells, and each signature records it
 *   cwd?: string,                            the folder `sheet` is relative to (default: the current one)
 *   isTTY?: boolean | { stdin: boolean, stdout: boolean },  stdin and stdout are both a terminal
 *   ask?: (question: string) => Promise<string>,  one answer per call; a rejection (Ctrl+C) aborts without
 *                                                 writing, and gets `signedBeforeStop`, the answers it threw away
 *   command?: string,                        how the person ran the tool, for the hints
 *   log?: (line: string) => void,
 *   logError?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ code: number, pending: number, signed: number, skipped: number, stale: number, wrote: boolean, wroteAuthors: boolean }>}
 *   code 2: the options do not go together, or the author name is not valid
 * @throws {SignTextError} when the module cannot be read, or human-text.json cannot be written
 */
export async function signTexts({ dir = process.cwd(), sign = false, author, sheet, cwd = process.cwd(), isTTY = false, ask, command = DEFAULT_COMMAND, log = console.log, logError = console.error } = {}) {
  const result = { code: 0, pending: 0, signed: 0, skipped: 0, stale: 0, wrote: false, wroteAuthors: false };
  const usage = (message) => {
    logError(`sign-text: ERROR: ${message}\n${USAGE}`);
    return { ...result, code: 2 };
  };
  if (author !== undefined && sheet !== undefined) {
    return usage("--author and --sheet do not go together: --author names the author of every text it asks about, --sheet takes the author of each row from the sheet");
  }
  let name = null;
  if (author !== undefined) {
    if (!sign) return usage("--author goes with --sign");
    const problem = authorNameProblem(author);
    if (problem) return usage(`--author ${problem}`);
    name = author.trim();
  }
  if (sheet !== undefined) {
    if (!sign) return usage("--sheet goes with --sign");
    if (typeof sheet !== "string" || !sheet.trim()) return usage("--sheet needs the sheet file, as in --sheet textos-hoja.csv");
  }
  const flags = `--sign${name !== null ? ` --author ${quoteArg(name)}` : ""}${sheet !== undefined ? ` --sheet ${quoteArg(sheet)}` : ""}`;
  if (sign && !bothTty(isTTY)) {
    logError(noTtyMessage({ ...(isTTY !== null && typeof isTTY === "object" ? isTTY : {}), command, flags }));
    return { ...result, code: 1 };
  }
  if (sign && typeof ask !== "function") throw new TypeError("signTexts: --sign needs an ask() function");
  const root = path.resolve(dir);
  const { module, entries, texts, signed, missing, stale, mode, authors, authorsMissing } = load(root);
  const pending = texts.filter((t) => TO_SIGN.has(t.status));
  const blocked = texts.filter((t) => !TO_SIGN.has(t.status) && t.status !== "signed");
  const done = texts.length - pending.length - blocked.length;
  result.pending = pending.length;
  result.stale = stale.length;

  log(`sign-text: ${module?.id ?? path.basename(root)} (${root})${sign ? ` ${flags}` : ""}`);
  const off = mode === undefined || mode === "markers";
  if (off) {
    log('note: baron.json does not say "humanText": "signed", so check-module does not ask for these signatures yet');
  } else if (mode !== "signed") {
    // check-module fails the value in [c] and keeps the lock on: a typo never switches it off.
    log(`note: baron.json "humanText" is ${JSON.stringify(mode)}, which check-module rejects (rule [c]); its lock still asks for these signatures`);
  }
  if (missing) log(`note: there is no ${HUMAN_TEXT_FILE} yet: every text counts as unsigned`);

  if (!sign) {
    // Who wrote each signed text, when a signature recorded it.
    const credited = texts.filter((t) => t.status === "signed" && authorOf(authors, t.file, t.key) !== null);
    for (const t of credited) log(`${"signed".padEnd(9)} ${t.file}  ${t.key}  by ${JSON.stringify(authorOf(authors, t.file, t.key))}`);
    for (const t of pending) show(t, log);
    for (const t of blocked) show(t, log);
    const unsigned = pending.filter((t) => t.status === "unsigned").length;
    log(`sign-text: ${pending.length} text(s) need a signature (${unsigned} unsigned, ${pending.length - unsigned} changed since signed); ${done} of ${texts.length} signed`);
    if (credited.length) {
      const anonymous = done - credited.length;
      log(`sign-text: authors of the ${done} signed text(s): ${authorCounts(credited.map((t) => authorOf(authors, t.file, t.key)))}${anonymous ? `; ${anonymous} with no author recorded` : ""}`);
    }
    reportBlocked(blocked, log);
    if (stale.length) {
      log(`info: ${stale.length} signature(s) for keys that no longer exist; --sign removes them:`);
      for (const s of stale.slice(0, STALE_CAP)) log(`${"stale".padEnd(9)} ${s.file}  ${s.key}`);
      if (stale.length > STALE_CAP) log(`and ${stale.length - STALE_CAP} more`);
    }
    const orphans = unsignedAuthors(authors, signed).length;
    if (orphans) log(`info: ${orphans} author record(s) in ${HUMAN_TEXT_AUTHORS_FILE} have no signature in ${HUMAN_TEXT_FILE}; --sign removes them`);
    if (pending.length) {
      log(`next: rewrite each of these yourself, from scratch, then sign them in your terminal: ${command} --sign${off ? ' (check-module asks for them once baron.json says "humanText": "signed")' : ""}`);
    }
    return result;
  }

  // What to ask about, and for whom: null is the person at the terminal.
  let queue = pending.map((t) => ({ t, author: name, rows: [] }));
  if (sheet !== undefined) {
    const sheetPath = path.resolve(cwd, sheet);
    const shown = path.relative(cwd, sheetPath).split(path.sep).join("/") || sheet;
    const plan = sheetPlan({ sheetPath, shown, entries, texts });
    queue = plan.queue;
    log(`sheet: ${shown}: ${queue.length} text(s) to ask about, each for the author of its row`);
    reportSheet(plan.skips, log);
    const elsewhere = pending.filter((t) => !queue.some((q) => q.t === t)).length;
    if (elsewhere) log(`info: ${elsewhere} other text(s) need a signature and are not asked about from this sheet; sign-text without --sign lists them`);
  }
  const next = copyByFile(signed);
  for (const { file, key } of stale) {
    delete next[file][key];
    if (!Object.keys(next[file]).length) delete next[file];
  }
  if (queue.length) {
    log("");
    for (const line of name !== null || sheet !== undefined ? AUTHOR_LEGEND : LEGEND) log(line);
  }
  // The signatures given in this run, and the author each one records (null: none).
  const given = [];
  let stopped = false;
  for (const [i, { t, author: by, rows }] of queue.entries()) {
    log("");
    const where = rows.length ? `  (sheet row${rows.length > 1 ? "s" : ""} ${rows.join(", ")})` : "";
    log(`[${i + 1}/${queue.length}] ${t.file}  ${t.key}${t.status === "changed" ? "  (changed since it was signed)" : ""}${where}`);
    log(`  ${JSON.stringify(t.value)}`);
    let answer;
    for (;;) {
      try {
        answer = String(await ask(by === null ? QUESTION : authorQuestion(by))).trim().toLowerCase();
      } catch (err) {
        // Ctrl+C or the end of input: nothing is written, so say what is lost.
        if (err !== null && typeof err === "object") err.signedBeforeStop = result.signed;
        throw err;
      }
      if (["s", "n", "", "q"].includes(answer)) break;
      log(`  answer "s" (${by === null ? "you" : by} wrote it from scratch: sign it), "n" or Enter (skip it) or "q" (stop and keep what you signed)`);
    }
    if (answer === "q") {
      stopped = true;
      break;
    }
    if (answer === "s") {
      next[t.file] ??= Object.create(null);
      next[t.file][t.key] = hashText(t.value);
      given.push({ file: t.file, key: t.key, author: by });
      result.signed++;
    } else result.skipped++;
  }

  // Each signature given records its author, or none (dropping an older one);
  // an author entry whose signature is gone describes nothing and goes too.
  const nextAuthors = copyByFile(authors);
  for (const g of given) {
    if (g.author !== null) {
      nextAuthors[g.file] ??= Object.create(null);
      nextAuthors[g.file][g.key] = g.author;
    } else if (nextAuthors[g.file]) delete nextAuthors[g.file][g.key];
  }
  for (const { file, key } of unsignedAuthors(nextAuthors, next)) delete nextAuthors[file][key];
  for (const file of Object.keys(nextAuthors)) if (!Object.keys(nextAuthors[file]).length) delete nextAuthors[file];

  const file = path.join(root, HUMAN_TEXT_FILE);
  const text = signaturesText(next);
  const before = missing ? null : fs.readFileSync(file);
  if (before === null ? Object.keys(next).length > 0 : !before.equals(Buffer.from(text, "utf8"))) {
    // The authors change only with the signatures, in the same step.
    const writes = [];
    const authorsFile = path.join(root, HUMAN_TEXT_AUTHORS_FILE);
    const authorsNow = authorsText(nextAuthors);
    const authorsBefore = authorsMissing ? null : fs.readFileSync(authorsFile);
    if (authorsBefore === null ? Object.keys(nextAuthors).length > 0 : !authorsBefore.equals(Buffer.from(authorsNow, "utf8"))) {
      writes.push({ file: authorsFile, rel: HUMAN_TEXT_AUTHORS_FILE, text: authorsNow, before: authorsBefore });
    }
    writes.push({ file, rel: HUMAN_TEXT_FILE, text, before });
    await writeTogether(writes, result.signed);
    result.wrote = true;
    result.wroteAuthors = writes.length > 1;
  }
  log("");
  log(
    `sign-text: ${result.signed} signed, ${result.skipped} skipped${stopped ? `, stopped with ${queue.length - result.signed - result.skipped} left` : ""}` +
      `${stale.length ? `, ${stale.length} stale signature(s) removed` : ""}; ` +
      (result.wrote ? `wrote ${result.wroteAuthors ? `${HUMAN_TEXT_FILE} and ${HUMAN_TEXT_AUTHORS_FILE}` : HUMAN_TEXT_FILE}` : `${HUMAN_TEXT_FILE} unchanged`),
  );
  const recorded = given.filter((g) => g.author !== null).map((g) => g.author);
  if (recorded.length) log(`sign-text: authors recorded with the signatures of this run: ${authorCounts(recorded)}`);
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
  const valued = { "--author": undefined, "--sheet": undefined };
  const needs = { "--author": "the name of the person who wrote the texts", "--sheet": "the sheet file, as in --sheet textos-hoja.csv" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = Object.keys(valued).find((f) => a === f || a.startsWith(`${f}=`));
    if (a === "--sign") sign = true;
    else if (flag) {
      // A mistake in these options exits 2, as signTexts() does for a bad name.
      let value = a.slice(flag.length + 1);
      if (a === flag) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          console.error(`sign-text: ERROR: ${flag} needs ${needs[flag]}\n${USAGE}`);
          return 2;
        }
        i++;
      }
      if (valued[flag] !== undefined) {
        console.error(`sign-text: ERROR: ${flag} given twice\n${USAGE}`);
        return 2;
      }
      valued[flag] = value;
    } else if (a === "-h" || a === "--help") {
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
      author: valued["--author"],
      sheet: valued["--sheet"],
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
  const script = process.argv[1] ? path.relative(process.cwd(), process.argv[1]).split(path.sep).join("/") : "";
  if (!script) return DEFAULT_COMMAND;
  return `node ${quoteArg(script)} ${quoteArg(dir ?? ".")}`;
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
