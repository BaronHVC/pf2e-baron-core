#!/usr/bin/env node
// check-module: static checks for a BaronHVC Foundry module, run locally
// before tagging and by the reusable module-check / module-release workflows.
//
//   node <core>/tools/check-module.mjs [moduleDir=cwd] [--core-repo <path>] [--online] [--parity warn|error] [--release]
//
// Every check prints PASS / FAIL / WARN / NOTICE; under GitHub Actions the
// findings are also emitted as annotations. Exit code 1 on any FAIL.
// --release is for the tag build: what a push may still carry (text waiting
// for a person to write it, a legal notice waiting for the author to fill or
// sign it off) fails instead of warning.
//
//   [a] declared files exist      [g] imports stay inside the module, no top-level await
//   [b] scripts parse as ESM      [h] static i18n keys exist in lang/en.json
//   [c] JSON files parse          [i] persisted identifiers still present
//   [d] language key parity       [j] manifest rules (no protected key, no core dependency)
//   [e] vendored core vs lock     [k] no leftover template placeholders
//   [f] lock vs core repo (--online)
//   [l] Paizo license: baron.json "paizo" agrees with the mode and with NOTICE.md; no unfilled
//       ORC field and no "PENDIENTE:" line left in NOTICE.md (FAIL with --release)
//   [m] protected packaging: a paid module has a landing page, requires its free base and never links to GitHub
//   [n] human text: no "TODO-HUMANO:" value left in lang files or module.json title/description (FAIL with --release)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CORE_DIR,
  LOCK_FILE,
  VENDORED_PATH,
  coreFileAt,
  findUsesPins,
  flattenLang,
  githubPaths,
  gitTry,
  httpsUrlProblem,
  languageEntries,
  mentionsGitHub,
  readCoreVersion,
  scanJs,
  sha256Lf,
  splitGitHubPaths,
  toLf,
  walk,
  workflowFiles,
} from "./shared.mjs";

const USAGE = "usage: node check-module.mjs [moduleDir] [--core-repo <path>] [--online] [--parity warn|error] [--release]";
const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*__/g;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/* ----------------------------------------------------------------------------
 * Arguments and output
 * -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { moduleDir: null, coreRepo: null, online: false, parity: null, release: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--online") opts.online = true;
    else if (a === "--release") opts.release = true;
    else if (a === "--core-repo") {
      opts.coreRepo = argv[++i];
      if (!opts.coreRepo) usage("--core-repo needs a path");
    } else if (a.startsWith("--core-repo=")) opts.coreRepo = a.slice(12);
    else if (a === "--parity") opts.parity = argv[++i];
    else if (a.startsWith("--parity=")) opts.parity = a.slice(9);
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) usage(`unknown option ${a}`);
    else if (opts.moduleDir === null) opts.moduleDir = a;
    else usage(`unexpected argument ${a}`);
  }
  if (opts.parity !== null && !["warn", "error"].includes(opts.parity)) usage("--parity takes warn or error");
  return opts;
}

function usage(message) {
  console.error(`check-module: ERROR: ${message}\n${USAGE}`);
  process.exit(1);
}

// Workflow command escaping, from the GitHub Actions toolkit.
const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
// A report line stays one stdout line: a CR/LF inside it (a lang key, a
// module id, a stack trace) prints escaped, so no text from the module can
// start a line that the Actions runner reads as a workflow command.
const oneLine = (s) => String(s).replace(/\r/g, "\\r").replace(/\n/g, "\\n");

class Reporter {
  constructor({ root, annotate }) {
    this.root = root;
    this.annotate = annotate;
    this.counts = { passed: 0, warnings: 0, failed: 0 };
  }

  /**
   * Runs one check. A check counts once in the summary: failed if it emitted
   * any FAIL, warning if any WARN, passed otherwise; a skipped check (nothing
   * to verify) is not counted.
   */
  check(id, title, fn) {
    const state = { fails: 0, warns: 0, skipped: false, detail: "" };
    const api = {
      fail: (msg, loc) => {
        state.fails++;
        this.emit("FAIL", id, title, msg, loc);
      },
      warn: (msg, loc) => {
        state.warns++;
        this.emit("WARN", id, title, msg, loc);
      },
      notice: (msg, loc) => this.emit("NOTICE", id, title, msg, loc),
      skip: (msg) => {
        state.skipped = true;
        if (msg) this.emit("NOTICE", id, title, msg);
      },
      detail: (msg) => {
        state.detail = msg;
      },
    };
    try {
      fn(api);
    } catch (err) {
      api.fail(`internal error in check-module: ${err?.stack ?? err}`);
    }
    if (state.fails) this.counts.failed++;
    else if (state.warns) this.counts.warnings++;
    else if (!state.skipped) {
      this.counts.passed++;
      this.emit("PASS", id, title, state.detail);
    }
  }

  emit(level, id, title, msg, loc) {
    const where = loc?.file ? ` (${loc.file}${loc.line ? `:${loc.line}` : ""})` : "";
    console.log(oneLine(`${level.padEnd(6)} [${id}] ${title}${msg ? `: ${msg}` : ""}${where}`));
    if (!this.annotate || level === "PASS") return;
    const command = { FAIL: "error", WARN: "warning", NOTICE: "notice" }[level];
    const props = [];
    if (loc?.file) {
      // Annotations resolve paths against the workspace, which is the cwd.
      const file = path.relative(process.cwd(), path.join(this.root, loc.file)).split(path.sep).join("/");
      props.push(`file=${escProp(file)}`);
      if (loc.line) props.push(`line=${loc.line}`);
    }
    props.push(`title=${escProp(`check-module [${id}] ${title}`)}`);
    console.log(`::${command} ${props.join(",")}::${escData(msg || title)}`);
  }
}

/* ----------------------------------------------------------------------------
 * Module model
 * -------------------------------------------------------------------------- */

function readJson(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return { rel, missing: true };
  const text = fs.readFileSync(file, "utf8");
  try {
    return { rel, data: JSON.parse(text) };
  } catch (err) {
    const bom = text.charCodeAt(0) === 0xfeff ? " (the file starts with a UTF-8 BOM)" : "";
    return { rel, error: `${err.message}${bom}` };
  }
}

/**
 * Does `rel` exist with exactly this case? Windows and macOS are forgiving,
 * the Linux servers most Foundry hosts run on are not.
 * @returns {{ ok: true } | { ok: false, actual?: string, invalid?: boolean }}
 */
function existsExact(root, rel) {
  const clean = rel.replace(/^\.\//, "");
  if (!clean || path.isAbsolute(clean) || clean.startsWith("/") || clean.split("/").includes("..")) {
    return { ok: false, invalid: true };
  }
  let dir = root;
  const actual = [];
  for (const seg of clean.split("/")) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false };
    const names = fs.readdirSync(dir);
    if (names.includes(seg)) actual.push(seg);
    else {
      const other = names.find((nm) => nm.toLowerCase() === seg.toLowerCase());
      if (!other) return { ok: false };
      actual.push(other);
    }
    dir = path.join(dir, seg);
  }
  const joined = actual.join("/");
  return joined === clean ? { ok: true } : { ok: false, actual: joined };
}

function loadModule(root, opts) {
  const ctx = { root, opts };
  ctx.moduleJson = readJson(root, "module.json");
  ctx.module = ctx.moduleJson.data && typeof ctx.moduleJson.data === "object" ? ctx.moduleJson.data : null;
  ctx.baronJson = readJson(root, "baron.json");
  ctx.lockJson = readJson(root, LOCK_FILE);

  const defaults = {
    mode: "public",
    devChannel: true,
    i18nPrefix: ctx.module?.id ?? null,
    langParity: "error",
    persisted: [],
  };
  ctx.baronDefaults = defaults;
  const given = ctx.baronJson.data && typeof ctx.baronJson.data === "object" ? ctx.baronJson.data : {};
  ctx.baron = { ...defaults, ...given };

  ctx.scripts = walk(root, "scripts", (n) => /\.m?js$/i.test(n));
  ctx.ownScripts = ctx.scripts.filter((s) => s !== VENDORED_PATH);
  ctx.vendored = fs.existsSync(path.join(root, VENDORED_PATH));

  // Languages Foundry will load: the manifest's list, else every lang/*.json.
  const langEntries = languageEntries(root, ctx.module);
  ctx.langFiles = [...new Set([...langEntries.map((l) => l.rel), ...walk(root, "lang", (n) => n.endsWith(".json"))])];
  ctx.langJson = new Map(ctx.langFiles.map((rel) => [rel, readJson(root, rel)]));
  ctx.langKeys = new Map(); // lang code -> Set of keys (several files per code merge, as in Foundry)
  for (const { lang, rel } of langEntries) {
    const data = ctx.langJson.get(rel)?.data;
    if (!data) continue;
    const keys = ctx.langKeys.get(lang) ?? new Set();
    for (const [k] of flattenLang(data)) keys.add(k);
    ctx.langKeys.set(lang, keys);
  }

  const scans = new Map();
  ctx.text = (rel) => toLf(fs.readFileSync(path.join(root, rel), "utf8"));
  ctx.scan = (rel) => {
    if (!scans.has(rel)) scans.set(rel, scanJs(ctx.text(rel)));
    return scans.get(rel);
  };
  return ctx;
}

/* ----------------------------------------------------------------------------
 * Checks
 * -------------------------------------------------------------------------- */

function checkDeclaredFiles(ctx, c) {
  const m = ctx.module;
  if (!m) return c.fail("module.json is missing or is not valid JSON", { file: "module.json" });
  const entries = [];
  const asPath = (x) => (typeof x === "string" ? x : (x?.src ?? x?.path ?? null));
  for (const key of ["esmodules", "scripts", "styles"]) {
    if (m[key] === undefined) continue;
    if (!Array.isArray(m[key])) {
      c.fail(`"${key}" must be an array`, { file: "module.json" });
      continue;
    }
    for (const x of m[key]) entries.push({ p: asPath(x), loc: { file: "module.json" }, from: key });
  }
  for (const l of Array.isArray(m.languages) ? m.languages : []) {
    entries.push({ p: l?.path ?? null, loc: { file: "module.json" }, from: "languages" });
  }
  // Templates the scripts load by path: a missing one only breaks when the
  // editor opens, long after the module loaded fine. Only paths rooted in this
  // module count: "modules/<id>/templates/..." or an interpolated root such as
  // `modules/${MODULE_ID}/templates/...` or `${ROOT}/templates/...`. A path
  // that starts with "templates/" is resolved by Foundry against its own root
  // (core templates like templates/generic/form-footer.hbs), and a system's or
  // another module's templates are not this module's files.
  for (const rel of ctx.scripts) {
    const { code, lineOf } = ctx.scan(rel);
    for (const t of code.matchAll(/templates\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.hbs/g)) {
      const before = code.slice(Math.max(0, t.index - 80), t.index);
      if (/systems\/[^/\s'"`]+\/$/.test(before)) continue; // a system's template
      const owner = /modules\/([A-Za-z0-9_-]+)\/$/.exec(before);
      if (owner ? owner[1] !== m.id : !before.endsWith("}/")) continue; // another module's, or Foundry's
      entries.push({ p: t[0], loc: { file: rel, line: lineOf(t.index) }, from: "template" });
    }
  }
  const seen = new Set();
  let present = 0;
  for (const { p, loc, from } of entries) {
    if (typeof p !== "string" || !p) {
      c.fail(`a "${from}" entry has no path`, loc);
      continue;
    }
    if (seen.has(p)) continue;
    seen.add(p);
    const r = existsExact(ctx.root, p);
    if (r.ok) present++;
    else if (r.invalid) c.fail(`"${p}" must be a path relative to the module folder`, loc);
    else if (r.actual) c.fail(`"${p}" exists only as "${r.actual}": paths are case-sensitive on Linux hosts`, loc);
    else if (from === "template") c.fail(`"${p}" does not exist: the sheet or dialog that renders it fails when it opens`, loc);
    else c.fail(`"${p}" does not exist (a missing esmodule makes Foundry drop the whole module)`, loc);
  }
  c.detail(`${present} declared or referenced file(s) present`);
}

function checkSyntax(ctx, c) {
  if (!ctx.scripts.length) return c.detail("no scripts/ files");
  // Copied as .mjs so node parses them as ES modules (they use import/export)
  // whatever the nearest package.json says.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-module-"));
  try {
    for (const rel of ctx.scripts) {
      const dest = path.join(tmp, rel.replace(/\.m?js$/i, ".mjs"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ctx.root, rel), dest);
      const res = spawnSync(process.execPath, ["--check", dest], { encoding: "utf8", windowsHide: true });
      if (res.status === 0) continue;
      const err = String(res.stderr ?? res.error ?? "");
      const line = Number(/:(\d+)\r?\n/.exec(err)?.[1]) || undefined;
      const reason = /^\w*Error:.*$/m.exec(err)?.[0] ?? (err.trim().split(/\r?\n/)[0] || `node --check exited ${res.status}`);
      c.fail(reason, { file: rel, line });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  c.detail(`${ctx.scripts.length} script(s) parse as ES modules`);
}

function checkJson(ctx, c) {
  const files = [ctx.moduleJson, ctx.baronJson, ctx.lockJson, ...ctx.langJson.values()];
  let parsed = 0;
  for (const f of files) {
    if (f.missing) continue;
    if (f.error) c.fail(`invalid JSON: ${f.error}`, { file: f.rel });
    else parsed++;
  }
  if (ctx.moduleJson.missing) c.fail("module.json does not exist", { file: "module.json" });

  if (ctx.baronJson.missing) {
    const d = ctx.baronDefaults;
    c.notice(`no baron.json: using defaults ${JSON.stringify(d)}`);
  } else if (ctx.baronJson.data !== undefined) {
    const b = ctx.baronJson.data;
    const loc = { file: "baron.json" };
    if (!b || typeof b !== "object" || Array.isArray(b)) c.fail("baron.json must be an object", loc);
    else {
      if (b.mode !== undefined && !["public", "protected"].includes(b.mode)) c.fail(`mode must be "public" or "protected", not ${JSON.stringify(b.mode)}`, loc);
      if (b.devChannel !== undefined && typeof b.devChannel !== "boolean") c.fail("devChannel must be true or false", loc);
      if (b.i18nPrefix !== undefined && (typeof b.i18nPrefix !== "string" || !b.i18nPrefix)) c.fail("i18nPrefix must be a non-empty string", loc);
      if (b.langParity !== undefined && !["error", "warn"].includes(b.langParity)) c.fail(`langParity must be "error" or "warn", not ${JSON.stringify(b.langParity)}`, loc);
      if (b.persisted !== undefined && (!Array.isArray(b.persisted) || b.persisted.some((s) => typeof s !== "string" || !s))) {
        c.fail("persisted must be an array of non-empty strings", loc);
      }
    }
  }
  c.detail(`${parsed} JSON file(s) parse`);
}

function checkLangParity(ctx, c) {
  const langs = [...ctx.langKeys.keys()];
  if (langs.length < 2) return c.detail(langs.length ? `only one language (${langs[0]})` : "no language files");
  const severity = ctx.opts.parity ?? (ctx.baron.langParity === "warn" ? "warn" : "error");
  const report = severity === "warn" ? c.warn : c.fail;
  const refLang = ctx.langKeys.has("en") ? "en" : langs[0];
  const ref = ctx.langKeys.get(refLang);
  const list = (keys) => keys.slice(0, 15).join(", ") + (keys.length > 15 ? `, ... (+${keys.length - 15})` : "");
  let even = true;
  for (const lang of langs) {
    if (lang === refLang) continue;
    const keys = ctx.langKeys.get(lang);
    const missing = [...ref].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !ref.has(k));
    if (missing.length) report(`${lang} lacks ${missing.length} key(s) of ${refLang}: ${list(missing)}`);
    if (extra.length) report(`${lang} has ${extra.length} key(s) that ${refLang} lacks: ${list(extra)}`);
    if (missing.length || extra.length) even = false;
  }
  if (even) c.detail(`${langs.join(", ")}: ${ref.size} keys each`);
}

/** Lock contents if it is a usable release lock, else null (reasons go to `c`). */
function validLock(ctx, c) {
  const lock = ctx.lockJson.data;
  const loc = { file: LOCK_FILE };
  if (ctx.lockJson.error) {
    c.fail("baron-core.lock.json is not valid JSON", loc);
    return null;
  }
  if (!lock || typeof lock !== "object") {
    c.fail("baron-core.lock.json must be an object", loc);
    return null;
  }
  let ok = true;
  if (lock.version === "dev" || lock.commit === "dev") {
    c.fail("the lock comes from sync-core --watch (version/commit \"dev\"): run sync-core --ref <tag> before committing or releasing", loc);
    return null;
  }
  if (typeof lock.version !== "string" || !lock.version) ok = !!c.fail("lock.version must be the CORE_VERSION string", loc);
  if (typeof lock.commit !== "string" || !SHA1_RE.test(lock.commit)) ok = !!c.fail("lock.commit must be a full 40-character lowercase commit sha", loc);
  if (typeof lock.sha256 !== "string" || !SHA256_RE.test(lock.sha256)) ok = !!c.fail("lock.sha256 must be 64 lowercase hex characters", loc);
  return ok ? lock : null;
}

function checkLockOffline(ctx, c) {
  const hasLock = !ctx.lockJson.missing;
  if (!ctx.vendored && !hasLock) return c.skip("module does not vendor baron-core");
  if (!hasLock) return c.fail(`${VENDORED_PATH} has no ${LOCK_FILE}: run sync-core --ref <tag>`, { file: VENDORED_PATH });
  if (!ctx.vendored) return c.fail(`${LOCK_FILE} exists but ${VENDORED_PATH} does not: run sync-core --ref <tag>`, { file: LOCK_FILE });
  const lock = validLock(ctx, c);
  if (!lock) return;
  const text = ctx.text(VENDORED_PATH);
  const sha = sha256Lf(text);
  if (sha !== lock.sha256) {
    c.fail(`sha256 ${sha} differs from the lock (${lock.sha256}): the copy was edited or is not the locked version; never edit it by hand, rerun sync-core --ref <tag>`, { file: VENDORED_PATH });
  }
  const version = readCoreVersion(text);
  if (version !== lock.version) {
    c.fail(`CORE_VERSION ${version ?? "(missing)"} differs from lock.version ${lock.version}`, { file: VENDORED_PATH });
  }
  c.detail(`baron-core ${lock.version}, sha256 matches the lock`);
}

function checkLockOnline(ctx, c) {
  const hasLock = !ctx.lockJson.missing;
  if (!ctx.vendored && !hasLock) return c.skip();
  if (!ctx.opts.online) return c.skip("offline: pass --online (and --core-repo <path>) to verify the lock against the core repo");
  const lock = ctx.lockJson.data;
  if (!lock || typeof lock !== "object" || !SHA1_RE.test(lock.commit ?? "") || !SHA256_RE.test(lock.sha256 ?? "")) {
    return c.skip("skipped: the lock is not a release lock (see [e])");
  }
  const core = path.resolve(ctx.opts.coreRepo ?? CORE_DIR);
  if (!gitTry(core, ["rev-parse", "--git-dir"])) return c.fail(`${core} is not a git repository (--core-repo)`);

  const tagged = gitTry(core, ["rev-parse", "--verify", "--quiet", `v${lock.version}^{commit}`]);
  if (!tagged) {
    c.fail(`tag v${lock.version} does not exist in ${core} (a release must lock a tagged core; CI needs fetch-depth: 0 to see tags)`, { file: LOCK_FILE });
  } else if (tagged !== lock.commit) {
    c.fail(`tag v${lock.version} points at ${tagged}, not at lock.commit ${lock.commit}`, { file: LOCK_FILE });
  }

  let blob = null;
  try {
    blob = coreFileAt(core, lock.commit);
  } catch {
    c.fail(`commit ${lock.commit} (or its baron-core.js) is not in ${core}`, { file: LOCK_FILE });
  }
  if (blob !== null && sha256Lf(blob) !== lock.sha256) {
    c.fail(`baron-core.js at ${lock.commit} hashes to ${sha256Lf(blob)}, not to lock.sha256`, { file: LOCK_FILE });
  }

  let pins = 0;
  for (const rel of workflowFiles(ctx.root)) {
    for (const pin of findUsesPins(fs.readFileSync(path.join(ctx.root, rel), "utf8"))) {
      pins++;
      if (pin.ref !== lock.commit) {
        c.fail(`${pin.workflow}@${pin.ref} is not pinned to lock.commit ${lock.commit}: run sync-core --ref <tag>`, { file: rel, line: pin.line });
      }
    }
  }
  if (!pins) c.notice("no workflow calls BaronHVC/pf2e-baron-core: nothing to compare with the lock");
  c.detail(`tag v${lock.version} -> ${lock.commit.slice(0, 12)}, sha256 matches, ${pins} workflow pin(s) at the lock commit`);
}

const IMPORT_RES = [
  // import x from "y" / import { a } from "y" / import * as n from "y" / import "y"
  /(?<![\w$.])import\s*(?:[\w$*{}\s,]+?\s*from\s*)?(["'])([^"'\n]+)\1/g,
  // export { a } from "y" / export * from "y" / export * as n from "y"
  /(?<![\w$.])export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\1/g,
  // import("y") with a literal argument; a template literal is checked by its static text
  /(?<![\w$.])import\s*\(\s*(["'`])([^"'`\n]*)\1/g,
];
// Top-level await, by the column-0 heuristic: a statement that starts a line
// with await, for await or a declaration initialized by await, optionally
// exported (`export const DATA = await ...` is the usual ESM form). It cannot
// see an await indented inside a top-level block; formatters indent function
// bodies, so a column-0 await inside a function does not happen in practice.
const TLA_RE = /^(?:export\s+(?:default\s+)?)?(?:await[\s(]|for\s+await\b|(?:const|let|var)\s+(?:[\w$]+|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*await\b)/gm;
// Browsers resolve only these without an import map, and Foundry defines none.
const URL_SPEC_RE = /^(?:https?|data|blob):/i;

function checkImports(ctx, c) {
  let count = 0;
  for (const rel of ctx.scripts) {
    const { code, bare, lineOf } = ctx.scan(rel);
    const seen = new Set();
    for (const re of IMPORT_RES) {
      // Matched on `code` because the specifier is a string; the keyword
      // itself must be real code, not words inside a string or template.
      for (const m of code.matchAll(re)) {
        if (seen.has(m.index) || bare[m.index] === " ") continue;
        seen.add(m.index);
        const spec = m[2];
        const loc = { file: rel, line: lineOf(m.index) };
        count++;
        const dynamic = spec.includes("${");
        if (spec.startsWith("/")) {
          c.fail(`import "${spec}" is absolute: Foundry may serve the module under a route prefix or a versioned path (The Forge); use a ./ path inside the module`, loc);
        } else if (spec.startsWith("./") || spec.startsWith("../")) {
          // Resolved against the module root, so a relative path is judged by
          // where it lands: the module's own scripts/modules/ folder is fine,
          // ../../other-module/ is not.
          if (dynamic) continue;
          const target = path.resolve(path.dirname(path.join(ctx.root, rel)), spec);
          const inside = path.relative(ctx.root, target);
          if (inside.startsWith("..") || path.isAbsolute(inside)) {
            c.fail(`import "${spec}" leaves the module folder`, loc);
          } else {
            const r = existsExact(ctx.root, inside.split(path.sep).join("/"));
            if (!r.ok) c.fail(`import "${spec}" ${r.actual ? `matches only "${r.actual}" (case)` : "does not exist"}: the module would fail to load`, loc);
          }
        } else if (spec.includes("/modules/") || spec.startsWith("modules/")) {
          c.fail(`import "${spec}" reaches into another module's folder: modules never import each other`, loc);
        } else if (!URL_SPEC_RE.test(spec) && !dynamic) {
          c.fail(`import "${spec}" is a bare specifier: Foundry loads modules in the browser without an import map, so it cannot resolve; import a ./ path inside the module`, loc);
        }
      }
    }
    // On `bare`: a multi-line template whose text starts a line with "await "
    // is not a top-level await.
    for (const m of bare.matchAll(TLA_RE)) {
      c.fail("top-level await: it delays the module's evaluation past Foundry's init hooks", { file: rel, line: lineOf(m.index) });
    }
  }
  c.detail(`${count} import(s) checked, none leave the module; no top-level await`);
}

// Foundry namespaces other identifiers as "<id>.<name>" too, and with the
// default i18n prefix (the module id) they look like lang keys. A literal in
// one of these call positions is an identifier, never a key: hook names
// (Hooks.on/once/off/call/callAll), query names (CONFIG.queries[...],
// user.query(...)) and setting ids (game.settings.settings.get(...)).
const NOT_A_KEY_RE = /(?:(?<![\w$])Hooks\s*\.\s*(?:on|once|off|call|callAll)\s*\(|(?<![\w$])queries\s*\[|\.\s*query\s*\(|(?<![\w$])settings\s*\.\s*(?:get|has|set|delete)\s*\()\s*$/;

function checkI18n(ctx, c, stats) {
  const prefix = ctx.baron.i18nPrefix;
  if (typeof prefix !== "string" || !prefix) return c.skip("no i18nPrefix in baron.json and no id in module.json");
  const head = `${prefix}.`;
  const refs = [];
  const dynamicHeads = new Set();

  for (const rel of ctx.ownScripts) {
    const { code, strings, lineOf } = ctx.scan(rel);
    for (const s of strings) {
      const before = code.slice(Math.max(0, s.start - 60), s.start);
      const after = code.slice(s.end, s.end + 20);
      const plusAfter = /^\s*\+/.test(after);
      const plusBefore = /\+\s*$/.test(before);
      if (/(?<![\w$.])i18n\s*\(\s*$/.test(before)) {
        // i18n("X") resolves to "<prefix>.X"; a computed argument is skipped.
        if (s.value !== null && !plusAfter && /^\s*\)/.test(after)) {
          refs.push({ key: head + s.value, loc: { file: rel, line: lineOf(s.start) } });
        } else if (s.head) dynamicHeads.add(head + s.head);
        continue;
      }
      const text = s.value ?? s.head;
      if (!text.startsWith(head)) continue;
      if (NOT_A_KEY_RE.test(before)) continue;
      if (s.value === null || plusAfter || plusBefore) {
        if (text.length > head.length) dynamicHeads.add(text);
        continue;
      }
      if (/\s/.test(text)) continue; // prose that happens to start with the prefix
      refs.push({ key: text, loc: { file: rel, line: lineOf(s.start) } });
    }
  }

  for (const rel of walk(ctx.root, "templates", (n) => /\.(hbs|html)$/i.test(n))) {
    // Handlebars comments may quote keys that no longer exist.
    const src = ctx.text(rel).replace(/\{\{!--[\s\S]*?--\}\}|\{\{![\s\S]*?\}\}/g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of src.matchAll(/\blocalize\s+(["'])([^"'\n]+)\1/g)) {
      if (!m[2].startsWith(head)) continue;
      refs.push({ key: m[2], loc: { file: rel, line: src.slice(0, m.index).split("\n").length } });
    }
  }

  const en = ctx.langKeys.get("en");
  stats.refs = refs.length;
  stats.distinct = new Set(refs.map((r) => r.key)).size;
  if (!en) {
    stats.missing = refs.length;
    if (refs.length) c.fail(`${refs.length} static key reference(s) but no "en" language file`);
    else c.detail("no static keys and no en.json");
    return;
  }
  const reported = new Set();
  let missing = 0;
  for (const r of refs) {
    if (en.has(r.key)) continue;
    missing++;
    const id = `${r.key}|${r.loc.file}|${r.loc.line}`;
    if (reported.has(id)) continue;
    reported.add(id);
    c.fail(`"${r.key}" is not in lang/en.json`, r.loc);
  }
  const used = new Set(refs.map((r) => r.key));
  const heads = [...dynamicHeads];
  const unused = [...en].filter((k) => !used.has(k) && !heads.some((h) => k.startsWith(h)));
  stats.missing = missing;
  stats.unused = unused.length;
  stats.enKeys = en.size;
  if (unused.length) {
    const sample = unused.slice(0, 10).join(", ") + (unused.length > 10 ? ", ..." : "");
    c.notice(`${unused.length} of ${en.size} en.json key(s) have no static reference (keys built at runtime cannot be traced): ${sample}`);
  }
  c.detail(`${refs.length} static reference(s) to ${stats.distinct} key(s), all in lang/en.json`);
}

function checkPersisted(ctx, c) {
  const list = Array.isArray(ctx.baron.persisted) ? ctx.baron.persisted.filter((s) => typeof s === "string" && s) : [];
  if (!list.length) return c.detail("no persisted identifiers declared in baron.json");
  // Matched as whole string literals, never as substrings: the module id also
  // sits inside "<id>.SettingGmOnly" and "gmOnly" inside "gmOnlyRenamed", so a
  // substring test stays green after exactly the rename it exists to catch. A
  // template literal counts by its text before the first ${ (`swe-p-${i}`
  // keeps the prefix "swe-p-"). Comments do not count: a flag scope or rule
  // slug that only survives in a comment has stopped being written, and worlds
  // that stored it are orphaned.
  const literals = new Set();
  for (const rel of ctx.ownScripts) {
    for (const s of ctx.scan(rel).strings) literals.add(s.value ?? s.head);
  }
  for (const s of list) {
    if (!literals.has(s)) {
      c.fail(`"${s}" no longer appears in scripts/ as a whole string literal (or the text before a template's first \${}): it is stored in worlds (flags, settings, rule slugs, roll options), renaming it orphans existing data`, { file: "baron.json" });
    }
  }
  c.detail(`${list.length} persisted identifier(s) present`);
}

function checkManifestRules(ctx, c) {
  const m = ctx.module;
  if (!m) return c.skip("module.json unavailable (see [a])");
  const loc = { file: "module.json" };
  if (Object.hasOwn(m, "protected")) {
    c.fail('"protected" must not be in the source module.json: Foundry hides a protected module from your own install and v14 refuses it unsigned; the release build adds it', loc);
  }
  const requires = Array.isArray(m.relationships?.requires) ? m.relationships.requires : [];
  if (requires.some((r) => r?.id === "pf2e-baron-core")) {
    c.fail("relationships.requires lists pf2e-baron-core: the core is vendored into scripts/, never a Foundry dependency", loc);
  }
  for (const key of ["esmodules", "scripts"]) {
    const list = Array.isArray(m[key]) ? m[key] : [];
    if (list.some((p) => typeof p === "string" && p.replace(/^\.\//, "") === VENDORED_PATH)) {
      c.warn(`${key} lists ${VENDORED_PATH}: it loads through the module's own imports, not as an entry point`, loc);
    }
  }
  c.detail("no protected key, no core dependency");
}

function checkPlaceholders(ctx, c) {
  const files = [
    "module.json",
    "baron.json",
    "README.md",
    // Init fills the title, author and id into the Paizo notice; a NOTICE.md
    // copied from the template by hand would ship "__TITLE__ uses trademarks".
    "NOTICE.md",
    ...walk(ctx.root, "scripts", () => true).filter((rel) => rel !== VENDORED_PATH),
    ...walk(ctx.root, "lang", () => true),
    ...walk(ctx.root, "styles", () => true),
    ...walk(ctx.root, "templates", () => true),
  ].filter((rel) => fs.existsSync(path.join(ctx.root, rel)));
  let scanned = 0;
  for (const rel of [...new Set(files)]) {
    const buf = fs.readFileSync(path.join(ctx.root, rel));
    if (buf.length > 4 * 1024 * 1024 || buf.includes(0)) continue; // binary assets
    scanned++;
    const text = buf.toString("utf8");
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      c.fail(`leftover placeholder ${m[0]}: run tools/init-module.mjs or replace it`, { file: rel, line: text.slice(0, m.index).split("\n").length });
    }
  }
  c.detail(`${scanned} file(s) free of __PLACEHOLDER__ markers`);
}

// Paizo's license is a separate axis from how the module ships: "cup" is the
// Community Use Policy, which forbids charging for anything in the project, so
// a paid module and the free base it extends both declare "orc".
const PAIZO_LICENSES = ["cup", "orc"];
// A fragment of each required notice, as pf2e-module-template's NOTICE.md
// copies it from paizo.com. Enough to tell the two apart: a module must carry
// the notice of its license and must not keep the other one, which is what a
// module that switched license by pasting the new block in would ship (a paid
// module still saying "we are expressly prohibited from charging you").
const PAIZO_NOTICE = {
  cup: { name: "Community Use Policy notice", fragment: "used under Paizo's Community Use Policy" },
  orc: { name: "ORC Notice", fragment: "licensed under the ORC License" },
};
// Where a wrong or missing NOTICE.md comes from. Init deletes itself after the
// first run, so the reliable copy is init's output on a scratch clone, which
// keeps exactly one block and fills the title, author and id in it.
const noticeHint = (paizo) =>
  `rebuild it by running pf2e-module-template's tools/init-module.mjs --paizo ${paizo} (same id, title, description, author and prefix) on a scratch clone and copying its NOTICE.md`;
// Between the words of a field: any whitespace, so a hard-wrapped NOTICE.md
// still matches, plus the "> " that starts each line of a quoted one.
const FIELD_GAP = String.raw`\s+(?:>\s*)*`;
const fieldWords = (words) => words.split(" ").join(FIELD_GAP);
// The bracketed fields of the template's ORC block that the author fills by
// hand: the license's own Sample Notice fields and the template's Spanish
// hints (the Reserved Material one ends with the module title). Listed one by
// one rather than "any [text]": a finished notice may hold markdown links, and
// the template's prose quotes the brackets themselves as `[ ]`. A field name
// followed by "(" or "[" is the text of an inline or reference link, not a field.
const ORC_FIELD_RE = new RegExp(
  String.raw`\[(?:` +
    ["Title of Work", "Copyright Notice", "Author Credit Information", "ninguno"].map(fieldWords).join("|") +
    "|" + fieldWords("nombres, logos, arte e identidad comercial de") + String.raw`\s[^\][]*` +
    String.raw`)\](?![(\[])`,
  "g",
);
// Built from char codes so this file stays ASCII: a notice pasted from
// paizo.com or a word processor may use typographic apostrophes.
const TYPOGRAPHIC_APOSTROPHES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, "g");
// Paizo itself, its games and their setting, plus the usual short forms. The
// ORC licenses none of them, so any of these in an ORC module's id or title is
// worth a warning. tools/init-module.mjs in pf2e-module-template uses the same
// list: keep the two in sync.
const PAIZO_TRADEMARK_RE = /pf2|sf2e|pathfinder|starfinder|golarion|paizo/i;
// The family marker for a legal field that waits on the author's sign-off: a
// session that drafts NOTICE.md text it cannot settle (an attribution not yet
// checked against the book, a decision only the author makes) writes
// "PENDIENTE: <what is missing>" on that line, or "PENDIENTE (<who>):" to name
// who decides. Emphasis may wrap it anywhere ("__PENDIENTE:__", "**PENDIENTE**:",
// "**PENDIENTE (who)**:") and spaces may come before the colon: a reader sees
// the marker in every one of them. Only a letter or digit glued in front
// breaks it ("_" is emphasis there, not part of a word).
// Upper case only, as with TODO-HUMANO: "pendiente:" in Spanish prose is text.
// It counts anywhere in the file, an HTML comment included: a sign-off is open
// whether GitHub shows the note or not.
const PENDING_RE = /(?<![\p{L}\p{N}])PENDIENTE(?:[*_]*[^\S\n]*(\([^()\n]*\)))?[*_]*[^\S\n]*:/u;

// NOTICE.md reduced to the words GitHub shows: a notice inside an HTML comment
// is not shown, so it does not count; quote markers, emphasis and link syntax
// are shown as plain words, so they must not hide one; and the notice may be
// hard-wrapped across lines.
function renderedWords(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/[*_]+/g, "")
    .replace(TYPOGRAPHIC_APOSTROPHES, "'")
    .replace(/\s+/g, " ");
}

/**
 * Reports each line of NOTICE.md that holds the pending marker: a warning on a
 * push, a failure with --release. Returns how many lines it reported.
 */
function reportPending(ctx, c, text) {
  let count = 0;
  text.split("\n").forEach((line, i) => {
    const m = PENDING_RE.exec(line);
    if (!m) return;
    count++;
    const loc = { file: "NOTICE.md", line: i + 1 };
    // Named without its emphasis or spacing, so every spelling reads the same.
    const marker = m[1] ? `PENDIENTE ${m[1]}:` : "PENDIENTE:";
    const what = `${JSON.stringify(marker)} marker: a legal field awaits the author's sign-off`;
    if (ctx.opts.release) c.fail(`${what} and the release does not publish it; settle it, delete the marker and tag again`, loc);
    else c.warn(`${what}; settle it and delete the marker before tagging, the release refuses it`, loc);
  });
  return count;
}

function checkPaizoLicense(ctx, c) {
  const paizo = ctx.baron.paizo;
  if (paizo === undefined) {
    // Still only a notice, so a module from before rule [l] keeps passing, but
    // a paid one is told which value it needs.
    const paid = ctx.baron.mode === "protected" ? '; a protected (paid) module must declare "orc", the Community Use Policy forbids charging' : "";
    const msg = `baron.json does not declare "paizo" ("cup" or "orc"): the Paizo license is not checked and NOTICE.md is not required${paid}`;
    // The release ships NOTICE.md whatever the license, so an open sign-off in
    // it is reported all the same.
    if (existsExact(ctx.root, "NOTICE.md").ok && reportPending(ctx, c, ctx.text("NOTICE.md"))) return c.notice(msg);
    return c.skip(msg);
  }
  const conf = { file: "baron.json" };
  if (!PAIZO_LICENSES.includes(paizo)) return c.fail(`paizo must be "cup" or "orc", not ${JSON.stringify(paizo)}`, conf);
  if (ctx.baron.mode === "protected" && paizo === "cup") {
    c.fail('mode "protected" with paizo "cup": the Community Use Policy forbids charging for anything in the project; a paid module, and the free base it extends, use "orc"', conf);
  }

  const r = existsExact(ctx.root, "NOTICE.md");
  if (!r.ok) {
    const found = r.actual ? ` (only "${r.actual}", and Linux hosts and GitHub links are case-sensitive)` : "";
    return c.fail(`NOTICE.md does not exist${found}: it carries the Paizo ${PAIZO_NOTICE[paizo].name}; ${noticeHint(paizo)}`, { file: "NOTICE.md" });
  }
  const text = ctx.text("NOTICE.md");
  const loc = { file: "NOTICE.md" };
  const words = renderedWords(text);
  const { name, fragment } = PAIZO_NOTICE[paizo];
  if (!words.includes(fragment)) {
    c.fail(`paizo is "${paizo}" but NOTICE.md lacks the ${name} ("... ${fragment} ..."): ${noticeHint(paizo)}`, loc);
  }
  const other = PAIZO_NOTICE[paizo === "cup" ? "orc" : "cup"];
  if (words.includes(other.fragment)) {
    c.fail(`paizo is "${paizo}" but NOTICE.md also carries the ${other.name} ("... ${other.fragment} ..."): a module under one license must not claim the other; delete that block, or ${noticeHint(paizo)}`, loc);
  }
  // A push only warns, so a notice in progress stays green; the tag build
  // passes --release and refuses an incomplete notice. One finding per line,
  // so each annotation points at what is left to fill.
  if (paizo === "orc") {
    const byLine = new Map();
    for (const m of text.matchAll(ORC_FIELD_RE)) {
      const line = text.slice(0, m.index).split("\n").length;
      const field = m[0].replace(new RegExp(FIELD_GAP, "g"), " ");
      byLine.set(line, [...(byLine.get(line) ?? []), field]);
    }
    for (const [line, fields] of byLine) {
      const what = `unfilled template field(s) ${fields.join(", ")}`;
      const at = { file: "NOTICE.md", line };
      if (ctx.opts.release) c.fail(`${what}: the release does not publish an incomplete ORC notice; fill them and tag again`, at);
      else c.warn(`${what}: fill them before tagging, the release refuses them`, at);
    }
  }
  reportPending(ctx, c, text);
  if (paizo !== "orc") return c.detail(`paizo "${paizo}", NOTICE.md carries the ${name}`);

  // An open legal question rather than a field left to fill, so it stays a
  // warning with --release: the author settles it, the check cannot.
  const named = ["id", "title"].filter((k) => typeof ctx.module?.[k] === "string" && PAIZO_TRADEMARK_RE.test(ctx.module[k]));
  if (named.length) {
    const where = named.map((k) => `${k} ${JSON.stringify(ctx.module[k])}`).join(" and ");
    c.warn(`module.json ${where} name(s) Paizo or one of its games (PF2e, Pathfinder, Starfinder, Golarion): the ORC License never licenses Paizo's trademarks, so this is an open legal question; settle it before the first release, an id can never change afterwards`, { file: "module.json" });
  }
  c.detail(`paizo "orc", NOTICE.md carries the ORC Notice with every template field filled`);
}

// The protected release build (release-manifest.mjs) rewrites these three and
// refuses any other link into the private repo.
const RELEASE_REWRITES = new Set(["url", "manifest", "download"]);

// A paid module is a freemium add-on: private repo, a package Foundry hosts and
// serves to patrons only, and a free base module whose API it registers its
// features through. What the release needs is reported on every push, not
// first at tag time.
function checkProtectedPackaging(ctx, c) {
  if (ctx.baron.mode !== "protected") return c.skip();
  const conf = { file: "baron.json" };
  const landing = ctx.baron.landingUrl;
  const problem = httpsUrlProblem(landing);
  if (problem) {
    c.fail(`landingUrl ${problem}: a protected module needs the https page where players learn how to get it (Patreon, a site); the release writes it as the manifest's "url", since the private repo's link would be dead`, conf);
  } else if (mentionsGitHub(landing)) {
    c.fail(`landingUrl ${JSON.stringify(landing)} points at GitHub: the repo of a paid module is private, so players would land on a 404; use the Patreon or site page`, conf);
  }

  const m = ctx.module;
  if (!m) return c.skip("module.json unavailable (see [a])");
  const loc = { file: "module.json" };
  // Foundry's default relationship type is "module"; the core never counts
  // as the base (rule [j] fails a core dependency on its own).
  const requires = Array.isArray(m.relationships?.requires) ? m.relationships.requires : [];
  const bases = requires
    .filter((r) => r && typeof r.id === "string" && r.id && r.id !== "pf2e-baron-core" && (r.type ?? "module") === "module")
    .map((r) => r.id);
  if (!bases.length) {
    c.warn("relationships.requires lists no module: a freemium add-on requires its free base, so Foundry installs and enables it first (init-module --requires <base-id> writes it)", loc);
  }
  // A fail, not a warning: the tag build refuses these for certain, so a
  // green push would only move the failure to release time.
  const { own, deps } = splitGitHubPaths(githubPaths(m).filter((p) => !RELEASE_REWRITES.has(p)));
  if (own.length) {
    c.fail(`${own.join(", ")} still link to GitHub: the protected release refuses them, since the repo is private; point them at a public page or remove them`, loc);
  }
  if (deps.length) {
    c.fail(`${deps.join(", ")} link to GitHub: the protected release refuses every GitHub link, a dependency's manifest included; remove it and list that module on foundryvtt.com, where Foundry finds a dependency by its id alone`, loc);
  }
  c.detail(`landing page ${landing}, requires ${bases.join(", ")}`);
}

// Foundry's AI policy wants UI labels and listing text written by a person.
// A Claude session never writes that text: it adds the key with the value
// "TODO-HUMANO: <what it should say>" and the author fills it in. Only a value
// that starts with the marker is a placeholder; text that quotes it
// mid-sentence is real text, and "todo-humano:" is not the marker.
const HUMAN_MARKER = "TODO-HUMANO:";
// Fields of module.json that the package listing shows as prose.
const LISTING_FIELDS = ["title", "description"];

/** Key paths (dotted, as Foundry flattens them) of the string values that start with the marker. */
function humanPlaceholders(value, prefix = "", out = []) {
  if (typeof value === "string") {
    if (value.trimStart().startsWith(HUMAN_MARKER)) out.push(prefix);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => humanPlaceholders(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) humanPlaceholders(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// A push only warns, so work in progress stays green; the tag build passes
// --release and refuses to publish a placeholder.
function checkHumanText(ctx, c) {
  const sources = [...ctx.langJson.values()].filter((f) => f.data !== undefined);
  if (ctx.module) {
    const listing = Object.fromEntries(LISTING_FIELDS.filter((k) => Object.hasOwn(ctx.module, k)).map((k) => [k, ctx.module[k]]));
    sources.unshift({ rel: "module.json", data: listing });
  }
  for (const { rel, data } of sources) {
    const keys = humanPlaceholders(data);
    if (!keys.length) continue;
    const sample = keys.slice(0, 5).join(", ") + (keys.length > 5 ? `, ... +${keys.length - 5} more` : "");
    const what = `${keys.length} value(s) still start with "${HUMAN_MARKER}" (${sample})`;
    if (ctx.opts.release) c.fail(`${what}: Foundry's AI policy wants UI and listing text written by a person; write them and tag again`, { file: rel });
    else c.warn(`${what}: a person writes them before tagging, the release refuses them (Foundry's AI policy)`, { file: rel });
  }
  const langs = sources.length - (ctx.module ? 1 : 0);
  c.detail(`no TODO-HUMANO placeholders in ${langs} language file(s)${ctx.module ? " or in module.json title and description" : ""}`);
}

/* ----------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------- */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.moduleDir ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) usage(`${root} is not a folder`);

  const ctx = loadModule(root, opts);
  const r = new Reporter({ root, annotate: !!process.env.GITHUB_ACTIONS });
  const stats = {};
  console.log(oneLine(`check-module: ${ctx.module?.id ?? path.basename(root)} (${root})${opts.online ? " --online" : ""}${opts.release ? " --release" : ""}`));

  r.check("a", "declared files", (c) => checkDeclaredFiles(ctx, c));
  r.check("b", "script syntax", (c) => checkSyntax(ctx, c));
  r.check("c", "JSON files", (c) => checkJson(ctx, c));
  r.check("d", "language parity", (c) => checkLangParity(ctx, c));
  r.check("e", "vendored core", (c) => checkLockOffline(ctx, c));
  r.check("f", "core lock online", (c) => checkLockOnline(ctx, c));
  r.check("g", "imports", (c) => checkImports(ctx, c));
  r.check("h", "i18n keys", (c) => checkI18n(ctx, c, stats));
  r.check("i", "persisted identifiers", (c) => checkPersisted(ctx, c));
  r.check("j", "manifest rules", (c) => checkManifestRules(ctx, c));
  r.check("k", "placeholders", (c) => checkPlaceholders(ctx, c));
  r.check("l", "paizo license", (c) => checkPaizoLicense(ctx, c));
  r.check("m", "protected packaging", (c) => checkProtectedPackaging(ctx, c));
  r.check("n", "human text", (c) => checkHumanText(ctx, c));

  const { passed, warnings, failed } = r.counts;
  console.log(`check-module: ${passed} passed, ${warnings} warnings, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main();
