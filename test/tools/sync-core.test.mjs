// sync-core and check-module --online against a throwaway core repo built in a
// temp folder: a fake baron-core.js committed and tagged, this repo's tools
// copied next to it, and a consumer module with workflow pins.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CI_WORKFLOW,
  RELEASE_WORKFLOW,
  ZERO_SHA,
  checkModule,
  commitCore,
  fakeCore,
  git,
  makeConsumer,
  makeCoreRepo,
  parseReport,
  readJson,
  readText,
  sha256Lf,
  startNode,
  syncCore,
  tempDir,
  waitFor,
} from "./helpers.mjs";

test("sync-core --ref <tag> vendors the file, writes the lock and rewrites every core pin", (t) => {
  const { core, commit } = makeCoreRepo(t, "1.2.3");
  const mod = makeConsumer(t);
  const res = syncCore(core, [mod, "--ref", "v1.2.3"]);
  assert.equal(res.status, 0, res.out);

  const expected = fakeCore("1.2.3");
  const copy = readText(mod, "scripts", "baron-core.js");
  assert.equal(copy, expected);
  assert.ok(!copy.includes("\r"));

  const lockRaw = readText(mod, "baron-core.lock.json");
  assert.equal(lockRaw, JSON.stringify({ version: "1.2.3", commit, sha256: sha256Lf(expected) }, null, 2) + "\n");
  assert.match(commit, /^[0-9a-f]{40}$/);

  // Pins move to the commit; every other line is untouched, CRLF included.
  assert.equal(readText(mod, ".github", "workflows", "ci.yml"), CI_WORKFLOW.replace(ZERO_SHA, commit));
  assert.equal(
    readText(mod, ".github", "workflows", "release.yml"),
    RELEASE_WORKFLOW.replace("module-release.yml@main", `module-release.yml@${commit}`),
  );
  assert.ok(readText(mod, ".github", "workflows", "ci.yml").includes("actions/checkout@v4"));
  assert.ok(readText(mod, ".github", "workflows", "ci.yml").includes("module-check.yml@commented-out"));
  assert.match(res.stdout, /pf2e-baron-core 1\.2\.3 @ [0-9a-f]{40} \(tag v1\.2\.3\)/);

  // A second run is a no-op.
  const again = syncCore(core, [mod, "--ref", "v1.2.3"]);
  assert.equal(again.status, 0, again.out);
  assert.match(again.stdout, /already at/);
  assert.equal(readText(mod, "baron-core.lock.json"), lockRaw);
});

test("sync-core runs from the module folder when no folder is given", (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  const mod = makeConsumer(t);
  const res = syncCore(core, ["--ref=v1.2.3"], { cwd: mod });
  assert.equal(res.status, 0, res.out);
  assert.equal(readJson(mod, "baron-core.lock.json").version, "1.2.3");
});

test("sync-core refuses a tag that does not match CORE_VERSION", (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  commitCore(core, fakeCore("1.2.4"), "v1.2.5");
  const mod = makeConsumer(t);
  const res = syncCore(core, [mod, "--ref", "v1.2.5"]);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /tag v1\.2\.5 does not match CORE_VERSION 1\.2\.4/);
  // Nothing was written.
  assert.ok(!fs.existsSync(path.join(mod, "scripts", "baron-core.js")));
  assert.ok(!fs.existsSync(path.join(mod, "baron-core.lock.json")));
  assert.ok(readText(mod, ".github", "workflows", "ci.yml").includes(ZERO_SHA));
});

test("sync-core accepts an untagged sha but warns that --online will fail", (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  const sha = commitCore(core, fakeCore("1.3.0"));
  const mod = makeConsumer(t);
  const res = syncCore(core, [mod, "--ref", sha]);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /WARNING: .* is not tag v1\.3\.0/);
  assert.deepEqual(readJson(mod, "baron-core.lock.json"), { version: "1.3.0", commit: sha, sha256: sha256Lf(fakeCore("1.3.0")) });

  // check-module --online then fails on the missing tag, and passes once it exists.
  const before = checkModule([mod, "--online", "--core-repo", core], { core });
  assert.equal(before.status, 1, before.out);
  assert.deepEqual([...parseReport(before.out).fail], ["f"], before.out);
  assert.match(before.out, /tag v1\.3\.0 does not exist/);
  git(core, "tag", "-a", "v1.3.0", "-m", "v1.3.0", sha);
  const after = checkModule([mod, "--online", "--core-repo", core], { core });
  assert.equal(after.status, 0, after.out);
});

test("sync-core vendors a CRLF blob as LF and hashes the LF text", (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  const crlf = fakeCore("2.0.0", { eol: "\r\n" });
  const sha = commitCore(core, crlf, "v2.0.0");
  assert.ok(git(core, "cat-file", "-p", `${sha}:baron-core.js`).includes("\r\n"), "the blob itself must hold CRLF");
  const mod = makeConsumer(t);
  const res = syncCore(core, [mod, "--ref", "v2.0.0"]);
  assert.equal(res.status, 0, res.out);
  const copy = readText(mod, "scripts", "baron-core.js");
  assert.ok(!copy.includes("\r"));
  assert.equal(readJson(mod, "baron-core.lock.json").sha256, sha256Lf(crlf));
  const check = checkModule([mod, "--online", "--core-repo", core], { core });
  assert.equal(check.status, 0, check.out);
});

test("sync-core usage and input errors exit 1 with a clear message", (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  const mod = makeConsumer(t);
  const cases = [
    [[mod], /pass --ref <tag\|sha>/],
    [[mod, "--ref"], /--ref needs a tag or a commit sha/],
    [[mod, "--ref", "v1.2.3", "--watch"], /exclusive/],
    [[mod, "--ref", "-x"], /invalid ref "-x"/],
    [[mod, "--ref", "--watch"], /--ref needs a tag or a commit sha/],
    [[mod, "--ref", "v9.9.9"], /does not resolve to a commit/],
    [[mod, "--bogus"], /unknown option --bogus/],
    [[tempDir(t, "empty"), "--ref", "v1.2.3"], /has no module\.json/],
  ];
  for (const [args, re] of cases) {
    const res = syncCore(core, args);
    assert.equal(res.status, 1, `${args.join(" ")}\n${res.out}`);
    assert.match(res.stderr, re, args.join(" "));
  }
});

test("sync-core fails when the commit has no baron-core.js or no CORE_VERSION line", (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  commitCore(core, "export const nothing = 1;\n", "v0.0.1");
  const mod = makeConsumer(t);
  const noVersion = syncCore(core, [mod, "--ref", "v0.0.1"]);
  assert.equal(noVersion.status, 1);
  assert.match(noVersion.stderr, /has no 'export const CORE_VERSION/);

  fs.rmSync(path.join(core, "baron-core.js"));
  git(core, "add", "-A");
  git(core, "commit", "-q", "-m", "drop core");
  const gone = syncCore(core, [mod, "--ref", "main"]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /baron-core\.js does not exist at [0-9a-f]{40}/);
});

test("check-module --online passes on a fresh sync and catches every kind of drift", (t) => {
  const { core, commit } = makeCoreRepo(t, "1.2.3");
  const mod = makeConsumer(t);
  assert.equal(syncCore(core, [mod, "--ref", "v1.2.3"]).status, 0);
  const online = () => checkModule([mod, "--online", "--core-repo", core], { core });

  const ok = online();
  assert.equal(ok.status, 0, ok.out);
  const okReport = parseReport(ok.out);
  assert.ok(okReport.pass.has("e") && okReport.pass.has("f"), ok.out);
  assert.match(ok.out, /PASS {3}\[f\] core lock online: tag v1\.2\.3 -> [0-9a-f]{12}, sha256 matches, 2 workflow pin\(s\) at the lock commit/);

  // Offline the same module passes [e] and only notes that [f] was not run.
  const offline = checkModule([mod], { core });
  assert.equal(offline.status, 0, offline.out);
  assert.ok(offline.out.includes("NOTICE [f] core lock online: offline"), offline.out);

  const save = (rel) => {
    const file = path.join(mod, rel);
    const text = fs.readFileSync(file, "utf8");
    return () => fs.writeFileSync(file, text);
  };

  // 1) The vendored copy edited by hand: [e] fails offline already.
  let restore = save("scripts/baron-core.js");
  fs.appendFileSync(path.join(mod, "scripts", "baron-core.js"), "export const hotfix = true;\n");
  let res = online();
  assert.equal(res.status, 1);
  assert.deepEqual([...parseReport(res.out).fail], ["e"], res.out);
  restore();

  // 2) Copy and lock edited together (the hash is consistent locally): only
  //    the core repo can tell, so [f] fails and [e] passes.
  restore = save("scripts/baron-core.js");
  const restoreLock = save("baron-core.lock.json");
  fs.appendFileSync(path.join(mod, "scripts", "baron-core.js"), "export const hotfix = true;\n");
  const lock = readJson(mod, "baron-core.lock.json");
  lock.sha256 = sha256Lf(readText(mod, "scripts", "baron-core.js"));
  fs.writeFileSync(path.join(mod, "baron-core.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  res = online();
  assert.equal(res.status, 1);
  assert.deepEqual([...parseReport(res.out).fail], ["f"], res.out);
  assert.match(res.out, /baron-core\.js at [0-9a-f]{40} hashes to [0-9a-f]{64}, not to lock\.sha256/);
  restore();
  restoreLock();

  // 3) A workflow pin moved by hand.
  restore = save(".github/workflows/ci.yml");
  const other = commitCore(core, fakeCore("1.2.3", { extra: "// unrelated\n" }));
  fs.writeFileSync(path.join(mod, ".github", "workflows", "ci.yml"), readText(mod, ".github", "workflows", "ci.yml").replace(commit, other));
  res = online();
  assert.equal(res.status, 1);
  assert.deepEqual([...parseReport(res.out).fail], ["f"], res.out);
  assert.match(res.out, /module-check\.yml@[0-9a-f]{40} is not pinned to lock\.commit/);
  assert.match(res.out, /\(\.github\/workflows\/ci\.yml:6\)/);
  restore();

  // 4) The tag moved away from the locked commit.
  git(core, "tag", "-f", "-a", "v1.2.3", "-m", "moved", other);
  res = online();
  assert.equal(res.status, 1);
  assert.match(res.out, new RegExp(`tag v1\\.2\\.3 points at ${other}, not at lock\\.commit ${commit}`));
  git(core, "tag", "-f", "-a", "v1.2.3", "-m", "back", commit);
  assert.equal(online().status, 0);

  // 5) lock.commit unknown to the core repo.
  const restoreLock2 = save("baron-core.lock.json");
  const bogus = readJson(mod, "baron-core.lock.json");
  bogus.commit = "f".repeat(40);
  fs.writeFileSync(path.join(mod, "baron-core.lock.json"), JSON.stringify(bogus, null, 2) + "\n");
  res = online();
  assert.equal(res.status, 1);
  assert.match(res.out, /commit f{40} \(or its baron-core\.js\) is not in/);
  restoreLock2();

  // 6) --core-repo that is not a git repository.
  res = checkModule([mod, "--online", "--core-repo", tempDir(t, "not-git")], { core });
  assert.equal(res.status, 1);
  assert.match(res.out, /is not a git repository \(--core-repo\)/);
});

test("sync-core --watch mirrors the core working tree and marks the lock dev", async (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  const mod = makeConsumer(t);
  const watcher = startNode(path.join(core, "tools", "sync-core.mjs"), [mod, "--watch"]);
  t.after(watcher.stop);

  const lockFile = path.join(mod, "baron-core.lock.json");
  const copyFile = path.join(mod, "scripts", "baron-core.js");
  const dev = (text) => {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return lock.version === "dev" && lock.commit === "dev" && lock.sha256 === sha256Lf(text) && fs.readFileSync(copyFile, "utf8") === text;
  };

  const first = fakeCore("1.2.3");
  assert.ok(await waitFor(() => dev(first)), `initial copy not made\n${watcher.output()}`);

  // An edit in the core working tree (uncommitted, CRLF) reaches the module as LF.
  const edited = fakeCore("1.3.0-dev", { eol: "\r\n", extra: "export const live = true;" });
  fs.writeFileSync(path.join(core, "baron-core.js"), edited);
  const editedLf = edited.replace(/\r\n/g, "\n");
  assert.ok(await waitFor(() => dev(editedLf)), `edit not mirrored\n${watcher.output()}`);
  // The copied files can be visible here before the child's log line has come
  // through its stdout pipe (seen on Linux CI), so the log gets its own wait.
  const logged = /copied baron-core\.js \(CORE_VERSION 1\.3\.0-dev/;
  assert.ok(await waitFor(() => logged.test(watcher.output())), `copy not logged\n${watcher.output()}`);
  await watcher.stop();

  // A dev lock never passes check-module.
  const res = checkModule([mod], { core });
  assert.equal(res.status, 1, res.out);
  assert.deepEqual([...parseReport(res.out).fail], ["e"], res.out);
  assert.match(res.out, /sync-core --watch/);
});

test("sync-core --watch marks the lock dev on start even when the copy is already identical", async (t) => {
  const { core } = makeCoreRepo(t, "1.2.3");
  const mod = makeConsumer(t);
  const synced = syncCore(core, [mod, "--ref", "v1.2.3"]);
  assert.equal(synced.status, 0, synced.out);
  assert.equal(readJson(mod, "baron-core.lock.json").version, "1.2.3");

  // No edit at all: the module holds the release text, yet watching means the
  // copy no longer follows a release, so the lock must say so right away.
  const watcher = startNode(path.join(core, "tools", "sync-core.mjs"), [mod, "--watch"]);
  t.after(watcher.stop);
  const lockFile = path.join(mod, "baron-core.lock.json");
  const isDev = () => {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return lock.version === "dev" && lock.commit === "dev" && lock.sha256 === sha256Lf(fakeCore("1.2.3"));
  };
  assert.ok(await waitFor(isDev), `lock not marked dev on start\n${watcher.output()}`);
  assert.equal(readText(mod, "scripts", "baron-core.js"), fakeCore("1.2.3"));
  await watcher.stop();
});
