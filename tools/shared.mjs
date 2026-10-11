// Helpers shared by sync-core.mjs and check-module.mjs. Node built-ins and git
// only: the tools run on a dev's Windows box and on the Linux CI runner, with
// no npm install in between.

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
