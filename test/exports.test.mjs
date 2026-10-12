import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../baron-core.js";

// The v1 surface. A new export must be added here on purpose (MINOR release),
// and nothing may disappear within 1.x.
const EXPECTED = [
  "CORE_VERSION",
  "createI18n",
  "slugOf",
  "resolveLabel",
  "locRecord",
  "labelFor",
  "clampInt",
  "escHTML",
  "isValuedCondition",
  "DIE_SIZES",
  "PF2E_MODIFIER_TYPES",
  "isSoleExecutor",
  "canEditItem",
  "makeCanEdit",
  "formDataClass",
  "textEditor",
  "sheetElement",
  "packIndex",
  "enrichHTML",
  "guardClicks",
  "releaseClickGuard",
  "renderSoon",
  "injectSheetButton"
];

test("exports exactly the 1.0.0 surface, all named", () => {
  assert.deepEqual(Object.keys(core).sort(), [...EXPECTED].sort());
  assert.equal("default" in core, false);
});

test("every export except the constants is a function", () => {
  const constants = new Set(["CORE_VERSION", "DIE_SIZES", "PF2E_MODIFIER_TYPES"]);
  for (const name of EXPECTED) {
    if (constants.has(name)) continue;
    assert.equal(typeof core[name], "function", name);
  }
});

test("CORE_VERSION is 1.4.0 and valid SemVer", () => {
  assert.equal(core.CORE_VERSION, "1.4.0");
  assert.match(core.CORE_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("DIE_SIZES keeps SWE's order and is not frozen", () => {
  assert.deepEqual(core.DIE_SIZES, ["d4", "d6", "d8", "d10", "d12"]);
  assert.equal(Object.isFrozen(core.DIE_SIZES), false);
});

test("PF2E_MODIFIER_TYPES keeps SWE's order and is not frozen", () => {
  assert.deepEqual(core.PF2E_MODIFIER_TYPES, ["circumstance", "status", "item", "untyped"]);
  assert.equal(Object.isFrozen(core.PF2E_MODIFIER_TYPES), false);
});
