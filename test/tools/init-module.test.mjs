// tools/init-module.mjs of pf2e-module-template, run on a scratch copy of that
// repo: every new module opts into the human-text lock. The template lives
// next to this repo (the layout both READMEs ask for), or where
// BARON_TEMPLATE_DIR says; without it, as in this repo's CI, the tests skip.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signTexts } from "../../tools/sign-text.mjs";
import { REPO, checkModule, parseReport, readJson, runNode, tempDir } from "./helpers.mjs";

const TEMPLATE = path.resolve(process.env.BARON_TEMPLATE_DIR ?? path.join(REPO, "..", "pf2e-module-template"));
const INIT_REL = path.join("tools", "init-module.mjs");
const skip = fs.existsSync(path.join(TEMPLATE, INIT_REL)) ? false : `no pf2e-module-template with ${INIT_REL} at ${TEMPLATE}`;

/** The template's working tree copied to a folder named like the new id, then initialized. */
function initModule(t, id, extra = [], { oldBaronJson = false, lockVersion } = {}) {
  const dir = path.join(tempDir(t, "init"), id);
  // Init skips these folders too; .git would point the copy at the template's remote.
  const SKIP = new Set([".git", "node_modules", ".baron-core", ".code-review-graph"]);
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  if (oldBaronJson) {
    // A template baron.json from before the lock: init still opts the module in.
    const baron = readJson(dir, "baron.json");
    delete baron.humanText;
    fs.writeFileSync(path.join(dir, "baron.json"), JSON.stringify(baron, null, 2) + "\n");
  }
  if (lockVersion !== undefined) {
    // The core the module's CI will run, as sync-core would pin it.
    const lock = readJson(dir, "baron-core.lock.json");
    lock.version = lockVersion;
    fs.writeFileSync(path.join(dir, "baron-core.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  }
  const res = runNode(path.join(dir, INIT_REL), ["--id", id, "--title", "Init Fixture", "--description", "A module made by the init test.", "--author", "BaronHVC", "--prefix", "bif", ...extra], { cwd: dir });
  assert.equal(res.status, 0, res.out);
  assert.ok(!fs.existsSync(path.join(dir, INIT_REL)), "init deletes itself");
  return { dir, out: res.stdout };
}

test("init-module writes humanText \"signed\" into the baron.json of every new module", { skip }, (t) => {
  for (const [id, extra, opts] of [
    ["baron-init-public", ["--mode", "public"]],
    ["baron-init-orc", ["--mode", "public", "--paizo", "orc"]],
    ["baron-init-paid", ["--mode", "protected", "--requires", "baron-init-public"]],
    ["baron-init-old", ["--mode", "public"], { oldBaronJson: true }],
  ]) {
    const { dir, out } = initModule(t, id, extra, opts);
    const baron = readJson(dir, "baron.json");
    assert.equal(baron.humanText, "signed", `${id}: ${JSON.stringify(baron)}`);
    assert.ok(out.includes("node ../pf2e-baron-core/tools/sign-text.mjs . --sign"), out);
    // Decision 28: BaronHVC or IAR18 write the texts, and BaronHVC signs each one for its real author.
    assert.ok(out.includes("node ../pf2e-baron-core/tools/sign-text.mjs . --sign --sheet textos-hoja.csv"), out);
    assert.ok(out.includes("--sign --author <nombre>"), out);
    assert.ok(out.includes("BaronHVC o IAR18"), out);
    assert.ok(!out.includes("los escribes tu"), out);
  }
});

test("a freshly initialized module is held by the lock until its author signs every text", { skip }, async (t) => {
  const { dir } = initModule(t, "baron-init-lock", ["--mode", "public"]);
  const nOf = (res, level) => parseReport(res.out).lines.filter((l) => l.startsWith(`${level.padEnd(6)} [n]`));

  const push = checkModule([dir]);
  assert.equal(push.status, 0, push.out);
  assert.ok(!parseReport(push.out).fail.has("c"), push.out);
  assert.match(nOf(push, "WARN")[0] ?? "", /^WARN {3}\[n\] human text: \d+ text\(s\) lack a valid signature in human-text\.json \(there is no such file yet\)/, push.out);
  const release = checkModule([dir, "--release"]);
  assert.equal(release.status, 1, release.out);
  assert.deepEqual([...parseReport(release.out).fail], ["n"], release.out);

  // The author answers "s" to every question at his terminal (faked here).
  const res = await signTexts({ dir, sign: true, isTTY: true, ask: async () => "s", log: () => {} });
  assert.ok(res.signed > 0 && res.wrote, JSON.stringify(res));
  const signed = checkModule([dir, "--release"]);
  assert.deepEqual(nOf(signed, "FAIL"), [], signed.out);
  const pass = nOf(signed, "PASS")[0] ?? "";
  assert.ok(pass.endsWith(`; ${res.signed} text(s) signed in human-text.json`), signed.out);
});

test("init-module warns while the pinned core's CI does not check the signatures yet", { skip }, (t) => {
  const WARN = "OJO: baron-core.lock.json fija";
  for (const [version, warns] of [
    ["1.4.0", true],
    ["1.3.0", true],
    ["1.4.0-rc.1", true],
    ["1.4.1", false],
    ["1.5.0-rc.1", false],
    ["1.5.0", false],
    ["2.0.0", false],
  ]) {
    const { out } = initModule(t, `baron-init-v${version.replace(/[.]/g, "-")}`, ["--mode", "public"], { lockVersion: version });
    assert.equal(out.includes(WARN), warns, `${version}${String.fromCharCode(10)}${out}`);
    if (warns) {
      assert.ok(out.includes(`${WARN} v${version}, y la CI de ese nucleo no revisa las firmas`), out);
      assert.ok(out.includes("un texto nuevo lleva el marcador TODO-HUMANO: (regla 15 del CLAUDE.md)"), out);
    }
  }
});
