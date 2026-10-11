#!/usr/bin/env node
// check-module: static checks for a BaronHVC Foundry module, run locally
// before tagging and by the reusable module-check / module-release workflows.
//
//   node <core>/tools/check-module.mjs [moduleDir=cwd] [--core-repo <path>] [--online] [--parity warn|error]
//
// Every check prints PASS / FAIL / WARN / NOTICE; under GitHub Actions the
// findings are also emitted as annotations. Exit code 1 on any FAIL.
//
//   [a] declared files exist      [g] imports stay inside the module, no top-level await
//   [b] scripts parse as ESM      [h] static i18n keys exist in lang/en.json
//   [c] JSON files parse          [i] persisted identifiers still present
//   [d] language key parity       [j] manifest rules (no protected key, no core dependency)
//   [e] vendored core vs lock     [k] no leftover template placeholders
//   [f] lock vs core repo (--online)

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
  gitTry,
  readCoreVersion,
  scanJs,
  sha256Lf,
  toLf,
  workflowFiles,
} from "./shared.mjs";

const USAGE = "usage: node check-module.mjs [moduleDir] [--core-repo <path>] [--online] [--parity warn|error]";
const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*__/g;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/* ----------------------------------------------------------------------------
 * Arguments and output
 * -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { moduleDir: null, coreRepo: null, online: false, parity: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--online") opts.online = true;
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
    console.log(`${level.padEnd(6)} [${id}] ${title}${msg ? `: ${msg}` : ""}${where}`);
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

function walk(root, relDir, filter) {
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

/** Foundry keys may be nested objects or flat dotted strings; both mean the same key. */
function flattenKeys(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenKeys(v, key, out);
    else out.add(key);
  }
  return out;
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
  const declared = Array.isArray(ctx.module?.languages) ? ctx.module.languages.filter((l) => l && typeof l.path === "string") : [];
  const langEntries = declared.length
    ? declared.map((l) => ({ lang: String(l.lang ?? path.basename(l.path, ".json")), rel: l.path.replace(/^\.\//, "") }))
    : walk(root, "lang", (n) => n.endsWith(".json")).map((rel) => ({ lang: path.basename(rel, ".json"), rel }));
  ctx.langFiles = [...new Set([...langEntries.map((l) => l.rel), ...walk(root, "lang", (n) => n.endsWith(".json"))])];
  ctx.langJson = new Map(ctx.langFiles.map((rel) => [rel, readJson(root, rel)]));
  ctx.langKeys = new Map(); // lang code -> Set of keys (several files per code merge, as in Foundry)
  for (const { lang, rel } of langEntries) {
    const data = ctx.langJson.get(rel)?.data;
    if (!data) continue;
    const keys = ctx.langKeys.get(lang) ?? new Set();
    for (const k of flattenKeys(data)) keys.add(k);
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
  // editor opens, long after the module loaded fine.
  for (const rel of ctx.scripts) {
    const { code, lineOf } = ctx.scan(rel);
    for (const t of code.matchAll(/templates\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.hbs/g)) {
      const before = code.slice(Math.max(0, t.index - 80), t.index);
      if (/systems\/[^/\s'"`]+\/$/.test(before)) continue; // a system's template
      const other = /modules\/([A-Za-z0-9_-]+)\/$/.exec(before);
      if (other && other[1] !== m.id) continue; // another module's template
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
const TLA_RE = /^(?:await[\s(]|for\s+await\b|(?:const|let|var)\s+(?:[\w$]+|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*await\b)/gm;

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
        if (spec.startsWith("/")) {
          c.fail(`import "${spec}" is absolute: Foundry may serve the module under a route prefix or a versioned path (The Forge); use a ./ path inside the module`, loc);
        } else if (spec.includes("/modules/") || spec.startsWith("modules/")) {
          c.fail(`import "${spec}" reaches into another module's folder: modules never import each other`, loc);
        } else if (spec.startsWith(".") && !spec.includes("${")) {
          const target = path.resolve(path.dirname(path.join(ctx.root, rel)), spec);
          const inside = path.relative(ctx.root, target);
          if (inside.startsWith("..") || path.isAbsolute(inside)) {
            c.fail(`import "${spec}" leaves the module folder`, loc);
          } else {
            const r = existsExact(ctx.root, inside.split(path.sep).join("/"));
            if (!r.ok) c.fail(`import "${spec}" ${r.actual ? `matches only "${r.actual}" (case)` : "does not exist"}: the module would fail to load`, loc);
          }
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
  // Comments do not count: a flag scope or rule slug that only survives in a
  // comment has stopped being written, and worlds that stored it are orphaned.
  const code = ctx.ownScripts.map((rel) => ctx.scan(rel).code).join("\n");
  for (const s of list) {
    if (!code.includes(s)) {
      c.fail(`"${s}" no longer appears in scripts/: it is stored in worlds (flags, rule slugs, roll options), renaming it orphans existing data`, { file: "baron.json" });
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
  console.log(`check-module: ${ctx.module?.id ?? path.basename(root)} (${root})${opts.online ? " --online" : ""}`);

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

  const { passed, warnings, failed } = r.counts;
  console.log(`check-module: ${passed} passed, ${warnings} warnings, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main();
