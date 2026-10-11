#!/usr/bin/env node
// release-manifest: rewrites a module's module.json for a release. The
// reusable module-release workflow runs it from the pinned core commit, so the
// rules live here, with tests, instead of in inline `node -e` steps.
//
//   node <core>/tools/release-manifest.mjs <module.json> --tag <tag> --repo <owner/name>
//     --channel stable|prerelease|dev [--run-number <n>]
//     [--mode public|protected] [--landing-url <url>]
//
// public, stable      version from the tag; download in the tag's release;
//                     manifest at releases/latest, the URL users install once
// public, prerelease  the same, but the manifest stays in the tag's release
// public, dev         numeric version X.Y.Z.<run>; manifest and download in the
//                     fixed "dev" release (the test channel)
// protected           Foundry hosts the package and serves it to patrons only:
//                     "protected": true, no download, the manifest Foundry
//                     hosts, url = the landing page. Never the dev channel, and
//                     the result may not link to GitHub anywhere, not even in a
//                     key: the repo of a paid module is private.
//
// The file is written (2-space JSON and a newline) only when the result is
// valid; any error exits 1 and leaves it untouched.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { githubPaths, httpsUrlProblem, splitGitHubPaths } from "./shared.mjs";

const USAGE =
  "usage: node release-manifest.mjs <module.json> --tag <tag> --repo <owner/name> --channel stable|prerelease|dev [--run-number <n>] [--mode public|protected] [--landing-url <url>]";

export const CHANNELS = ["stable", "prerelease", "dev"];
export const MODES = ["public", "protected"];

// The same test module-release applies to the tag: anything else (v1.2.0-rc.1)
// is published as a prerelease.
const STABLE_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_NUMBER_RE = /^[0-9]+$/;

/** @param {string} tag */
export const isStableTag = (tag) => STABLE_TAG_RE.test(tag);

/** The manifest URL Foundry serves for a package it hosts. */
export const foundryManifestUrl = (id) => `https://r2.foundryvtt.com/packages-public/${id}/module.json`;

/**
 * The release copy of a module.json. Pure: `manifest` is not modified.
 * @param {object} manifest parsed module.json
 * @param {{
 *   tag: string,
 *   repo: string,
 *   channel: "stable"|"prerelease"|"dev",
 *   runNumber?: string|number|null,
 *   mode?: "public"|"protected",
 *   landingUrl?: string|null,
 * }} opts
 * @returns {object}
 * @throws {Error} with a message meant for the release log
 */
export function releaseManifest(manifest, { tag, repo, channel, runNumber = null, mode = "public", landingUrl = null }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("module.json must be a JSON object");
  if (typeof manifest.id !== "string" || !manifest.id) throw new Error('module.json has no "id"');
  if (typeof tag !== "string" || !tag) throw new Error("--tag is required");
  if (typeof repo !== "string" || !REPO_RE.test(repo)) throw new Error(`--repo must be <owner>/<name>, not ${JSON.stringify(repo ?? "")}`);
  if (!MODES.includes(mode)) throw new Error(`--mode must be public or protected, not ${JSON.stringify(mode)}`);
  if (!CHANNELS.includes(channel)) throw new Error(`--channel must be stable, prerelease or dev, not ${JSON.stringify(channel ?? "")}`);

  const run = runNumber === null || runNumber === undefined ? null : String(runNumber);
  if (channel === "dev") {
    // Paid modules never use the test channel: its files would sit in a
    // GitHub release, outside the Patreon access Foundry enforces.
    if (mode === "protected") throw new Error("--channel dev is not allowed with --mode protected: a paid module never publishes a test channel");
    if (run === null || !RUN_NUMBER_RE.test(run)) throw new Error(`--channel dev needs --run-number <n> (digits), not ${JSON.stringify(run ?? "")}`);
  } else {
    if (run !== null) throw new Error("--run-number only applies to --channel dev");
    // The workflow derives both from the tag; disagreeing would publish a test
    // build at the stable update URL, or hide a stable one from it.
    if (isStableTag(tag) !== (channel === "stable")) {
      throw new Error(`tag ${tag} is ${isStableTag(tag) ? "a stable vX.Y.Z" : "not vX.Y.Z, so a prerelease"}: use --channel ${isStableTag(tag) ? "stable" : "prerelease"}`);
    }
  }

  // A JSON round trip, not structuredClone: the copy must serialize exactly
  // as the parsed file did, own "__proto__" keys included.
  const m = JSON.parse(JSON.stringify(manifest));
  const version = tag.startsWith("v") ? tag.slice(1) : tag;

  if (mode === "protected") {
    const problem = httpsUrlProblem(landingUrl);
    if (problem) {
      throw new Error(`--landing-url ${problem}: a protected module needs baron.json "landingUrl", the https page where players learn how to get it; it becomes the manifest's "url"`);
    }
    m.version = version;
    m.manifest = foundryManifestUrl(m.id);
    m.url = landingUrl;
    m.protected = true;
    delete m.download;
    const { own, deps } = splitGitHubPaths(githubPaths(m));
    if (own.length || deps.length) {
      const why = [];
      if (own.length) {
        why.push(`at ${own.join(", ")}: a paid module lives in a private repo, so those links are dead for players and name the repo; point them at a public page (the landing page) or remove them`);
      }
      // Usually the free base's public manifest: no leak, but still a GitHub
      // link, and Foundry needs none for a package it lists.
      if (deps.length) {
        why.push(`at ${deps.join(", ")}: a dependency's manifest is refused too, since a protected manifest never links to GitHub; remove it and list that module on foundryvtt.com, where Foundry finds a dependency by its id alone`);
      }
      throw new Error(`the protected manifest still links to GitHub (github.com, githubusercontent.com, github.io) ${why.join("; and ")}`);
    }
    return m;
  }

  // The assignment order is the key order of a module.json that lacks these
  // keys, so it must match what module-release has always written.
  const base = `https://github.com/${repo}/releases`;
  m.version = version;
  m.download = `${base}/download/${tag}/${m.id}-${tag}.zip`;
  // Stable builds point at 'latest' so Foundry offers updates on its own and
  // the install URL never has to change. Prereleases are excluded from
  // 'latest' on purpose, so pointing them there would make Foundry resolve a
  // test build straight back to the last stable one.
  m.manifest = isStableTag(tag) ? `${base}/latest/download/module.json` : `${base}/download/${tag}/module.json`;
  if (channel !== "dev") return m;

  // Foundry compares versions segment by segment and falls back to a string
  // compare on anything non-numeric, so '0.7.0-rc10' reads as older than
  // '0.7.0-rc9' and the update stops being offered. The test channel therefore
  // reports a plain numeric build that always grows.
  const dev = `https://github.com/${repo}/releases/download/dev/`;
  m.version = `${version.replace(/[-+].*$/, "")}.${run}`;
  m.manifest = `${dev}module.json`;
  m.download = `${dev}${m.id}-dev.zip`;
  return m;
}

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

const OPTIONS = { "--tag": "tag", "--repo": "repo", "--channel": "channel", "--run-number": "runNumber", "--mode": "mode", "--landing-url": "landingUrl" };

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { file: null, mode: "public" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (Object.hasOwn(OPTIONS, flag)) {
      if (seen.has(flag)) throw new UsageError(`${flag} given twice`);
      seen.add(flag);
      const value = flag === a ? argv[++i] : a.slice(eq + 1);
      // An empty value is passed on: "--landing-url ''" from an empty
      // baron.json field must say the URL is empty, not that it is missing.
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      opts[OPTIONS[flag]] = value;
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (opts.file === null) opts.file = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (opts.file === null) throw new UsageError("missing the module.json path");
  for (const flag of ["--tag", "--repo", "--channel"]) {
    if (!seen.has(flag)) throw new UsageError(`${flag} is required`);
  }
  if (opts.landingUrl !== undefined && opts.mode !== "protected") throw new UsageError("--landing-url only applies to --mode protected");
  return opts;
}

// Workflow command escaping, from the GitHub Actions toolkit.
const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function fail(message, usage = false) {
  console.error(`release-manifest: ERROR: ${message}${usage ? `\n${USAGE}` : ""}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=release-manifest::${escData(message)}`);
  process.exit(1);
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, true);
    throw err;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(opts.file, "utf8"));
  } catch (err) {
    fail(err.code === "ENOENT" ? `${opts.file} does not exist` : `${opts.file} is not valid JSON: ${err.message}`);
  }
  let m;
  try {
    m = releaseManifest(manifest, { ...opts, landingUrl: opts.landingUrl ?? null });
  } catch (err) {
    fail(err.message);
  }
  fs.writeFileSync(opts.file, JSON.stringify(m, null, 2) + "\n");

  const show = (k) => console.log(`${k.padEnd(8)} = ${m[k]}`);
  if (opts.mode === "protected") ["version", "manifest", "url", "protected"].forEach(show);
  else if (opts.channel === "dev") ["version", "manifest", "download"].forEach(show);
  else ["version", "download", "manifest"].forEach(show);
}

// Imported by the tests, run by the workflow: only the latter parses argv.
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

if (isMain()) main(process.argv.slice(2));
