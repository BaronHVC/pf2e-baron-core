// Checks test/legacy/swe-v0.12.0.mjs against the SWE release it claims to copy,
// so the parity tests compare baron-core with what actually shipped and not
// with a copy that drifted.
//
// Every "// @verbatim <file>..." ... "// @end" region must appear, line for
// line, in scripts/<file> of SWE_COMMIT for each file it names (line endings
// normalized to LF, so a CRLF checkout compares equal). Regions opened with
// "@verbatim-statements" hold statements lifted out of a method body: their
// indentation depends on how deep they sat in each file, so both sides are
// compared after removing their common indentation, and nothing else.
//
// Read-only on the SWE checkout: objects of a fixed commit are read with
// `git cat-file --batch`, optional locks off, because another working tree may
// be busy in there. Library only: test/legacy-verbatim.test.mjs runs it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SWE_TAG = "v0.12.0";
export const SWE_COMMIT = "d15a90a17b1dbf746c62be4589e4d903d2e98b54";
export const LEGACY_FILE = fileURLToPath(new URL("./swe-v0.12.0.mjs", import.meta.url));
const CORE_ROOT = resolve(dirname(LEGACY_FILE), "..", "..");

// Fetched up front with the commit itself, in the same git process.
const USUAL_FILES = ["main.js", "armor.js"];

// What the parity tests rely on. Each entry must start a line inside some
// region (of the statements kind when `statements` is set), so deleting a
// region cannot quietly turn a verified copy into an unverified one.
export const REQUIRED = [
  { starts: "const MODULE_ID = " },
  { starts: "const DIES = " },
  { starts: "const BONUS_TYPES = " },
  { starts: "function isValuedCondition(" },
  { starts: "function slugOf(" },
  { starts: "function resolveLabel(" },
  { starts: "function i18n(" },
  { starts: "function locRecord(" },
  { starts: "function labelFor(" },
  { starts: "function clampInt(" },
  { starts: "function guardClicks(" },
  { starts: "function releaseClickGuard(" },
  { starts: "function renderSoon(" },
  { starts: "static async runeIndex(" },
  { starts: "const TE = ", statements: true },
  { starts: "const FDE = ", statements: true },
  { starts: "const el = sheet.element", statements: true },
  { starts: "function isSoleExecutor(" },
  { starts: "function escHTML(" },
  { starts: "function canEdit(" },
  { starts: "function injectButton(" },
  { starts: "async function equipmentIndex(" },
  { starts: "function injectArmorButton(" }
];

const OPEN = /^\s*\/\/ @verbatim(-statements)?((?: [\w.-]+)*)\s*$/;
const CLOSE = /^\s*\/\/ @end\s*$/;

/** Where the SWE checkout is expected: $SWE_REPO, else a sibling of this repo. */
export function defaultSweRepo() {
  return process.env.SWE_REPO || resolve(CORE_ROOT, "..", "pf2e-simple-weapon-editor");
}

/* ------------------------------------------------------------- git objects */

// Starting git can take seconds on some Windows machines and these objects
// never change, so each one is read once per process, in as few spawns as
// possible. Keyed by repo and object name; null means "missing".
const OBJECTS = new Map();

function catFileBatch(repo, names) {
  const buf = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: names.join("\n") + "\n",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const out = [];
  let pos = 0;
  for (const name of names) {
    const eol = buf.indexOf(10, pos);
    if (eol < 0) throw new Error(`git cat-file: no answer for ${name}`);
    const header = buf.toString("utf8", pos, eol);
    pos = eol + 1;
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(header);
    if (!m) {
      out.push(null); // "<name> missing" or "<name> ambiguous"
      continue;
    }
    const size = Number(m[3]);
    out.push({ sha: m[1], type: m[2], text: buf.toString("utf8", pos, pos + size) });
    pos += size + 1; // content is followed by a newline
  }
  return out;
}

function objects(repo, names) {
  const key = (n) => `${repo}\0${n}`;
  const todo = names.filter((n) => !OBJECTS.has(key(n)));
  if (todo.length) catFileBatch(repo, todo).forEach((o, i) => OBJECTS.set(key(todo[i]), o));
  return names.map((n) => OBJECTS.get(key(n)));
}

const fileSpec = (file) => `${SWE_COMMIT}:scripts/${file}`;

/**
 * Whether the SWE release can be read from `repo`.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function sweAvailability(repo = defaultSweRepo()) {
  if (!existsSync(repo)) return { ok: false, reason: `SWE checkout not found at ${repo} (set SWE_REPO to use another path)` };
  let commit;
  try {
    [commit] = objects(repo, [`${SWE_COMMIT}^{commit}`, `${SWE_TAG}^{commit}`, ...USUAL_FILES.map(fileSpec)]);
  } catch (err) {
    return { ok: false, reason: `git cannot read ${repo}: ${String(err.message).split("\n")[0]}` };
  }
  if (!commit) return { ok: false, reason: `commit ${SWE_COMMIT} (${SWE_TAG}) is not available in ${repo}` };
  return { ok: true };
}

/* ------------------------------------------------------------------ regions */

/**
 * Splits the legacy file into its verbatim regions.
 * @param {string} text
 * @returns {Array<{line: number, files: string[], statements: boolean, lines: string[]}>}
 *   `line` is the 1-based line of the opening marker.
 */
export function parseRegions(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const regions = [];
  let open = null;
  lines.forEach((l, i) => {
    const m = OPEN.exec(l);
    if (m) {
      if (open) throw new Error(`line ${i + 1}: @verbatim inside the region opened at line ${open.line}`);
      const files = m[2].trim().split(/\s+/).filter(Boolean);
      if (!files.length) throw new Error(`line ${i + 1}: @verbatim names no file`);
      for (const f of files) if (!/^[\w.-]+\.js$/.test(f)) throw new Error(`line ${i + 1}: "${f}" is not a script name`);
      open = { line: i + 1, files, statements: !!m[1], lines: [] };
      return;
    }
    if (CLOSE.test(l)) {
      if (!open) throw new Error(`line ${i + 1}: @end without @verbatim`);
      if (!open.lines.some((x) => x.trim())) throw new Error(`line ${open.line}: empty region`);
      regions.push(open);
      open = null;
      return;
    }
    // A near-miss marker would silently leave lines unverified.
    if (/^\s*\/\/\s*@(verbatim|end)/.test(l)) throw new Error(`line ${i + 1}: malformed marker: ${l.trim()}`);
    if (open) open.lines.push(l);
  });
  if (open) throw new Error(`line ${open.line}: region never closed with // @end`);
  return regions;
}

/** Removes the indentation shared by every non-blank line. */
export function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.trim() ? l.slice(cut) : ""));
}

/**
 * First 0-based line of `source` where `block` appears, or -1.
 * @param {string[]} source
 * @param {string[]} block
 * @param {{statements?: boolean}} [o]  Compare ignoring common indentation.
 */
export function findBlock(source, block, { statements = false } = {}) {
  const want = statements ? dedent(block) : block;
  const first = want[0].trim();
  for (let i = 0; i + want.length <= source.length; i++) {
    if (source[i].trim() !== first) continue;
    const got = source.slice(i, i + want.length);
    const cmp = statements ? dedent(got) : got;
    if (cmp.every((l, k) => l === want[k])) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------- verify */

/**
 * Verifies every region of the legacy file against the SWE release.
 * @param {object} [o]
 * @param {string} [o.repo]  SWE checkout (default: defaultSweRepo()).
 * @param {string} [o.legacyText]  Legacy source (default: the file on disk).
 * @returns {{skipped: string} | {regions: object[], failures: string[]}}
 */
export function verifyLegacy({ repo = defaultSweRepo(), legacyText } = {}) {
  const avail = sweAvailability(repo);
  if (!avail.ok) return { skipped: avail.reason };

  const failures = [];
  // A moved tag means v0.12.0 was re-released; the copies follow the commit,
  // so say so instead of silently comparing against something else. A clone
  // without the tag is fine: the commit alone pins the source.
  const [tagged] = objects(repo, [`${SWE_TAG}^{commit}`]);
  if (tagged && tagged.sha !== SWE_COMMIT) failures.push(`${SWE_TAG} points to ${tagged.sha}, not ${SWE_COMMIT}`);

  const text = legacyText ?? readFileSync(LEGACY_FILE, "utf8");
  let regions;
  try {
    regions = parseRegions(text);
  } catch (err) {
    return { regions: [], failures: [...failures, `swe-v0.12.0.mjs: ${err.message}`] };
  }

  const files = [...new Set(regions.flatMap((r) => r.files))];
  const blobs = objects(repo, files.map(fileSpec));
  const sources = new Map();
  files.forEach((file, i) => {
    const blob = blobs[i];
    if (!blob || blob.type !== "blob") failures.push(`scripts/${file} does not exist at ${SWE_COMMIT}`);
    else sources.set(file, blob.text.replace(/\r\n/g, "\n").split("\n"));
  });

  const report = regions.map((r) => {
    const found = {};
    for (const file of r.files) {
      const src = sources.get(file);
      if (!src) continue;
      const at = findBlock(src, r.lines, { statements: r.statements });
      found[file] = at < 0 ? null : at + 1;
      if (at < 0) {
        const head = r.lines.find((l) => l.trim()).trim();
        failures.push(`region at line ${r.line} ("${head}") is not in ${SWE_TAG}:scripts/${file}`);
      }
    }
    return { line: r.line, files: r.files, statements: r.statements, size: r.lines.length, found };
  });

  for (const req of REQUIRED) {
    const covered = regions.some(
      (r) => (!req.statements || r.statements) && r.lines.some((l) => l.trim().startsWith(req.starts))
    );
    if (!covered) failures.push(`no ${req.statements ? "@verbatim-statements" : "@verbatim"} region holds "${req.starts}"`);
  }

  return { regions: report, failures };
}
