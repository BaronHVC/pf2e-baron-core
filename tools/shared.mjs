// Helpers shared by sync-core.mjs, check-module.mjs, release-manifest.mjs and
// sign-text.mjs. Node built-ins and git only: the tools run on a dev's Windows
// box and on the Linux CI runner, with no npm install in between.

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
 * normalization, so any change to the text needs a new signature.
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
 * human-text.json text: keys sorted at every level, 2-space indent, LF and a
 * trailing newline, so signing the same texts again produces no diff. Written
 * by hand rather than with JSON.stringify(obj, null, 2), which would put a key
 * that looks like an array index ("2", "10") first whatever the sort says.
 * @param {object} signed file -> key -> sha256
 * @returns {string}
 */
export function signaturesText(signed) {
  const write = (value, indent) => {
    if (!isPlainObject(value)) return JSON.stringify(value);
    const keys = Object.keys(value).sort();
    if (!keys.length) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${write(value[k], inner)}`).join(",\n")}\n${indent}}`;
  };
  return `${write({ version: HUMAN_TEXT_VERSION, signed }, "")}\n`;
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

/** Resolves the escapes that can appear in an i18n key or a path; others pass through. */
function unescapeJs(raw) {
  return raw.replace(/\\(?:\r\n|\n|(.))/g, (_, ch) => {
    if (ch === undefined) return "";
    return { n: "\n", r: "\r", t: "\t", 0: "\0" }[ch] ?? ch;
  });
}
