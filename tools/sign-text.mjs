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
// human-text-authors.json next to human-text.json. A name is trimmed and put
// in NFC, and holds no control character and no character that prints nothing
// (it would pass for another name). Plain --sign records no author, and drops
// the one an earlier signature of that text had. That file is written with
// human-text.json, in the same step and in an order where a stop between two
// renames can leave a signature without its author, never with another one's
// (writeSteps), and loses the entries of the signatures --sign drops; a --sign
// that leaves human-text.json as it was still drops the entries that have no
// signature. A run stopped between its last two renames leaves the authors of
// the signatures it saved in a temporary file: the listing says to rename it,
// and --sign stops until it is renamed or deleted. check-module never reads
// it, and the listing shows the author of each signed text that has one, and
// a count per author.
//
// --sheet <file.csv> reads a text sheet with text-sheet import's own reader
// and asks only about its language cells with text (the module.json title and
// description too, from the first language column), mapped to the module as
// import maps them, that import accepts (text-sheet's sheetRefusals), whose
// value in the module is byte for byte the cell (line breaks as import writes
// them) and needs a signature: "did <author> write this text from scratch?",
// <author> being the row's "author" column, which each signature records. A
// cell import refuses, a row without an author, a cell whose value in the
// module differs (not imported yet, changed since, or replaced by another
// sheet's import, which it names; apart when the module's text is validly
// signed, since importing would replace that signature), a text already signed
// (with the row's author and the recorded one when they differ, or none is
// recorded) and a text that rows with two authors, or with an author and
// without a valid one, give are reported, never asked about. Names that
// differ only in case are warned about before the first question.
//
// A long run says every 50 questions how many signatures Ctrl+C would throw
// away, and "q" ends with the command that goes on where it stopped.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HUMAN_TEXT_AUTHORS_FILE,
  HUMAN_TEXT_FILE,
  LISTING_FIELDS,
  LISTING_PREFIX,
  SIGN_TEXT_COMMAND,
  TextSheetError,
  authorName,
  authorNameProblem,
  authorsProblem,
  authorsText,
  hashText,
  humanTexts,
  languageEntries,
  readAuthors,
  readSheet,
  readSignatures,
  showName,
  signatureStatus,
  signaturesText,
  staleSignatures,
} from "./shared.mjs";
import { SHEET_FILE, sheetRefusals } from "./text-sheet.mjs";

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
export const DEFAULT_COMMAND = SIGN_TEXT_COMMAND;

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
// A long run says this often how many of its answers a Ctrl+C would throw away.
const UNSAVED_EVERY = 50;
// The temporary files of a --sign that could not finish: <file>.<pid>[.part].tmp.
const LEFTOVER_RE = /^\.human-text(?:-authors)?\.json\.\d+(?:\.part)?\.tmp$/;
// The last content of the authors file a run wrote, by the pid of that run.
const FINAL_AUTHORS_RE = /^\.human-text-authors\.json\.(\d+)\.tmp$/;
// The text sheets of a folder: textos-hoja.csv (SHEET_FILE) and one per author, such as textos-hoja-IAR18.csv.
const SHEET_RE = /^textos-hoja.*[.]csv$/i;
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
    .map(([n, c]) => `${showName(n)} ${c}`)
    .join(", ");
}

// As commandLine() quotes the folder: forward slashes work in PowerShell and in Git Bash.
const quoteArg = (s) => (/[\s"'&|<>()^;$`\\]/.test(s) ? `"${s}"` : s);

/** A path as the person types it from `cwd`: relative, with forward slashes. */
const shownPath = (cwd, file) => path.relative(cwd, file).split(path.sep).join("/") || path.basename(file);

/** Whether two paths name one file, whatever case or form Windows gives them in. */
function samePath(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The text sheets (SHEET_RE) in `dirs`, each file once, by name within its folder. */
function sheetsIn(dirs) {
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && SHEET_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      // a folder that cannot be read has no sheet to name
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (!found.some((f) => samePath(f, file))) found.push(file);
    }
  }
  return found;
}

/** One key for a file and a key of the module. */
const idOf = (file, key) => JSON.stringify([file, key]);

/**
 * The temporary files a --sign that did not finish left in the module folder
 * (LEFTOVER_RE), and among them the last authors file of a run stopped between
 * its last two renames (writeSteps): it keeps every entry the authors file has
 * and only adds authors to signatures that are valid and have none, so renaming
 * it over the authors file finishes that run.
 * @returns {{ files: string[], finish: { name: string, adds: number }[] }}
 */
function leftovers(root, texts, authors) {
  const files = fs
    .readdirSync(root)
    .filter((f) => LEFTOVER_RE.test(f))
    .sort();
  const byId = new Map(texts.map((t) => [idOf(t.file, t.key), t]));
  const finish = [];
  for (const name of files) {
    const pid = FINAL_AUTHORS_RE.exec(name)?.[1];
    // With its human-text.json still beside it, that run saved no signature.
    if (pid === undefined || files.includes(`.${HUMAN_TEXT_FILE}.${pid}.tmp`)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    } catch {
      continue;
    }
    if (authorsProblem(data)) continue;
    const keeps = Object.entries(authors).every(([file, keys]) => Object.entries(keys).every(([key, who]) => authorOf(data.authors, file, key) === who));
    const adds = Object.entries(data.authors).flatMap(([file, keys]) =>
      Object.keys(keys)
        .filter((key) => authorOf(authors, file, key) === null)
        .map((key) => byId.get(idOf(file, key))),
    );
    if (keeps && adds.length && adds.every((t) => t?.status === "signed")) finish.push({ name, adds: adds.length });
  }
  return { files, finish };
}

/** What a leftover that finishes a run holds, and what to do with it. */
const finishLine = ({ name, adds }) =>
  `${name} holds the authors of ${adds} valid signature(s) that have none recorded: a --sign stopped after saving those signatures and before saving their authors; ` +
  `rename it over ${HUMAN_TEXT_AUTHORS_FILE} to record them (it changes no other entry)`;

/** The leftovers of `leftovers()`, as information. */
function reportLeftovers({ files, finish }, log) {
  for (const x of finish) log(`info: ${finishLine(x)}`);
  const rest = files.filter((f) => !finish.some((x) => x.name === f));
  if (rest.length) {
    log(
      `info: ${rest.length} temporary file(s) left by a --sign that did not finish (${rest.join(", ")}): if that run printed a message, do what it said; ` +
        "if not (a closed window), the signatures in them were never saved: delete them, and sign those texts again",
    );
  }
}

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
 * Writes human-text.json and, when they change too, human-text-authors.json,
 * as one step: every content goes to a temporary file next to its target
 * first, then each temporary file is renamed over its target, in the order of
 * `steps`. The authors file may come twice, around human-text.json: first
 * without the entries this run removes or replaces, last with the ones it
 * adds, so that a stop between two renames (a closed window) can leave a
 * signature without its author but never with another one's. When a rename
 * fails, every file already replaced is put back as it was, the last one
 * first, and the last new content of each file stays in its temporary file,
 * so no answer is lost; when human-text.json cannot be put back, the authors
 * file stays without the entries the run removes or replaces, and the message
 * says to rename the authors' temporary file.
 * @param {{ file: string, rel: string, text: string, before: Buffer|null }[]} steps
 *   `before`: the file as the run found it (null: there was none)
 * @param {number} signed the signatures given in this run, for the messages
 */
async function writeSteps(steps, signed) {
  const last = new Map(steps.map((s) => [s.rel, s]));
  const names = [HUMAN_TEXT_FILE, HUMAN_TEXT_AUTHORS_FILE].filter((rel) => last.has(rel)).join(" and ");
  const are = last.size > 1 ? "are" : "is";
  const staged = [];
  for (const s of steps) {
    // Written next to the target and renamed over it: a reader never sees half a file.
    const final = last.get(s.rel) === s;
    const tmp = path.join(path.dirname(s.file), `.${s.rel}.${process.pid}${final ? "" : ".part"}.tmp`);
    try {
      fs.writeFileSync(tmp, s.text);
      staged.push({ ...s, tmp, final });
    } catch (err) {
      for (const x of staged) removeQuietly(x.tmp);
      removeQuietly(tmp);
      throw new SignTextError(`could not write ${tmp} (${err.code ?? err.message}): ${names} ${are} unchanged, and the ${signed} signature(s) given in this run were not saved`);
    }
  }
  const done = [];
  for (const s of staged) {
    try {
      await replaceFile(s.tmp, s.file);
      done.push(s.rel);
    } catch (err) {
      // Put back what was replaced, the last one first, and keep the last new
      // content of each file next to it. human-text.json goes back before the
      // authors file, and the authors file goes back only once the signatures
      // did: next to the new signatures it stays without the entries this run
      // removes or replaces, so no signature is ever left with another one's author.
      const lost = [];
      let signaturesBack = true;
      for (const rel of [...new Set(done)].reverse()) {
        if (rel === HUMAN_TEXT_AUTHORS_FILE && !signaturesBack) continue;
        const { file, before } = steps.find((x) => x.rel === rel);
        const fin = staged.find((x) => x.rel === rel && x.final);
        try {
          if (!fs.existsSync(fin.tmp)) fs.writeFileSync(fin.tmp, fin.text);
          if (before === null) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, before);
        } catch {
          lost.push(rel);
          if (rel === HUMAN_TEXT_FILE) signaturesBack = false;
        }
      }
      for (const x of staged) if (!x.final) removeQuietly(x.tmp);
      const tmpOf = (rel) => staged.find((x) => x.rel === rel && x.final)?.tmp;
      const held = `could not replace ${s.file} (${err.code ?? err.message}: another program may have it open, such as an editor, a sync client or an antivirus scan). `;
      if (!signaturesBack) {
        // The signatures stay saved: only their authors are missing, and a new --sign would not ask about them.
        const tmpH = tmpOf(HUMAN_TEXT_FILE);
        let whole = false;
        try {
          whole = fs.readFileSync(path.join(path.dirname(tmpH), HUMAN_TEXT_FILE)).equals(Buffer.from(last.get(HUMAN_TEXT_FILE).text, "utf8"));
        } catch {
          // unreadable: keep the copy
        }
        if (whole) removeQuietly(tmpH);
        throw new SignTextError(
          held +
            `${HUMAN_TEXT_FILE} could not be put back as it was, so it keeps the ${signed} signature(s) given in this run; their authors are in ${tmpOf(HUMAN_TEXT_AUTHORS_FILE)}: ` +
            `close that program and ${whole ? "" : `rename ${tmpH} over ${HUMAN_TEXT_FILE}, then `}rename that file over ${HUMAN_TEXT_AUTHORS_FILE} ` +
            "(running --sign again would not ask about those signatures, so it would not record their authors)",
        );
      }
      const where =
        last.size > 1
          ? `${lost.length ? "The" : "Nothing was changed: the"} ${signed} signature(s) given in this run are in ${tmpOf(HUMAN_TEXT_FILE)}, and their authors in ${tmpOf(HUMAN_TEXT_AUTHORS_FILE)}`
          : `The ${signed} signature(s) given in this run are in ${tmpOf(HUMAN_TEXT_FILE)}`;
      const rename = last.size > 1 ? `rename each of those files over its target (${names})` : `rename that file over ${HUMAN_TEXT_FILE}`;
      throw new SignTextError(
        `${held}${where}: close that program and ${rename}, or run --sign again` + (lost.length ? `. ${lost.join(", ")} could not be put back as it was: restore it from git` : ""),
      );
    }
  }
}

/**
 * Writes the authors file alone, when human-text.json stays as it was: only
 * to drop entries that have no signature. Failing to is not worth stopping
 * for: nothing the person answered is lost, and the next --sign tries again.
 * @returns {boolean} whether it was written
 */
async function dropAuthorEntries(file, text, count, log) {
  const tmp = path.join(path.dirname(file), `.${HUMAN_TEXT_AUTHORS_FILE}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    await replaceFile(tmp, file);
    return true;
  } catch (err) {
    removeQuietly(tmp);
    log(`warn: could not remove the ${count} author record(s) without a signature from ${HUMAN_TEXT_AUTHORS_FILE} (${err.code ?? err.message}): the next --sign tries again`);
    return false;
  }
}

// What --sheet reports instead of asking, in this order; "signed" only as a count.
const SHEET_SKIPS = [
  ["unmapped", "cell(s) that text-sheet import writes nowhere (no key, a key that is not in the files of that language, or a module.json row outside the first language column)"],
  ["refused", "cell(s) that text-sheet import refuses, so it never wrote them from this sheet: fix them in the sheet and import it again"],
  [
    "replaces",
    "cell(s) whose key holds another text, validly signed: importing this sheet would replace that signed text; keep one of the two texts (drop this row, or import the sheet and sign it)",
  ],
  [
    "differs",
    "cell(s) not imported yet, changed since, or replaced by another sheet's import: the value in the module is not the sheet's text (import the sheet first, if its text is the one to keep)",
  ],
  ["signed", "cell(s) already validly signed"],
  ["otherAuthor", "cell(s) already validly signed whose recorded author is not their row's: the record keeps its author (sign-text never changes the author of a valid signature)"],
  ["unattributed", "cell(s) already validly signed with no author recorded (a plain --sign records none): sign-text never gives a valid signature an author afterwards"],
  ["blocked", "cell(s) whose text cannot be signed yet (still to write, a list, a key defined twice or a broken string)"],
  ["noAuthor", 'cell(s) in rows without an author: write in "author" the name of the person who wrote each one, save the sheet and run this again'],
  ["badAuthor", "cell(s) whose author is not a valid name (1 to 60 characters, none of them a control character or one that prints nothing)"],
  ["twoAuthors", "cell(s) that give one text with different authors: keep one row for it"],
  ["mixedAuthor", "cell(s) whose text another row gives without a valid author: write the same author in every row that gives it"],
];

/** The sheet file of --sheet: where it was looked for, and the module's own, or the text sheets found, when there are. */
function missingSheet({ sheetPath, shown, cwd, root, sheet }) {
  const inModule = path.resolve(root, sheet);
  const there = inModule !== sheetPath && fs.existsSync(inModule) && fs.statSync(inModule).isFile();
  let hint = "";
  if (there) hint = `; the module folder has one: --sheet ${quoteArg(shownPath(cwd, inModule))}`;
  else {
    // A sheet per author (textos-hoja-IAR18.csv) is not the default name export gives.
    const found = sheetsIn([cwd, root]).map((f) => `--sheet ${quoteArg(shownPath(cwd, f))}`);
    if (found.length) hint = `; text sheets found: ${found.join(" or ")}`;
  }
  return new SignTextError(`${shown} does not exist in ${cwd}, the folder this runs in (--sheet is read from there)${hint}`);
}

/**
 * The other text sheets next to the sheet and in the module folder, read with
 * the same reader: for each text of the module, the sheet rows that give its
 * value now ("textos-hoja-BaronHVC.csv row 2"), so a cell whose key holds
 * another sheet's text can name that sheet. Never their values. A sheet that
 * cannot be read is left out.
 * @returns {Map<string, string[]>} by idOf(file, key)
 */
function otherSheets({ sheetPath, cwd, root, langs, targetsOf }) {
  const from = new Map();
  for (const file of sheetsIn([path.dirname(sheetPath), root])) {
    if (samePath(file, sheetPath)) continue;
    let other;
    try {
      other = readSheet(fs.readFileSync(file), langs);
    } catch {
      continue;
    }
    if (!other.header || other.keyIdx < 0) continue;
    const name = shownPath(cwd, file);
    for (const r of other.records) {
      const key = (r.fields[other.keyIdx] ?? "").trim();
      for (const c of other.langCols) {
        const cell = r.fields[c.idx] ?? "";
        if (cell === "") continue;
        const value = cell.replace(/\r\n?/g, "\n");
        for (const t of targetsOf(key, c.lang)) {
          if (t.value !== value) continue;
          const id = idOf(t.file, t.key);
          if (!from.has(id)) from.set(id, []);
          const where = `${name} row ${r.row}`;
          if (!from.get(id).includes(where)) from.get(id).push(where);
        }
      }
    }
  }
  return from;
}

/**
 * What --sheet asks about: each language cell with text of the sheet (the
 * module.json title and description from the first language column), mapped
 * as text-sheet import maps it, that import accepts, whose value in the module
 * is byte for byte the cell and needs a signature, once per text, with the
 * author of its row. Every other cell goes to `skips`, by SHEET_SKIPS reason.
 * Values are never kept for the report: a value that differs may be an AI
 * working text.
 * @returns {{ queue: { t: object, author: string, rows: number[] }[], skips: Record<string, object[]>, columns: object[], names: Map<string, number[]> }}
 *   `columns`: what import refuses in the whole sheet; `names`: each valid author name of the sheet and its rows
 */
function sheetPlan({ sheetPath, shown, cwd, root, sheet: given, entries, texts, authors }) {
  if (!fs.existsSync(sheetPath) || !fs.statSync(sheetPath).isFile()) throw missingSheet({ sheetPath, shown, cwd, root, sheet: given });
  const langs = [...new Set(entries.map((e) => e.lang))];
  const buf = fs.readFileSync(sheetPath);
  let sheet;
  let refusals;
  try {
    sheet = readSheet(buf, langs);
    if (sheet.header && sheet.keyIdx >= 0) refusals = sheetRefusals(root, buf);
  } catch (err) {
    if (err instanceof TextSheetError) throw new SignTextError(`${shown}: ${err.message}`);
    throw err;
  }
  if (!sheet.header || sheet.keyIdx < 0) throw new SignTextError(`${shown} has no header row with a "key" column: --sheet reads the sheet that text-sheet export wrote and import read`);
  if (!sheet.langCols.length) throw new SignTextError(`${shown} has no language column: the module declares ${langs.join(", ")}`);
  const twice = sheet.langCols.find((c, i) => sheet.langCols.findIndex((d) => d.lang === c.lang) !== i);
  if (twice) throw new SignTextError(`${shown} has two "${twice.lang}" columns: keep one`);
  // Why import refuses each cell: a cell it refuses was never written from this sheet.
  const refused = new Map();
  for (const x of refusals.cells) {
    const id = `${x.row}\n${x.lang}`;
    if (!refused.has(id)) refused.set(id, []);
    if (!refused.get(id).includes(x.reason)) refused.get(id).push(x.reason);
  }

  // The module's texts a cell of `lang` under `key` goes to, as import maps it.
  const targetsOf = (key, lang) => {
    if (key.startsWith(LISTING_PREFIX)) {
      const field = key.slice(LISTING_PREFIX.length);
      return LISTING_FIELDS.includes(field) && lang === langs[0] ? texts.filter((t) => t.file === "module.json" && t.key === field) : [];
    }
    if (!key) return [];
    const rels = entries.filter((e) => e.lang === lang).map((e) => e.rel);
    return texts.filter((t) => rels.includes(t.file) && t.key === key);
  };
  const elsewhere = otherSheets({ sheetPath, cwd, root, langs, targetsOf });

  const skips = Object.fromEntries(SHEET_SKIPS.map(([id]) => [id, []]));
  const asked = new Map(); // text -> the cells that give it, with their author
  let seq = 0; // the order of the cells, for the report
  for (const r of sheet.records) {
    const key = (r.fields[sheet.keyIdx] ?? "").trim();
    const raw = sheet.authorIdx < 0 ? "" : (r.fields[sheet.authorIdx] ?? "").trim();
    const valid = raw !== "" && !authorNameProblem(raw);
    const author = valid ? authorName(raw) : raw;
    for (const c of sheet.langCols) {
      const cell = r.fields[c.idx] ?? "";
      if (cell === "") continue;
      // What import writes: the cell with its line breaks as LF.
      const value = cell.replace(/\r\n?/g, "\n");
      const at = { row: r.row, lang: c.lang, key: key || "(no key)", seq: seq++ };
      const targets = targetsOf(key, c.lang);
      if (!targets.length) {
        skips.unmapped.push(at);
        continue;
      }
      const why = refused.get(`${r.row}\n${c.lang}`);
      if (why) {
        skips.refused.push({ ...at, why: why.join("; ") });
        continue;
      }
      const off = targets.filter((t) => t.value !== value);
      if (off.length) {
        // Which other sheet gave the module its value, when one did: never the value itself.
        const from = [...new Set(off.flatMap((t) => elsewhere.get(idOf(t.file, t.key)) ?? []))];
        const files = [...new Set(targets.map((t) => t.file))];
        if (off.every((t) => t.status === "signed")) {
          // "Import the sheet first" would replace a valid signature: said apart, with whose it is.
          const recorded = [...new Set(off.map((t) => authorOf(authors, t.file, t.key)))].map((n) => (n === null ? "no author recorded" : `recorded ${showName(n)}`));
          skips.replaces.push({ ...at, files, detail: [...recorded, ...from.map((w) => `the text of ${w}`)].join("; ") });
        } else skips.differs.push({ ...at, files, ...(from.length ? { detail: `the module holds the text of ${from.join(", ")}` } : {}) });
        continue;
      }
      for (const t of targets) {
        const one = targets.length > 1 ? { ...at, files: [t.file] } : at;
        if (t.status === "signed") {
          // A row's author that the record does not name is reported: the record may be wrong.
          const recorded = authorOf(authors, t.file, t.key);
          if (!valid || recorded === author) skips.signed.push(one);
          else if (recorded === null) skips.unattributed.push({ ...one, detail: `sheet ${showName(author)}` });
          else skips.otherAuthor.push({ ...one, detail: `sheet ${showName(author)}, recorded ${showName(recorded)}` });
        } else if (!TO_SIGN.has(t.status)) skips.blocked.push(one);
        else {
          if (!asked.has(t)) asked.set(t, []);
          asked.get(t).push({ ...one, author, valid });
        }
      }
    }
  }
  // A text is asked about only when every row that gives it names the same valid author.
  const queue = [];
  for (const [t, cells] of asked) {
    const named = cells.filter((x) => x.valid);
    const authorsOfText = new Set(named.map((x) => x.author));
    if (authorsOfText.size === 1 && named.length === cells.length) {
      queue.push({ t, author: named[0].author, rows: [...new Set(cells.map((x) => x.row))] });
      continue;
    }
    for (const x of cells) if (!x.valid) (x.author ? skips.badAuthor : skips.noAuthor).push(x);
    if (authorsOfText.size > 1) skips.twoAuthors.push(...named);
    else skips.mixedAuthor.push(...named);
  }
  for (const list of Object.values(skips)) list.sort((a, b) => a.seq - b.seq);
  // The authors it will ask about, and their rows.
  const names = new Map();
  for (const q of queue) {
    if (!names.has(q.author)) names.set(q.author, []);
    for (const row of q.rows) if (!names.get(q.author).includes(row)) names.get(q.author).push(row);
  }
  for (const rows of names.values()) rows.sort((a, b) => a - b);
  return { queue, skips, columns: refusals.columns, names };
}

/** What --sheet does not ask about, by reason: rows, columns and keys, never values. */
function reportSheet(skips, columns, log) {
  if (columns.length) {
    log(
      `info: text-sheet import refuses ${columns.length} column(s) of this sheet, which hold text it does not read (${columns.map((x) => `${x.lang} ${x.key}`).join(", ")}): ` +
        "it writes nothing from the sheet until they are renamed or emptied, or with --partial",
    );
  }
  for (const [id, what] of SHEET_SKIPS) {
    const list = skips[id];
    if (!list.length) continue;
    if (id === "signed") {
      log(`info: ${list.length} ${what}: not asked`);
      continue;
    }
    log(`info: ${list.length} ${what}; not asked:`);
    for (const x of list.slice(0, STALE_CAP)) {
      const files = x.files ? ` -> ${x.files.join(", ")}` : "";
      const why = x.why ? `: ${x.why}` : "";
      const who = x.detail ? `  (${x.detail})` : x.author ? `  (${showName(x.author)})` : "";
      log(`  row ${x.row}  ${x.lang}  ${x.key}${files}${why}${who}`);
    }
    if (list.length > STALE_CAP) log(`  and ${list.length - STALE_CAP} more`);
  }
}

/**
 * Author names that differ only in case: each spelling would be recorded as
 * its own author. `inSheet`: the sheet's names and their rows (or the
 * --author name); `recorded`: the names human-text-authors.json holds.
 * @returns {string|null} the warning, or null
 */
function caseWarning(inSheet, recorded) {
  const counts = new Map();
  for (const keys of Object.values(recorded)) for (const n of Object.values(keys)) counts.set(n, (counts.get(n) ?? 0) + 1);
  const groups = new Map();
  const add = (name) => {
    const fold = name.toLowerCase();
    if (!groups.has(fold)) groups.set(fold, new Set());
    groups.get(fold).add(name);
  };
  for (const n of inSheet.keys()) add(n);
  for (const n of counts.keys()) add(n);
  const clashes = [...groups.values()].filter((g) => g.size > 1 && [...g].some((n) => inSheet.has(n)));
  if (!clashes.length) return null;
  const capped = (rows) => (rows.length > STALE_CAP ? `${rows.slice(0, STALE_CAP).join(", ")} and ${rows.length - STALE_CAP} more` : rows.join(", "));
  const where = (n) => {
    const parts = [];
    const rows = inSheet.get(n);
    if (rows?.length) parts.push(`sheet row${rows.length > 1 ? "s" : ""} ${capped(rows)}`);
    else if (inSheet.has(n)) parts.push("--author");
    if (counts.has(n)) parts.push(`${counts.get(n)} recorded`);
    return `${showName(n)} (${parts.join("; ")})`;
  };
  return `warn: author names that differ only in case are recorded as different authors: ${clashes.map((g) => [...g].map(where).join(", ")).join("; ")}; write one spelling, or answer q`;
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
    name = authorName(author);
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
  const left = leftovers(root, texts, authors);
  if (sign && left.finish.length) {
    // A new run would write the authors file, and that leftover could no longer simply be renamed over it.
    throw new SignTextError(`${left.finish.map(finishLine).join("; ")}; or delete it to leave them without an author. Then run this again`);
  }

  if (!sign) {
    // Who wrote each signed text, when a signature recorded it.
    const credited = texts.filter((t) => t.status === "signed" && authorOf(authors, t.file, t.key) !== null);
    for (const t of credited) log(`${"signed".padEnd(9)} ${t.file}  ${t.key}  by ${showName(authorOf(authors, t.file, t.key))}`);
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
    if (orphans) {
      const removes = missing ? `the first --sign that saves a signature removes them (restore ${HUMAN_TEXT_FILE} from git if it was lost)` : "--sign removes them";
      log(`info: ${orphans} author record(s) in ${HUMAN_TEXT_AUTHORS_FILE} have no signature in ${HUMAN_TEXT_FILE}; ${removes}`);
    }
    reportLeftovers(left, log);
    if (pending.length) {
      // Decision 28: a person writes each text from scratch, and the person who attests signs naming that author.
      // The sheets are named as they are, one per author (textos-hoja-IAR18.csv); export's name when there is none.
      const sheets = sheetsIn([cwd, root]).map((f) => quoteArg(shownPath(cwd, f)));
      const sheetArg = sheets.length ? `${sheets[0]} (the author of each row${sheets.length > 1 ? `; the same for ${sheets.slice(1).join(", ")}` : ""})` : `${SHEET_FILE} (the author of each row)`;
      log(
        "next: once a person has written each of these from scratch, the person who attests them (BaronHVC) signs them at a terminal, naming who wrote them: " +
          `${command} --sign --sheet ${sheetArg} or ${command} --sign --author <name>` +
          `${off ? ' (check-module asks for them once baron.json says "humanText": "signed")' : ""}`,
      );
    }
    return result;
  }
  reportLeftovers(left, log);

  // What to ask about, and for whom: null is the person at the terminal.
  let queue = pending.map((t) => ({ t, author: name, rows: [] }));
  if (sheet !== undefined) {
    const sheetPath = path.resolve(cwd, sheet);
    const shown = path.relative(cwd, sheetPath).split(path.sep).join("/") || sheet;
    const plan = sheetPlan({ sheetPath, shown, cwd, root, sheet, entries, texts, authors });
    queue = plan.queue;
    log(`sheet: ${shown}: ${queue.length} text(s) to ask about, each for the author of its row${queue.length ? ` (${authorCounts(queue.map((q) => q.author))})` : ""}`);
    reportSheet(plan.skips, plan.columns, log);
    const elsewhere = pending.filter((t) => !queue.some((q) => q.t === t)).length;
    if (elsewhere) log(`info: ${elsewhere} other text(s) need a signature and are not asked about from this sheet; sign-text without --sign lists them`);
    const warning = caseWarning(plan.names, authors);
    if (warning) log(warning);
  } else if (name !== null && queue.length) {
    const warning = caseWarning(new Map([[name, []]]), authors);
    if (warning) log(warning);
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
    // Ctrl+C throws away every answer of the run: a long one says how many, now and then.
    if (i && i % UNSAVED_EVERY === 0 && given.length) log(`(${given.length} signature(s) of this run not saved yet: q saves them and stops, Ctrl+C throws them away)`);
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
  // `kept` is that file without the entries this run adds: true whichever
  // human-text.json is on disk, so it lands before the signatures, and the
  // new entries after them.
  const kept = copyByFile(authors);
  for (const g of given) if (kept[g.file]) delete kept[g.file][g.key];
  for (const { file, key } of unsignedAuthors(kept, next)) delete kept[file][key];
  const nextAuthors = copyByFile(kept);
  for (const g of given) {
    if (g.author === null) continue;
    nextAuthors[g.file] ??= Object.create(null);
    nextAuthors[g.file][g.key] = g.author;
  }
  for (const map of [kept, nextAuthors]) for (const file of Object.keys(map)) if (!Object.keys(map[file]).length) delete map[file];

  const file = path.join(root, HUMAN_TEXT_FILE);
  const text = signaturesText(next);
  const before = missing ? null : fs.readFileSync(file);
  const authorsFile = path.join(root, HUMAN_TEXT_AUTHORS_FILE);
  let dropped = 0;
  if (before === null ? Object.keys(next).length > 0 : !before.equals(Buffer.from(text, "utf8"))) {
    // The authors change with the signatures, in the same step; never created empty.
    const authorsBefore = authorsMissing ? null : fs.readFileSync(authorsFile);
    const differs = (now, map) => (now === null ? Object.keys(map).length > 0 : !Buffer.from(now).equals(Buffer.from(authorsText(map), "utf8")));
    const steps = [];
    let authorsNow = authorsBefore;
    if (authorsText(kept) !== authorsText(authors)) {
      steps.push({ file: authorsFile, rel: HUMAN_TEXT_AUTHORS_FILE, text: authorsText(kept), before: authorsBefore });
      authorsNow = authorsText(kept);
    }
    steps.push({ file, rel: HUMAN_TEXT_FILE, text, before });
    if (differs(authorsNow, nextAuthors)) steps.push({ file: authorsFile, rel: HUMAN_TEXT_AUTHORS_FILE, text: authorsText(nextAuthors), before: authorsBefore });
    await writeSteps(steps, result.signed);
    result.wrote = true;
    result.wroteAuthors = steps.some((s) => s.rel === HUMAN_TEXT_AUTHORS_FILE);
  } else if (!missing && authorsText(kept) !== authorsText(authors)) {
    // human-text.json stays as it was, so this run gave no signature: only the
    // author entries without one go. Not without human-text.json, which may be lost.
    dropped = unsignedAuthors(authors, next).length;
    result.wroteAuthors = await dropAuthorEntries(authorsFile, authorsText(kept), dropped, log);
  }
  log("");
  log(
    `sign-text: ${result.signed} signed, ${result.skipped} skipped${stopped ? `, stopped with ${queue.length - result.signed - result.skipped} left` : ""}` +
      `${stale.length ? `, ${stale.length} stale signature(s) removed` : ""}; ` +
      (result.wrote
        ? `wrote ${result.wroteAuthors ? `${HUMAN_TEXT_FILE} and ${HUMAN_TEXT_AUTHORS_FILE}` : HUMAN_TEXT_FILE}`
        : `${HUMAN_TEXT_FILE} unchanged${result.wroteAuthors ? `; removed ${dropped} author record(s) without a signature from ${HUMAN_TEXT_AUTHORS_FILE}` : ""}`),
  );
  const recorded = given.filter((g) => g.author !== null).map((g) => g.author);
  if (recorded.length) log(`sign-text: authors recorded with the signatures of this run: ${authorCounts(recorded)}`);
  if (stopped) log(`to continue: ${command} ${flags} (a text signed now is not asked again; a skipped one is)`);
  // A sheet run lists only its own texts: the module's others are counted, not shown.
  if (sheet === undefined) for (const t of blocked) show(t, log);
  reportBlocked(blocked, log);
  return result;
}

/** Texts no answer can sign yet, as information after the count. */
function reportBlocked(blocked, log) {
  const count = (status) => blocked.filter((t) => t.status === status).length;
  // Decision 28: a person writes them, never an agent; the person who attests signs them for that author.
  if (count("unwritten")) {
    log(`info: ${count("unwritten")} text(s) still to write (empty or TODO-HUMANO:): BaronHVC or IAR18 writes each one from scratch (in the sheet), then BaronHVC signs it naming its author`);
  }
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
