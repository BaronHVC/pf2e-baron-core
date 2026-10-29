#!/usr/bin/env node
// text-sheet: a spreadsheet where people write a module's human texts, for
// Foundry's AI policy (publisher handbook 4.1) and check-module rule [n]. Run
// it from the module folder:
//
//   node ../pf2e-baron-core/tools/text-sheet.mjs export [moduleDir=cwd] [--out <file.csv>] [--all]
//   node ../pf2e-baron-core/tools/text-sheet.mjs import <file.csv> [moduleDir=cwd] [--dry-run] [--partial]
//
// export writes a CSV (UTF-8 with a BOM, comma-separated, RFC 4180 quoting,
// CRLF) that Excel and Google Sheets open as is, by default textos-hoja.csv
// at the module root (never inside a folder the release ZIP packs). One row
// per text, in the order of docs/textos-borrador.md: by default only those
// that still need a person (the texts that sign-text and check-module [n]
// report; with baron.json "humanText" absent or "markers", those [n] reports,
// a TODO-HUMANO: marker), with --all every text of the declared languages
// plus the module.json title and description. Columns: key, where, intent,
// placeholders, max_length, status, one empty column per language, one
// current_<lang> column per language, then author (who wrote the row: import
// only echoes it) and section (the heading of the row in the draft). A
// current_<lang> cell holds a value only when its signature is valid, and a
// cell taken from the draft is left empty when it quotes a text without one:
// the sheet never shows an AI working text, so nobody starts from one.
//
// import reads that CSV back as Excel or Google Sheets save it (with or
// without a BOM, UTF-16 too; comma, semicolon or tab; CRLF or LF; columns in
// any order, matched by name; the header row wherever a sort left it) and
// writes each filled language cell into its lang file, or into module.json
// for the title and description rows. A cell is refused when its key is not in
// that language file (the tool never creates a key), when its {placeholders}
// differ from the ones the text must keep, when it starts with TODO-HUMANO:,
// holds only whitespace or is a spreadsheet error such as #NAME?; a column it
// does not read that holds text is refused too, so a misnamed language never
// loses a text. Over max_length only warns. One refused cell and nothing is
// written, unless --partial; --dry-run writes nothing and shows what would
// change. Only the edited values change in each file, byte for byte, through
// a temporary file and a rename. It never touches human-text.json and never
// signs: the person who attests the texts (BaronHVC) signs them at a
// terminal with sign-text --sign --sheet <that sheet>, answering for the
// author of each row, which each signature records.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTHOR_COLUMN,
  AUTHOR_HEADERS,
  CURRENT_PREFIX,
  FIXED_COLUMNS,
  HUMAN_TEXT_FILE,
  LISTING_FIELDS,
  LISTING_PREFIX,
  NOTE_COLUMNS,
  SECTION_COLUMN,
  TextSheetError,
  csvParse,
  decodeSheet,
  flattenLang,
  gitTry,
  humanTexts,
  i18nRefs,
  isHumanPlaceholder,
  languageEntries,
  ownScripts,
  readSheet,
  readSignatures,
  signatureStatus,
  walk,
} from "./shared.mjs";
import { DEFAULT_COMMAND as SIGN_COMMAND } from "./sign-text.mjs";

// The sheet's columns and its CSV reader live in shared.mjs, where sign-text
// --sheet reads the same sheet; they are still this tool's exports.
export { AUTHOR_COLUMN, CURRENT_PREFIX, FIXED_COLUMNS, LISTING_PREFIX, NOTE_COLUMNS, SECTION_COLUMN, TextSheetError, csvParse, decodeSheet };

const USAGE = [
  "usage: node text-sheet.mjs export [moduleDir] [--out <file.csv>] [--all]",
  "       node text-sheet.mjs import <file.csv> [moduleDir] [--dry-run] [--partial]",
].join("\n");

/** How the tool is run from the module folder, as the docs write it. */
export const DEFAULT_COMMAND = "node ../pf2e-baron-core/tools/text-sheet.mjs";
/** How sign-text is run from the module folder, without its folder argument. */
export const SIGN_TOOL = SIGN_COMMAND.replace(/ \.$/, "");
/** Where export writes by default, at the module root; modules list it in .gitignore. */
export const SHEET_FILE = "textos-hoja.csv";
/** The intent of each text, written by the agent that wrote the working text. */
export const DRAFT_FILE = "docs/textos-borrador.md";
/** What the release ZIP packs (module-release.yml): the sheet never goes there. */
export const PACKED_PATHS = ["module.json", "scripts", "styles", "templates", "lang", "packs", "LICENSE", "NOTICE.md"];
/** What the module's .gitignore needs: every sheet (one per author, the .xlsx a person keeps) and Excel's lock files. */
export const GITIGNORE_LINES = ["textos-hoja*", "~$*"];

// Built from char codes so this file stays ASCII.
const ch = (...codes) => String.fromCharCode(...codes);
const BOM = ch(0xfeff);
const BACKSLASH = ch(92);
// Joins the parts of one cell on one line: a line break makes Excel wrap the whole row.
const DASH = ` ${ch(0x2014)} `;
// game.i18n.format() fills in each {name}. A brace group right after "]" is
// the label of an enricher (@Check[...]{Label}, @UUID[...]{Name}), and one
// that is not a name ({two words}) is text: the person rewrites those.
const TOKEN_RE = /(?<!\])\{[A-Za-z_$][\w.$]*\}/g;
// What Excel and Google Sheets save for a formula that failed, in English and
// Spanish (#NAME?, #N/A, #REF!, #DIV/0!, #SPILL!, and the same with an opening
// inverted mark: #?NOMBRE?, #!VALOR!; #N/D for #N/A).
const SHEET_ERROR_RE = /^#(?:N\/[AD]|[\xa1\xbf]?[A-Z\xc1\xc9\xcd\xd1\xd3\xda][A-Z0-9_\/\xc1\xc9\xcd\xd1\xd3\xda]*[!?]|GETTING_DATA|OBTENIENDO_DATOS)$/;
// A cell a spreadsheet may have turned into a number or a date: "1/2", "1,000", "+2".
const NUMBER_OR_DATE_RE = /^(?:[-+]?(?:\d[\d.,\s]*)?\d(?:[eE][-+]?\d+)?%?|\d{1,4}[\/.-]\d{1,2}(?:[\/.-]\d{1,4})?)$/;
// A cell that starts with one of these opens in Excel as a formula.
const FORMULA_START_RE = /^[=+\-@]/;
// Lists in the output stop after this many lines, as check-module caps its own.
const CAP = 10;
// On Windows an editor, Excel or a sync client may hold a file for a moment.
const RENAME_RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 200;

/* ----------------------------------------------------------------------------
 * The commands the hints print
 * -------------------------------------------------------------------------- */

// As sign-text quotes them: forward slashes work in PowerShell and in Git Bash.
const quote = (s) => (/[\s"'&|<>()^;$`\\]/.test(s) ? `"${s}"` : s);
const relPath = (from, to) => path.relative(from, to).split(path.sep).join("/");

/** `import <sheet> [<module>]`, from the folder the tool runs in. */
function importCommand({ tool, cwd, root }, sheet) {
  const dir = relPath(cwd, root);
  return `${tool} import ${quote(relPath(cwd, sheet) || sheet)}${dir ? ` ${quote(dir)}` : ""}`;
}

/** `sign-text <module> --sign`, from the folder the tool runs in. */
const signCommand = ({ signTool, cwd, root }) => `${signTool} ${quote(relPath(cwd, root) || ".")} --sign`;

/** `sign-text <module> --sign --sheet <sheet>`: the person who attests signs a sheet's texts for their authors. */
const sheetSignCommand = (hint, sheet) => `${signCommand(hint)} --sheet ${quote(relPath(hint.cwd, sheet) || sheet)}`;

/* ----------------------------------------------------------------------------
 * CSV
 * -------------------------------------------------------------------------- */

/** One field, quoted when RFC 4180 needs it or when it has whitespace at an end. */
function csvField(value, delimiter) {
  const s = String(value ?? "");
  if (s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * CSV text: a BOM (so Excel reads UTF-8), comma-separated, CRLF after every
 * record. A newline inside a field stays as it is, inside quotes.
 * @param {unknown[][]} rows
 * @param {{ delimiter?: string, bom?: boolean }} [opts]
 * @returns {string}
 */
export function csvWrite(rows, { delimiter = ",", bom = true } = {}) {
  return (bom ? BOM : "") + rows.map((r) => `${r.map((f) => csvField(f, delimiter)).join(delimiter)}\r\n`).join("");
}

/* ----------------------------------------------------------------------------
 * docs/textos-borrador.md
 * -------------------------------------------------------------------------- */

// Header names compare without accents, case or punctuation: "Max." (with
// its accent) is "max".
const fold = (s) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const KEY_HEADER_RE = /^(?:clave|key)\b/;
const DRAFT_ROLES = [
  ["key", KEY_HEADER_RE],
  ["where", /^(?:donde|where)\b/],
  ["intent", /^(?:intencion|que comunica|intent|proposito)\b/],
  ["placeholders", /^(?:variables?|marcadores?|placeholders?)\b/],
  ["max", /^(?:max|maximo|largo|longitud)\b/],
];
// "Claves donde aparece": the column of a table of concepts.
const CONCEPT_KEYS_RE = /^(?:claves|keys)\b/;
const DELIMITER_ROW_RE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of a markdown table row: an escaped \| stays in its cell. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith(`${BACKSLASH}|`)) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === BACKSLASH && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur);
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.replace(/<br\s*\/?>/gi, "\n").trim());
}

/** The keys a key cell names: every `code span` without spaces, or the bare cell. */
function cellKeys(cell) {
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((k) => k && !/\s/.test(k));
  if (spans.length || cell.includes("`")) return spans;
  return cell && !/\s/.test(cell) && /[\p{L}\p{N}]/u.test(cell) ? [cell] : [];
}

const tokensOf = (s) => [...new Set(String(s).match(TOKEN_RE) ?? [])];
/** Markdown text as a spreadsheet cell shows it: no backticks, one line. */
const plain = (s) => s.replace(/`/g, "").replace(/\s+/g, " ").trim();

/**
 * Every markdown table of a draft outside code fences and HTML comments, with
 * its folded header, its rows (cells and line number) and the heading above it.
 */
function draftTables(text) {
  const src = (text.startsWith(BOM) ? text.slice(1) : text)
    .replace(/\r\n?/g, "\n")
    // An HTML comment is not shown; blanked line by line, so line numbers stay.
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const lines = src.split("\n");
  const tables = [];
  let fence = null;
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) {
      section = plain(heading[1]);
      continue;
    }
    if (!line.trim().startsWith("|") || !DELIMITER_ROW_RE.test(lines[i + 1] ?? "")) continue;
    const table = { section, header: splitRow(line).map(fold), rows: [] };
    for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) table.rows.push({ line: i + 1, cells: splitRow(lines[i]) });
    i--;
    tables.push(table);
  }
  return tables;
}

/**
 * The rows of a textos-borrador.md. Every markdown table whose header has a
 * column named "clave" (or "key") lists texts; any other table is ignored, and
 * so is everything outside a table and inside a code fence. Columns are found
 * by their header, in any order, without regard to accents or case: "clave",
 * "donde" ("donde aparece"), "intencion" (or "que comunica"), "variables" (or
 * "marcadores") and "max." (or "largo maximo"); others, such as "archivo",
 * are ignored. A key cell names its keys in backticks; a key may leave out the
 * module's i18n prefix, and module.json:title and module.json:description
 * name the listing texts. A placeholder is every {name} in the variables cell.
 * `section` is the heading above the table.
 * @param {string} text
 * @returns {{ key: string, line: number, section: string, where: string, intent: string, placeholders: string[]|null, max: number|null }[]}
 *   `placeholders` is null without a variables column; `max` is null without a number
 */
export function parseDraft(text) {
  const rows = [];
  for (const table of draftTables(text)) {
    const roles = {};
    table.header.forEach((h, idx) => {
      const role = DRAFT_ROLES.find(([, re]) => re.test(h))?.[0];
      if (role && roles[role] === undefined) roles[role] = idx;
    });
    if (roles.key === undefined) continue;
    for (const { line, cells } of table.rows) {
      const cell = (role) => (roles[role] === undefined ? "" : (cells[roles[role]] ?? ""));
      const placeholders = roles.placeholders === undefined ? null : tokensOf(cell("placeholders"));
      const max = /\d+/.exec(cell("max"));
      for (const key of cellKeys(cell("key"))) {
        rows.push({ key, line, section: table.section, where: cell("where"), intent: cell("intent"), placeholders, max: max ? Number(max[0]) : null });
      }
    }
  }
  return rows;
}

/**
 * The tables of concepts of a textos-borrador.md: a table with a "claves"
 * column ("Claves donde aparece") and no "clave" column lists, in each row,
 * the keys that must name one concept with the same term. `concept` is the
 * first other cell of the row.
 * @param {string} text
 * @returns {{ line: number, concept: string, keys: string[] }[]} rows with two keys or more
 */
export function parseConcepts(text) {
  const out = [];
  for (const { header, rows } of draftTables(text)) {
    if (header.some((h) => KEY_HEADER_RE.test(h))) continue;
    const at = header.findIndex((h) => CONCEPT_KEYS_RE.test(h));
    if (at < 0) continue;
    const named = header.findIndex((h, i) => i !== at && h);
    for (const { line, cells } of rows) {
      const keys = cellKeys(cells[at] ?? "");
      if (keys.length > 1) out.push({ line, concept: named < 0 ? "" : plain(cells[named] ?? ""), keys });
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * The module
 * -------------------------------------------------------------------------- */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Where a JSON text stops being valid, as " at line L, column C", or "". Never
 * V8's message: it quotes the text around the error, a working text maybe.
 */
function jsonErrorPlace(text, err) {
  let at = /position (\d+)/.exec(String(err?.message))?.[1];
  if (at === undefined) {
    try {
      jsonStringLeaves(text);
    } catch (e) {
      at = /at (\d+)$/.exec(String(e?.message))?.[1];
    }
  }
  if (at === undefined) return "";
  const before = text.slice(0, Number(at)).split("\n");
  return ` at line ${before.length}, column ${before.at(-1).length + 1}`;
}

/** A JSON file as it is on disk: its bytes, its BOM, its text and its data. */
function readJsonFile(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new TextSheetError(`${rel} does not exist in ${root}`);
  const buf = fs.readFileSync(file);
  const bom = buf.subarray(0, 3).equals(UTF8_BOM);
  let text;
  try {
    // Fatal, so a file that is not UTF-8 is never rewritten with U+FFFD in it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(bom ? 3 : 0));
  } catch {
    throw new TextSheetError(`${rel} is not UTF-8 text`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new TextSheetError(`${rel} is not valid JSON${jsonErrorPlace(text, err)}: fix it in an editor`);
  }
  return { rel, file, buf, bom, text, data };
}

// How each signatureStatus() status reads in the sheet, as sign-text lists them.
const SIGNED_LABELS = {
  signed: "signed",
  unsigned: "unsigned",
  changed: "changed",
  unwritten: "to write",
  conflict: "conflict",
  list: "list",
  illformed: "broken",
};

/** Whether a value, or any string inside it, starts with TODO-HUMANO:, as check-module [n] reads it. */
const hasMarker = (v) => (typeof v === "string" ? isHumanPlaceholder(v) : v !== null && typeof v === "object" && Object.values(v).some(hasMarker));
const countMarkers = (v) => (typeof v === "string" ? +isHumanPlaceholder(v) : v !== null && typeof v === "object" ? Object.values(v).reduce((n, x) => n + countMarkers(x), 0) : 0);

/**
 * Status of one text. With "humanText": "signed", the signature status
 * (sign-text and check-module [n]); otherwise the marker rule of [n]: "to
 * write" starts with TODO-HUMANO:, "no marker" does not (who wrote it, the
 * tool cannot know) and "empty" is empty; a list, a key defined twice and a
 * broken string keep their own status.
 */
function labelOf(t, mode) {
  if (mode === "signed" || t.status === "list" || t.status === "conflict" || t.status === "illformed") return SIGNED_LABELS[t.status];
  if (isHumanPlaceholder(t.value)) return "to write";
  return t.value.trim() ? "no marker" : "empty";
}

/** Whether a text needs a person: every text without a valid signature with the lock (sign-text, [n]); without it, what [n] reports. */
const needsOf = (t, mode) => (mode === "signed" ? t.status !== "signed" : hasMarker(t.value));

/**
 * THE LEAK GUARD. The only way a value reaches the sheet or the output: when
 * every copy of the text has a valid signature, i.e. a person wrote and signed
 * it. An unsigned, changed or still-to-write value is never shown: an AI
 * working text must not become the starting point of the human one (Foundry's
 * AI policy, 4.1), and there is no option that shows one.
 * @param {{ status: string, value: unknown }[]} entries
 * @returns {string}
 */
function shownValue(entries) {
  if (!entries.length || entries.some((t) => t.status !== "signed")) return "";
  const [{ value }] = entries;
  return typeof value === "string" && entries.every((t) => t.value === value) ? value : "";
}

// Text folded for a search: case and runs of whitespace do not hide a quote.
const foldText = (s) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
// A working text this long is a sentence, never a term a description would
// use by chance: anywhere in a draft cell it is a copy. A shorter one ("Runas
// de propiedad", "Revelar la trampa") is often the plain name of the thing,
// so it counts only between quotation marks.
const SENTENCE_WORDS = 7;
const QUOTE_PAIRS = [['"', '"'], [ch(0x201c), ch(0x201d)], [ch(0xab), ch(0xbb)], ["'", "'"], [ch(0x2018), ch(0x2019)]];

/** The texts a cell copied from the draft must never quote: every value without a valid signature (strings inside a list too), folded. */
function workingTexts(texts) {
  const out = new Map();
  const add = (v) => {
    if (typeof v === "string") {
      const s = foldText(v);
      if (s) out.set(s, s.split(" ").length >= SENTENCE_WORDS);
    } else if (v !== null && typeof v === "object") Object.values(v).forEach(add);
  };
  for (const t of texts) if (t.status !== "signed") add(t.value);
  return [...out].map(([s, sentence]) => ({ s, sentence }));
}

/** Whether `cell` quotes one of `secrets`: whole, between quotation marks, or, for a sentence, anywhere as whole words (case and spacing aside). */
function quotesAny(cell, secrets) {
  if (!cell) return false;
  const hay = foldText(cell);
  const edge = (c, inner) => c === undefined || !WORD_CHAR_RE.test(c) || !WORD_CHAR_RE.test(inner);
  return secrets.some(({ s, sentence }) => {
    if (QUOTE_PAIRS.some(([open, close]) => hay.includes(open + s + close))) return true;
    if (!sentence) return false;
    for (let i = hay.indexOf(s); i >= 0; i = hay.indexOf(s, i + 1)) {
      if (edge(hay[i - 1], s[0]) && edge(hay[i + s.length], s.at(-1))) return true;
    }
    return false;
  });
}

/** baron.json "humanText", read as sign-text reads it: only a missing value or "markers" leaves the lock off. */
function readMode(root) {
  try {
    const baron = JSON.parse(fs.readFileSync(path.join(root, "baron.json"), "utf8"));
    if (baron && typeof baron === "object") {
      const prefix = typeof baron.i18nPrefix === "string" && baron.i18nPrefix ? baron.i18nPrefix : null;
      const off = baron.humanText === undefined || baron.humanText === "markers";
      return { mode: off ? "markers" : "signed", prefix, raw: baron.humanText };
    }
  } catch {
    // no baron.json, or one check-module reports
  }
  return { mode: "markers", prefix: null, raw: undefined };
}

/** A language code that cannot name a column: it would be read as another column. */
const reservedColumn = (name) =>
  FIXED_COLUMNS.includes(name) || AUTHOR_HEADERS.includes(name) || name === SECTION_COLUMN || NOTE_COLUMNS.includes(name) || name.startsWith(CURRENT_PREFIX);

/**
 * Everything both commands need, read once: the declared languages and their
 * files, every text with its status, the draft rows and where each key is used.
 */
function loadModule(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TextSheetError(`${root} is not a folder`);
  const moduleFile = readJsonFile(root, "module.json");
  const module = moduleFile.data;
  if (!module || typeof module !== "object" || Array.isArray(module)) throw new TextSheetError("module.json must hold a JSON object");
  const { mode, prefix: given, raw } = readMode(root);
  const prefix = given ?? (typeof module.id === "string" && module.id ? module.id : null);

  // The languages Foundry loads, as check-module [d], [h] and [n] read them.
  const entries = languageEntries(root, module);
  const langs = [...new Set(entries.map((e) => e.lang))];
  if (!langs.length) throw new TextSheetError("module.json declares no language and lang/ has no .json file: there is nothing to write");
  const bad = langs.find((l) => !l || /[\s,;"]/.test(l) || reservedColumn(l.toLowerCase()));
  if (bad !== undefined) throw new TextSheetError(`the language code ${JSON.stringify(bad)} cannot name a column of the sheet`);
  const files = new Map();
  for (const { rel } of entries) if (!files.has(rel)) files.set(rel, readJsonFile(root, rel));
  // lang/ ships whole in the release ZIP: a file module.json does not declare is still checked by [n].
  const undeclared = walk(root, "lang", (n) => n.endsWith(".json")).filter((rel) => !files.has(rel));

  const read = readSignatures(root);
  if (read.error) throw new TextSheetError(`${HUMAN_TEXT_FILE} ${read.error}: restore it from git`);
  const texts = signatureStatus(
    humanTexts(module, [...files.values()].map((f) => ({ rel: f.rel, data: f.data }))),
    read.signed,
  ).map((t) => ({ ...t, label: labelOf(t, mode), needs: needsOf(t, mode) }));

  // lang -> key -> its texts (one per file of that language, or two for a conflict).
  const byLang = new Map(langs.map((l) => [l, new Map()]));
  const keys = [];
  const seen = new Set();
  for (const { lang, rel } of entries) {
    for (const t of texts.filter((x) => x.file === rel)) {
      const map = byLang.get(lang);
      if (!map.has(t.key)) map.set(t.key, []);
      if (!map.get(t.key).includes(t)) map.get(t.key).push(t);
      if (!seen.has(t.key)) {
        seen.add(t.key);
        keys.push(t.key);
      }
    }
  }
  const listing = new Map(texts.filter((t) => t.file === "module.json").map((t) => [t.key, t]));

  // Where each key is used: check-module [h]'s scan, shared.
  const places = new Map();
  const dynamic = [];
  if (prefix) {
    const scan = i18nRefs({ root, prefix, scripts: ownScripts(root) });
    for (const r of scan.refs) {
      const at = `${r.loc.file}:${r.loc.line}`;
      if (!places.has(r.key)) places.set(r.key, []);
      if (!places.get(r.key).includes(at)) places.get(r.key).push(at);
    }
    dynamic.push(...scan.dynamic);
  }
  const whereUsed = (key) => {
    if (places.has(key)) return places.get(key);
    return [...new Set(dynamic.filter((d) => key.startsWith(d.head)).map((d) => `${d.loc.file}:${d.loc.line} (key built at runtime)`))];
  };

  return {
    root,
    module,
    moduleFile,
    mode,
    rawMode: raw,
    prefix,
    langs,
    entries,
    files,
    undeclared,
    texts,
    byLang,
    keys,
    listing,
    whereUsed,
    missingSignatures: !!read.missing,
    draft: loadDraft(root, { prefix, keys, listing }),
  };
}

/** The draft rows and concepts matched to the module's keys, and what does not match. */
function loadDraft(root, { prefix, keys, listing }) {
  const out = { exists: false, byKey: new Map(), concepts: new Map(), unknown: [], duplicates: [] };
  const file = path.join(root, DRAFT_FILE);
  if (!fs.existsSync(file)) return out;
  out.exists = true;
  const known = new Set(keys);
  const resolve = (key) => {
    if (key.startsWith(LISTING_PREFIX)) return listing.has(key.slice(LISTING_PREFIX.length)) ? key : null;
    if (known.has(key)) return key;
    return prefix && known.has(`${prefix}.${key}`) ? `${prefix}.${key}` : null;
  };
  const text = fs.readFileSync(file, "utf8");
  for (const row of parseDraft(text)) {
    const key = resolve(row.key);
    if (key === null) out.unknown.push(row);
    else if (out.byKey.has(key)) out.duplicates.push({ ...row, first: out.byKey.get(key).line });
    else out.byKey.set(key, row);
  }
  // Each key of a concept: the other keys that name it with the same term, as the draft writes them.
  for (const { concept, keys: named } of parseConcepts(text)) {
    const found = named.map((k) => [k, resolve(k)]).filter(([, key]) => key !== null);
    for (const [, key] of found) {
      const others = [...new Set(found.filter(([, k]) => k !== key).map(([k]) => k))];
      if (!others.length) continue;
      if (!out.concepts.has(key)) out.concepts.set(key, []);
      out.concepts.get(key).push({ concept, others });
    }
  }
  return out;
}

/** One language cell of a key: its status, whether it needs a person, its shown value (signed only) and its texts. */
function langCell(m, lang, key) {
  const list = m.byLang.get(lang).get(key) ?? [];
  if (!list.length) return { label: "missing", needs: false, shown: "", list };
  const open = list.find((t) => t.needs) ?? list.find((t) => t.status !== "signed");
  return { label: (open ?? list[0]).label, needs: list.some((t) => t.needs), shown: shownValue(list), list };
}

/**
 * The {placeholders} a text must keep: those of its current values in every
 * language (marker text included), else those textos-borrador.md lists.
 */
function requiredPlaceholders(m, key) {
  const values = key.startsWith(LISTING_PREFIX)
    ? [m.listing.get(key.slice(LISTING_PREFIX.length))?.value]
    : m.langs.flatMap((l) => (m.byLang.get(l).get(key) ?? []).map((t) => t.value));
  const strings = values.filter((v) => typeof v === "string");
  const found = [...new Set(strings.flatMap(tokensOf))];
  const draft = m.draft.byKey.get(key);
  if (!found.length && draft?.placeholders?.length && strings.every((v) => !v.trim() || isHumanPlaceholder(v))) return draft.placeholders;
  return found;
}

const E_ACUTE = ch(0xe9);

/** The intent of a key: its draft row, then the other keys that name each of its concepts with the same term. */
function intentOf(m, key) {
  const terms = (m.draft.concepts.get(key) ?? []).map((c) => `mismo t${E_ACUTE}rmino que ${c.others.join(", ")}${c.concept ? ` (${c.concept})` : ""}`);
  return [m.draft.byKey.get(key)?.intent, ...terms].filter(Boolean).join(DASH);
}

/**
 * The sheet's rows for the module, in the order of textos-borrador.md (the
 * rows without a draft row after them: the module.json listing fields first,
 * then every key in file order). Each cell taken from the draft goes through
 * the leak guard: one that quotes a text without a valid signature is left
 * empty and reported in `leaks` (key, column, line; never the text).
 */
function sheetRows(m, all) {
  const rows = [];
  const first = m.langs[0];
  for (const field of LISTING_FIELDS) {
    const t = m.listing.get(field);
    if (!t || (!all && !t.needs)) continue;
    rows.push({
      key: LISTING_PREFIX + field,
      status: t.label,
      needs: t.needs,
      signedAll: t.status === "signed",
      code: `module.json "${field}": one text for every language, written in the ${first} column`,
      current: Object.fromEntries(m.langs.map((l) => [l, l === first ? shownValue([t]) : ""])),
    });
  }
  for (const key of m.keys) {
    const cells = Object.fromEntries(m.langs.map((l) => [l, langCell(m, l, key)]));
    const needs = m.langs.some((l) => cells[l].needs);
    if (!all && !needs) continue;
    const labels = m.langs.map((l) => cells[l].label);
    const status = new Set(labels).size === 1 ? labels[0] : m.langs.map((l, i) => `${l}: ${labels[i]}`).join("; ");
    const signedAll = m.langs.every((l) => cells[l].list.every((t) => t.status === "signed"));
    rows.push({ key, status, needs, signedAll, code: m.whereUsed(key).join(", "), current: Object.fromEntries(m.langs.map((l) => [l, cells[l].shown])) });
  }

  const secrets = workingTexts(m.texts);
  const leaks = [];
  for (const r of rows) {
    r.draft = m.draft.byKey.get(r.key);
    const guard = (column, text, line) => {
      if (!quotesAny(text, secrets)) return text;
      leaks.push({ key: r.key, column, line });
      return "";
    };
    const draftWhere = guard("where", r.draft?.where ?? "", r.draft?.line);
    const parts = r.key.startsWith(LISTING_PREFIX) ? [r.code, draftWhere] : [draftWhere, r.code];
    r.where = parts.filter(Boolean).join(DASH);
    const conceptLine = m.draft.byKey.get(r.key)?.line;
    r.intent = guard("intent", intentOf(m, r.key), conceptLine);
    r.section = guard("section", r.draft?.section ?? "", r.draft?.line);
  }
  const order = rows.map((r, i) => ({ r, i, at: r.draft?.line ?? Infinity }));
  order.sort((a, b) => (a.at === b.at ? a.i - b.i : a.at - b.at));
  return { rows: order.map((o) => o.r), leaks };
}

const listCapped = (items, log, fmt) => {
  for (const x of items.slice(0, CAP)) log(fmt(x));
  if (items.length > CAP) log(`  and ${items.length - CAP} more`);
};

const capRows = (rows) => (rows.length > CAP ? `${rows.slice(0, CAP).join(", ")} and ${rows.length - CAP} more` : rows.join(", "));
const rowWord = (rows) => (rows.length === 1 ? `row ${rows[0]}` : `rows ${capRows(rows)}`);
/** A spreadsheet's name of a column: A, B, ..., Z, AA. */
const colName = (i) => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/** The UTF-8 BOM warning of every declared file that has one: sign-text and check-module refuse such a file. */
function bomWarnings(m) {
  return [m.moduleFile, ...m.files.values()].filter((f) => f.bom).map((f) => `${f.rel} starts with a UTF-8 BOM, which sign-text and check-module refuse: save it as UTF-8 without a BOM before signing`);
}

/* ----------------------------------------------------------------------------
 * Files: atomic writes
 * -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameOver(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!RENAME_RETRY.has(err?.code) || attempt >= RENAME_TRIES) throw err;
      await sleep(RENAME_WAIT_MS);
    }
  }
}

const tmpOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
const removeQuietly = (file) => {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // the message of the caller is what matters
  }
};

/**
 * Writes every file or none: each one goes to a temporary file next to it,
 * then each temporary file is renamed over its target. A failed rename puts
 * back the files already replaced. A file that changed on disk since it was
 * read stops everything first.
 * @param {{ file: string, rel: string, before: Buffer|null, after: Buffer }[]} writes
 */
async function writeAll(writes) {
  for (const w of writes) {
    const now = fs.existsSync(w.file) ? fs.readFileSync(w.file) : null;
    if (w.before !== null && (now === null || !now.equals(w.before))) {
      throw new TextSheetError(`${w.rel} changed on disk while text-sheet ran: nothing was written; run it again`);
    }
  }
  const staged = [];
  try {
    for (const w of writes) {
      const tmp = tmpOf(w.file);
      fs.writeFileSync(tmp, w.after);
      staged.push({ ...w, tmp });
    }
  } catch (err) {
    for (const s of staged) removeQuietly(s.tmp);
    removeQuietly(tmpOf(writes[staged.length].file));
    throw new TextSheetError(`could not write next to ${writes[staged.length].rel} (${err.code ?? err.message}): nothing was written`);
  }
  const done = [];
  for (const s of staged) {
    try {
      await renameOver(s.tmp, s.file);
      done.push(s);
    } catch (err) {
      for (const r of staged.filter((x) => !done.includes(x))) removeQuietly(r.tmp);
      const restored = [];
      for (const d of done.reverse()) {
        try {
          if (d.before === null) fs.rmSync(d.file, { force: true });
          else fs.writeFileSync(d.file, d.before);
          restored.push(d.rel);
        } catch {
          // reported below as not restored
        }
      }
      const lost = done.map((d) => d.rel).filter((r) => !restored.includes(r));
      throw new TextSheetError(
        `could not replace ${s.rel} (${err.code ?? err.message}: another program may have it open, such as Excel, an editor or a sync client); ` +
          (lost.length ? `${lost.join(", ")} could not be put back: restore them from git` : "nothing was written"),
      );
    }
  }
}

/* ----------------------------------------------------------------------------
 * export
 * -------------------------------------------------------------------------- */

/** The texts of `key` in `lang` (or its listing field): what import would write. */
function textsOf(m, key, lang) {
  if (key.startsWith(LISTING_PREFIX)) {
    const t = m.listing.get(key.slice(LISTING_PREFIX.length));
    return t ? [t] : [];
  }
  return m.byLang.get(lang)?.get(key) ?? [];
}

/**
 * Why the sheet cannot be written at `target`, or null. An existing sheet may
 * hold what people wrote: it is replaced only when every text in it is in the
 * module and, with the lock, signed (else a new sheet would list an imported
 * text as one to write, and its second author would write it again), and when
 * no other column holds text.
 */
function outProblem(m, target, hint) {
  const { root } = m;
  if (path.extname(target).toLowerCase() !== ".csv") return `${target} does not end in .csv`;
  const rel = path.relative(root, target);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    const top = rel.split(path.sep)[0].toLowerCase();
    if (PACKED_PATHS.some((p) => p.toLowerCase() === top)) {
      return `${rel.split(path.sep).join("/")} is inside ${top}/, which the release ZIP packs (${PACKED_PATHS.join(", ")}): write the sheet at the module root, as ${SHEET_FILE} (the default)`;
    }
  }
  if (!fs.existsSync(target)) return null;
  if (!fs.statSync(target).isFile()) return `${target} is not a file`;
  let sheet;
  try {
    sheet = readSheet(fs.readFileSync(target), m.langs);
  } catch {
    return `${target} exists and is not a text sheet: choose another --out`;
  }
  if (!sheet.header || sheet.keyIdx < 0) return `${target} exists and is not a text sheet: choose another --out`;
  const filled = sheet.records.flatMap((r) => {
    const key = (r.fields[sheet.keyIdx] ?? "").trim();
    return sheet.langCols
      .map((c) => ({ key, lang: c.lang, row: r.row, cell: (r.fields[c.idx] ?? "").replace(/\r\n?/g, "\n") }))
      .filter((x) => x.cell !== "")
      .map((x) => ({ ...x, list: textsOf(m, x.key, x.lang), place: `row ${x.row} (${x.key || "no key"}, ${x.lang})` }));
  });
  // Not imported first: importing comes before signing.
  const pending = filled.find((x) => !x.list.length || !x.list.every((t) => t.value === x.cell));
  if (pending) {
    return `${target} holds a text in ${pending.place} that is not in the module yet: import it first (${importCommand(hint, target)}); a cell that import refuses must be fixed or emptied in the sheet; or move the sheet away`;
  }
  const unsigned = m.mode === "signed" && filled.find((x) => !x.list.every((t) => t.status === "signed"));
  if (unsigned) {
    return `${target} holds a text in ${unsigned.place} that was imported but is not signed yet: sign it first (${sheetSignCommand(hint, target)}), or move the sheet away: a new sheet would list it as a text to write`;
  }
  for (const col of [...sheet.notes, ...sheet.unknown]) {
    const rows = sheet.records.filter((r) => (r.fields[col.idx] ?? "").trim() !== "").map((r) => r.row);
    if (rows.length) {
      return `${target} holds text in column ${col.name ? JSON.stringify(col.name) : colName(col.idx)} (${rowWord(rows)}), which a new sheet would drop: move the sheet away, or give --out another name`;
    }
  }
  return null;
}

/**
 * Writes the sheet. The CLI wraps it; tests call it directly.
 * @param {{ dir?: string, out?: string, all?: boolean, cwd?: string, log?: (line: string) => void, tool?: string, signTool?: string }} [opts]
 *   `tool` and `signTool`: how the hints run text-sheet and sign-text
 * @returns {Promise<{ code: number, file: string, rows: number, header: string[], warnings: number }>}
 * @throws {TextSheetError}
 */
export async function exportSheet({ dir = process.cwd(), out, all = false, cwd = process.cwd(), log = console.log, tool = DEFAULT_COMMAND, signTool = SIGN_TOOL } = {}) {
  const root = path.resolve(cwd, dir);
  const m = loadModule(root);
  const target = out ? path.resolve(cwd, out) : path.join(root, SHEET_FILE);
  const hint = { tool, signTool, cwd, root };
  const problem = outProblem(m, target, hint);
  if (problem) throw new TextSheetError(problem);

  const { rows, leaks } = sheetRows(m, all);
  const header = [...FIXED_COLUMNS, ...m.langs, ...m.langs.map((l) => CURRENT_PREFIX + l), AUTHOR_COLUMN, SECTION_COLUMN];
  const table = [
    header,
    ...rows.map((r) => [
      r.key,
      r.where,
      r.intent,
      requiredPlaceholders(m, r.key).join(" "),
      r.draft?.max ?? "",
      r.status,
      ...m.langs.map(() => ""),
      ...m.langs.map((l) => r.current[l]),
      "",
      r.section,
    ]),
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await writeAll([{ file: target, rel: path.basename(target), before: fs.existsSync(target) ? fs.readFileSync(target) : null, after: Buffer.from(csvWrite(table), "utf8") }]);

  const relOut = relPath(cwd, target) || target;
  log(`text-sheet: ${m.module.id ?? path.basename(root)} (${root}) export${all ? " --all" : ""}`);
  if (m.mode === "markers") {
    log('note: baron.json does not say "humanText": "signed": a text needs a person when it starts with TODO-HUMANO: (check-module [n]), also inside a list or in one copy of a key defined twice');
  } else if (m.rawMode !== "signed") {
    log(`note: baron.json "humanText" is ${JSON.stringify(m.rawMode)}, which check-module rejects (rule [c]); its lock still applies, so the sheet follows the signatures`);
  }
  const needing = rows.filter((r) => r.needs).length;
  const shown = rows.reduce((n, r) => n + m.langs.filter((l) => r.current[l] !== "").length, 0);
  log(`text-sheet: wrote ${relOut}: ${rows.length} row(s), ${needing} that need a person; columns ${m.langs.join(", ")} to write, ${shown} signed text(s) shown in ${m.langs.map((l) => CURRENT_PREFIX + l).join(", ")}`);

  let warnings = 0;
  const warn = (line) => {
    warnings++;
    log(`warn: ${line}`);
  };
  for (const w of bomWarnings(m)) warn(w);
  for (const rel of m.undeclared) {
    let markers = null;
    try {
      markers = countMarkers(readJsonFile(root, rel).data);
    } catch {
      // check-module [c] reports a broken file; here it only counts as undeclared
    }
    if (m.mode === "signed") {
      warn(`${rel} is in lang/ but module.json "languages" does not declare it: the sheet leaves it out, and check-module [n] reports it (lang/ ships whole in the release ZIP, and its texts cannot be signed); declare it, or move it out of lang/`);
    } else if (markers === null || markers > 0) {
      warn(`${rel} is in lang/ but module.json "languages" does not declare it: the sheet leaves out its ${markers ?? "unread"} TODO-HUMANO: text(s), which check-module [n] reports; declare it, or move it out of lang/`);
    }
  }
  if (leaks.length) {
    warn(`${leaks.length} cell(s) of ${DRAFT_FILE} quote a text that has no valid signature (a working text), so the sheet leaves them empty: rewrite each one as an intent, never with the text's wording:`);
    listCapped(leaks, log, (x) => `  ${DRAFT_FILE}${x.line ? `:${x.line}` : ""}  ${x.key} (${x.column})`);
  }
  const noIntent = rows.filter((r) => !r.draft && !r.signedAll);
  if (!m.draft.exists) {
    if (noIntent.length) warn(`there is no ${DRAFT_FILE}: the intent column is empty for all ${noIntent.length} row(s) not signed yet`);
  } else if (noIntent.length) {
    warn(`${noIntent.length} row(s) not signed yet have no row in ${DRAFT_FILE}, so their intent is empty:`);
    listCapped(noIntent, log, (r) => `  ${r.key}`);
  }
  if (m.draft.unknown.length) {
    warn(`${m.draft.unknown.length} row(s) of ${DRAFT_FILE} name a key that is not in the language files (nor module.json:title or module.json:description):`);
    listCapped(m.draft.unknown, log, (r) => `  ${DRAFT_FILE}:${r.line}  ${r.key}`);
  }
  if (m.draft.duplicates.length) {
    warn(`${m.draft.duplicates.length} key(s) have a second row in ${DRAFT_FILE}; the sheet takes the first:`);
    listCapped(m.draft.duplicates, log, (r) => `  ${DRAFT_FILE}:${r.line}  ${r.key} (first at line ${r.first})`);
  }
  const mismatch = rows.filter((r) => r.draft?.placeholders && r.draft.placeholders.slice().sort().join(" ") !== requiredPlaceholders(m, r.key).slice().sort().join(" "));
  if (mismatch.length) {
    warn(`${mismatch.length} row(s) of ${DRAFT_FILE} list other placeholders than the language files use; the sheet keeps those of the language files:`);
    listCapped(mismatch, log, (r) => `  ${r.key}: ${DRAFT_FILE} ${r.draft.placeholders.join(" ") || "(none)"}, language files ${requiredPlaceholders(m, r.key).join(" ") || "(none)"}`);
  }
  const uneven = rows.filter((r) => !r.key.startsWith(LISTING_PREFIX)).filter((r) => {
    const sets = m.langs.flatMap((l) => (m.byLang.get(l).get(r.key) ?? []).filter((t) => typeof t.value === "string" && t.value.trim() && !isHumanPlaceholder(t.value)).map((t) => tokensOf(t.value).sort().join(" ")));
    return new Set(sets).size > 1;
  });
  if (uneven.length) {
    warn(`${uneven.length} key(s) use different placeholders in each language; the sheet asks for all of them:`);
    listCapped(uneven, log, (r) => `  ${r.key}`);
  }
  // Excel opens a cell that starts with = + - or @ as a formula and shows #NAME?.
  const formulas = [];
  table.slice(1).forEach((cells, i) => {
    header.forEach((h, c) => {
      if (c > 0 && !m.langs.includes(h) && FORMULA_START_RE.test(String(cells[c]))) formulas.push({ row: i + 2, column: h, key: cells[0] });
    });
  });
  if (formulas.length) {
    warn(`${formulas.length} cell(s) start with =, +, - or @, which Excel opens as a formula and shows as #NAME? (#${ch(0xbf)}NOMBRE?): read them in the language files or in ${DRAFT_FILE}, or open the sheet with Datos > Desde el texto/CSV:`);
    listCapped(formulas, log, (x) => `  row ${x.row}  ${x.column}  ${x.key}`);
  }
  if (m.mode === "signed") {
    const done = [...m.draft.byKey.keys()].filter((k) => !rows.some((r) => r.key === k && r.needs) && (k.startsWith(LISTING_PREFIX) ? m.listing.get(k.slice(LISTING_PREFIX.length))?.label === "signed" : m.langs.every((l) => langCell(m, l, k).label === "signed")));
    if (done.length) log(`info: ${done.length} row(s) of ${DRAFT_FILE} are for texts signed in every language: delete them`);
  }
  // The sheet holds people's drafts: it stays out of git, like the release ZIP.
  const inside = path.relative(root, target).split(path.sep).join("/");
  if (!inside.startsWith("..") && !path.isAbsolute(inside) && gitTry(root, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    if (gitTry(root, ["check-ignore", "-q", "--", inside]) === null) {
      const lines = /^textos-hoja[^/]*$/.test(inside) ? GITIGNORE_LINES : [`/${inside}`, GITIGNORE_LINES[1]];
      warn(`${inside} is not in .gitignore: add the lines ${lines.map((l) => `"${l}"`).join(" and ")} so no sheet (nor Excel's lock file) is ever committed`);
    }
  }
  log(
    `next: the people who write the texts ${m.draft.exists ? `read the rules in ${DRAFT_FILE} first, then ` : ""}fill in the ${m.langs.join(" and ")} column(s) themselves (never an AI, and never starting from an AI text) and their name in "${AUTHOR_COLUMN}", ` +
      `save the file as CSV UTF-8, then run: ${importCommand(hint, target)}`,
  );
  return { code: 0, file: target, rows: rows.length, header, warnings };
}

/* ----------------------------------------------------------------------------
 * import
 * -------------------------------------------------------------------------- */

/**
 * Every leaf string of a JSON text with its key path and the offsets of its
 * string token, so a value can be replaced without touching a byte around it.
 * Throws a SyntaxError that ends in "at <offset>" on text that is not JSON
 * (callers parse it first).
 * @param {string} text
 * @returns {{ path: string[], start: number, end: number, value: string, inArray: boolean }[]}
 */
export function jsonStringLeaves(text) {
  const out = [];
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const expect = (c) => {
    if (text[i] !== c) throw new SyntaxError(`expected ${c} at ${i}`);
    i++;
  };
  const str = () => {
    const start = i;
    expect('"');
    while (i < text.length && text[i] !== '"') i += text[i] === BACKSLASH ? 2 : 1;
    expect('"');
    try {
      return { start, end: i, value: JSON.parse(text.slice(start, i)) };
    } catch {
      throw new SyntaxError(`bad string at ${start}`);
    }
  };
  const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const value = (keyPath, inArray) => {
    ws();
    if (text[i] === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        const k = str();
        ws();
        expect(":");
        value([...keyPath, k.value], inArray);
        ws();
        if (text[i] === ",") i++;
        else return expect("}");
      }
    }
    if (text[i] === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (let n = 0; ; n++) {
        value([...keyPath, String(n)], true);
        ws();
        if (text[i] === ",") i++;
        else return expect("]");
      }
    }
    if (text[i] === '"') return void out.push({ path: keyPath, ...str(), inArray });
    literal.lastIndex = i;
    const m = literal.exec(text);
    if (!m) throw new SyntaxError(`unexpected character at ${i}`);
    i += m[0].length;
  };
  value([], false);
  ws();
  if (i !== text.length) throw new SyntaxError(`unexpected text at ${i}`);
  return out;
}

/** A JSON string token for `value`, in the file's own style: raw UTF-8, or every non-ASCII character escaped. */
function encodeJsonString(value, asciiOnly) {
  const s = JSON.stringify(value);
  return asciiOnly ? s.replace(/[^\x00-\x7f]/g, (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) : s;
}

/**
 * The file's text with the edited values, and nothing else, changed. A key is
 * every leaf string whose dotted path is that key (nested and dotted copies of
 * one Foundry key change together); module.json edits name a top-level field.
 * Two edits of one value are refused (import groups its cells by file and key
 * first, so this never happens). The result is checked by parsing it again:
 * every other value is unchanged.
 */
function applyEdits(f, edits) {
  const leaves = jsonStringLeaves(f.text);
  // A file written with every non-ASCII character escaped stays that way.
  const asciiOnly = !/[^\x00-\x7f]/.test(f.text) && leaves.some((l) => /[^\x00-\x7f]/.test(l.value));
  const reps = [];
  for (const e of edits) {
    const hits = leaves.filter((l) => !l.inArray && (e.field ? l.path.length === 1 && l.path[0] === e.field : l.path.join(".") === e.key));
    if (!hits.length) throw new Error(`text-sheet: internal error: no value for ${e.field ?? e.key} in ${f.rel}`);
    for (const h of hits) reps.push({ ...h, name: e.field ?? e.key, token: encodeJsonString(e.value, asciiOnly) });
  }
  reps.sort((a, b) => b.start - a.start);
  for (let k = 1; k < reps.length; k++) {
    if (reps[k].end > reps[k - 1].start) throw new TextSheetError(`two cells of the sheet write the same value of ${f.rel} (${reps[k].name}): nothing was written`);
  }
  let text = f.text;
  for (const r of reps) text = text.slice(0, r.start) + r.token + text.slice(r.end);

  const before = flattenLang(f.data);
  let after;
  try {
    after = flattenLang(JSON.parse(text));
  } catch {
    // Never V8's message: it would quote the file.
    throw new Error(`text-sheet: internal error: editing ${f.rel} would not leave valid JSON`);
  }
  const edited = new Map(edits.map((e) => [e.field ?? e.key, e.value]));
  const same = before.length === after.length && before.every(([k, v], n) => after[n][0] === k && JSON.stringify(after[n][1]) === JSON.stringify(edited.has(k) && typeof v === "string" ? edited.get(k) : v));
  if (!same) throw new Error(`text-sheet: internal error: editing ${f.rel} would change more than the edited values`);
  return Buffer.concat([f.bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(text, "utf8")]);
}

const lengthOf = (value) => [...value.replace(TOKEN_RE, "")].length;
const showSet = (list) => list.join(" ") || "(none)";

/**
 * Checks one language cell. Returns the reasons it is refused (empty: it is
 * accepted) and the warnings that do not refuse it.
 */
function checkCell(m, target, lang, value) {
  const reasons = [];
  const warnings = [];
  if (target.field) {
    const first = m.langs[0];
    if (lang !== first) return { reasons: [`module.json has one "${target.field}" for every language: write it in the ${first} column`], warnings };
    const t = m.listing.get(target.field);
    if (!t) return { reasons: [`module.json has no "${target.field}" text: the import never creates one`], warnings };
  } else {
    const list = m.byLang.get(lang).get(target.key) ?? [];
    const rels = m.entries.filter((e) => e.lang === lang).map((e) => e.rel);
    if (!list.length) return { reasons: [`is not a key of ${rels.join(", ")}: the import never creates keys; add it to every language file first`], warnings };
    if (list.some((t) => t.status === "list")) return { reasons: [`is a list in ${list[0].file}, not a text: edit it by hand`], warnings };
    if (list.some((t) => t.status === "conflict")) {
      return { reasons: [`is defined twice in ${list[0].file} (nested and dotted) with different values: keep one by hand first`], warnings };
    }
  }
  const trimmed = value.trim();
  if (!trimmed) reasons.push("holds only whitespace");
  else if (isHumanPlaceholder(value)) reasons.push('starts with "TODO-HUMANO:", the marker of a text nobody wrote');
  else if (SHEET_ERROR_RE.test(trimmed)) {
    reasons.push("is a spreadsheet error, not a text: the spreadsheet took what was typed for a formula (a text that starts with =, +, - or @); type it again in a cell formatted as text");
  }
  // Unreachable while both sheet decoders are fatal; kept so that a lenient
  // one could never write a value whose signature would not be its own.
  if (!value.isWellFormed()) reasons.push("holds a lone UTF-16 surrogate");
  const required = requiredPlaceholders(m, target.field ? LISTING_PREFIX + target.field : target.key);
  const got = tokensOf(value);
  const lacks = required.filter((p) => !got.includes(p));
  const extra = got.filter((p) => !required.includes(p));
  if (lacks.length || extra.length) {
    const parts = [lacks.length && `lacks ${lacks.join(" ")}`, extra.length && `has ${extra.join(" ")}, which the code does not fill in`].filter(Boolean);
    reasons.push(`${parts.join(" and ")}: it must keep exactly ${showSet(required)}`);
  }
  const max = m.draft.byKey.get(target.field ? LISTING_PREFIX + target.field : target.key)?.max ?? null;
  if (max !== null && lengthOf(value) > max) warnings.push(`is ${lengthOf(value)} characters long without its placeholders, over max_length ${max}`);
  if (trimmed && value !== trimmed) warnings.push("starts or ends with whitespace, which stays in the text");
  if (value.startsWith("'")) warnings.push("starts with an apostrophe, which stays in the text: if the spreadsheet kept the one typed to stop a conversion, delete it");
  if (NUMBER_OR_DATE_RE.test(trimmed)) warnings.push("is only a number or a date: check that the spreadsheet did not convert what was typed");
  return { reasons, warnings };
}

/**
 * Reads a sheet back into the module. The CLI wraps it; tests call it directly.
 * @param {{
 *   file: string, dir?: string, dryRun?: boolean, partial?: boolean, cwd?: string,
 *   log?: (line: string) => void, logError?: (line: string) => void, tool?: string, signTool?: string,
 * }} opts
 * @returns {Promise<{ code: number, written: number, unchanged: number, unsignedSame: number, rejected: number, files: string[] }>}
 *   `unsignedSame`: cells equal to a value that has no valid signature (nothing to write, nothing counted as unchanged)
 * @throws {TextSheetError}
 */
export async function importSheet({ file, dir = process.cwd(), dryRun = false, partial = false, cwd = process.cwd(), log = console.log, logError = console.error, tool = DEFAULT_COMMAND, signTool = SIGN_TOOL } = {}) {
  if (!file) throw new TextSheetError(`import needs the sheet: ${tool} import ${SHEET_FILE}`, { usage: true });
  const root = path.resolve(cwd, dir);
  const sheetPath = path.resolve(cwd, file);
  if (!fs.existsSync(sheetPath) || !fs.statSync(sheetPath).isFile()) throw new TextSheetError(`${file} does not exist`);
  const m = loadModule(root);
  const hint = { tool, signTool, cwd, root };
  const sheet = readSheet(fs.readFileSync(sheetPath), m.langs);
  if (!sheet.header || sheet.keyIdx < 0) {
    throw new TextSheetError(
      `${file} has no header row with a "key" column. If the rows were sorted, the header row went with them: undo the sort, or sort again with "Mis datos tienen encabezados" checked (Datos > Ordenar). import reads a sheet written by ${tool} export`,
    );
  }
  const byLangCol = new Map();
  for (const c of sheet.langCols) {
    if (byLangCol.has(c.lang)) throw new TextSheetError(`${file} has two "${c.lang}" columns: keep one`);
    byLangCol.set(c.lang, c);
  }
  if (!sheet.langCols.length) throw new TextSheetError(`${file} has no language column: the module declares ${m.langs.join(", ")}`);

  log(`text-sheet: ${m.module.id ?? path.basename(root)} (${root}) import ${relPath(cwd, sheetPath) || file}${dryRun ? " --dry-run" : ""}${partial ? " --partial" : ""}`);
  const notes = [];
  const rejects = [];
  const reject = (row, lang, key, reason) => rejects.push({ row, lang, key, reason });

  // A column import does not read loses whatever was typed in it: refused when it holds text.
  const ignored = [...sheet.notes];
  for (const u of sheet.unknown) {
    const rows = sheet.records.filter((r) => (r.fields[u.idx] ?? "").trim() !== "").map((r) => r.row);
    if (!rows.length) {
      if (u.name) ignored.push(u);
      continue;
    }
    reject(
      sheet.header.row,
      `column ${colName(u.idx)}`,
      u.name ? JSON.stringify(u.name) : "(no header)",
      `has text in ${rowWord(rows)}, but import reads only "key", "${AUTHOR_COLUMN}" and the language columns (${m.langs.join(", ")}): if it holds texts, name it by their language code; a column for your own notes is named "${NOTE_COLUMNS[0]}"`,
    );
  }
  ignored.sort((a, b) => a.idx - b.idx);
  if (ignored.length) notes.push(`column(s) ${ignored.map((c) => JSON.stringify(c.name)).join(", ")} ignored: only "key", "${AUTHOR_COLUMN}" and the language columns (${m.langs.join(", ")}) are read`);
  const missingCols = m.langs.filter((l) => !byLangCol.has(l));
  if (missingCols.length) notes.push(`no column for ${missingCols.join(", ")}: those texts stay as they are`);

  // Nothing written in any language cell: most likely not the file the person saved.
  if (!rejects.length && !sheet.records.some((r) => sheet.langCols.some((c) => (r.fields[c.idx] ?? "") !== ""))) {
    throw new TextSheetError(
      `no ${sheet.langCols.map((c) => c.lang).join(" or ")} cell of ${file} has text: is it the file you saved? ` +
        'Google Sheets saves its download in Downloads (Descargas) as "<spreadsheet> - <tab>.csv": pass that path, in quotes, ' +
        `as in ${tool} import "$HOME/Downloads/textos-hoja - textos-hoja.csv"; Excel writes the file only with Guardar como > "CSV UTF-8 (delimitado por comas)"`,
    );
  }

  /** @type {{ row: number, lang: string, key: string, value: string, target: object, author: string, warnings: string[] }[]} */
  const cells = [];
  for (const r of sheet.records) {
    const key = (r.fields[sheet.keyIdx] ?? "").trim();
    for (const c of sheet.currentCols) {
      const cell = (r.fields[c.idx] ?? "").replace(/\r\n?/g, "\n");
      const target = key.startsWith(LISTING_PREFIX) ? m.listing.get(key.slice(LISTING_PREFIX.length)) : null;
      const expected = target ? (c.lang === m.langs[0] ? shownValue([target]) : "") : m.byLang.has(c.lang) ? langCell(m, c.lang, key).shown : "";
      if (cell !== "" && cell !== expected) notes.push(`row ${r.row}: the ${CURRENT_PREFIX}${c.lang} cell was edited; import reads only the ${c.lang} column`);
    }
    const filled = sheet.langCols.filter((c) => (r.fields[c.idx] ?? "") !== "");
    if (!filled.length) continue;
    if (!key) {
      for (const c of filled) reject(r.row, c.lang, "(no key)", "the row has text but its key cell is empty");
      continue;
    }
    let target = null;
    if (key.startsWith(LISTING_PREFIX)) {
      const field = key.slice(LISTING_PREFIX.length);
      if (LISTING_FIELDS.includes(field)) target = { field };
    } else if (m.keys.includes(key)) target = { key };
    if (!target) {
      for (const c of filled) reject(r.row, c.lang, key, "is not a key of the language files: the import never creates keys");
      continue;
    }
    const author = sheet.authorIdx < 0 ? "" : (r.fields[sheet.authorIdx] ?? "").trim();
    for (const c of filled) {
      const value = r.fields[c.idx].replace(/\r\n?/g, "\n");
      const { reasons, warnings } = checkCell(m, target, c.lang, value);
      if (reasons.length) for (const reason of reasons) reject(r.row, c.lang, key, reason);
      else cells.push({ row: r.row, lang: c.lang, key, value, target, author, warnings });
    }
  }

  // Cells are grouped by the value they write, file and key: two language
  // columns may share one file. Two different texts for one value are both
  // refused; the same text twice is written once.
  const textsFor = (c) => (c.target.field ? [m.listing.get(c.target.field)] : m.byLang.get(c.lang).get(c.key));
  const idsOf = (c) => [...new Set(textsFor(c).map((t) => `${t.file}\n${c.target.field ?? c.key}`))];
  const groups = new Map();
  for (const c of cells) {
    for (const id of idsOf(c)) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(c);
    }
  }
  const clash = new Map();
  for (const [id, group] of groups) {
    if (new Set(group.map((c) => c.value)).size < 2) continue;
    const rows = [...new Set(group.map((c) => c.row))];
    const langs = [...new Set(group.map((c) => c.lang))];
    const reason =
      langs.length > 1
        ? `the ${langs.join(" and ")} columns both write it in ${id.split("\n")[0]}, with different texts (${rowWord(rows)}): keep one`
        : `rows ${rows.join(", ")} give it different texts: keep one`;
    for (const c of group) if (!clash.has(c)) clash.set(c, reason);
  }
  for (const [c, reason] of clash) reject(c.row, c.lang, c.key, reason);
  for (const group of groups.values()) {
    if (group.length < 2 || group.some((c) => clash.has(c))) continue;
    const rows = [...new Set(group.map((c) => c.row))];
    const note = `${rowWord(rows)} give${rows.length === 1 ? "s" : ""} ${group[0].key} (${[...new Set(group.map((c) => c.lang))].join(", ")}) the same text: written once`;
    if (!notes.includes(note)) notes.push(note);
  }
  rejects.sort((a, b) => a.row - b.row || a.lang.localeCompare(b.lang));

  // What changes, file by file. A text equal to its current value changes
  // nothing: unchanged when that value is signed (or there is no lock), and
  // reported apart when it has no valid signature (the working text copied
  // into the sheet, or a text imported before and not signed yet).
  const claimed = new Set();
  const edits = new Map();
  const changes = [];
  const same = [];
  let unchanged = 0;
  for (const c of cells) {
    if (clash.has(c)) continue;
    const fresh = idsOf(c).filter((id) => !claimed.has(id));
    if (!fresh.length) continue;
    for (const id of fresh) claimed.add(id);
    const texts = textsFor(c).filter((t) => fresh.includes(`${t.file}\n${c.target.field ?? c.key}`));
    if (texts.every((t) => t.value === c.value)) {
      if (m.mode === "signed" && texts.some((t) => t.status !== "signed")) same.push({ ...c, rels: [...new Set(texts.map((t) => t.file))] });
      else unchanged++;
      continue;
    }
    const rels = [...new Set(texts.map((t) => t.file))];
    for (const rel of rels) {
      if (!edits.has(rel)) edits.set(rel, []);
      edits.get(rel).push(c.target.field ? { field: c.target.field, value: c.value } : { key: c.key, value: c.value });
    }
    changes.push({ ...c, rels, was: texts.every((t) => t.status === "signed") ? "signed" : texts[0].label });
  }

  for (const c of cells.filter((x) => x.warnings.length && !clash.has(x))) for (const w of c.warnings) log(`warn: row ${c.row}  ${c.lang}  ${c.key}: ${w}`);
  for (const c of same) {
    log(
      `warn: row ${c.row}  ${c.lang}  ${c.key}: is already the value in ${c.rels.join(", ")}, which has no valid signature: nothing to write. ` +
        `If a person wrote these words (in an earlier import, or the same words by chance), that person signs it with sign-text; if they were copied from ${c.rels.join(", ")}, they are the AI working text: write it again from scratch`,
    );
  }
  for (const w of bomWarnings(m)) log(`warn: ${w}`);
  for (const n of notes) log(`note: ${n}`);
  const result = { code: rejects.length ? 1 : 0, written: 0, unchanged, unsignedSame: same.length, rejected: rejects.length, files: [] };
  if (rejects.length) {
    logError(`text-sheet: ${rejects.length} cell(s) refused:`);
    for (const x of rejects) logError(`  row ${x.row}  ${x.lang}  ${x.key}: ${x.reason}`);
    if (!partial) {
      logError(`text-sheet: nothing written: fix those cells in the sheet and import it again, or pass --partial to write the ${changes.length} valid change(s) and leave these out`);
      return result;
    }
  }

  const showChange = (c) => {
    // Through the leak guard: an old value shows only when it was signed.
    const shown = shownValue(c.target.field ? [m.listing.get(c.target.field)] : m.byLang.get(c.lang).get(c.key));
    const old = shown ? ` (replaces the signed text ${JSON.stringify(shown)})` : ` (was ${c.was})`;
    return `  row ${c.row}  ${c.lang}  ${c.key} -> ${c.rels.join(", ")}: ${JSON.stringify(c.value)}${old}`;
  };
  // Who wrote what: the author column, written nowhere, so each author knows what to sign.
  const byAuthor = () => {
    if (!changes.some((c) => c.author)) return;
    const groupsBy = new Map();
    for (const c of changes) {
      const name = c.author || "(no author)";
      if (!groupsBy.has(name)) groupsBy.set(name, []);
      if (!groupsBy.get(name).includes(c.row)) groupsBy.get(name).push(c.row);
    }
    log("by author (import writes it nowhere; sign-text --sheet asks about each row for its author, and records it with the signature):");
    const names = [...groupsBy.keys()].filter((n) => n !== "(no author)");
    for (const name of [...names, ...(groupsBy.has("(no author)") ? ["(no author)"] : [])]) log(`  ${name}: ${rowWord(groupsBy.get(name))}`);
  };
  const tail = `${unchanged} unchanged${same.length ? `, ${same.length} already there without a signature` : ""}`;
  if (dryRun) {
    log(`text-sheet: --dry-run: would write ${changes.length} text(s)${changes.length ? ` to ${[...edits.keys()].join(", ")}` : ""}, ${tail}; nothing written`);
    for (const c of changes) log(showChange(c));
    byAuthor();
    return result;
  }

  if (changes.length) {
    const writes = [...edits.entries()].map(([rel, list]) => {
      const f = rel === "module.json" ? m.moduleFile : m.files.get(rel);
      return { file: f.file, rel, before: f.buf, after: applyEdits(f, list) };
    });
    await writeAll(writes);
    result.files = writes.map((w) => w.rel);
  }
  result.written = changes.length;
  log(`text-sheet: wrote ${changes.length} text(s)${changes.length ? ` to ${result.files.join(", ")}` : ""}, ${tail}${rejects.length ? `, ${rejects.length} refused (left out with --partial)` : ""}; ${HUMAN_TEXT_FILE} untouched`);
  for (const c of changes) log(showChange(c));
  const resigned = changes.filter((c) => c.was === "signed").length;
  if (resigned) log(`info: ${resigned} of them replace a signed text: its signature no longer matches`);
  byAuthor();
  if (changes.length) {
    log(
      "next: the person who attests the texts (BaronHVC) signs them at a terminal before the next export, answering for the author of each row " +
        `(no pipe, no redirection): ${sheetSignCommand(hint, sheetPath)}`,
    );
  }
  return result;
}

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, positional: [], out: null, all: false, dryRun: false, partial: false };
  const usage = (message) => new TextSheetError(message, { usage: true });
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (command === "export" && a === "--out") {
      opts.out = rest[++i];
      if (!opts.out) throw usage("--out needs a file name");
    } else if (command === "export" && a.startsWith("--out=")) opts.out = a.slice(6);
    else if (command === "export" && a === "--all") opts.all = true;
    else if (command === "import" && a === "--dry-run") opts.dryRun = true;
    else if (command === "import" && a === "--partial") opts.partial = true;
    else if (a.startsWith("-")) throw usage(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  const most = command === "export" ? 1 : 2;
  if (opts.positional.length > most) throw usage(`unexpected argument ${opts.positional[most]}`);
  return opts;
}

/** How the person ran text-sheet, and so sign-text next to it, from the current folder: for the hints. */
function commandsRun() {
  const script = process.argv[1];
  if (!script) return {};
  const run = (file) => `node ${quote(relPath(process.cwd(), file) || file)}`;
  return { tool: run(script), signTool: run(path.join(path.dirname(script), "sign-text.mjs")) };
}

async function main(argv) {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    (argv.length ? console.log : console.error)(USAGE);
    return argv.length ? 0 : 1;
  }
  try {
    if (!["export", "import"].includes(argv[0])) throw new TextSheetError(`unknown command ${argv[0]}`, { usage: true });
    const opts = parseArgs(argv);
    if (opts.command === "export") {
      return (await exportSheet({ dir: opts.positional[0] ?? ".", out: opts.out ?? undefined, all: opts.all, ...commandsRun() })).code;
    }
    const [file, dir] = opts.positional;
    return (await importSheet({ file, dir: dir ?? ".", dryRun: opts.dryRun, partial: opts.partial, ...commandsRun() })).code;
  } catch (err) {
    if (err instanceof TextSheetError) {
      console.error(`text-sheet: ERROR: ${err.message}${err.usage ? `\n${USAGE}` : ""}`);
      return 1;
    }
    throw err;
  }
}

// Imported by the tests, run by a person: only the latter parses argv.
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
