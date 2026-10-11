import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isValuedCondition, isSoleExecutor, canEditItem, makeCanEdit } from "../baron-core.js";
import { setGlobals, makeGame, makePf2e } from "./helpers/foundry-stubs.mjs";

let restore = () => {};
afterEach(() => {
  restore();
  restore = () => {};
});

/* ------------------------------------------------------ isValuedCondition */

test("isValuedCondition reads the PF2e ConditionManager", () => {
  restore = setGlobals({ game: makeGame({ pf2e: makePf2e({ frightened: true, prone: false }) }) });
  assert.equal(isValuedCondition("frightened"), true);
  assert.equal(isValuedCondition("prone"), false);
  assert.equal(isValuedCondition("unknown"), false);
});

test("isValuedCondition is false when the system API is missing", () => {
  restore = setGlobals({ game: makeGame() });
  assert.equal(isValuedCondition("frightened"), false);
  restore();
  restore = setGlobals({ game: { pf2e: {} } });
  assert.equal(isValuedCondition("frightened"), false);
  restore();
  restore = setGlobals({ game: { pf2e: { ConditionManager: { conditions: {} } } } });
  assert.equal(isValuedCondition("frightened"), false);
});

/* --------------------------------------------------------- isSoleExecutor */

test("isSoleExecutor is true only on the active GM's client", () => {
  const gm = { id: "gm", isGM: true };
  const other = { id: "gm2", isGM: true };
  const player = { id: "p", isGM: false };

  restore = setGlobals({ game: makeGame({ user: gm, users: { activeGM: gm } }) });
  assert.equal(isSoleExecutor(), true);
  restore();

  restore = setGlobals({ game: makeGame({ user: other, users: { activeGM: gm } }) });
  assert.equal(isSoleExecutor(), false);
  restore();

  restore = setGlobals({ game: makeGame({ user: player, users: { activeGM: gm } }) });
  assert.equal(isSoleExecutor(), false);
  restore();

  restore = setGlobals({ game: makeGame({ user: gm, users: { activeGM: null } }) });
  assert.equal(isSoleExecutor(), false);
  restore();

  restore = setGlobals({ game: makeGame({ user: gm, users: undefined }) });
  assert.equal(isSoleExecutor(), false);
});

/* ---------------------------------------------- canEditItem / makeCanEdit */

const MATRIX = [];
for (const gmOnly of [true, false])
  for (const isGM of [true, false])
    for (const isOwner of [true, false]) MATRIX.push({ gmOnly, isGM, isOwner, expected: gmOnly ? isGM : isGM || isOwner });

test("canEditItem over gmOnly x isGM x isOwner", () => {
  for (const { gmOnly, isGM, isOwner, expected } of MATRIX) {
    restore = setGlobals({ game: makeGame({ user: { isGM } }) });
    assert.equal(canEditItem({ isOwner }, gmOnly), expected, JSON.stringify({ gmOnly, isGM, isOwner }));
    restore();
  }
  restore = () => {};
});

test("makeCanEdit over gmOnly x isGM x isOwner, reading the module's setting", () => {
  for (const { gmOnly, isGM, isOwner, expected } of MATRIX) {
    const game = makeGame({ user: { isGM }, settings: { "my-mod.gmOnly": gmOnly } });
    restore = setGlobals({ game });
    const canEdit = makeCanEdit("my-mod");
    assert.equal(canEdit({ isOwner }), expected, JSON.stringify({ gmOnly, isGM, isOwner }));
    assert.deepEqual(game.settings.calls, [["my-mod", "gmOnly"]]);
    restore();
  }
  restore = () => {};
});

test("makeCanEdit reads the setting on every call, never when created", () => {
  const canEdit = makeCanEdit("my-mod"); // no game yet: must not throw
  const settings = { "my-mod.gmOnly": true };
  const game = makeGame({ user: { isGM: false }, settings });
  restore = setGlobals({ game });
  assert.equal(canEdit({ isOwner: true }), false);
  settings["my-mod.gmOnly"] = false;
  assert.equal(canEdit({ isOwner: true }), true);
  assert.equal(game.settings.calls.length, 2);
});

test("makeCanEdit honours a custom setting key", () => {
  const game = makeGame({ user: { isGM: false }, settings: { "my-mod.playersMayEdit": false } });
  restore = setGlobals({ game });
  assert.equal(makeCanEdit("my-mod", "playersMayEdit")({ isOwner: true }), true);
  assert.deepEqual(game.settings.calls, [["my-mod", "playersMayEdit"]]);
});

test("makeCanEdit surfaces an unregistered setting instead of guessing", () => {
  restore = setGlobals({ game: makeGame({ user: { isGM: true } }) });
  assert.throws(() => makeCanEdit("my-mod")({ isOwner: true }), /not a registered game setting/);
});
