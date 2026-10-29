// Helpers shared by sync-core.mjs, check-module.mjs, release-manifest.mjs,
// sign-text.mjs and text-sheet.mjs. Node built-ins and git only: the tools run
// on a dev's Windows box and on the Linux CI runner, with no npm install in
// between.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The core repo is the parent of tools/, wherever the tools are run from. */
export const CORE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const CORE_FILE = "baron-core.js";
export const LOCK_FILE = "baron-core.lock.json";
export const VENDORED_PATH = "scripts/baron-core.js";

/**
 * Git on Windows (core.autocrlf=true) may hand back CRLF; the hash, the copy
 * and the release zip must not depend on which machine produced them.
 * @param {string} text
 * @returns {string}
 */
export function toLf(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * sha256 of the LF-normalized text: the value stored in the lock.
 * @param {string} text
 * @returns {string} lowercase hex
 */
export function sha256Lf(text) {
  return createHash("sha256").update(Buffer.from(toLf(text), "utf8")).digest("hex");
}

/**
 * CORE_VERSION as declared on its export line, or null. Read with a regex, not
 * by importing the file, so a broken copy can still be diagnosed.
 * @param {string} text
 * @returns {string|null}
 */
export function readCoreVersion(text) {
  const m = /^export const CORE_VERSION = (["'])([^"'\r\n]+)\1;?[ \t]*\r?$/m.exec(text);
  return m ? m[2] : null;
}

/**
 * Matches a `uses:` line that calls a reusable workflow of the core repo.
 * Groups: 1 = everything up to and including "@", 2 = workflow path, 3 = ref.
 * GitHub treats owner/repo case-insensitively, so the match does too.
 */
export const USES_PIN_RE =
  /^([ \t]*(?:-[ \t]+)?uses:[ \t]*["']?BaronHVC\/pf2e-baron-core\/(\.github\/workflows\/[^@\s"']+)@)([^\s"'#]+)/gim;

/**
 * Workflow files of a module (.github/workflows/*.yml|*.yaml), sorted.
 * @param {string} moduleDir
 * @returns {string[]} paths relative to moduleDir, with forward slashes
 */
export function workflowFiles(moduleDir) {
  const dir = path.join(moduleDir, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => `.github/workflows/${e.name}`)
    .sort();
}

/**
 * Every core pin in a workflow text, with its 1-based line.
 * @param {string} text
 * @returns {{ workflow: string, ref: string, line: number }[]}
 */
export function findUsesPins(text) {
  const pins = [];
  for (const m of text.matchAll(USES_PIN_RE)) {
    const line = text.slice(0, m.index).split("\n").length;
    pins.push({ workflow: m[2], ref: m[3], line });
  }
  return pins;
}

/**
 * Runs git and returns stdout. execFile, not a shell: no quoting differences
 * between cmd, PowerShell and bash, and no MSYS path conversion of "<sha>:file".
 * @param {string} cwd repo passed as `git -C`
 * @param {string[]} args
 * @param {{ encoding?: BufferEncoding|"buffer" }} [opts]
 * @returns {string|Buffer}
 */
export function git(cwd, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: encoding === "buffer" ? undefined : encoding,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * Like git(), but returns null instead of throwing (for "does this ref exist").
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null} trimmed stdout
 */
export function gitTry(cwd, args) {
  try {
    return String(git(cwd, args)).trim();
  } catch {
    return null;
  }
}

/**
 * baron-core.js as committed at `commit`, LF-normalized. `git show` reads the
 * object database, so the tag never has to be checked out.
 * @param {string} coreDir
 * @param {string} commit
 * @returns {string}
 */
export function coreFileAt(coreDir, commit) {
  return toLf(git(coreDir, ["show", `${commit}:${CORE_FILE}`], { encoding: "buffer" }).toString("utf8"));
}

/**
 * Lock file text: 2-space JSON plus a trailing newline, fixed key order so a
 * resync to the same commit produces no diff.
 * @param {{ version: string, commit: string, sha256: string }} lock
 * @returns {string}
 */
export function lockText({ version, commit, sha256 }) {
  return JSON.stringify({ version, commit, sha256 }, null, 2) + "\n";
}

/**
 * Why `value` cannot be a protected module's landing page, or null when it
 * can: a non-empty https URL. check-module rule [m] reports it on every push;
 * release-manifest refuses to build without it, since it becomes the
 * manifest's "url".
 * @param {unknown} value
 * @returns {string|null}
 */
export function httpsUrlProblem(value) {
  if (value === undefined || value === null) return "is missing";
  if (typeof value !== "string") return "must be a string";
  if (!value.trim()) return "is empty";
  // URL() trims the ends and drops tabs and newlines, so it would accept a
  // value that is not the link actually written into the manifest.
  if (/\s/.test(value)) return `${JSON.stringify(value)} contains whitespace`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return `${JSON.stringify(value)} is not a URL`;
  }
  if (url.protocol !== "https:") return `${JSON.stringify(value)} is not an https URL`;
  return null;
}

/**
 * A link into GitHub, which can name a private repo: github.com and its
 * subdomains, the githubusercontent.com hosts that serve raw files and release
 * assets, and github.io Pages. Host names are case-insensitive, so the match
 * is too.
 */
export const GITHUB_HOST_RE = /github\.com|githubusercontent\.com|github\.io/i;

// URL parsing percent-decodes a host, so "github%2Ecom" still opens github.com.
const percentDecoded = (s) => s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

/**
 * Whether `text` mentions a GitHub host (GITHUB_HOST_RE), percent-escaped too.
 * @param {string} text
 * @returns {boolean}
 */
export const mentionsGitHub = (text) => GITHUB_HOST_RE.test(text) || GITHUB_HOST_RE.test(percentDecoded(text));

const JSON_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * JSON paths of every string under `value` that mentions a GitHub host, such
 * as "bugs" or "authors[0].url", and of every key that does, marked " (key)".
 * A paid module lives in a private repo, so such a link in its published
 * manifest is dead for players and names the repo.
 * @param {unknown} value
 * @param {string} [at] path of `value` itself
 * @returns {string[]}
 */
export function githubPaths(value, at = "") {
  if (typeof value === "string") return mentionsGitHub(value) ? [at || "(root)"] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => githubPaths(v, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const key = JSON_IDENT_RE.test(k) ? (at ? `${at}.${k}` : k) : `${at}[${JSON.stringify(k)}]`;
    // A key is published just like a value.
    return [...(mentionsGitHub(k) ? [`${key} (key)`] : []), ...githubPaths(v, key)];
  });
}

/**
 * githubPaths() output split in two: the module's own links, and those under
 * "relationships", usually the manifest of a public dependency. A protected
 * manifest refuses both, but the way out differs: a dependency is found by its
 * id once it is listed on foundryvtt.com.
 * @param {string[]} paths
 * @returns {{ own: string[], deps: string[] }}
 */
export function splitGitHubPaths(paths) {
  const isDep = (p) => /^relationships[.[]/.test(p);
  return { own: paths.filter((p) => !isDep(p)), deps: paths.filter(isDep) };
}

/* ----------------------------------------------------------------------------
 * Module files and language keys
 * -------------------------------------------------------------------------- */

/**
 * Files under `relDir` whose name passes `filter`, recursively (node_modules
 * skipped), sorted.
 * @param {string} root module folder
 * @param {string} relDir
 * @param {(name: string) => boolean} filter
 * @returns {string[]} paths relative to root, with forward slashes
 */
export function walk(root, relDir, filter) {
  const out = [];
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...walk(root, rel, filter));
    } else if (e.isFile() && filter(e.name)) out.push(rel);
  }
  return out.sort();
}

/**
 * The language files Foundry will load: module.json's "languages" list, else
 * every lang/*.json.
 * @param {string} root module folder
 * @param {object|null} module parsed module.json
 * @returns {{ lang: string, rel: string }[]}
 */
export function languageEntries(root, module) {
  const declared = Array.isArray(module?.languages) ? module.languages.filter((l) => l && typeof l.path === "string") : [];
  return declared.length
    ? declared.map((l) => ({ lang: String(l.lang ?? path.basename(l.path, ".json")), rel: l.path.replace(/^\.\//, "") }))
    : walk(root, "lang", (n) => n.endsWith(".json")).map((rel) => ({ lang: path.basename(rel, ".json"), rel }));
}

/**
 * Every leaf of a language file as [key, value], in file order. Foundry keys
 * may be nested objects or flat dotted strings; both mean the same key, so a
 * nested key is joined with dots. Anything that is not a plain object (a
 * string, an array, a number) is a leaf. check-module's key parity [d] and key
 * lookups [h] use the keys; the human-text signatures use keys and values.
 * @param {unknown} obj
 * @returns {[string, unknown][]}
 */
export function flattenLang(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenLang(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * Human text: Foundry's AI policy (publisher handbook 4.1) wants UI labels and
 * prepared text written by a person. check-module rule [n] reports the
 * placeholder marker always and, with baron.json "humanText": "signed", every
 * text that the author has not signed with sign-text.mjs.
 * -------------------------------------------------------------------------- */

/** Value of a text nobody has written yet: "TODO-HUMANO: <what it should say>". */
export const HUMAN_MARKER = "TODO-HUMANO:";
/** Fields of module.json that the package listing shows as prose. */
export const LISTING_FIELDS = ["title", "description"];
/** baron.json "humanText": absent or "markers" = the marker only; "signed" = the signature lock. */
export const HUMAN_TEXT_MODES = ["markers", "signed"];
/** The signatures, at the module root. The release ZIP never packs it. */
export const HUMAN_TEXT_FILE = "human-text.json";
export const HUMAN_TEXT_VERSION = 1;
/**
 * How sign-text is run from the module folder, as the docs write it: its
 * DEFAULT_COMMAND, here so that text-sheet can name it without importing
 * sign-text, which imports text-sheet.
 */
export const SIGN_TEXT_COMMAND = "node ../pf2e-baron-core/tools/sign-text.mjs .";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasString = (v) => typeof v === "string" || (v !== null && typeof v === "object" && Object.values(v).some(hasString));

/**
 * Whether a value is still the placeholder. Only a value that starts with the
 * marker counts (after leading whitespace): text that quotes it mid-sentence is
 * real text, and "todo-humano:" is not the marker.
 * @param {string} value
 */
export const isHumanPlaceholder = (value) => value.trimStart().startsWith(HUMAN_MARKER);

/**
 * sha256 of the exact string, as UTF-8: no trim, no line-ending or Unicode
 * normalization, so any change to the text needs a new signature. UTF-8 is
 * lossless only for a well-formed string: it turns every lone surrogate into
 * U+FFFD, so signatureStatus() never counts a string that is not well formed
 * as signed.
 * @param {string} value
 * @returns {string} lowercase hex
 */
export function hashText(value) {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

/**
 * The texts the lock covers: the module.json title and description, then every
 * value of each language file, keyed as flattenLang() keys them.
 * @param {object|null} module parsed module.json
 * @param {{ rel: string, data: unknown }[]} langFiles parsed language files
 * @returns {{ file: string, key: string, value: unknown }[]} a value is a string,
 *   or an array that holds strings (which cannot be signed)
 */
export function humanTexts(module, langFiles) {
  const out = [];
  if (isPlainObject(module)) {
    for (const key of LISTING_FIELDS) {
      if (Object.hasOwn(module, key) && typeof module[key] === "string") out.push({ file: "module.json", key, value: module[key] });
    }
  }
  for (const { rel, data } of langFiles) {
    const seen = new Set();
    for (const [key, value] of flattenLang(data)) {
      if (typeof value !== "string" && !(Array.isArray(value) && hasString(value))) continue;
      // The same key and value both nested and dotted is one text.
      const id = JSON.stringify([key, value]);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ file: rel, key, value });
    }
  }
  return out;
}

/**
 * Why `data` is not a valid human-text.json, or null:
 * { "version": 1, "signed": { "<file>": { "<key>": "<sha256 hex>" } } }.
 * @param {unknown} data
 * @returns {string|null}
 */
export function signaturesProblem(data) {
  const show = (v) => String(JSON.stringify(v));
  if (!isPlainObject(data)) return "must hold a JSON object";
  const extra = Object.keys(data).filter((k) => k !== "version" && k !== "signed");
  if (extra.length) return `has unknown key(s) ${extra.map(show).join(", ")}: only "version" and "signed" are allowed`;
  if (data.version !== HUMAN_TEXT_VERSION) return `has "version" ${show(data.version)}: it must be ${HUMAN_TEXT_VERSION}`;
  if (!isPlainObject(data.signed)) return 'needs "signed" to be an object of files';
  for (const [file, keys] of Object.entries(data.signed)) {
    if (!isPlainObject(keys)) return `has signed[${show(file)}] that is not an object of keys`;
    for (const [key, hash] of Object.entries(keys)) {
      if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) {
        return `has signed[${show(file)}][${show(key)}] that is not a sha256 (64 lowercase hex characters)`;
      }
    }
  }
  return null;
}

/**
 * Reads human-text.json from the module folder.
 * @param {string} root
 * @returns {{ missing: true, signed: object } | { error: string } | { signed: object }}
 *   `signed` is the file's "signed" map ({} when there is no file)
 */
export function readSignatures(root) {
  const file = path.join(root, HUMAN_TEXT_FILE);
  if (!fs.existsSync(file)) return { missing: true, signed: {} };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { error: `cannot be read: ${err.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const bom = text.charCodeAt(0) === 0xfeff ? " (the file starts with a UTF-8 BOM)" : "";
    return { error: `is not valid JSON: ${err.message}${bom}` };
  }
  const problem = signaturesProblem(data);
  return problem ? { error: problem } : { signed: data.signed };
}

/**
 * Each text with its signature status against `signed`, the "signed" map of
 * human-text.json:
 *   "signed"     the hash of the current value is recorded
 *   "unsigned"   no signature for this file and key
 *   "changed"    a signature exists, for another value
 *   "unwritten"  empty, or still a TODO-HUMANO: placeholder: nothing to sign yet
 *   "conflict"   the file defines the key twice (nested and dotted) with different values
 *   "list"       an array holds the text: only a string value can be signed
 *   "illformed"  the string holds a lone UTF-16 surrogate (a JSON escape of
 *                half a pair): its hash would not tell it from another value
 * @param {{ file: string, key: string, value: unknown }[]} texts from humanTexts()
 * @param {object} signed
 * @returns {{ file: string, key: string, value: unknown, status: string }[]}
 */
export function signatureStatus(texts, signed) {
  const values = new Map();
  for (const t of texts) {
    const id = JSON.stringify([t.file, t.key]);
    values.set(id, [...(values.get(id) ?? []), t.value]);
  }
  return texts.map((t) => {
    const all = values.get(JSON.stringify([t.file, t.key]));
    const keys = Object.hasOwn(signed, t.file) ? signed[t.file] : null;
    const recorded = keys && Object.hasOwn(keys, t.key) ? keys[t.key] : null;
    let status;
    if (typeof t.value !== "string") status = "list";
    else if (!t.value.isWellFormed()) status = "illformed";
    else if (all.some((v) => v !== t.value)) status = "conflict";
    else if (!t.value.trim() || isHumanPlaceholder(t.value)) status = "unwritten";
    else if (recorded === hashText(t.value)) status = "signed";
    else status = recorded === null ? "unsigned" : "changed";
    return { ...t, status };
  });
}

/**
 * Signatures for a file and key that no longer hold a text.
 * @param {{ file: string, key: string }[]} texts
 * @param {object} signed
 * @returns {{ file: string, key: string }[]}
 */
export function staleSignatures(texts, signed) {
  const live = new Set(texts.map((t) => JSON.stringify([t.file, t.key])));
  return Object.entries(signed).flatMap(([file, keys]) =>
    Object.keys(keys).filter((key) => !live.has(JSON.stringify([file, key]))).map((key) => ({ file, key })),
  );
}

/**
 * JSON text with the keys sorted at every level, 2-space indent, LF and a
 * trailing newline. Written by hand rather than with JSON.stringify(obj, null,
 * 2), which would put a key that looks like an array index ("2", "10") first
 * whatever the sort says.
 */
function sortedJsonText(data) {
  const write = (value, indent) => {
    if (!isPlainObject(value)) return JSON.stringify(value);
    const keys = Object.keys(value).sort();
    if (!keys.length) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${write(value[k], inner)}`).join(",\n")}\n${indent}}`;
  };
  return `${write(data, "")}\n`;
}

/**
 * human-text.json text: keys sorted at every level, 2-space indent, LF and a
 * trailing newline, so signing the same texts again produces no diff.
 * @param {object} signed file -> key -> sha256
 * @returns {string}
 */
export function signaturesText(signed) {
  return sortedJsonText({ version: HUMAN_TEXT_VERSION, signed });
}

/* ----------------------------------------------------------------------------
 * Who wrote each signed text: human-text-authors.json, next to
 * human-text.json. sign-text --sign --author <name> and --sign --sheet record
 * the author with each signature they give, for the person who attests the
 * texts to Foundry and signs for an author without a terminal. check-module
 * never reads it, and the release ZIP never packs it.
 * -------------------------------------------------------------------------- */

/** The authors, at the module root, committed like human-text.json. */
export const HUMAN_TEXT_AUTHORS_FILE = "human-text-authors.json";
export const HUMAN_TEXT_AUTHORS_VERSION = 1;
/** The longest author name, in characters (code points), after trimming. */
export const AUTHOR_NAME_MAX = 60;

// What a name cannot hold besides a control character: a character that prints
// nothing (format characters such as a zero-width space, a soft hyphen or a
// direction mark; the line and paragraph separators) or nothing defined (private
// use), so "IAR18" plus one of them would look like IAR18 and be another author.
const INVISIBLE_RE = /[\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u;
// Noncharacters: U+FDD0 to U+FDEF and the last two code points of every plane.
const isNonCharacter = (cp) => (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
const BACKSLASH = String.fromCharCode(92);

/**
 * An author name as it is recorded: trimmed and in Unicode NFC, so a name
 * typed with a precomposed accent or with a combining one is one author.
 * @param {string} name
 * @returns {string}
 */
export const authorName = (name) => name.trim().normalize("NFC");

/**
 * A name for a message: as JSON, with every control, invisible or
 * noncharacter written as its escape, so a name that only looks like another
 * one shows the difference.
 * @param {string} name
 * @returns {string}
 */
export function showName(name) {
  const escape = (c) => [...c].map((_, i) => `${BACKSLASH}u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
  return [...JSON.stringify(String(name))].map((c) => (/\p{Cc}/u.test(c) || INVISIBLE_RE.test(c) || isNonCharacter(c.codePointAt(0)) ? escape(c) : c)).join("");
}

/**
 * Why `name` cannot name an author, or null. It is trimmed and put in NFC
 * first (authorName()): what is left must be 1 to AUTHOR_NAME_MAX characters,
 * none of them a control character or one that prints nothing.
 * @param {unknown} name
 * @returns {string|null}
 */
export function authorNameProblem(name) {
  if (typeof name !== "string") return "must be a name";
  if (!name.isWellFormed()) return "holds a lone UTF-16 surrogate";
  const s = authorName(name);
  if (!s) return "is empty: give the name of the person who wrote the texts";
  if (/\p{Cc}/u.test(s)) return `${showName(s)} holds a control character (a tab, a line break or another invisible one)`;
  if (INVISIBLE_RE.test(s) || [...s].some((c) => isNonCharacter(c.codePointAt(0)))) {
    return `${showName(s)} holds a character that prints nothing (a zero-width space, a soft hyphen, a direction mark, a line or paragraph separator, a private-use character or a noncharacter): it would look like another name`;
  }
  const length = [...s].length;
  if (length > AUTHOR_NAME_MAX) return `is ${length} characters long: an author name has ${AUTHOR_NAME_MAX} at most`;
  return null;
}

/**
 * Why `data` is not a valid human-text-authors.json, or null:
 * { "version": 1, "authors": { "<file>": { "<key>": "<name>" } } }, each name
 * as authorNameProblem() accepts it and as authorName() records it.
 * @param {unknown} data
 * @returns {string|null}
 */
export function authorsProblem(data) {
  const show = (v) => String(JSON.stringify(v));
  if (!isPlainObject(data)) return "must hold a JSON object";
  const extra = Object.keys(data).filter((k) => k !== "version" && k !== "authors");
  if (extra.length) return `has unknown key(s) ${extra.map(show).join(", ")}: only "version" and "authors" are allowed`;
  if (data.version !== HUMAN_TEXT_AUTHORS_VERSION) return `has "version" ${show(data.version)}: it must be ${HUMAN_TEXT_AUTHORS_VERSION}`;
  if (!isPlainObject(data.authors)) return 'needs "authors" to be an object of files';
  for (const [file, keys] of Object.entries(data.authors)) {
    if (!isPlainObject(keys)) return `has authors[${show(file)}] that is not an object of keys`;
    for (const [key, name] of Object.entries(keys)) {
      const problem = authorNameProblem(name) ?? (name !== name.trim() ? "spaces at an end" : name !== authorName(name) ? "not in Unicode NFC, as sign-text records it" : null);
      if (problem) return `has authors[${show(file)}][${show(key)}] that is not an author name (${problem})`;
    }
  }
  return null;
}

/**
 * Reads human-text-authors.json from the module folder.
 * @param {string} root
 * @returns {{ missing: true, authors: object } | { error: string } | { authors: object }}
 *   `authors` is the file's "authors" map ({} when there is no file)
 */
export function readAuthors(root) {
  const file = path.join(root, HUMAN_TEXT_AUTHORS_FILE);
  if (!fs.existsSync(file)) return { missing: true, authors: {} };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { error: `cannot be read: ${err.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const bom = text.charCodeAt(0) === 0xfeff ? " (the file starts with a UTF-8 BOM)" : "";
    return { error: `is not valid JSON: ${err.message}${bom}` };
  }
  const problem = authorsProblem(data);
  return problem ? { error: problem } : { authors: data.authors };
}

/**
 * human-text-authors.json text, in the format of human-text.json: keys sorted
 * at every level, 2-space indent, LF and a trailing newline.
 * @param {object} authors file -> key -> name
 * @returns {string}
 */
export function authorsText(authors) {
  return sortedJsonText({ version: HUMAN_TEXT_AUTHORS_VERSION, authors });
}

/* ----------------------------------------------------------------------------
 * The text sheet's CSV reader: text-sheet import reads the sheet with it, and
 * sign-text --sign --sheet reads the same sheet the same way.
 * -------------------------------------------------------------------------- */

// Built from char codes so this file stays ASCII.
const SHEET_BOM = String.fromCharCode(0xfeff);

/** The columns before the language columns, in this order. */
export const FIXED_COLUMNS = ["key", "where", "intent", "placeholders", "max_length", "status"];
/** current_<lang>: the signed value, the only value the sheet ever shows. */
export const CURRENT_PREFIX = "current_";
/** After the current_<lang> columns: who wrote the row's texts (import only echoes it; sign-text --sheet records it). */
export const AUTHOR_COLUMN = "author";
/** The last column: the heading above the row's table in the draft, to sort and filter by screen. */
export const SECTION_COLUMN = "section";
/** Headers read as the author column. */
export const AUTHOR_HEADERS = [AUTHOR_COLUMN, "autor"];
/** Columns a person may add for their own notes: import ignores them. Any other column with text is refused. */
export const NOTE_COLUMNS = ["notas", "nota", "notes", "note", "comentarios", "comments"];
/** Key of a module.json listing field in the sheet: "module.json:title". */
export const LISTING_PREFIX = "module.json:";

const DELIMITERS = [",", ";", "\t"];

/** A problem with the module or the sheet that stops the tool (exit 1), never a crash. */
export class TextSheetError extends Error {
  /** @param {string} message @param {{ usage?: boolean }} [opts] usage: a mistake in the arguments, so the CLI adds its usage */
  constructor(message, { usage = false } = {}) {
    super(message);
    this.usage = usage;
  }
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
  let s = text.startsWith(SHEET_BOM) ? text.slice(1) : text;
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

/**
 * A saved sheet: its records and where its columns are, by header name (case
 * and surrounding spaces do not matter): "key", one column per language of
 * `langs`, their current_<lang> columns and "author". The header is the record
 * with "key" and a language, wherever a sort put it (else the first with
 * "key"); every other record that is not empty is data. The export's other
 * columns are ignored; `notes` are columns for a person's notes, `unknown`
 * every other column (import refuses one that holds text).
 */
export function readSheet(buf, langs) {
  const { delimiter, records } = csvParse(decodeSheet(buf));
  const blank = (r) => r.fields.every((f) => !f.trim());
  const namesOf = (r) => r.fields.map((f) => f.trim().toLowerCase());
  const langOf = (name) => langs.find((l) => l.toLowerCase() === name);
  let at = records.findIndex((r) => namesOf(r).includes("key") && namesOf(r).some((n) => langOf(n)));
  if (at < 0) at = records.findIndex((r) => namesOf(r).includes("key"));
  const data = records.filter((r, i) => i !== at && !blank(r));
  if (at < 0) return { delimiter, records: data, keyIdx: -1, langCols: [], currentCols: [], authorIdx: -1, notes: [], unknown: [], header: null };
  const header = records[at];
  const names = namesOf(header);
  const langCols = [];
  const currentCols = [];
  const notes = [];
  const unknown = [];
  let authorIdx = -1;
  names.forEach((name, idx) => {
    if (FIXED_COLUMNS.includes(name) || name === SECTION_COLUMN) return;
    const lang = langOf(name);
    const cur = name.startsWith(CURRENT_PREFIX) ? langOf(name.slice(CURRENT_PREFIX.length)) : undefined;
    if (lang) langCols.push({ lang, idx });
    else if (cur) currentCols.push({ lang: cur, idx });
    else if (AUTHOR_HEADERS.includes(name) && authorIdx < 0) authorIdx = idx;
    else if (NOTE_COLUMNS.includes(name)) notes.push({ name: header.fields[idx].trim(), idx });
    else unknown.push({ name: header.fields[idx].trim(), idx });
  });
  return { delimiter, records: data, keyIdx: names.indexOf("key"), langCols, currentCols, authorIdx, notes, unknown, header };
}

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);
// After one of these, "/" starts a regex literal rather than a division.
const REGEX_PUNCT = "(,=:[!&|?{};+-*%<>~^}";

/**
 * Minimal JavaScript scanner: blanks comments (keeping newlines, so offsets and
 * line numbers stay valid) and collects string and template literals. Not a
 * parser: enough to keep the static checks from matching inside comments or
 * mistaking a quote inside a regex for the start of a string.
 * @param {string} src
 * @returns {{
 *   code: string,
 *   bare: string,
 *   strings: { value: string|null, head: string, quote: string, start: number, end: number, interpolated: boolean }[],
 *   lineOf: (offset: number) => number,
 * }}
 *   `code` is `src` with comments replaced by spaces; `bare` also blanks the
 *   text of string, template (not the `${}` expressions) and regex literals,
 *   so a pattern matched on it is real code, never text inside a literal. For a
 *   template literal with `${}`, `value` is null and `head` is the text before
 *   the first `${`.
 */
export function scanJs(src) {
  const n = src.length;
  const code = src.split("");
  const strings = [];
  const textRanges = []; // [start, end) of literal text, blanked in `bare`
  const stack = []; // open `${` expressions: the template and the brace depth to return at
  let depth = 0;
  let lastSig = "";
  let i = 0;

  const blank = (arr, a, b) => {
    for (let k = a; k < b; k++) if (arr[k] !== "\n" && arr[k] !== "\r") arr[k] = " ";
  };

  // Reads template text from j until the closing backtick or a `${`.
  const readTemplate = (j, tpl) => {
    const from = j;
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        tpl.raw += src.slice(j, j + 2);
        j += 2;
      } else if (c === "`") {
        textRanges.push([from, j]);
        tpl.end = j + 1;
        if (tpl.interpolated) tpl.value = null;
        else tpl.value = unescapeJs(tpl.raw);
        lastSig = "`";
        return j + 1;
      } else if (c === "$" && src[j + 1] === "{") {
        textRanges.push([from, j]);
        if (!tpl.interpolated) tpl.head = unescapeJs(tpl.raw);
        tpl.interpolated = true;
        tpl.raw += "${";
        stack.push({ tpl, depth });
        lastSig = "(";
        return j + 2;
      } else {
        tpl.raw += c;
        j++;
      }
    }
    textRanges.push([from, n]);
    tpl.end = n;
    tpl.value = tpl.interpolated ? null : unescapeJs(tpl.raw);
    return n;
  };

  const skipRegex = (start) => {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === "\n" || c === "\r") return -1;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (inClass) {
        if (c === "]") inClass = false;
      } else if (c === "[") inClass = true;
      else if (c === "/") {
        j++;
        while (j < n && /[A-Za-z]/.test(src[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  };

  if (src.startsWith("#!")) {
    const e = src.indexOf("\n");
    blank(code, 0, e < 0 ? n : e);
    i = e < 0 ? n : e;
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(code, i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(code, i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let raw = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          raw += src.slice(j, j + 2);
          j += 2;
        } else raw += src[j++];
      }
      textRanges.push([i + 1, Math.min(j, n)]);
      const value = unescapeJs(raw);
      strings.push({ value, head: value, quote: c, start: i, end: j + 1, interpolated: false });
      lastSig = c;
      i = j + 1;
    } else if (c === "`") {
      const tpl = { value: null, head: "", quote: "`", start: i, end: n, interpolated: false, raw: "" };
      strings.push(tpl);
      i = readTemplate(i + 1, tpl);
      if (!tpl.interpolated) tpl.head = tpl.value ?? "";
    } else if (c === "{") {
      depth++;
      lastSig = "{";
      i++;
    } else if (c === "}") {
      const top = stack[stack.length - 1];
      if (top && top.depth === depth) {
        stack.pop();
        i = readTemplate(i + 1, top.tpl);
      } else {
        depth--;
        lastSig = "}";
        i++;
      }
    } else if (c === "/") {
      const regexOk = lastSig === "" || REGEX_KEYWORDS.has(lastSig) || (lastSig.length === 1 && REGEX_PUNCT.includes(lastSig));
      const j = regexOk ? skipRegex(i) : -1;
      if (j > 0) {
        // A regex body is pattern text, like a string: blank it in `bare` too.
        textRanges.push([i + 1, j]);
        lastSig = "regex";
        i = j;
      } else {
        lastSig = "/";
        i++;
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      lastSig = src.slice(i, j);
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      lastSig = "0";
      i = j;
    } else {
      if (!/\s/.test(c)) lastSig = c;
      i++;
    }
  }

  for (const s of strings) delete s.raw;
  const bare = code.slice();
  for (const [a, b] of textRanges) blank(bare, a, b);

  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  return { code: code.join(""), bare: bare.join(""), strings, lineOf };
}

/* ----------------------------------------------------------------------------
 * Language keys used by a module's code: check-module rule [h] checks them
 * against lang/en.json, and text-sheet lists them as the places that show
 * each text. One scan, so both always agree on where a key is used.
 * -------------------------------------------------------------------------- */

// Foundry namespaces other identifiers as "<id>.<name>" too, and with the
// default i18n prefix (the module id) they look like lang keys. A literal in
// one of these call positions is an identifier, never a key: hook names
// (Hooks.on/once/off/call/callAll), query names (CONFIG.queries[...],
// user.query(...)) and setting ids (game.settings.settings.get(...)).
const NOT_A_KEY_RE = /(?:(?<![\w$])Hooks\s*\.\s*(?:on|once|off|call|callAll)\s*\(|(?<![\w$])queries\s*\[|\.\s*query\s*\(|(?<![\w$])settings\s*\.\s*(?:get|has|set|delete)\s*\()\s*$/;

/**
 * The module's own scripts: every .js and .mjs file under scripts/ except
 * the vendored core, as check-module reads them.
 * @param {string} root module folder
 * @returns {string[]}
 */
export function ownScripts(root) {
  return walk(root, "scripts", (n) => /\.m?js$/i.test(n)).filter((s) => s !== VENDORED_PATH);
}

/**
 * Static references to the language keys under `prefix` in the module's own
 * scripts (`i18n("X")` is "<prefix>.X", and a "<prefix>.X" literal outside a
 * hook, query or setting call) and in the .hbs and .html files under
 * templates/ (`{{localize "<prefix>.X"}}`, Handlebars comments skipped), in
 * that order.
 * A key built at runtime is not a reference: the text before its first `${}`
 * (or before a `+`) comes back as a dynamic head instead.
 * @param {{
 *   root: string,
 *   prefix: string,
 *   scripts: string[],
 *   text?: (rel: string) => string,
 *   scan?: (rel: string) => ReturnType<typeof scanJs>,
 * }} opts `text` reads a file LF-normalized and `scan` scans a script; by
 *   default both read from `root` (check-module passes its cached ones)
 * @returns {{
 *   refs: { key: string, loc: { file: string, line: number } }[],
 *   dynamic: { head: string, loc: { file: string, line: number } }[],
 * }}
 */
export function i18nRefs({ root, prefix, scripts, text, scan }) {
  const read = text ?? ((rel) => toLf(fs.readFileSync(path.join(root, rel), "utf8")));
  const scanOf = scan ?? ((rel) => scanJs(read(rel)));
  const head = `${prefix}.`;
  const refs = [];
  const dynamic = [];

  for (const rel of scripts) {
    const { code, strings, lineOf } = scanOf(rel);
    for (const s of strings) {
      const before = code.slice(Math.max(0, s.start - 60), s.start);
      const after = code.slice(s.end, s.end + 20);
      const plusAfter = /^\s*\+/.test(after);
      const plusBefore = /\+\s*$/.test(before);
      const loc = { file: rel, line: lineOf(s.start) };
      if (/(?<![\w$.])i18n\s*\(\s*$/.test(before)) {
        // i18n("X") resolves to "<prefix>.X"; a computed argument is skipped.
        if (s.value !== null && !plusAfter && /^\s*\)/.test(after)) {
          refs.push({ key: head + s.value, loc });
        } else if (s.head) dynamic.push({ head: head + s.head, loc });
        continue;
      }
      const value = s.value ?? s.head;
      if (!value.startsWith(head)) continue;
      if (NOT_A_KEY_RE.test(before)) continue;
      if (s.value === null || plusAfter || plusBefore) {
        if (value.length > head.length) dynamic.push({ head: value, loc });
        continue;
      }
      if (/\s/.test(value)) continue; // prose that happens to start with the prefix
      refs.push({ key: value, loc });
    }
  }

  for (const rel of walk(root, "templates", (n) => /\.(hbs|html)$/i.test(n))) {
    // Handlebars comments may quote keys that no longer exist.
    const src = read(rel).replace(/\{\{!--[\s\S]*?--\}\}|\{\{![\s\S]*?\}\}/g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of src.matchAll(/\blocalize\s+(["'])([^"'\n]+)\1/g)) {
      if (!m[2].startsWith(head)) continue;
      refs.push({ key: m[2], loc: { file: rel, line: src.slice(0, m.index).split("\n").length } });
    }
  }
  return { refs, dynamic };
}

/** Resolves the escapes that can appear in an i18n key or a path; others pass through. */
function unescapeJs(raw) {
  return raw.replace(/\\(?:\r\n|\n|(.))/g, (_, ch) => {
    if (ch === undefined) return "";
    return { n: "\n", r: "\r", t: "\t", 0: "\0" }[ch] ?? ch;
  });
}
