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
// per text: by default only those that still need a person (the texts that
// sign-text and check-module [n] report; with baron.json "humanText" absent
// or "markers", those that start with TODO-HUMANO: or are empty), with --all
// every text of the declared languages plus the module.json title and
// description. Columns: key, where, intent, placeholders, max_length, status,
// one empty column per language and one current_<lang> column per language.
// A current_<lang> cell holds a value only when its signature is valid: the
// sheet never shows an AI working text, so nobody starts from one.
//
// import reads that CSV back as Excel or Google Sheets save it (with or
// without a BOM, UTF-16 too; comma, semicolon or tab; CRLF or LF; columns in
// any order, matched by name) and writes each filled language cell into its
// lang file, or into module.json for the title and description rows. A cell is
// refused when its key is not in that language file (the tool never creates a
// key), when its {placeholders} differ from the ones the text must keep, when
// it starts with TODO-HUMANO: or holds only whitespace; over max_length it
// only warns. One refused cell and nothing is written, unless --partial;
// --dry-run writes nothing and shows what would change. Only the edited
// values change in each file, byte for byte, through a temporary file and a
// rename. It never touches human-text.json and never signs: the authors sign
// what they wrote, each at a terminal, with sign-text --sign.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUMAN_TEXT_FILE,
  LISTING_FIELDS,
  flattenLang,
  gitTry,
  humanTexts,
  i18nRefs,
  isHumanPlaceholder,
  languageEntries,
  ownScripts,
  readSignatures,
  signatureStatus,
} from "./shared.mjs";
import { DEFAULT_COMMAND as SIGN_COMMAND } from "./sign-text.mjs";

const USAGE = [
  "usage: node text-sheet.mjs export [moduleDir] [--out <file.csv>] [--all]",
  "       node text-sheet.mjs import <file.csv> [moduleDir] [--dry-run] [--partial]",
].join("\n");

/** How the tool is run from the module folder, as the docs write it. */
export const DEFAULT_COMMAND = "node ../pf2e-baron-core/tools/text-sheet.mjs";
/** Where export writes by default, at the module root; modules list it in .gitignore. */
export const SHEET_FILE = "textos-hoja.csv";
/** The intent of each text, written by the agent that wrote the working text. */
export const DRAFT_FILE = "docs/textos-borrador.md";
/** The columns before the language columns, in this order. */
export const FIXED_COLUMNS = ["key", "where", "intent", "placeholders", "max_length", "status"];
/** current_<lang>: the signed value, the only value the sheet ever shows. */
export const CURRENT_PREFIX = "current_";
/** Key of a module.json listing field in the sheet: "module.json:title". */
export const LISTING_PREFIX = "module.json:";
/** What the release ZIP packs (module-release.yml): the sheet never goes there. */
export const PACKED_PATHS = ["module.json", "scripts", "styles", "templates", "lang", "packs", "LICENSE", "NOTICE.md"];

// Built from char codes so this file stays ASCII.
const BOM = String.fromCharCode(0xfeff);
const BACKSLASH = String.fromCharCode(92);
// game.i18n.format() replaces every match of this with the named value.
const TOKEN_RE = /{[^}]+}/g;
const DELIMITERS = [",", ";", "\t"];
// Lists in the output stop after this many lines, as check-module caps its own.
const CAP = 10;
// On Windows an editor, Excel or a sync client may hold a file for a moment.
const RENAME_RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 200;

/** A problem with the module or the sheet that stops the tool (exit 1), never a crash. */
export class TextSheetError extends Error {}

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

const NOT_UTF8 =
  'is not UTF-8 text. In Excel save it with "Guardar como" > "CSV UTF-8 (delimitado por comas)" (or "Texto Unicode"): plain "CSV (delimitado por comas)" uses the Windows code page and has already turned every character it lacks into "?". In Google Sheets: Archivo > Descargar > "Valores separados por comas (.csv)"';

/**
 * The text of a saved sheet: UTF-8 with or without a BOM, or UTF-16 with its
 * BOM (Excel's "Texto Unicode"). Anything else is refused, never guessed.
 * @param {Buffer|Uint8Array} buf
 * @returns {string} without the BOM
 */
export function decodeSheet(buf) {
  const b = Buffer.from(buf);
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
    try {
      if (b.length % 2) throw new TypeError("odd length");
      const body = Buffer.from(b.subarray(2));
      if (b[0] === 0xfe) body.swap16();
      return new TextDecoder("utf-16le", { fatal: true }).decode(body);
    } catch {
      throw new TextSheetError("the sheet starts like UTF-16 text but is not valid UTF-16: save it again from the spreadsheet");
    }
  }
  try {
    const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b.subarray(bom ? 3 : 0));
  } catch {
    throw new TextSheetError(`the sheet ${NOT_UTF8}`);
  }
}

/** The delimiter the first record uses most outside quotes: a tie goes to the comma, then the semicolon. */
function detectDelimiter(s) {
  const count = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && count.has(c)) count.set(c, count.get(c) + 1);
  }
  return DELIMITERS.reduce((best, d) => (count.get(d) > count.get(best) ? d : best), ",");
}

/**
 * Records of a CSV text, leniently, as Excel and Google Sheets save them:
 * the delimiter is the comma, semicolon or tab that the header row uses most
 * (Excel saves with the list separator of the Windows region), or the one an
 * Excel "sep=;" first line names; a quoted field may hold the delimiter,
 * newlines and doubled quotes; a record ends in CRLF, LF or CR.
 * @param {string} text
 * @returns {{ delimiter: string, records: { row: number, fields: string[] }[] }}
 *   `row` is the row number a spreadsheet shows (the header is row 1)
 */
export function csvParse(text) {
  let s = text.startsWith(BOM) ? text.slice(1) : text;
  let delimiter = null;
  const hint = /^sep=([,;\t])(?:\r\n|\n|\r|$)/i.exec(s);
  if (hint) {
    delimiter = hint[1];
    s = s.slice(hint[0].length);
  }
  delimiter ??= detectDelimiter(s);

  const records = [];
  let fields = [];
  let field = "";
  let quoted = false; // this field started with a quote
  let open = false; // inside the quotes
  let row = 1;
  let openedAt = 1;
  const endField = () => {
    fields.push(field);
    field = "";
    quoted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ row, fields });
    fields = [];
    row++;
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (open) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (c === '"') {
        open = false;
        i++;
      } else {
        field += c;
        i++;
      }
    } else if (c === '"' && field === "" && !quoted) {
      open = quoted = true;
      openedAt = row;
      i++;
    } else if (c === delimiter) {
      endField();
      i++;
    } else if (c === "\r" || c === "\n") {
      endRecord();
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (open) throw new TextSheetError(`the quote that opens a cell in row ${openedAt} never closes: the sheet is cut short or was not saved as CSV`);
  if (field !== "" || quoted || fields.length) endRecord();
  return { delimiter, records };
}

/* ----------------------------------------------------------------------------
 * docs/textos-borrador.md
 * -------------------------------------------------------------------------- */

// Header names compare without accents, case or punctuation: "Max." (with
// its accent) is "max".
const fold = (s) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const DRAFT_ROLES = [
  ["key", /^(?:clave|key)\b/],
  ["where", /^(?:donde|where)\b/],
  ["intent", /^(?:intencion|que comunica|intent|proposito)\b/],
  ["placeholders", /^(?:variables?|marcadores?|placeholders?)\b/],
  ["max", /^(?:max|maximo|largo|longitud)\b/],
];
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
 * @param {string} text
 * @returns {{ key: string, line: number, where: string, intent: string, placeholders: string[]|null, max: number|null }[]}
 *   `placeholders` is null without a variables column; `max` is null without a number
 */
export function parseDraft(text) {
  const src = (text.startsWith(BOM) ? text.slice(1) : text)
    .replace(/\r\n?/g, "\n")
    // An HTML comment is not shown; blanked line by line, so line numbers stay.
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const lines = src.split("\n");
  const rows = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence || !line.trim().startsWith("|") || !DELIMITER_ROW_RE.test(lines[i + 1] ?? "")) continue;
    const roles = {};
    splitRow(line).forEach((h, idx) => {
      const role = DRAFT_ROLES.find(([, re]) => re.test(fold(h)))?.[0];
      if (role && roles[role] === undefined) roles[role] = idx;
    });
    i += 2;
    for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
      if (roles.key === undefined) continue;
      const cells = splitRow(lines[i]);
      const cell = (role) => (roles[role] === undefined ? "" : (cells[roles[role]] ?? ""));
      const placeholders = roles.placeholders === undefined ? null : tokensOf(cell("placeholders"));
      const max = /\d+/.exec(cell("max"));
      for (const key of cellKeys(cell("key"))) {
        rows.push({ key, line: i + 1, where: cell("where"), intent: cell("intent"), placeholders, max: max ? Number(max[0]) : null });
      }
    }
    i--;
  }
  return rows;
}

/* ----------------------------------------------------------------------------
 * The module
 * -------------------------------------------------------------------------- */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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
    throw new TextSheetError(`${rel} is not valid JSON: ${err.message}`);
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

/**
 * Status of one text. With "humanText": "signed", the signature status
 * (sign-text and check-module [n]); otherwise the marker rule of [n]: a text
 * that starts with TODO-HUMANO: (or is empty) is still to write.
 */
function labelOf(t, mode) {
  if (mode === "signed") return SIGNED_LABELS[t.status];
  if (t.status === "list" || t.status === "conflict") return t.status;
  return !t.value.trim() || isHumanPlaceholder(t.value) ? "to write" : "written";
}

/** Whether a text needs a person: what sign-text and check-module [n] report, by mode. */
const needsPerson = (label, mode) => (mode === "signed" ? label !== "signed" && label !== "missing" : label === "to write");

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
  const bad = langs.find((l) => !l || /[\s,;"]/.test(l) || l.toLowerCase().startsWith(CURRENT_PREFIX) || FIXED_COLUMNS.includes(l.toLowerCase()));
  if (bad !== undefined) throw new TextSheetError(`the language code ${JSON.stringify(bad)} cannot name a column of the sheet`);
  const files = new Map();
  for (const { rel } of entries) if (!files.has(rel)) files.set(rel, readJsonFile(root, rel));

  const read = readSignatures(root);
  if (read.error) throw new TextSheetError(`${HUMAN_TEXT_FILE} ${read.error}: restore it from git`);
  const texts = signatureStatus(
    humanTexts(module, [...files.values()].map((f) => ({ rel: f.rel, data: f.data }))),
    read.signed,
  ).map((t) => ({ ...t, label: labelOf(t, mode) }));

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

  return { root, module, moduleFile, mode, rawMode: raw, prefix, langs, entries, files, texts, byLang, keys, listing, whereUsed, missingSignatures: !!read.missing, draft: loadDraft(root, { prefix, keys, listing }) };
}

/** The draft rows matched to the module's keys, and what does not match. */
function loadDraft(root, { prefix, keys, listing }) {
  const out = { exists: false, byKey: new Map(), unknown: [], duplicates: [] };
  const file = path.join(root, DRAFT_FILE);
  if (!fs.existsSync(file)) return out;
  out.exists = true;
  const known = new Set(keys);
  for (const row of parseDraft(fs.readFileSync(file, "utf8"))) {
    let key = null;
    if (row.key.startsWith(LISTING_PREFIX)) {
      const field = row.key.slice(LISTING_PREFIX.length);
      if (listing.has(field)) key = row.key;
    } else if (known.has(row.key)) key = row.key;
    else if (prefix && known.has(`${prefix}.${row.key}`)) key = `${prefix}.${row.key}`;
    if (key === null) out.unknown.push(row);
    else if (out.byKey.has(key)) out.duplicates.push({ ...row, first: out.byKey.get(key).line });
    else out.byKey.set(key, row);
  }
  return out;
}

/** One language cell of a key: its status, its shown value (signed only) and its texts. */
function langCell(m, lang, key) {
  const list = m.byLang.get(lang).get(key) ?? [];
  if (!list.length) return { label: "missing", shown: "", list };
  const open = list.find((t) => t.label !== "signed" && t.label !== "written");
  return { label: (open ?? list[0]).label, shown: shownValue(list), list };
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

/** The sheet's rows for the module: the module.json listing fields first, then every key in file order. */
function sheetRows(m, all) {
  const rows = [];
  const first = m.langs[0];
  for (const field of LISTING_FIELDS) {
    const t = m.listing.get(field);
    if (!t) continue;
    const key = LISTING_PREFIX + field;
    if (!all && !needsPerson(t.label, m.mode)) continue;
    const draft = m.draft.byKey.get(key);
    const where = [`module.json "${field}": one text for every language, written in the ${first} column`, draft?.where].filter(Boolean).join("\n");
    rows.push({
      key,
      where,
      draft,
      status: t.label,
      needs: needsPerson(t.label, m.mode),
      current: Object.fromEntries(m.langs.map((l) => [l, l === first ? shownValue([t]) : ""])),
    });
  }
  for (const key of m.keys) {
    const cells = Object.fromEntries(m.langs.map((l) => [l, langCell(m, l, key)]));
    const needs = m.langs.some((l) => needsPerson(cells[l].label, m.mode));
    if (!all && !needs) continue;
    const labels = m.langs.map((l) => cells[l].label);
    const status = new Set(labels).size === 1 ? labels[0] : m.langs.map((l, i) => `${l}: ${labels[i]}`).join("; ");
    const draft = m.draft.byKey.get(key);
    const where = [draft?.where, m.whereUsed(key).join(", ")].filter(Boolean).join("\n");
    rows.push({ key, where, draft, status, needs, current: Object.fromEntries(m.langs.map((l) => [l, cells[l].shown])) });
  }
  return rows;
}

const listCapped = (items, log, fmt) => {
  for (const x of items.slice(0, CAP)) log(fmt(x));
  if (items.length > CAP) log(`  and ${items.length - CAP} more`);
};

const showKey = (k) => JSON.stringify(k);

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

/** Whether the module already holds `value` as the text of `key` in `lang` (or as a listing field). */
function holds(m, key, lang, value) {
  if (key.startsWith(LISTING_PREFIX)) return m.listing.get(key.slice(LISTING_PREFIX.length))?.value === value;
  const list = m.byLang.get(lang)?.get(key) ?? [];
  return list.length > 0 && list.every((t) => t.value === value);
}

/** Why the sheet cannot be written at `target`, or null. */
function outProblem(m, target) {
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
  // An existing sheet may hold texts nobody imported yet: never overwrite
  // those. One whose every written cell is already in the module was imported.
  let sheet;
  try {
    sheet = readSheet(fs.readFileSync(target), m.langs);
  } catch {
    return `${target} exists and is not a text sheet: choose another --out`;
  }
  if (sheet.keyIdx < 0) return `${target} exists and is not a text sheet: choose another --out`;
  const pending = sheet.records.find((r) =>
    sheet.langCols.some((c) => {
      const cell = (r.fields[c.idx] ?? "").replace(/\r\n?/g, "\n");
      return cell !== "" && !holds(m, (r.fields[sheet.keyIdx] ?? "").trim(), c.lang, cell);
    }),
  );
  if (pending) {
    return `${target} holds written texts that are not in the module yet (row ${pending.row}): import it first (${DEFAULT_COMMAND} import ${path.basename(target)}), or move it away`;
  }
  return null;
}

/**
 * Writes the sheet. The CLI wraps it; tests call it directly.
 * @param {{ dir?: string, out?: string, all?: boolean, cwd?: string, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ code: number, file: string, rows: number, header: string[], warnings: number }>}
 * @throws {TextSheetError}
 */
export async function exportSheet({ dir = process.cwd(), out, all = false, cwd = process.cwd(), log = console.log } = {}) {
  const root = path.resolve(cwd, dir);
  const m = loadModule(root);
  const target = out ? path.resolve(cwd, out) : path.join(root, SHEET_FILE);
  const problem = outProblem(m, target);
  if (problem) throw new TextSheetError(problem);

  const rows = sheetRows(m, all);
  const header = [...FIXED_COLUMNS, ...m.langs, ...m.langs.map((l) => CURRENT_PREFIX + l)];
  const table = [
    header,
    ...rows.map((r) => [
      r.key,
      r.where,
      r.draft?.intent ?? "",
      requiredPlaceholders(m, r.key).join(" "),
      r.draft?.max ?? "",
      r.status,
      ...m.langs.map(() => ""),
      ...m.langs.map((l) => r.current[l]),
    ]),
  ];
  await writeAll([{ file: target, rel: path.basename(target), before: fs.existsSync(target) ? fs.readFileSync(target) : null, after: Buffer.from(csvWrite(table), "utf8") }]);

  const relOut = path.relative(cwd, target).split(path.sep).join("/") || target;
  log(`text-sheet: ${m.module.id ?? path.basename(root)} (${root}) export${all ? " --all" : ""}`);
  if (m.mode === "markers") {
    log('note: baron.json does not say "humanText": "signed": a text needs a person when it starts with TODO-HUMANO: or is empty (check-module [n])');
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
  const noIntent = rows.filter((r) => r.needs && !r.draft);
  if (!m.draft.exists) {
    if (noIntent.length) warn(`there is no ${DRAFT_FILE}: the intent column is empty for all ${noIntent.length} row(s) that need a person`);
  } else if (noIntent.length) {
    warn(`${noIntent.length} row(s) that need a person have no row in ${DRAFT_FILE}, so their intent is empty:`);
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
  const mismatch = rows.filter((r) => r.draft?.placeholders && tokensOf(r.draft.placeholders.join(" ")).sort().join(" ") !== requiredPlaceholders(m, r.key).slice().sort().join(" "));
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
  if (m.mode === "signed") {
    const done = [...m.draft.byKey.keys()].filter((k) => !rows.some((r) => r.key === k && r.needs) && (k.startsWith(LISTING_PREFIX) ? m.listing.get(k.slice(LISTING_PREFIX.length))?.label === "signed" : m.langs.every((l) => langCell(m, l, k).label === "signed")));
    if (done.length) log(`info: ${done.length} row(s) of ${DRAFT_FILE} are for texts signed in every language: delete them`);
  }
  // The sheet holds people's drafts: it stays out of git, like the release ZIP.
  const inside = path.relative(root, target).split(path.sep).join("/");
  if (!inside.startsWith("..") && !path.isAbsolute(inside) && gitTry(root, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    if (gitTry(root, ["check-ignore", "-q", "--", inside]) === null) {
      warn(`${inside} is not in .gitignore: add a line "${inside === SHEET_FILE ? SHEET_FILE : `/${inside}`}" so the sheet is never committed`);
    }
  }
  log(
    `next: the people who write the texts fill in the ${m.langs.join(" and ")} column(s) themselves (never an AI, and never starting from an AI text), ` +
      `save the file as CSV UTF-8, then run: ${DEFAULT_COMMAND} import ${relOut}`,
  );
  return { code: 0, file: target, rows: rows.length, header, warnings };
}

/* ----------------------------------------------------------------------------
 * import
 * -------------------------------------------------------------------------- */

/**
 * A saved sheet: its records and where its columns are, by header name (case
 * and surrounding spaces do not matter): "key", one column per language of
 * `langs` and their current_<lang> columns. The header is the first record
 * that is not empty; every other column is ignored.
 */
function readSheet(buf, langs) {
  const { delimiter, records } = csvParse(decodeSheet(buf));
  const blank = (r) => r.fields.every((f) => !f.trim());
  const at = records.findIndex((r) => !blank(r));
  if (at < 0) return { delimiter, records: [], keyIdx: -1, langCols: [], currentCols: [], unknown: [], header: null };
  const header = records[at];
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const langOf = (name) => langs.find((l) => l.toLowerCase() === name);
  const langCols = [];
  const currentCols = [];
  const unknown = [];
  names.forEach((name, idx) => {
    if (!name || FIXED_COLUMNS.includes(name)) return;
    const lang = langOf(name);
    const cur = name.startsWith(CURRENT_PREFIX) ? langOf(name.slice(CURRENT_PREFIX.length)) : undefined;
    if (lang) langCols.push({ lang, idx });
    else if (cur) currentCols.push({ lang: cur, idx });
    else unknown.push(header.fields[idx].trim());
  });
  return { delimiter, records: records.slice(at + 1), keyIdx: names.indexOf("key"), langCols, currentCols, unknown, header };
}

/**
 * Every leaf string of a JSON text with its key path and the offsets of its
 * string token, so a value can be replaced without touching a byte around it.
 * Throws on text that is not JSON (callers parse it first).
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
    return { start, end: i, value: JSON.parse(text.slice(start, i)) };
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
    if (!m) throw new SyntaxError(`unexpected ${JSON.stringify(text[i])} at ${i}`);
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
 * The result is checked by parsing it again: every other value is unchanged.
 */
function applyEdits(f, edits) {
  const leaves = jsonStringLeaves(f.text);
  // A file written with every non-ASCII character escaped stays that way.
  const asciiOnly = !/[^\x00-\x7f]/.test(f.text) && leaves.some((l) => /[^\x00-\x7f]/.test(l.value));
  const reps = [];
  for (const e of edits) {
    const hits = leaves.filter((l) => !l.inArray && (e.field ? l.path.length === 1 && l.path[0] === e.field : l.path.join(".") === e.key));
    if (!hits.length) throw new Error(`text-sheet: internal error: no value for ${e.field ?? e.key} in ${f.rel}`);
    for (const h of hits) reps.push({ ...h, token: encodeJsonString(e.value, asciiOnly) });
  }
  reps.sort((a, b) => b.start - a.start);
  let text = f.text;
  for (const r of reps) text = text.slice(0, r.start) + r.token + text.slice(r.end);

  const before = flattenLang(f.data);
  const after = flattenLang(JSON.parse(text));
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
  if (!value.trim()) reasons.push("holds only whitespace");
  else if (isHumanPlaceholder(value)) reasons.push('starts with "TODO-HUMANO:", the marker of a text nobody wrote');
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
  if (value.trim() && value !== value.trim()) warnings.push("starts or ends with whitespace, which stays in the text");
  return { reasons, warnings };
}

/**
 * Reads a sheet back into the module. The CLI wraps it; tests call it directly.
 * @param {{
 *   file: string, dir?: string, dryRun?: boolean, partial?: boolean, cwd?: string,
 *   log?: (line: string) => void, logError?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ code: number, written: number, unchanged: number, rejected: number, files: string[] }>}
 * @throws {TextSheetError}
 */
export async function importSheet({ file, dir = process.cwd(), dryRun = false, partial = false, cwd = process.cwd(), log = console.log, logError = console.error } = {}) {
  if (!file) throw new TextSheetError(`import needs the sheet: ${DEFAULT_COMMAND} import ${SHEET_FILE}`);
  const root = path.resolve(cwd, dir);
  const sheetPath = path.resolve(cwd, file);
  if (!fs.existsSync(sheetPath) || !fs.statSync(sheetPath).isFile()) throw new TextSheetError(`${file} does not exist`);
  const m = loadModule(root);
  const sheet = readSheet(fs.readFileSync(sheetPath), m.langs);
  if (!sheet.header || sheet.keyIdx < 0) throw new TextSheetError(`${file} has no "key" column: import reads a sheet written by ${DEFAULT_COMMAND} export`);
  const byLangCol = new Map();
  for (const c of sheet.langCols) {
    if (byLangCol.has(c.lang)) throw new TextSheetError(`${file} has two "${c.lang}" columns: keep one`);
    byLangCol.set(c.lang, c);
  }
  if (!sheet.langCols.length) throw new TextSheetError(`${file} has no language column: the module declares ${m.langs.join(", ")}`);

  log(`text-sheet: ${m.module.id ?? path.basename(root)} (${root}) import ${path.relative(cwd, sheetPath).split(path.sep).join("/") || file}${dryRun ? " --dry-run" : ""}${partial ? " --partial" : ""}`);
  const notes = [];
  if (sheet.unknown.length) notes.push(`column(s) ${sheet.unknown.map((n) => JSON.stringify(n)).join(", ")} ignored: only "key" and the language columns (${m.langs.join(", ")}) are read`);
  const missingCols = m.langs.filter((l) => !byLangCol.has(l));
  if (missingCols.length) notes.push(`no column for ${missingCols.join(", ")}: those texts stay as they are`);

  /** @type {{ row: number, lang: string, key: string, value: string, target: object, warnings: string[] }[]} */
  const cells = [];
  const rejects = [];
  const reject = (row, lang, key, reason) => rejects.push({ row, lang, key, reason });
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
    for (const c of filled) {
      const value = r.fields[c.idx].replace(/\r\n?/g, "\n");
      const { reasons, warnings } = checkCell(m, target, c.lang, value);
      if (reasons.length) for (const reason of reasons) reject(r.row, c.lang, key, reason);
      else cells.push({ row: r.row, lang: c.lang, key, value, target, warnings });
    }
  }

  // The same text twice: once is enough; two different texts are both refused.
  const accepted = [];
  const groups = new Map();
  for (const c of cells) {
    const id = `${c.lang}\n${c.key}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(c);
  }
  for (const group of groups.values()) {
    const rowsOf = group.map((c) => c.row).join(", ");
    if (new Set(group.map((c) => c.value)).size > 1) {
      for (const c of group) reject(c.row, c.lang, c.key, `rows ${rowsOf} give it different texts: keep one`);
    } else {
      if (group.length > 1) notes.push(`rows ${rowsOf} give ${group[0].key} (${group[0].lang}) the same text: written once`);
      accepted.push(group[0]);
    }
  }
  rejects.sort((a, b) => a.row - b.row || a.lang.localeCompare(b.lang));

  // What changes, file by file; a text equal to the current value changes nothing.
  const edits = new Map();
  const changes = [];
  let unchanged = 0;
  for (const c of accepted) {
    const texts = c.target.field ? [m.listing.get(c.target.field)] : m.byLang.get(c.lang).get(c.key);
    if (texts.every((t) => t.value === c.value)) {
      unchanged++;
      continue;
    }
    const rels = c.target.field ? ["module.json"] : [...new Set(texts.map((t) => t.file))];
    for (const rel of rels) {
      if (!edits.has(rel)) edits.set(rel, []);
      edits.get(rel).push(c.target.field ? { field: c.target.field, value: c.value } : { key: c.key, value: c.value });
    }
    changes.push({ ...c, rels, was: texts.every((t) => t.status === "signed") ? "signed" : texts[0].label });
  }

  for (const c of accepted.filter((x) => x.warnings.length)) for (const w of c.warnings) log(`warn: row ${c.row}  ${c.lang}  ${c.key}: ${w}`);
  for (const n of notes) log(`note: ${n}`);
  const result = { code: rejects.length ? 1 : 0, written: 0, unchanged, rejected: rejects.length, files: [] };
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
  if (dryRun) {
    log(`text-sheet: --dry-run: would write ${changes.length} text(s)${changes.length ? ` to ${[...edits.keys()].join(", ")}` : ""}, ${unchanged} unchanged; nothing written`);
    for (const c of changes) log(showChange(c));
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
  log(`text-sheet: wrote ${changes.length} text(s)${changes.length ? ` to ${result.files.join(", ")}` : ""}, ${unchanged} unchanged${rejects.length ? `, ${rejects.length} refused (left out with --partial)` : ""}; ${HUMAN_TEXT_FILE} untouched`);
  for (const c of changes) log(showChange(c));
  const resigned = changes.filter((c) => c.was === "signed").length;
  if (resigned) log(`info: ${resigned} of them replace a signed text: its signature no longer matches`);
  if (changes.length || unchanged) {
    log(`next: sign them yourself at a terminal, each author the texts they wrote (no pipe, no redirection): ${SIGN_COMMAND} --sign`);
  }
  return result;
}

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, positional: [], out: null, all: false, dryRun: false, partial: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (command === "export" && a === "--out") {
      opts.out = rest[++i];
      if (!opts.out) throw new TextSheetError("--out needs a file name");
    } else if (command === "export" && a.startsWith("--out=")) opts.out = a.slice(6);
    else if (command === "export" && a === "--all") opts.all = true;
    else if (command === "import" && a === "--dry-run") opts.dryRun = true;
    else if (command === "import" && a === "--partial") opts.partial = true;
    else if (a.startsWith("-")) throw new TextSheetError(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  const most = command === "export" ? 1 : 2;
  if (opts.positional.length > most) throw new TextSheetError(`unexpected argument ${opts.positional[most]}`);
  return opts;
}

async function main(argv) {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    (argv.length ? console.log : console.error)(USAGE);
    return argv.length ? 0 : 1;
  }
  try {
    if (!["export", "import"].includes(argv[0])) throw new TextSheetError(`unknown command ${argv[0]}`);
    const opts = parseArgs(argv);
    if (opts.command === "export") {
      return (await exportSheet({ dir: opts.positional[0] ?? ".", out: opts.out ?? undefined, all: opts.all })).code;
    }
    const [file, dir] = opts.positional;
    return (await importSheet({ file, dir: dir ?? ".", dryRun: opts.dryRun, partial: opts.partial })).code;
  } catch (err) {
    if (err instanceof TextSheetError) {
      console.error(`text-sheet: ERROR: ${err.message}\n${USAGE}`);
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
