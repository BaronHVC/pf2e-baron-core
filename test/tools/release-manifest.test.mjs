// release-manifest: the module.json rewrite of module-release, public (stable,
// prerelease, dev channel) and protected (Foundry-hosted, paid), as a function
// and as the CLI the workflow runs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { foundryManifestUrl, isStableTag, releaseManifest } from "../../tools/release-manifest.mjs";
import { githubPaths, httpsUrlProblem, mentionsGitHub } from "../../tools/shared.mjs";
import { TOOLS, VALID_MODULE, childEnv, readJson, runNode, tempDir } from "./helpers.mjs";

const SOURCE = readJson(VALID_MODULE, "module.json");
const REPO = "BaronHVC/baron-fixture";
const GH = `https://github.com/${REPO}/releases`;
const LANDING = "https://www.example.com/baron-fixture";

const pub = (tag, channel, extra = {}) => releaseManifest(SOURCE, { tag, repo: REPO, channel, ...extra });
const paid = (manifest = SOURCE, extra = {}) => releaseManifest(manifest, { tag: "v1.2.3", repo: REPO, channel: "stable", mode: "protected", landingUrl: LANDING, ...extra });
/** Everything except the given keys, to show the rest passes through untouched. */
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
// The protected leak error, matched on the JSON paths it lists.
const LEAK = "the protected manifest still links to GitHub (github.com, githubusercontent.com, github.io) at ";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const leakAt = (paths, prefix = "") => new RegExp(`${prefix}${escapeRe(`${LEAK}${paths}: `)}`);

/* ----------------------------------------------------------------------------
 * Public
 * -------------------------------------------------------------------------- */

test("public stable: version from the tag, download in its release, manifest at releases/latest", () => {
  const m = pub("v1.2.3", "stable");
  assert.equal(m.version, "1.2.3");
  assert.equal(m.download, `${GH}/download/v1.2.3/baron-fixture-v1.2.3.zip`);
  assert.equal(m.manifest, `${GH}/latest/download/module.json`);
  assert.deepEqual(without(m, "version", "download", "manifest"), without(SOURCE, "version", "download", "manifest"));
  assert.deepEqual(Object.keys(m), Object.keys(SOURCE), "existing keys keep their place");
  assert.ok(!("protected" in m));
});

test("public prerelease: the manifest stays in the tag's own release, never at latest", () => {
  const m = pub("v1.2.3-rc.1", "prerelease");
  assert.equal(m.version, "1.2.3-rc.1");
  assert.equal(m.download, `${GH}/download/v1.2.3-rc.1/baron-fixture-v1.2.3-rc.1.zip`);
  assert.equal(m.manifest, `${GH}/download/v1.2.3-rc.1/module.json`);
});

test("public dev: numeric X.Y.Z.<run> and the fixed dev release, from the source or from the release copy", () => {
  for (const [tag, run, version] of [
    ["v1.2.3", "18", "1.2.3.18"],
    ["v0.7.0-rc10", 1234, "0.7.0.1234"],
    ["v2.0.0+build.5", "7", "2.0.0.7"],
  ]) {
    const m = pub(tag, "dev", { runNumber: run });
    assert.equal(m.version, version);
    assert.equal(m.manifest, `${GH}/download/dev/module.json`);
    assert.equal(m.download, `${GH}/download/dev/baron-fixture-dev.zip`);
    // The workflow runs the dev rewrite on the copy the release step wrote.
    const release = pub(tag, isStableTag(tag) ? "stable" : "prerelease");
    assert.equal(JSON.stringify(releaseManifest(release, { tag, repo: REPO, channel: "dev", runNumber: run })), JSON.stringify(m));
  }
});

test("missing keys are appended as version, download, manifest: the order module-release always wrote", () => {
  const bare = without(SOURCE, "version", "download", "manifest");
  const keys = Object.keys(bare);
  assert.deepEqual(Object.keys(releaseManifest(bare, { tag: "v1.0.0", repo: REPO, channel: "stable" })), [...keys, "version", "download", "manifest"]);
  assert.deepEqual(Object.keys(releaseManifest(bare, { tag: "v1.0.0", repo: REPO, channel: "dev", runNumber: "3" })), [...keys, "version", "download", "manifest"]);
  assert.deepEqual(Object.keys(paid(bare)), [...keys, "version", "manifest", "url", "protected"].filter((k, i, a) => a.indexOf(k) === i));
});

test("the input object is never modified", () => {
  const before = JSON.stringify(SOURCE);
  pub("v1.2.3", "stable");
  pub("v1.2.3", "dev", { runNumber: "1" });
  paid();
  assert.equal(JSON.stringify(SOURCE), before);
});

test("the channel must agree with the tag, and --run-number belongs to dev only", () => {
  assert.throws(() => pub("v1.2.3-rc.1", "stable"), /tag v1\.2\.3-rc\.1 is not vX\.Y\.Z, so a prerelease: use --channel prerelease/);
  assert.throws(() => pub("v1.2.3", "prerelease"), /tag v1\.2\.3 is a stable vX\.Y\.Z: use --channel stable/);
  assert.throws(() => pub("v1.2.3", "dev"), /--channel dev needs --run-number <n> \(digits\), not ""/);
  assert.throws(() => pub("v1.2.3", "dev", { runNumber: "12a" }), /needs --run-number <n> \(digits\), not "12a"/);
  assert.throws(() => pub("v1.2.3", "stable", { runNumber: "5" }), /--run-number only applies to --channel dev/);
});

test("invalid arguments and manifests are refused", () => {
  assert.throws(() => pub("v1.2.3", "nightly"), /--channel must be stable, prerelease or dev, not "nightly"/);
  assert.throws(() => pub("", "stable"), /--tag is required/);
  assert.throws(() => releaseManifest(SOURCE, { tag: "v1.2.3", repo: "BaronHVC", channel: "stable" }), /--repo must be <owner>\/<name>, not "BaronHVC"/);
  assert.throws(() => releaseManifest(SOURCE, { tag: "v1.2.3", repo: REPO, channel: "stable", mode: "paid" }), /--mode must be public or protected, not "paid"/);
  assert.throws(() => releaseManifest(without(SOURCE, "id"), { tag: "v1.2.3", repo: REPO, channel: "stable" }), /module\.json has no "id"/);
  assert.throws(() => releaseManifest([], { tag: "v1.2.3", repo: REPO, channel: "stable" }), /module\.json must be a JSON object/);
});

/* ----------------------------------------------------------------------------
 * Protected
 * -------------------------------------------------------------------------- */

test("protected: protected true, no download, the manifest Foundry hosts, url = the landing page", () => {
  for (const [tag, channel] of [
    ["v1.2.3", "stable"],
    ["v1.3.0-rc.1", "prerelease"],
  ]) {
    const m = paid(SOURCE, { tag, channel });
    assert.equal(m.protected, true);
    assert.ok(!("download" in m));
    assert.equal(m.manifest, "https://r2.foundryvtt.com/packages-public/baron-fixture/module.json");
    assert.equal(m.manifest, foundryManifestUrl("baron-fixture"));
    assert.equal(m.url, LANDING);
    assert.equal(m.version, tag.slice(1));
    assert.deepEqual(without(m, "version", "manifest", "url", "protected"), without(SOURCE, "version", "manifest", "url", "download"));
    assert.deepEqual(githubPaths(m), []);
  }
});

test("protected: any string still linking to GitHub fails, with every JSON path listed", () => {
  const leaky = {
    ...SOURCE,
    authors: [{ name: "BaronHVC" }, { name: "Baron", url: "https://GitHub.com/BaronHVC" }],
    bugs: "https://github.com/BaronHVC/baron-fixture/issues",
    readme: "https://github.com/BaronHVC/baron-fixture#readme",
    changelog: "https://github.com/BaronHVC/baron-fixture/blob/main/CHANGELOG.md",
    relationships: { requires: [{ id: "baron-base", type: "module", manifest: "https://github.com/BaronHVC/baron-base/releases/latest/download/module.json" }] },
    flags: { "odd key": "see github.com/BaronHVC" },
  };
  assert.throws(
    () => paid(leaky),
    (err) => {
      assert.match(err.message, leakAt('authors[1].url, relationships.requires[0].manifest, bugs, readme, changelog, flags["odd key"]', "^"));
      assert.match(err.message, /: a paid module lives in a private repo/);
      return true;
    },
  );
  // Each field on its own is enough.
  for (const key of ["bugs", "readme", "changelog"]) {
    assert.throws(() => paid({ ...SOURCE, [key]: `https://github.com/${REPO}` }), leakAt(key));
  }
  assert.throws(() => paid({ ...SOURCE, authors: [{ name: "x", url: "https://github.com/x" }] }), leakAt("authors[0].url"));
  // A landing page on GitHub is the private repo too.
  assert.throws(() => paid(SOURCE, { landingUrl: `https://github.com/${REPO}` }), leakAt("url"));
});

test("protected: every GitHub host fails, and so does a key or a percent-escaped host", () => {
  // Each of these can name the private repo: raw files, release assets, Pages.
  for (const [extra, at] of [
    [{ readme: `https://raw.githubusercontent.com/${REPO}/main/README.md` }, "readme"],
    [{ media: [{ type: "cover", url: "https://objects.githubusercontent.com/github-production-release-asset/1/x.webp" }] }, "media[0].url"],
    [{ changelog: "https://baronhvc.GitHub.io/baron-fixture/changelog" }, "changelog"],
    [{ bugs: "https://gist.github.com/BaronHVC/1" }, "bugs"],
    [{ bugs: "https://github%2Ecom/BaronHVC/baron-fixture/issues" }, "bugs"],
    [{ flags: { [`https://github.com/${REPO}`]: true } }, `flags["https://github.com/${REPO}"] (key)`],
    [{ flags: { baron: { "x.github.io": { y: "https://github.com/x" } } } }, 'flags.baron["x.github.io"] (key), flags.baron["x.github.io"].y'],
  ]) {
    assert.throws(() => paid({ ...SOURCE, ...extra }), leakAt(at), JSON.stringify(extra));
  }
  // A landing page on any GitHub host is refused as the manifest's url.
  for (const landingUrl of [`https://raw.githubusercontent.com/${REPO}/main/README.md`, "https://baronhvc.github.io/baron-fixture"]) {
    assert.throws(() => paid(SOURCE, { landingUrl }), leakAt("url"), landingUrl);
  }
});

test("protected: the landing URL is required and must be https", () => {
  for (const [landingUrl, reason] of [
    [null, "is missing"],
    [undefined, "is missing"],
    ["", "is empty"],
    ["http://www.example.com", '"http://www.example.com" is not an https URL'],
    ["example.com/baron", '"example.com/baron" is not a URL'],
  ]) {
    assert.throws(() => paid(SOURCE, { landingUrl }), (err) => err.message.startsWith(`--landing-url ${reason}: a protected module needs baron.json "landingUrl"`));
  }
});

test("protected: the dev channel is refused", () => {
  assert.throws(() => paid(SOURCE, { channel: "dev", runNumber: "5" }), /--channel dev is not allowed with --mode protected/);
});

test("httpsUrlProblem and githubPaths, the shared pieces", () => {
  assert.equal(httpsUrlProblem("https://www.patreon.com/c/baron"), null);
  assert.equal(httpsUrlProblem(" https://x.example"), '" https://x.example" contains whitespace');
  assert.equal(httpsUrlProblem(["https://x.example"]), "must be a string");
  assert.deepEqual(githubPaths({ a: [{ b: "x" }, "GITHUB.COM"], "c-d": { e: "https://github.com" }, n: 1, z: null }), ["a[1]", '["c-d"].e']);
  assert.deepEqual(githubPaths("https://github.com"), ["(root)"]);
  assert.deepEqual(githubPaths({ media: "https://raw.githubusercontent.com/x/y/main/a.webp", pages: "https://x.github.io/y" }), ["media", "pages"]);
  // A key is reported before what it holds; a lookalike host is not GitHub.
  assert.deepEqual(githubPaths({ "github.com": "github.io", ok: "https://github.example.com/x" }), ['["github.com"] (key)', '["github.com"]']);
  assert.deepEqual(githubPaths({ a: "https://github%2ecom/x", b: "100%25 github" }), ["a"]);
  assert.equal(mentionsGitHub("https://GITHUBUSERCONTENT.COM/x"), true);
  assert.equal(mentionsGitHub("https://www.patreon.com/c/baron"), false);
});

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */

const SCRIPT = path.join(TOOLS, "release-manifest.mjs");

function moduleFile(t, data = SOURCE) {
  const file = path.join(tempDir(t, "release"), "module.json");
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 4));
  return file;
}

test("the CLI writes 2-space JSON plus a newline and prints what it set", (t) => {
  const file = moduleFile(t);
  const res = runNode(SCRIPT, [file, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable"]);
  assert.equal(res.status, 0, res.out);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(pub("v1.2.3", "stable"), null, 2) + "\n");
  assert.equal(res.stdout, `version  = 1.2.3\ndownload = ${GH}/download/v1.2.3/baron-fixture-v1.2.3.zip\nmanifest = ${GH}/latest/download/module.json\n`);

  const dev = runNode(SCRIPT, [file, "--tag=v1.2.3", "--repo=" + REPO, "--channel=dev", "--run-number=9"]);
  assert.equal(dev.status, 0, dev.out);
  assert.equal(readJson(file).version, "1.2.3.9");
  assert.equal(dev.stdout.split("\n")[0], "version  = 1.2.3.9");

  const prot = moduleFile(t);
  const p = runNode(SCRIPT, [prot, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable", "--mode", "protected", "--landing-url", LANDING]);
  assert.equal(p.status, 0, p.out);
  assert.deepEqual(readJson(prot), paid());
  assert.equal(p.stdout, `version  = 1.2.3\nmanifest = ${foundryManifestUrl("baron-fixture")}\nurl      = ${LANDING}\nprotected = true\n`);
});

test("on any error the CLI exits 1, leaves module.json untouched and annotates under GitHub Actions", (t) => {
  const text = JSON.stringify({ ...SOURCE, bugs: "https://github.com/BaronHVC/baron-fixture/issues" }, null, 4);
  const file = moduleFile(t, text);
  const args = [file, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable", "--mode", "protected", "--landing-url", LANDING];
  const res = runNode(SCRIPT, args);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, leakAt("bugs", "^release-manifest: ERROR: "));
  assert.equal(fs.readFileSync(file, "utf8"), text);

  const ci = runNode(SCRIPT, args, { env: childEnv({ GITHUB_ACTIONS: "true" }) });
  assert.ok(ci.stdout.startsWith(`::error title=release-manifest::${LEAK}bugs: `), ci.out);

  // An empty --landing-url (an empty baron.json field) says so.
  const empty = runNode(SCRIPT, [file, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable", "--mode", "protected", "--landing-url", ""]);
  assert.equal(empty.status, 1, empty.out);
  assert.match(empty.stderr, /--landing-url is empty/);

  const broken = moduleFile(t, "{ not json");
  const bad = runNode(SCRIPT, [broken, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not valid JSON/);
  assert.equal(fs.readFileSync(broken, "utf8"), "{ not json");
});

test("CLI usage errors exit 1 with the usage line", (t) => {
  const file = moduleFile(t);
  for (const [args, message] of [
    [[file, "--repo", REPO, "--channel", "stable"], "--tag is required"],
    [[file, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable", "--landing-url", LANDING], "--landing-url only applies to --mode protected"],
    [[file, "--tag", "v1.2.3", "--tag", "v1.2.4", "--repo", REPO, "--channel", "stable"], "--tag given twice"],
    [[file, "--tag", "v1.2.3", "--repo", REPO, "--channel", "stable", "--frobnicate"], "unknown option --frobnicate"],
    [["--tag", "v1.2.3", "--repo", REPO, "--channel", "stable"], "missing the module.json path"],
    [[file, "--tag"], "--tag needs a value"],
  ]) {
    const res = runNode(SCRIPT, args);
    assert.equal(res.status, 1, res.out);
    assert.ok(res.stderr.includes(`release-manifest: ERROR: ${message}\nusage: node release-manifest.mjs`), `${message}\n${res.out}`);
  }
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(SOURCE, null, 4));
  const help = runNode(SCRIPT, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: node release-manifest\.mjs <module\.json> --tag <tag>/);
});
