// tools/text-sheet.mjs: the CSV where people write a module's human texts.
// The CSV writer and reader against what Excel and Google Sheets save, the
// textos-borrador.md shapes the modules use, the export (above all: it never
// shows an AI working text) and the import (its checks, all or nothing, and
// files that change only in the edited values, byte for byte).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HUMAN_TEXT_FILE } from "../../tools/shared.mjs";
import {
  CURRENT_PREFIX,
  DRAFT_FILE,
  FIXED_COLUMNS,
  SHEET_FILE,
  TextSheetError,
  csvParse,
  csvWrite,
  decodeSheet,
  exportSheet,
  importSheet,
  jsonStringLeaves,
  parseDraft,
} from "../../tools/text-sheet.mjs";
import { TOOLS, git, materialize, readJson, readText, runNode } from "./helpers.mjs";

const ch = (...codes) => String.fromCharCode(...codes);
const BOM = ch(0xfeff);
const BS = ch(92);
const oracle = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const TEXT_SHEET = path.join(TOOLS, "text-sheet.mjs");
const SIGN_NEXT = "node ../pf2e-baron-core/tools/sign-text.mjs . --sign";
// Accented header words, as the modules write them.
const DONDE = `d${ch(0xf3)}nde aparece`;
const INTENCION = `intenci${ch(0xf3)}n`;
const MAX = `m${ch(0xe1)}x.`;

/* ----------------------------------------------------------------------------
 * The fixture: the valid module with the lock on, some texts signed, some not
 * -------------------------------------------------------------------------- */

// Every value an AI wrote starts with "AI-" (or is a TODO-HUMANO: marker), so
// a leak is a substring search away.
const EN = {
  "baron-fixture.Title": "Baron Fixture",
  "baron-fixture.Open": "Open",
  "baron-fixture.Notice": "AI-NOTICE-EN {count} items",
  "baron-fixture.Kind_a": "TODO-HUMANO: name of kind A",
  "baron-fixture.Kind_b": "AI-KIND-B-EN",
  "baron-fixture.Unused": "Never referenced",
};
const ES = {
  "baron-fixture.Title": "Baron Fixture",
  "baron-fixture.Open": "Abrir",
  "baron-fixture.Notice": "AI-NOTICE-ES {count} cosas",
  "baron-fixture.Kind_a": "TODO-HUMANO: nombre del tipo A",
  "baron-fixture.Kind_b": "AI-KIND-B-ES",
  "baron-fixture.Unused": "AI-CHANGED-ES",
};
const DESCRIPTION = "AI-DESCRIPTION of the fixture";
const SIGNED = {
  "module.json": { title: oracle("Baron Fixture") },
  "lang/en.json": {
    "baron-fixture.Title": oracle("Baron Fixture"),
    "baron-fixture.Open": oracle("Open"),
    "baron-fixture.Unused": oracle("Never referenced"),
  },
  "lang/es.json": {
    "baron-fixture.Title": oracle("Baron Fixture"),
    "baron-fixture.Open": oracle("Abrir"),
    // Signed once, then an AI changed it.
    "baron-fixture.Unused": oracle("Nunca referida"),
  },
};
const DRAFT = [
  "# Textos de trabajo",
  "",
  `| clave | ${DONDE} | ${INTENCION} | variables | ${MAX} |`,
  "|---|---|---|---|---|",
  "| `baron-fixture.Notice` | aviso del panel | dice cuantos hay | `{count}`: un numero | 40 |",
  "| `Kind_b` | etiqueta del tipo B | nombra el tipo B | -- | 12 |",
  "| `module.json:description` | lista de modulos | que hace el modulo | -- | 60 |",
  "| `baron-fixture.Gone` | nada | una clave que ya no existe | -- | |",
  "",
].join("\n");

const json2 = (data) => `${JSON.stringify(data, null, 2)}\n`;

/** The valid fixture with the lock on, the texts above, their signatures and the draft; `spec` as in helpers.materialize. */
function sheetModule(t, spec = {}) {
  return materialize(t, {
    ...spec,
    merge: { "baron.json": { humanText: "signed" }, "module.json": { description: DESCRIPTION }, ...(spec.merge ?? {}) },
    write: {
      "lang/en.json": json2(EN),
      "lang/es.json": json2(ES),
      [HUMAN_TEXT_FILE]: json2({ version: 1, signed: SIGNED }),
      [DRAFT_FILE]: DRAFT,
      ...(spec.write ?? {}),
    },
  });
}

/** Runs exportSheet and reads back what it wrote, by header name. */
async function exp(dir, opts = {}) {
  const lines = [];
  const res = await exportSheet({ dir, cwd: dir, log: (l) => lines.push(l), ...opts });
  const buf = fs.readFileSync(res.file);
  const records = csvParse(decodeSheet(buf)).records.map((r) => r.fields);
  const [header, ...rows] = records;
  const byKey = new Map(rows.map((r) => [r[0], Object.fromEntries(header.map((h, i) => [h, r[i]]))]));
  return { ...res, lines, out: lines.join("\n"), buf, text: buf.toString("utf8"), header, records, byKey };
}

/** Runs importSheet with captured output. */
async function imp(dir, file, opts = {}) {
  const lines = [];
  const errors = [];
  const res = await importSheet({ file, dir, cwd: dir, log: (l) => lines.push(l), logError: (l) => errors.push(l), ...opts });
  return { ...res, lines, errors, out: [...lines, ...errors].join("\n") };
}

/**
 * Exports, fills cells as a person would ([key, column, value]; an unknown key
 * gets a new row) and saves the sheet as `name`, by default as Excel saves
 * "CSV UTF-8" on a Windows set to a semicolon list separator.
 */
async function fill(dir, cells, { name = "filled.csv", delimiter = ";", bom = true } = {}) {
  const { records } = await exp(dir);
  const header = records[0];
  for (const [key, col, value] of cells) {
    let row = records.find((r) => r[0] === key);
    if (!row) {
      row = header.map(() => "");
      row[0] = key;
      records.push(row);
    }
    row[header.indexOf(col)] = value;
  }
  fs.writeFileSync(path.join(dir, name), csvWrite(records, { delimiter, bom }));
  return name;
}

const bytes = (dir, ...files) => Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f))]));
const TRACKED = ["module.json", "lang/en.json", "lang/es.json", HUMAN_TEXT_FILE];

/* ----------------------------------------------------------------------------
 * CSV
 * -------------------------------------------------------------------------- */

test("csvWrite: a BOM, commas, CRLF after every record, and RFC 4180 quotes only where a field needs them", () => {
  const text = csvWrite([
    ["key", "plain text", 'say "hi"'],
    ["a,b", "line one\nline two", " padded"],
    [12, "", null],
  ]);
  assert.equal(text, `${BOM}key,plain text,"say ""hi"""\r\n"a,b","line one\nline two"," padded"\r\n12,,\r\n`);
  assert.equal(csvWrite([["a;b", "c"]], { delimiter: ";", bom: false }), '"a;b";c\r\n');
});

test("csvParse reads back every awkward value csvWrite writes, with each delimiter", () => {
  const values = [
    "plain",
    "comma, inside",
    "semi; colon",
    "tab\tinside",
    'a "quoted" word',
    '""',
    "crlf\r\ninside",
    "lf\ninside",
    "",
    "  spaces at both ends  ",
    `Espa${ch(0xf1)}ol ${ch(0xbf)}s${ch(0xed)}?`,
    `pair ${ch(0xd83d, 0xde00)}`,
    "{count} of {total}",
  ];
  for (const delimiter of [",", ";", "\t"]) {
    const rows = [["key", "en"], ...values.map((v, i) => [`k${i}`, v])];
    const parsed = csvParse(csvWrite(rows, { delimiter }));
    assert.equal(parsed.delimiter, delimiter);
    assert.deepEqual(parsed.records.map((r) => r.fields), rows, JSON.stringify(delimiter));
  }
});

test("csvParse takes the delimiter from the header row, outside quotes, or from an Excel sep= line", () => {
  assert.equal(csvParse('key;en;es\r\n"a;b";"x, y";z\r\n').delimiter, ";");
  assert.deepEqual(csvParse('key;en;es\r\n"a;b";"x, y";z\r\n').records[1].fields, ["a;b", "x, y", "z"]);
  assert.equal(csvParse("key\ten\tes\na\tb\tc\n").delimiter, "\t");
  // Commas inside a quoted header cell do not count.
  assert.equal(csvParse('"k,e,y";en;es\n').delimiter, ";");
  assert.equal(csvParse("key,en\n").delimiter, ",");
  assert.equal(csvParse("key\n").delimiter, ",");
  const hinted = csvParse("sep=;\r\nkey;en\r\na;b\r\n");
  assert.equal(hinted.delimiter, ";");
  assert.deepEqual(hinted.records.map((r) => [r.row, ...r.fields]), [[1, "key", "en"], [2, "a", "b"]]);
});

test("csvParse: LF, CR or CRLF, no final newline, and the row numbers a spreadsheet shows", () => {
  const rows = (text) => csvParse(text).records.map((r) => [r.row, ...r.fields]);
  assert.deepEqual(rows("key,en\n\na,b"), [[1, "key", "en"], [2, ""], [3, "a", "b"]]);
  assert.deepEqual(rows("key,en\ra,b\r"), [[1, "key", "en"], [2, "a", "b"]]);
  // A cell with newlines is still one row.
  assert.deepEqual(rows('key,en\r\na,"l1\r\nl2"\r\nb,c\r\n'), [[1, "key", "en"], [2, "a", "l1\r\nl2"], [3, "b", "c"]]);
  // Trailing empty columns, as Excel writes them.
  assert.deepEqual(rows("key,en,,\r\na,b,,\r\n"), [[1, "key", "en", "", ""], [2, "a", "b", "", ""]]);
  // A stray quote inside an unquoted cell is text.
  assert.deepEqual(rows('key,en\na,5" screen\n'), [[1, "key", "en"], [2, "a", '5" screen']]);
  assert.deepEqual(rows(`${BOM}key\n`), [[1, "key"]]);
  assert.deepEqual(rows(""), []);
});

test("csvParse refuses a quote that never closes, naming its row", () => {
  assert.throws(() => csvParse('key,en\na,"open\nb,c\n'), (err) => err instanceof TextSheetError && /row 2 never closes/.test(err.message));
});

test("decodeSheet reads UTF-8 with or without a BOM and UTF-16 with its BOM, and refuses the Windows code page", () => {
  const text = `key,es\r\nk,Espa${ch(0xf1)}ol\r\n`;
  assert.equal(decodeSheet(Buffer.from(BOM + text, "utf8")), text);
  assert.equal(decodeSheet(Buffer.from(text, "utf8")), text);
  assert.equal(decodeSheet(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
  assert.equal(decodeSheet(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])), text);
  // Excel's plain "CSV (delimitado por comas)": n-tilde as the single byte 0xF1.
  const ansi = Buffer.from([...Buffer.from("key,es\r\nk,Espa"), 0xf1, ...Buffer.from("ol\r\n")]);
  assert.throws(() => decodeSheet(ansi), (err) => err instanceof TextSheetError && /CSV UTF-8/.test(err.message));
  assert.throws(() => decodeSheet(Buffer.from([0xff, 0xfe, 0x41])), TextSheetError);
});

/* ----------------------------------------------------------------------------
 * docs/textos-borrador.md
 * -------------------------------------------------------------------------- */

test("parseDraft reads the documented shape: the key first, the columns by header name, accents and case ignored", () => {
  const text = [
    "# Textos",
    "",
    "| Concepto | Claves donde aparece |",
    "|---|---|",
    "| un concepto | `Notice`, `Kind_b` |",
    "",
    "```md",
    "| clave | intencion |",
    "|---|---|",
    "| `Example.InACodeFence` | not a row |",
    "```",
    "",
    `| Clave | ${DONDE.toUpperCase()} | Qu${ch(0xe9)} comunica | Variables | Largo m${ch(0xe1)}ximo |`,
    "|:--|---|---|---|--:|",
    `| \`baron-fixture.Notice\` | panel<br>y chat | uno ${BS}| otro | \`{count}\` y \`{total}\` | 40 caracteres |`,
    "| `Kind_b` | etiqueta | nombra | -- | |",
    "| `A.One` `A.Two` | dos claves | la misma nota | | 9 |",
    "| | sin clave | se ignora | | |",
    "<!-- | `Hidden.Key` | no | no | | | -->",
    "",
  ].join("\r\n");
  assert.deepEqual(parseDraft(text), [
    { key: "baron-fixture.Notice", line: 15, where: "panel\ny chat", intent: "uno | otro", placeholders: ["{count}", "{total}"], max: 40 },
    { key: "Kind_b", line: 16, where: "etiqueta", intent: "nombra", placeholders: [], max: null },
    { key: "A.One", line: 17, where: "dos claves", intent: "la misma nota", placeholders: [], max: 9 },
    { key: "A.Two", line: 17, where: "dos claves", intent: "la misma nota", placeholders: [], max: 9 },
  ]);
});

test("parseDraft reads the template's earlier shape: archivo | clave | intencion", () => {
  const text = [
    "# Textos de trabajo escritos por IA",
    "",
    `| archivo | clave | ${INTENCION} (qu${ch(0xe9)} debe comunicar y ${DONDE}) |`,
    "|---------|-------|------------------------------------------------|",
    "| `lang/en.json`, `lang/es.json` | `__MODULE_ID__.Open` | viene de la plantilla: etiqueta del boton |",
    "| `lang/en.json`, `lang/es.json` | `__MODULE_ID__.SettingGmOnly` | nombre del ajuste |",
    "",
  ].join("\n");
  assert.deepEqual(parseDraft(text), [
    { key: "__MODULE_ID__.Open", line: 5, where: "", intent: "viene de la plantilla: etiqueta del boton", placeholders: null, max: null },
    { key: "__MODULE_ID__.SettingGmOnly", line: 6, where: "", intent: "nombre del ajuste", placeholders: null, max: null },
  ]);
});

test("parseDraft reads the baron-traps shape: several tables, keys without the prefix, a concept table and prose around them", () => {
  const text = [
    "# Textos pendientes",
    "",
    "- **Se queda:** `baron-traps.Title` y el `title` de `module.json`.",
    "",
    "| Concepto (nombre en el c" + ch(0xf3) + "digo) | Claves donde aparece |",
    "|---|---|",
    "| Los tres valores de la flag `state` | `StateArmed`, `StateTriggered` |",
    "",
    "### Tarjeta",
    "",
    `| Clave | D${ch(0xf3)}nde aparece | Qu${ch(0xe9)} comunica | Variables | M${ch(0xe1)}x. |`,
    "|---|---|---|---|---|",
    "| `CardTriggered` | T" + ch(0xed) + "tulo de la tarjeta. | Prop" + ch(0xf3) + "sito: encabezar. | `{victim}`: nombre del token; `{hazard}`: nombre del peligro | 60 |",
    "| `HazardGone` | Aviso. | Prop" + ch(0xf3) + "sito: avisar. | " + ch(0x2014) + " | 80 |",
    "",
    "### `description` de `module.json`",
    "",
    "- **D" + ch(0xf3) + "nde:** la lista de m" + ch(0xf3) + "dulos.",
  ].join("\n");
  const rows = parseDraft(text);
  assert.deepEqual(rows.map((r) => [r.key, r.line, r.placeholders, r.max]), [
    ["CardTriggered", 13, ["{victim}", "{hazard}"], 60],
    ["HazardGone", 14, [], 80],
  ]);
  assert.equal(rows[0].intent, `Prop${ch(0xf3)}sito: encabezar.`);
  assert.equal(rows[0].where, `T${ch(0xed)}tulo de la tarjeta.`);
});

/* ----------------------------------------------------------------------------
 * export
 * -------------------------------------------------------------------------- */

test("export never shows an unsigned, changed or still-to-write value: only the texts that need a person, with empty language cells", async (t) => {
  const dir = sheetModule(t);
  const e = await exp(dir);
  assert.equal(e.file, path.join(dir, SHEET_FILE));
  assert.deepEqual(e.header, [...FIXED_COLUMNS, "en", "es", `${CURRENT_PREFIX}en`, `${CURRENT_PREFIX}es`]);
  assert.deepEqual([...e.byKey.keys()], [
    "module.json:description",
    "baron-fixture.Notice",
    "baron-fixture.Kind_a",
    "baron-fixture.Kind_b",
    "baron-fixture.Unused",
  ]);
  assert.deepEqual(
    [...e.byKey.values()].map((r) => r.status),
    ["unsigned", "unsigned", "to write", "unsigned", "en: signed; es: changed"],
  );
  // The leak guard: no AI working text and no marker anywhere in the file or the output.
  for (const where of [e.text, e.out]) {
    assert.ok(!where.includes("AI-"), where);
    assert.ok(!where.includes("TODO-HUMANO"), where);
  }
  for (const r of e.byKey.values()) {
    assert.equal(r.en, "");
    assert.equal(r.es, "");
  }
  // A signed text is shown, beside a changed one that is not.
  assert.equal(e.byKey.get("baron-fixture.Unused").current_en, "Never referenced");
  assert.equal(e.byKey.get("baron-fixture.Unused").current_es, "");
  // UTF-8 with a BOM, CRLF between records.
  assert.deepEqual([...e.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(e.text.startsWith(`${BOM}key,where,intent,placeholders,max_length,status,en,es,current_en,current_es\r\n`));
  assert.match(e.out, /wrote textos-hoja\.csv: 5 row\(s\), 5 that need a person/);
  assert.match(e.out, /^next: .* import textos-hoja\.csv$/m);
});

test("export --all adds every signed text with its value in current_<lang>, and still no AI working text", async (t) => {
  const dir = sheetModule(t);
  const e = await exp(dir, { all: true });
  assert.equal(e.byKey.size, 8);
  assert.deepEqual(e.byKey.get("module.json:title"), {
    key: "module.json:title",
    where: 'module.json "title": one text for every language, written in the en column',
    intent: "",
    placeholders: "",
    max_length: "",
    status: "signed",
    en: "",
    es: "",
    current_en: "Baron Fixture",
    current_es: "",
  });
  assert.equal(e.byKey.get("baron-fixture.Title").current_es, "Baron Fixture");
  assert.equal(e.byKey.get("baron-fixture.Open").current_en, "Open");
  assert.equal(e.byKey.get("baron-fixture.Open").current_es, "Abrir");
  assert.equal(e.byKey.get("baron-fixture.Open").status, "signed");
  assert.ok(!e.text.includes("AI-"));
  assert.ok(!e.text.includes("TODO-HUMANO"));
  assert.match(e.out, /8 row\(s\), 5 that need a person/);
});

test("export fills where from check-module's key scan, and intent, placeholders and max_length from textos-borrador.md", async (t) => {
  const dir = sheetModule(t);
  const e = await exp(dir);
  const notice = e.byKey.get("baron-fixture.Notice");
  assert.equal(notice.where, "aviso del panel\nscripts/lib/util.js:5");
  assert.equal(notice.intent, "dice cuantos hay");
  assert.equal(notice.placeholders, "{count}");
  assert.equal(notice.max_length, "40");
  // A key built at runtime (i18n(`Kind_${kind}`)) points at where it is built.
  assert.equal(e.byKey.get("baron-fixture.Kind_a").where, "scripts/main.js:29 (key built at runtime)");
  // A draft key may leave out the i18n prefix.
  assert.equal(e.byKey.get("baron-fixture.Kind_b").intent, "nombra el tipo B");
  assert.equal(e.byKey.get("baron-fixture.Kind_b").max_length, "12");
  const description = e.byKey.get("module.json:description");
  assert.equal(description.where, 'module.json "description": one text for every language, written in the en column\nlista de modulos');
  assert.equal(description.max_length, "60");
  // The gaps both ways are warnings, not errors.
  assert.match(e.out, /warn: 2 row\(s\) that need a person have no row in docs\/textos-borrador\.md/);
  assert.match(e.out, /^ {2}baron-fixture\.Kind_a$/m);
  assert.match(e.out, /^ {2}baron-fixture\.Unused$/m);
  assert.match(e.out, /warn: 1 row\(s\) of docs\/textos-borrador\.md name a key that is not in the language files/);
  assert.match(e.out, /docs\/textos-borrador\.md:8 {2}baron-fixture\.Gone/);
  // The signed Title has no draft row, and needs none.
  assert.ok(!/^ {2}baron-fixture\.Title$/m.test(e.out));
  // The template's routine of a fresh module: in --all, the signed rows do not warn either.
  assert.match((await exp(dir, { all: true, out: "all.csv" })).out, /warn: 2 row\(s\) that need a person/);
});

test("export warns when textos-borrador.md lists other placeholders, or none at all exists", async (t) => {
  const dir = sheetModule(t, { write: { [DRAFT_FILE]: DRAFT.replace("`{count}`: un numero", "`{n}`") } });
  const e = await exp(dir);
  assert.equal(e.byKey.get("baron-fixture.Notice").placeholders, "{count}");
  assert.match(e.out, /list other placeholders than the language files use/);
  assert.match(e.out, /baron-fixture\.Notice: docs\/textos-borrador\.md \{n\}, language files \{count\}/);

  const bare = sheetModule(t, { delete: [DRAFT_FILE] });
  const b = await exp(bare);
  assert.match(b.out, /warn: there is no docs\/textos-borrador\.md: the intent column is empty for all 5 row\(s\)/);
  assert.equal(b.byKey.get("baron-fixture.Notice").intent, "");
});

test("export writes only outside the folders the release ZIP packs, and never over texts nobody imported", async (t) => {
  const dir = sheetModule(t);
  for (const out of ["lang/x.csv", "scripts/x.csv", "Templates/x.csv", "packs/x.csv"]) {
    await assert.rejects(exp(dir, { out }), (err) => err instanceof TextSheetError && /release ZIP packs/.test(err.message), out);
  }
  await assert.rejects(exp(dir, { out: "notes.txt" }), /does not end in \.csv/);
  await assert.rejects(exp(dir, { out: "README.md" }), /does not end in \.csv/);
  // A sheet elsewhere is fine, and an untouched sheet is simply written again.
  await exp(dir, { out: "docs/hoja.csv" });
  await exp(dir);
  await exp(dir);
  // Once a person wrote in it, export refuses to overwrite it until it is imported.
  await fill(dir, [["baron-fixture.Notice", "es", "{count} avisos"]], { name: SHEET_FILE });
  const before = fs.readFileSync(path.join(dir, SHEET_FILE));
  await assert.rejects(exp(dir), (err) => err instanceof TextSheetError && /holds written texts that are not in the module yet \(row 3\): import it first/.test(err.message));
  assert.ok(fs.readFileSync(path.join(dir, SHEET_FILE)).equals(before));
  assert.equal((await imp(dir, SHEET_FILE)).code, 0);
  assert.equal((await exp(dir)).byKey.get("baron-fixture.Notice").es, "");
  fs.writeFileSync(path.join(dir, "other.csv"), "name,phone\r\nx,1\r\n");
  await assert.rejects(exp(dir, { out: "other.csv" }), /is not a text sheet/);
});

test("export asks for textos-hoja.csv in .gitignore when the module is a git repo", async (t) => {
  const dir = sheetModule(t);
  git(dir, "init", "-q");
  assert.match((await exp(dir)).out, /warn: textos-hoja\.csv is not in \.gitignore/);
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\ntextos-hoja.csv\n");
  assert.ok(!/gitignore/.test((await exp(dir)).out));
});

test("export of a module without humanText follows the TODO-HUMANO rule, and its leak guard is the same", async (t) => {
  const dir = materialize(t, {
    write: {
      "lang/en.json": json2({ ...EN, "baron-fixture.Kind_b": "" }),
      "lang/es.json": json2(ES),
      [HUMAN_TEXT_FILE]: json2({ version: 1, signed: { "lang/en.json": { "baron-fixture.Open": oracle("Open") } } }),
    },
  });
  const e = await exp(dir);
  assert.match(e.out, /does not say "humanText": "signed": a text needs a person when it starts with TODO-HUMANO: or is empty/);
  assert.deepEqual([...e.byKey.keys()], ["baron-fixture.Kind_a", "baron-fixture.Kind_b"]);
  assert.deepEqual([...e.byKey.values()].map((r) => r.status), ["to write", "en: to write; es: written"]);
  const all = await exp(dir, { all: true });
  assert.equal(all.byKey.get("baron-fixture.Notice").status, "written");
  // Not a signed text: not shown, lock or no lock.
  assert.equal(all.byKey.get("baron-fixture.Notice").current_en, "");
  assert.equal(all.byKey.get("baron-fixture.Open").current_en, "Open");
  assert.equal(all.byKey.get("baron-fixture.Open").current_es, "");
  assert.ok(!all.text.includes("AI-"));
});

/* ----------------------------------------------------------------------------
 * import
 * -------------------------------------------------------------------------- */

test("import writes the filled cells, leaves human-text.json alone and says how to sign", async (t) => {
  const dir = sheetModule(t);
  const signatures = bytes(dir, HUMAN_TEXT_FILE);
  const file = await fill(dir, [
    ["baron-fixture.Notice", "en", "{count} notices"],
    ["baron-fixture.Notice", "es", `{count} avisos, se${ch(0xf1)}or`],
    ["baron-fixture.Kind_a", "en", "Kind A"],
    ["module.json:description", "en", "A fixture module."],
  ]);
  const r = await imp(dir, file);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.written, 4);
  assert.deepEqual(r.files, ["module.json", "lang/en.json", "lang/es.json"]);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Notice"], "{count} notices");
  assert.equal(readJson(dir, "lang", "es.json")["baron-fixture.Notice"], `{count} avisos, se${ch(0xf1)}or`);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Kind_a"], "Kind A");
  assert.equal(readJson(dir, "module.json").description, "A fixture module.");
  assert.ok(fs.readFileSync(path.join(dir, HUMAN_TEXT_FILE)).equals(signatures[HUMAN_TEXT_FILE]));
  assert.match(r.out, /human-text\.json untouched/);
  assert.ok(r.lines.at(-1).startsWith("next: sign them yourself at a terminal"));
  assert.ok(r.lines.at(-1).endsWith(SIGN_NEXT));
  // Nothing signed them: they still need their authors.
  const after = await exp(dir, { out: "after.csv" });
  assert.equal(after.byKey.get("baron-fixture.Notice").status, "unsigned");
  assert.equal(after.byKey.get("baron-fixture.Notice").current_en, "");
  assert.equal(after.byKey.get("baron-fixture.Kind_a").status, "en: unsigned; es: to write");
});

test("import reads the sheet as Excel and Google Sheets save it: BOM or not, UTF-16, comma, semicolon or tab, any column order", async (t) => {
  const want = {
    "baron-fixture.Notice": ["{count}\nnotices", `{count} cosas, ${ch(0xbf)}s${ch(0xed)}?`],
    "baron-fixture.Kind_b": ['The "B" kind', "Tipo B; el otro"],
  };
  const header = ["key", "en", "es"];
  const rows = Object.entries(want).map(([key, [en, es]]) => [key, en, es]);
  const variants = {
    "Excel CSV UTF-8, semicolon": () => Buffer.from(csvWrite([header, ...rows], { delimiter: ";" }), "utf8"),
    "Excel Texto Unicode (UTF-16, tab)": () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvWrite([header, ...rows], { delimiter: "\t", bom: false }), "utf16le")]),
    "Google Sheets (no BOM, comma, LF rows)": () => Buffer.from(csvWrite([header, ...rows], { bom: false }).replace(/\r\n/g, "\n"), "utf8"),
    "reordered, extra and empty columns, empty rows": () => {
      const h = ["notas", "es", "", "status", "KEY", "En", ""];
      const r = rows.map(([key, en, es]) => ["mine", es, "", "x", key, en, ""]);
      return Buffer.from(csvWrite([h, ["", "", "", "", "", "", ""], r[0], [], r[1], [""]], { delimiter: "," }), "utf8");
    },
  };
  for (const [name, make] of Object.entries(variants)) {
    const dir = sheetModule(t);
    fs.writeFileSync(path.join(dir, "saved.csv"), make());
    const r = await imp(dir, "saved.csv");
    assert.equal(r.code, 0, `${name}: ${r.out}`);
    assert.equal(r.written, 4, name);
    for (const [key, [en, es]] of Object.entries(want)) {
      assert.equal(readJson(dir, "lang", "en.json")[key], en, name);
      assert.equal(readJson(dir, "lang", "es.json")[key], es, name);
    }
    if (name.startsWith("reordered")) assert.match(r.out, /column\(s\) "notas" ignored/);
  }
});

test("import refuses a text whose {placeholders} differ from the ones it must keep, and accepts them reordered or repeated", async (t) => {
  const dir = sheetModule(t);
  const bad = {
    "{n} notices": "lacks {count} and has {n}, which the code does not fill in: it must keep exactly {count}",
    "notices": "lacks {count}: it must keep exactly {count}",
    "{count} of {total}": "has {total}, which the code does not fill in: it must keep exactly {count}",
  };
  for (const [value, reason] of Object.entries(bad)) {
    const file = await fill(dir, [["baron-fixture.Notice", "en", value]]);
    const r = await imp(dir, file);
    assert.equal(r.code, 1);
    assert.ok(r.errors.includes(`  row 3  en  baron-fixture.Notice: ${reason}`), r.out);
  }
  // A text with no placeholder may not gain one.
  const extra = await imp(dir, await fill(dir, [["baron-fixture.Kind_b", "en", "Kind {count}"]]));
  assert.match(extra.out, /has \{count\}, which the code does not fill in: it must keep exactly \(none\)/);
  const ok = await imp(dir, await fill(dir, [["baron-fixture.Notice", "en", "{count}: {count} notices"]]));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Notice"], "{count}: {count} notices");
});

test("import takes the placeholders from textos-borrador.md when every language still holds a marker", async (t) => {
  const dir = sheetModule(t, {
    write: { [DRAFT_FILE]: `${DRAFT}\n| clave | variables |\n|---|---|\n| \`Kind_a\` | \`{kind}\` |\n` },
  });
  assert.equal((await exp(dir)).byKey.get("baron-fixture.Kind_a").placeholders, "{kind}");
  assert.equal((await imp(dir, await fill(dir, [["baron-fixture.Kind_a", "en", "Kind A"]]))).code, 1);
  assert.equal((await imp(dir, await fill(dir, [["baron-fixture.Kind_a", "en", "Kind {kind}"]]))).code, 0);
});

test("import refuses TODO-HUMANO:, whitespace, unknown keys and keys one language lacks, every reason with its row; over max_length only warns", async (t) => {
  const dir = sheetModule(t, { write: { "lang/es.json": json2({ ...ES, "baron-fixture.OnlyEs": "AI-ONLY-ES" }) } });
  const before = bytes(dir, ...TRACKED);
  const file = await fill(dir, [
    ["baron-fixture.Kind_b", "en", "TODO-HUMANO: still a marker"],
    ["baron-fixture.Kind_b", "es", " \t "],
    ["baron-fixture.Nope", "en", "A text"],
    ["baron-fixture.OnlyEs", "en", "Only in es"],
    ["", "es", "A text without a key"],
    ["baron-fixture.Kind_a", "en", "  Kind A, and a far longer label  "],
  ]);
  const r = await imp(dir, file);
  assert.equal(r.code, 1);
  assert.equal(r.rejected, 5, r.out);
  // OnlyEs has its own row (es only); the unknown key and the keyless text get new ones.
  assert.deepEqual(r.errors.slice(1, 6), [
    "  row 5  en  baron-fixture.Kind_b: starts with \"TODO-HUMANO:\", the marker of a text nobody wrote",
    "  row 5  es  baron-fixture.Kind_b: holds only whitespace",
    "  row 7  en  baron-fixture.OnlyEs: is not a key of lang/en.json: the import never creates keys; add it to every language file first",
    "  row 8  en  baron-fixture.Nope: is not a key of the language files: the import never creates keys",
    "  row 9  es  (no key): the row has text but its key cell is empty",
  ]);
  assert.ok(r.errors.at(-1).includes("nothing written: fix those cells in the sheet and import it again, or pass --partial to write the 1 valid change(s)"), r.out);
  assert.ok(r.lines.includes("warn: row 4  en  baron-fixture.Kind_a: starts or ends with whitespace, which stays in the text"), r.out);
  for (const [f, b] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(dir, f)).equals(b), f);

  // Kind_b's max_length (12) only warns.
  const long = await imp(dir, await fill(dir, [["baron-fixture.Kind_b", "en", "A label longer than twelve"]]));
  assert.equal(long.code, 0, long.out);
  assert.match(long.out, /warn: row 5 {2}en {2}baron-fixture\.Kind_b: is 26 characters long without its placeholders, over max_length 12/);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Kind_b"], "A label longer than twelve");
});

test("import is all or nothing: one refused cell and no file changes; --partial writes the rest; --dry-run writes nothing", async (t) => {
  const dir = sheetModule(t);
  const before = bytes(dir, ...TRACKED);
  const file = await fill(dir, [
    ["baron-fixture.Notice", "en", "{count} notices"],
    ["baron-fixture.Kind_b", "es", "Tipo B"],
    ["baron-fixture.Kind_a", "en", "Kind {oops}"],
  ]);
  const all = await imp(dir, file);
  assert.equal(all.code, 1);
  assert.equal(all.written, 0);
  assert.match(all.errors.at(-1), /nothing written: .* or pass --partial to write the 2 valid change\(s\)/);
  for (const [f, b] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(dir, f)).equals(b), f);

  const dry = await imp(dir, file, { dryRun: true, partial: true });
  assert.equal(dry.code, 1);
  assert.match(dry.out, /--dry-run: would write 2 text\(s\) to lang\/en\.json, lang\/es\.json, 0 unchanged; nothing written/);
  assert.match(dry.out, /row 3 {2}en {2}baron-fixture\.Notice -> lang\/en\.json: "\{count\} notices" \(was unsigned\)/);
  // The old value of an unsigned text is never printed either.
  assert.ok(!dry.out.includes("AI-"), dry.out);
  for (const [f, b] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(dir, f)).equals(b), f);

  const partial = await imp(dir, file, { partial: true });
  assert.equal(partial.code, 1);
  assert.equal(partial.written, 2);
  assert.match(partial.out, /wrote 2 text\(s\) to lang\/en\.json, lang\/es\.json, 0 unchanged, 1 refused \(left out with --partial\)/);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Notice"], "{count} notices");
  assert.equal(readJson(dir, "lang", "es.json")["baron-fixture.Kind_b"], "Tipo B");
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Kind_a"], EN["baron-fixture.Kind_a"]);
});

test("import changes only the edited values, byte for byte: nesting, tabs, CRLF, BOM, no final newline, key order and escapes stay", async (t) => {
  const NL = "\r\n";
  const en = [
    `${BOM}{`,
    '\t"baron-fixture.Title": "Baron Fixture",',
    '\t"baron-fixture": {',
    '\t\t"Notice"  :  "AI-NOTICE-EN {count} items",',
    '\t\t"Open": "Open"',
    "\t},",
    '\t"baron-fixture.Open": "Open",',
    '\t"baron-fixture.Kind_a": "TODO-HUMANO: name of kind A",',
    `\t"baron-fixture.Kind_b": "AI-KIND-B-EN ${BS}"quoted${BS}" ${BS}/ slash",`,
    '\t"baron-fixture.Unused": "Never referenced",',
    '\t"list": ["Open", 2, {"x": "Open"}], "n": -1.5e3, "t": true, "z": null',
    "}",
  ].join(NL);
  // Every non-ASCII character escaped, as some editors and scripts write JSON.
  const es = [
    "{",
    '    "baron-fixture.Title": "Baron Fixture",',
    '    "baron-fixture.Open": "Abrir",',
    '    "baron-fixture.Notice": "AI-NOTICE-ES {count} cosas",',
    '    "baron-fixture.Kind_a": "TODO-HUMANO: nombre del tipo A",',
    `    "baron-fixture.Kind_b": "AI-KIND-B-ES categor${BS}u00eda",`,
    '    "baron-fixture.Unused": "AI-CHANGED-ES"',
    "}",
    "",
  ].join("\n");
  const dir = sheetModule(t, { write: { "lang/en.json": en, "lang/es.json": es } });
  const file = await fill(dir, [
    ["baron-fixture.Notice", "en", "{count} notices"],
    ["baron-fixture.Open", "en", 'Open "it"'],
    ["baron-fixture.Notice", "es", `{count} avisos, se${ch(0xf1)}or ${ch(0xd83d, 0xde00)}`],
    ["baron-fixture.Kind_b", "es", "Tipo B"],
  ]);
  const r = await imp(dir, file);
  assert.equal(r.code, 0, r.out);
  // The expected files, from the originals by plain text replacement.
  const wantEn = en
    .replace('"AI-NOTICE-EN {count} items"', '"{count} notices"')
    .replace('"Open": "Open"', `"Open": "Open ${BS}"it${BS}""`)
    .replace('"baron-fixture.Open": "Open"', `"baron-fixture.Open": "Open ${BS}"it${BS}""`);
  const wantEs = es
    .replace('"AI-NOTICE-ES {count} cosas"', `"{count} avisos, se${BS}u00f1or ${BS}ud83d${BS}ude00"`)
    .replace(`"AI-KIND-B-ES categor${BS}u00eda"`, '"Tipo B"');
  assert.ok(fs.readFileSync(path.join(dir, "lang", "en.json")).equals(Buffer.from(wantEn, "utf8")), readText(dir, "lang", "en.json"));
  assert.ok(fs.readFileSync(path.join(dir, "lang", "es.json")).equals(Buffer.from(wantEs, "utf8")), readText(dir, "lang", "es.json"));
  // The nested and the dotted copy of one key changed together.
  assert.equal(JSON.parse(readText(dir, "lang", "en.json").slice(1))["baron-fixture"].Open, 'Open "it"');
});

test("import writes the module.json title and description from the first language column only", async (t) => {
  const dir = sheetModule(t);
  const original = readText(dir, "module.json");
  const file = await fill(dir, [
    ["module.json:title", "en", "Fixture of the Baron"],
    ["module.json:description", "en", "Checks every rule."],
  ]);
  const r = await imp(dir, file);
  assert.equal(r.code, 0, r.out);
  const want = original
    .replace('"title": "Baron Fixture"', '"title": "Fixture of the Baron"')
    .replace(`"description": "${DESCRIPTION}"`, '"description": "Checks every rule."');
  assert.equal(readText(dir, "module.json"), want);
  // The signed title shows as signed in the dry run; afterwards it is changed.
  assert.match(r.out, /module\.json:title -> module\.json: "Fixture of the Baron" \(replaces the signed text "Baron Fixture"\)/);
  assert.match(r.out, /info: 1 of them replace a signed text/);
  assert.equal((await exp(dir, { all: true, out: "all.csv" })).byKey.get("module.json:title").status, "changed");

  const es = await imp(dir, await fill(dir, [["module.json:description", "es", "Revisa todo."]]));
  assert.equal(es.code, 1);
  assert.match(es.out, /row 3 {2}es {2}module\.json:description: module\.json has one "description" for every language: write it in the en column/);
  const unknown = await imp(dir, await fill(dir, [["module.json:version", "en", "9.9.9"]]));
  assert.match(unknown.out, /module\.json:version: is not a key of the language files/);
  assert.equal(readJson(dir, "module.json").version, "0.0.0");
});

test("import replaces a signed text without signing it, refuses two different texts for one cell and writes a repeated one once", async (t) => {
  const dir = sheetModule(t);
  const header = ["key", "en", "es"];
  const write = (rows) => fs.writeFileSync(path.join(dir, "s.csv"), csvWrite([header, ...rows]));
  write([
    ["baron-fixture.Open", "Open up", ""],
    ["baron-fixture.Kind_b", "Kind B", ""],
    ["baron-fixture.Kind_b", "Kind Bee", ""],
  ]);
  const twice = await imp(dir, "s.csv");
  assert.equal(twice.code, 1);
  assert.ok(twice.errors.includes("  row 3  en  baron-fixture.Kind_b: rows 3, 4 give it different texts: keep one"), twice.out);
  assert.ok(twice.errors.includes("  row 4  en  baron-fixture.Kind_b: rows 3, 4 give it different texts: keep one"), twice.out);

  write([
    ["baron-fixture.Open", "Open up", "Abrir"],
    ["baron-fixture.Kind_b", "Kind B", ""],
    ["baron-fixture.Kind_b", "Kind B", ""],
  ]);
  const once = await imp(dir, "s.csv");
  assert.equal(once.code, 0, once.out);
  assert.equal(once.written, 2);
  assert.equal(once.unchanged, 1);
  assert.match(once.out, /note: rows 3, 4 give baron-fixture\.Kind_b \(en\) the same text: written once/);
  const e = await exp(dir, { all: true, out: "all.csv" });
  assert.equal(e.byKey.get("baron-fixture.Open").status, "en: changed; es: signed");
  assert.equal(e.byKey.get("baron-fixture.Open").current_en, "");
  assert.equal(e.byKey.get("baron-fixture.Open").current_es, "Abrir");
});

test("import says when a current_<lang> cell was edited: only the language column is read", async (t) => {
  const dir = sheetModule(t);
  const file = await fill(dir, [
    ["baron-fixture.Unused", "current_es", "Nunca usada"],
    ["baron-fixture.Unused", "es", "Nunca usada"],
  ]);
  const r = await imp(dir, file);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /note: row 6: the current_es cell was edited; import reads only the es column/);
  assert.equal(readJson(dir, "lang", "es.json")["baron-fixture.Unused"], "Nunca usada");
});

test("a key in two files of one language: no current value unless both agree, and the import writes both", async (t) => {
  const languages = [
    { lang: "en", name: "English", path: "lang/en.json" },
    { lang: "en", name: "English", path: "lang/en-more.json" },
    { lang: "es", name: "Espanol", path: "lang/es.json" },
  ];
  const signed = { ...SIGNED, "lang/en-more.json": { "baron-fixture.Open": oracle("Open now"), "baron-fixture.Title": oracle("Baron Fixture") } };
  const dir = sheetModule(t, {
    merge: { "module.json": { description: DESCRIPTION, languages } },
    write: {
      "lang/en-more.json": json2({ "baron-fixture.Open": "Open now", "baron-fixture.Title": "Baron Fixture" }),
      [HUMAN_TEXT_FILE]: json2({ version: 1, signed }),
    },
  });
  const e = await exp(dir, { all: true });
  assert.deepEqual(e.header.slice(6), ["en", "es", "current_en", "current_es"]);
  // Both signed, but which one would the sheet show? Neither.
  assert.equal(e.byKey.get("baron-fixture.Open").current_en, "");
  assert.equal(e.byKey.get("baron-fixture.Title").current_en, "Baron Fixture");
  const r = await imp(dir, await fill(dir, [["baron-fixture.Open", "en", "Open it"]]));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.files, ["lang/en.json", "lang/en-more.json"]);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Open"], "Open it");
  assert.equal(readJson(dir, "lang", "en-more.json")["baron-fixture.Open"], "Open it");
});

test("import writes nothing when a file changes on disk after it was read", async (t) => {
  const dir = sheetModule(t);
  const file = await fill(dir, [
    ["baron-fixture.Notice", "es", "{count} avisos"],
    ["baron-fixture.Notice", "en", "{count} notices"],
  ]);
  const en = path.join(dir, "lang", "en.json");
  const edited = `${readText(dir, "lang", "en.json")} `;
  const before = bytes(dir, "lang/es.json");
  // The first line is logged after the module is read and before anything is written.
  const log = (line) => {
    if (line.startsWith("text-sheet: baron-fixture")) fs.writeFileSync(en, edited);
  };
  await assert.rejects(importSheet({ file, dir, cwd: dir, log, logError: () => {} }), (err) => err instanceof TextSheetError && /lang\/en\.json changed on disk while text-sheet ran: nothing was written/.test(err.message));
  assert.equal(readText(dir, "lang", "en.json"), edited);
  assert.ok(fs.readFileSync(path.join(dir, "lang", "es.json")).equals(before["lang/es.json"]));
});

test("import stops on a sheet it cannot read, before touching the module", async (t) => {
  const dir = sheetModule(t);
  const before = bytes(dir, ...TRACKED);
  fs.writeFileSync(path.join(dir, "nokey.csv"), "name,en\r\nx,y\r\n");
  await assert.rejects(imp(dir, "nokey.csv"), /has no "key" column/);
  fs.writeFileSync(path.join(dir, "nolang.csv"), "key,fr\r\nx,y\r\n");
  await assert.rejects(imp(dir, "nolang.csv"), /has no language column: the module declares en, es/);
  fs.writeFileSync(path.join(dir, "twice.csv"), "key,en,EN\r\nx,y,z\r\n");
  await assert.rejects(imp(dir, "twice.csv"), /two "en" columns/);
  await assert.rejects(imp(dir, "missing.csv"), /missing\.csv does not exist/);
  for (const [f, b] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(dir, f)).equals(b), f);
});

test("jsonStringLeaves gives every string value its key path and the exact offsets of its token", () => {
  const text = `{ "a": { "b": "x${BS}"y" }, "a.c": "z", "l": ["p", {"q": "r"}], "n": 1 }`;
  const leaves = jsonStringLeaves(text);
  assert.deepEqual(leaves.map((l) => [l.path.join("."), l.value, l.inArray, text.slice(l.start, l.end)]), [
    ["a.b", 'x"y', false, `"x${BS}"y"`],
    ["a.c", "z", false, '"z"'],
    ["l.0", "p", true, '"p"'],
    ["l.1.q", "r", true, '"r"'],
  ]);
  assert.throws(() => jsonStringLeaves('{"a": }'), SyntaxError);
});

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

test("the CLI exports and imports from the module folder, exits 1 on refused cells or errors, and explains its usage", (t) => {
  const dir = sheetModule(t);
  const ex = runNode(TEXT_SHEET, ["export"], { cwd: dir });
  assert.equal(ex.status, 0, ex.out);
  assert.ok(fs.existsSync(path.join(dir, SHEET_FILE)));
  const header = "key,en,es\r\n";
  fs.writeFileSync(path.join(dir, "bad.csv"), `${header}baron-fixture.Notice,no placeholder,\r\n`);
  const bad = runNode(TEXT_SHEET, ["import", "bad.csv"], { cwd: dir });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /1 cell\(s\) refused/);
  fs.writeFileSync(path.join(dir, "good.csv"), `${header}baron-fixture.Notice,{count} notices,\r\n`);
  const dry = runNode(TEXT_SHEET, ["import", "good.csv", ".", "--dry-run"], { cwd: dir });
  assert.equal(dry.status, 0, dry.out);
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Notice"], EN["baron-fixture.Notice"]);
  const good = runNode(TEXT_SHEET, ["import", "good.csv"], { cwd: dir });
  assert.equal(good.status, 0, good.out);
  assert.ok(good.stdout.trim().endsWith(SIGN_NEXT));
  assert.equal(readJson(dir, "lang", "en.json")["baron-fixture.Notice"], "{count} notices");

  assert.equal(runNode(TEXT_SHEET, []).status, 1);
  assert.equal(runNode(TEXT_SHEET, ["--help"]).status, 0);
  assert.match(runNode(TEXT_SHEET, ["export", "--sign"]).stderr, /unknown option --sign/);
  assert.match(runNode(TEXT_SHEET, ["import", "--all"]).stderr, /unknown option --all/);
  assert.match(runNode(TEXT_SHEET, ["import"], { cwd: dir }).stderr, /import needs the sheet/);
  assert.match(runNode(TEXT_SHEET, ["publish"]).stderr, /unknown command publish/);
  assert.match(runNode(TEXT_SHEET, ["export", "a", "b"]).stderr, /unexpected argument b/);
});
