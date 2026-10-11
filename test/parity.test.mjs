// Differential parity: baron-core against the SWE v0.12.0 code it was
// extracted from (test/legacy/swe-v0.12.0.mjs, itself checked against the
// SWE release by test/legacy-verbatim.test.mjs). Same inputs, same stubs, deep-equal
// outputs. The only intended difference is the header button's new
// data-baron-btn attribute and its dedupe by key; see the last test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../baron-core.js";
import * as legacy from "./legacy/swe-v0.12.0.mjs";
import { setGlobals, makeGame, makePack, makePf2e, tick } from "./helpers/foundry-stubs.mjs";
import { installDom, makeSheet, shapeOf, FakeElement, FakeWindow } from "./helpers/fake-dom.mjs";

const CORE_SRC = readFileSync(new URL("../baron-core.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LEGACY_SRC = readFileSync(new URL("./legacy/swe-v0.12.0.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const MODULE_ID = legacy.MODULE_ID;

let copies = 0;
const fresh = (rel) => import(new URL(`${rel}?parity=${++copies}`, import.meta.url).href);

// Runs fn and captures either its value or the error it threw.
function outcome(fn) {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: err?.constructor?.name, message: err?.message };
  }
}

async function settle(promise) {
  try {
    return { ok: await promise };
  } catch (err) {
    return { threw: err?.constructor?.name, message: err?.message };
  }
}

function withGame(game, fn) {
  const restore = setGlobals({ game });
  try {
    return fn();
  } finally {
    restore();
  }
}

/* ------------------------------------------------------------------ source */

test("verbatim functions have SWE's exact source text", () => {
  for (const name of [
    "slugOf",
    "resolveLabel",
    "locRecord",
    "labelFor",
    "clampInt",
    "escHTML",
    "isValuedCondition",
    "isSoleExecutor"
  ]) {
    assert.equal(core[name].toString(), legacy[name].toString(), name);
  }
});

test("click guard functions differ from SWE only in the state key", () => {
  for (const name of ["guardClicks", "releaseClickGuard", "renderSoon"]) {
    const expected = legacy[name].toString().replaceAll("app._sweGuard", "app[GUARD]");
    assert.notEqual(expected, legacy[name].toString(), `${name} used app._sweGuard`);
    assert.equal(core[name].toString(), expected, name);
  }
});

test("canEditItem is canEdit's body with the setting read moved out", () => {
  const body = legacy.canEdit.toString().split("\n").slice(2, 4).join("\n");
  assert.equal(body, "  if (gmOnly) return game.user.isGM;\n  return game.user.isGM || item.isOwner;");
  assert.ok(core.canEditItem.toString().includes(body));
});

test("generalized helpers keep SWE's expressions, with only the stated parameters", () => {
  // createI18n: only the "SWE" prefix became a parameter.
  assert.ok(legacy.i18n.toString().includes("return game.i18n.localize(`SWE.${key}`);"));
  assert.ok(core.createI18n.toString().includes("return (key) => game.i18n.localize(`${prefix}.${key}`);"));
  // The compat shims are SWE's inline expressions, now behind a call.
  for (const [fn, legacyFn, expr] of [
    [core.formDataClass, legacy.legacyFormDataClass, "foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended"],
    [core.textEditor, legacy.legacyEnrich, "foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor"],
    [core.sheetElement, legacy.legacySheetElement, "sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0]"]
  ]) {
    assert.ok(legacyFn.toString().includes(expr), legacyFn.name);
    assert.ok(fn.toString().includes(`return ${expr};`), fn.name);
  }
  // packIndex builds the index exactly as equipmentIndex did, with the pack
  // and the fields as parameters.
  const iife = (s) => s.slice(s.indexOf("(async () => {"), s.indexOf("})();") + "})();".length);
  const expected = iife(legacy.equipmentIndex.toString())
    .replace('game.packs.get("pf2e.equipment-srd")', "game.packs.get(packId)")
    .replace('pack.getIndex({ fields: ["system.slug", "type"] })', "pack.getIndex({ fields })");
  assert.notEqual(expected, iife(legacy.equipmentIndex.toString()));
  assert.equal(iife(core.packIndex.toString()), expected);
});

test("SWE's rationale comments travel with the code", () => {
  const blockFrom = (first) => {
    const lines = LEGACY_SRC.split("\n");
    const start = lines.indexOf(first);
    assert.ok(start >= 0, first);
    let end = start;
    while (lines[end + 1]?.startsWith("//")) end++;
    return lines.slice(start, end + 1).join("\n");
  };
  for (const first of [
    "// Search inputs backed by datalists hand the form a label, not a slug. An exact",
    "// A field's change event fires when it loses focus, which happens the moment",
    "// Typed so the system's own stacking applies: same-type bonuses do not stack"
  ]) {
    const block = blockFrom(first);
    assert.ok(block.split("\n").length >= 2);
    assert.ok(CORE_SRC.includes(block), `missing comment block starting: ${first}`);
  }
  assert.ok(CORE_SRC.includes("  // FormDataExtended hands an emptied number input over as null, and"));
});

/* -------------------------------------------------------------- constants */

test("DIE_SIZES and PF2E_MODIFIER_TYPES equal DIES and BONUS_TYPES", () => {
  assert.deepEqual(core.DIE_SIZES, legacy.DIES);
  assert.deepEqual(core.PF2E_MODIFIER_TYPES, legacy.BONUS_TYPES);
});

/* ------------------------------------------------------------ pure values */

const SLUG_CORPUS = [
  "Long Sword",
  "  Hello, World!  ",
  "Élfico",
  "Ñandú 2",
  "a__b",
  "---",
  "",
  "ALL CAPS",
  "x".repeat(3) + "  y",
  "d8+2",
  undefined,
  null,
  42,
  {},
  []
];

test("slugOf parity, with and without String#slugify", () => {
  for (const v of SLUG_CORPUS) assert.deepEqual(outcome(() => core.slugOf(v)), outcome(() => legacy.slugOf(v)), String(v));
  String.prototype.slugify = function (o) {
    return `${this.trim().toLowerCase().replace(/\s+/g, "-")}${o?.strict ? "!" : ""}`;
  };
  try {
    for (const v of SLUG_CORPUS) assert.deepEqual(outcome(() => core.slugOf(v)), outcome(() => legacy.slugOf(v)), String(v));
  } finally {
    delete String.prototype.slugify;
  }
});

test("resolveLabel parity", () => {
  const optionSets = [
    [
      { value: "elf", label: "Élfico" },
      { value: "dwarf", label: "Enano" },
      { value: "half-elf", label: "Semielfo" }
    ],
    [
      { value: "a", label: "Ä" },
      { value: "b", label: "a" }
    ],
    [],
    null,
    undefined
  ];
  const texts = ["Élfico", "elfico", "ELFICO", "  élfico ", "Enano", "Gnomo Feérico", "a", "ä", "", "   ", null, undefined, 42, "Hill Giant"];
  for (const options of optionSets)
    for (const text of texts)
      assert.deepEqual(
        outcome(() => core.resolveLabel(options, text)),
        outcome(() => legacy.resolveLabel(options, text)),
        JSON.stringify({ options, text })
      );
});

const TRANSLATIONS = {
  "PF2E.TraitElf": "Elfo",
  "PF2E.TraitDwarf": "Enano",
  "PF2E.TraitHuman": "Humano",
  "SWE.Open": "Editar",
  "SWE.Title": "Editor de armas",
  "SWE.ArmTitle": "Editor de armadura",
  "SWE.ShTitle": "Editor de escudo"
};

const RECORDS = [
  { elf: "PF2E.TraitElf", dwarf: { name: "PF2E.TraitDwarf" }, human: "PF2E.TraitHuman" },
  { gnome: "PF2E.Missing", orc: {}, plain: "Plain Text", kobold: null, goblin: { name: "PF2E.Nope" } },
  { a: "nube", b: "ñu", c: "oso", d: "Ángel", e: "año", f: "zorro" },
  {},
  null,
  undefined
];

test("locRecord parity across languages", () => {
  for (const lang of ["en", "es", "de"])
    for (const record of RECORDS)
      withGame(makeGame({ translations: TRANSLATIONS, lang }), () =>
        assert.deepEqual(
          outcome(() => core.locRecord(record)),
          outcome(() => legacy.locRecord(record)),
          JSON.stringify({ lang, record })
        )
      );
});

test("labelFor parity", () => {
  withGame(makeGame({ translations: TRANSLATIONS }), () => {
    for (const record of RECORDS) {
      const slugs = [...Object.keys(record ?? {}), "missing", "PF2E.TraitElf", ""];
      for (const slug of slugs)
        assert.deepEqual(
          outcome(() => core.labelFor(record, slug)),
          outcome(() => legacy.labelFor(record, slug)),
          JSON.stringify({ record, slug })
        );
    }
  });
});

test("clampInt parity", () => {
  const values = [null, undefined, "", "  ", "abc", "3.9", "-3.9", 3.9, NaN, Infinity, -Infinity, -4, 0, 7, 99, "99", " 7 ", true, false, [], {}, "0x10", "1e3", 1e400];
  const bounds = [
    [0, 10],
    [1, 60],
    [-10, 10],
    [5, 5]
  ];
  const fallbacks = [5, null, undefined, "keep"];
  for (const v of values)
    for (const [min, max] of bounds)
      for (const fb of fallbacks)
        assert.deepEqual(
          outcome(() => core.clampInt(v, min, max, fb)),
          outcome(() => legacy.clampInt(v, min, max, fb)),
          String(v)
        );
});

test("escHTML parity", () => {
  for (const v of [`&<>"'`, "<a href=\"x\">T & J</a>", "Élfico", "&amp;", "", null, undefined, 0, false, 12.5, { toString: () => "<o>" }])
    assert.deepEqual(outcome(() => core.escHTML(v)), outcome(() => legacy.escHTML(v)), String(v));
});

/* ------------------------------------------------------------- game reads */

test("isValuedCondition parity", () => {
  const games = [
    makeGame({ pf2e: makePf2e({ frightened: true, prone: false, clumsy: true }) }),
    makeGame(),
    { pf2e: {} },
    { pf2e: { ConditionManager: { conditions: {} } } }
  ];
  for (const game of games)
    for (const slug of ["frightened", "prone", "clumsy", "unknown", "", undefined])
      withGame(game, () =>
        assert.deepEqual(outcome(() => core.isValuedCondition(slug)), outcome(() => legacy.isValuedCondition(slug)))
      );
});

test("isSoleExecutor parity", () => {
  const gm = { id: "gm", isGM: true };
  const gm2 = { id: "gm2", isGM: true };
  const player = { id: "p", isGM: false };
  const games = [
    makeGame({ user: gm, users: { activeGM: gm } }),
    makeGame({ user: gm2, users: { activeGM: gm } }),
    makeGame({ user: player, users: { activeGM: gm } }),
    makeGame({ user: gm, users: { activeGM: null } }),
    makeGame({ user: gm, users: undefined }),
    makeGame({ user: undefined, users: { activeGM: undefined } })
  ];
  for (const game of games)
    withGame(game, () => assert.deepEqual(outcome(() => core.isSoleExecutor()), outcome(() => legacy.isSoleExecutor())));
});

test("makeCanEdit(MODULE_ID) parity with canEdit, including an unregistered setting", () => {
  const coreCanEdit = core.makeCanEdit(MODULE_ID);
  for (const settings of [{ [`${MODULE_ID}.gmOnly`]: true }, { [`${MODULE_ID}.gmOnly`]: false }, {}])
    for (const isGM of [true, false])
      for (const isOwner of [true, false])
        withGame(makeGame({ user: { isGM }, settings }), () =>
          assert.deepEqual(
            outcome(() => coreCanEdit({ isOwner })),
            outcome(() => legacy.canEdit({ isOwner })),
            JSON.stringify({ settings, isGM, isOwner })
          )
        );
});

test("createI18n('SWE') parity with i18n", () => {
  const i18n = core.createI18n("SWE");
  for (const lang of ["en", "es"])
    withGame(makeGame({ translations: lang === "es" ? TRANSLATIONS : {}, lang }), () => {
      for (const key of ["Open", "Title", "ArmTitle", "ShTitle", "Missing", "", "a.b"])
        assert.deepEqual(outcome(() => i18n(key)), outcome(() => legacy.i18n(key)), key);
    });
});

/* ------------------------------------------------------------------ compat */

test("formDataClass, textEditor and sheetElement parity with SWE's inline shims", async () => {
  const restoreDom = installDom();
  try {
    class UxFDE {}
    class GlobalFDE {}
    const impl = { enrichHTML: async (html, o) => `ux:${html}:${JSON.stringify(o)}` };
    const globalTE = { enrichHTML: async (html, o) => `global:${html}:${JSON.stringify(o)}` };
    const envs = [
      { foundry: { applications: { ux: { FormDataExtended: UxFDE, TextEditor: { implementation: impl } } } }, FormDataExtended: GlobalFDE, TextEditor: globalTE },
      { foundry: { applications: { ux: { TextEditor: {} } } }, FormDataExtended: GlobalFDE, TextEditor: globalTE },
      { foundry: { applications: {} }, FormDataExtended: GlobalFDE, TextEditor: globalTE }
    ];
    for (const env of envs) {
      const restore = setGlobals(env);
      try {
        assert.equal(core.formDataClass(), legacy.legacyFormDataClass());
        const old = await legacy.legacyEnrich("<p>x</p>");
        assert.equal(core.textEditor(), old.TE);
        assert.equal(await core.enrichHTML("<p>x</p>", { async: true }), old.descHTML);
      } finally {
        restore();
      }
    }
    const el = new FakeElement("div");
    for (const sheet of [{ element: el }, { element: { 0: el } }, { element: [el] }, {}, { element: null }])
      assert.equal(core.sheetElement(sheet), legacy.legacySheetElement(sheet));
  } finally {
    restoreDom();
  }
});

/* ------------------------------------------------------------------- packs */

const RUNE_PACK = "pf2e.equipment-srd";
const RUNE_FIELDS = ["system.slug", "type"];

// One scenario against the three implementations: SWE's runeIndex (weapon
// editor), SWE's equipmentIndex (armor editor) and core's packIndex.
async function packScenario({ packs, mutate, game = true }) {
  const results = [];
  for (const impl of ["runeIndex", "equipmentIndex", "packIndex"]) {
    const L = await fresh("./legacy/swe-v0.12.0.mjs");
    const C = await fresh("../baron-core.js");
    const call = {
      runeIndex: () => L.SimpleWeaponEditor.runeIndex(),
      equipmentIndex: () => L.equipmentIndex(),
      packIndex: () => C.packIndex(RUNE_PACK, RUNE_FIELDS)
    }[impl];
    const packMap = { ...packs };
    const restore = game ? setGlobals({ game: makeGame({ packs: packMap }) }) : () => {};
    try {
      const first = await settle(call());
      mutate?.(packMap);
      const second = await settle(call());
      const calls = Object.values(packs).map((p) => p.calls.splice(0));
      results.push({ first, second, calls });
    } finally {
      restore();
    }
  }
  return results;
}

test("packIndex parity with runeIndex and equipmentIndex", async () => {
  const index = [{ _id: "r1", type: "weapon", system: { slug: "flaming" } }];
  const scenarios = {
    present: { packs: { [RUNE_PACK]: makePack(index) } },
    missing: { packs: {} },
    "missing then added": { packs: {}, mutate: (m) => (m[RUNE_PACK] = makePack(["late"])) },
    rejecting: { packs: { [RUNE_PACK]: makePack(new Error("boom"), { reject: true }) } },
    "no game": { packs: {}, game: false }
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    const [rune, equip, core_] = await packScenario(scenario);
    assert.deepEqual(core_, rune, `${name}: vs runeIndex`);
    assert.deepEqual(core_, equip, `${name}: vs equipmentIndex`);
  }
});

/* ------------------------------------------------------------- click guard */

const GUARD_SCRIPTS = [
  ["guard", "renderSoon"],
  ["guard", "down:save", "renderSoon", "renderSoon", "up", "tick"],
  ["guard", "down:icon", "renderSoon", "cancel", "tick"],
  ["guard", "down:input", "renderSoon", "down:select", "renderSoon"],
  ["guard", "down:save", "up", "tick", "renderSoon"],
  ["guard", "down:save", "renderSoon", "close", "up", "tick"],
  ["guard", "down:save", "release", "renderSoon", "up", "tick"],
  ["renderSoon", "guard", "guard", "down:save", "renderSoon", "up", "tick", "renderSoon"],
  ["release", "renderSoon", "release"],
  ["noelement", "guard", "renderSoon"],
  ["guard", "release", "guard", "down:link", "renderSoon", "up", "tick", "release"],
  ["guard", "down:root", "renderSoon", "up", "tick"]
];

async function runGuardScript(impl, script) {
  const restoreDom = installDom();
  const win = new FakeWindow();
  const restoreWin = setGlobals({ window: win });
  try {
    const root = new FakeElement("form");
    const els = { root, save: new FakeElement("button"), link: new FakeElement("a"), icon: new FakeElement("i"), input: new FakeElement("input"), select: new FakeElement("select") };
    els.link.setAttribute("data-action", "x");
    els.link.appendChild(els.icon);
    root.append(els.save, els.link, els.input, els.select);
    const app = { element: root, rendered: true, renders: 0, render() { this.renders++; } };
    const trace = [];
    for (const step of script) {
      if (step === "guard") impl.guardClicks(app);
      else if (step === "release") impl.releaseClickGuard(app);
      else if (step === "renderSoon") impl.renderSoon(app);
      else if (step === "up") win.fire("pointerup");
      else if (step === "cancel") win.fire("pointercancel");
      else if (step === "tick") await tick();
      else if (step === "close") app.rendered = false;
      else if (step === "noelement") app.element = null;
      else if (step.startsWith("down:")) els[step.slice(5)].dispatch("pointerdown");
      trace.push([step, app.renders, win.count("pointerup"), win.count("pointercancel"), root.listeners.length]);
    }
    return trace;
  } finally {
    restoreWin();
    restoreDom();
  }
}

test("click guard parity: same render calls and listeners, step by step", async () => {
  for (const script of GUARD_SCRIPTS) {
    const expected = await runGuardScript(legacy, script);
    const actual = await runGuardScript(core, script);
    assert.deepEqual(actual, expected, script.join(" > "));
  }
});

/* ---------------------------------------------------------- header button */

// What SWE would pass to injectSheetButton to keep its two buttons as they are.
function sweButtonConfigs(opened) {
  const i18n = core.createI18n("SWE");
  const canShow = core.makeCanEdit(MODULE_ID);
  return {
    weapon: {
      key: `${MODULE_ID}:weapon`,
      match: (item) => item.type === "weapon",
      canShow,
      cssClass: "swe-open",
      icon: "fa-solid fa-wand-magic-sparkles",
      label: () => i18n("Open"),
      title: () => i18n("Title"),
      onClick: (item) => opened.weapon.push(item),
      logPrefix: `${MODULE_ID} | header button`
    },
    armor: {
      key: `${MODULE_ID}:armor`,
      match: (item) => item.type === "armor" || item.type === "shield",
      canShow,
      cssClass: "swe-open",
      icon: "fa-solid fa-shield-halved",
      label: () => i18n("Open"),
      title: (item) => i18n(item.type === "shield" ? "ShTitle" : "ArmTitle"),
      onClick: (item) => opened.armor.push(item),
      logPrefix: `${MODULE_ID} | armor header button`
    }
  };
}

function runButtonScenario(kind, s, origConsoleError) {
  const errors = [];
  console.error = (...args) => errors.push([args[0], args[1]?.constructor?.name]);
  try {
    const built = s.sheetNull ? { sheet: null, root: new FakeElement("div"), header: null } : makeSheet(s);
    const opened = { weapon: [], armor: [] };
    legacy.SimpleWeaponEditor.opened.length = 0;
    legacy.SimpleArmorEditor.opened.length = 0;
    const cfg = sweButtonConfigs(opened);
    // Both item-sheet render hooks fire, and each runs both injectors.
    for (let i = 0; i < 2; i++) {
      if (kind === "legacy") {
        legacy.injectButton(built.sheet);
        legacy.injectArmorButton(built.sheet);
      } else {
        core.injectSheetButton(built.sheet, cfg.weapon);
        core.injectSheetButton(built.sheet, cfg.armor);
      }
    }
    const clicks = built.root.querySelectorAll(".swe-open").map((b) => {
      const ev = b.click();
      return [ev.defaultPrevented, ev.propagationStopped];
    });
    const openedNow =
      kind === "legacy"
        ? { weapon: [...legacy.SimpleWeaponEditor.opened], armor: [...legacy.SimpleArmorEditor.opened] }
        : opened;
    return { dom: shapeOf(built.root, ["data-baron-btn"]), clicks, opened: openedNow, errors };
  } finally {
    console.error = origConsoleError;
  }
}

test("header button parity over items, permissions, sheet shapes and languages", () => {
  const restoreDom = installDom();
  const origConsoleError = console.error;
  try {
    const items = [
      { type: "weapon", isOwner: true },
      { type: "weapon", isOwner: false },
      { type: "armor", isOwner: true },
      { type: "shield", isOwner: true },
      { type: "consumable", isOwner: true },
      { type: "weapon", isOwner: true, pack: "pf2e.equipment-srd" },
      null
    ];
    let scenarios = 0;
    for (const item of items)
      for (const gmOnly of [true, false, undefined])
        for (const isGM of [true, false])
          for (const wrap of ["direct", "jquery", "none"])
            for (const close of ["action", "header-button", "close", "none"])
              for (const header of [true, false])
                for (const lang of ["en", "es"]) {
                  if (!header && close !== "action") continue;
                  const settings = gmOnly === undefined ? {} : { [`${MODULE_ID}.gmOnly`]: gmOnly };
                  const game = makeGame({ user: { isGM }, settings, lang, translations: lang === "es" ? TRANSLATIONS : {} });
                  const s = { item, wrap, close, header, asDocument: item?.type === "armor" };
                  const [expected, actual] = withGame(game, () => [
                    runButtonScenario("legacy", s, origConsoleError),
                    runButtonScenario("core", s, origConsoleError)
                  ]);
                  assert.deepEqual(actual.dom, expected.dom, JSON.stringify({ item, gmOnly, isGM, wrap, close, header, lang }));
                  assert.deepEqual(actual.clicks, expected.clicks);
                  assert.deepEqual(actual.opened.weapon.length, expected.opened.weapon.length);
                  assert.deepEqual(actual.opened.armor.length, expected.opened.armor.length);
                  for (const k of ["weapon", "armor"])
                    actual.opened[k].forEach((it, i) => assert.equal(it, expected.opened[k][i]));
                  assert.deepEqual(actual.errors, expected.errors);
                  scenarios++;
                }
    assert.ok(scenarios > 500, `ran ${scenarios} scenarios`);

    // A sheet that is not even an object: both log and carry on.
    const game = makeGame({ user: { isGM: true }, settings: { [`${MODULE_ID}.gmOnly`]: true } });
    const [expected, actual] = withGame(game, () => [
      runButtonScenario("legacy", { sheetNull: true }, origConsoleError),
      runButtonScenario("core", { sheetNull: true }, origConsoleError)
    ]);
    assert.deepEqual(actual, expected);
    assert.deepEqual(expected.errors, [
      [`${MODULE_ID} | header button`, "TypeError"],
      [`${MODULE_ID} | armor header button`, "TypeError"],
      [`${MODULE_ID} | header button`, "TypeError"],
      [`${MODULE_ID} | armor header button`, "TypeError"]
    ]);
  } finally {
    console.error = origConsoleError;
    restoreDom();
  }
});

test("documented divergence: dedupe by key instead of by class", () => {
  // SWE skipped the header whenever ANY .swe-open was there; core only skips
  // its own key, so a second module's button can share the header.
  const restoreDom = installDom();
  try {
    const game = makeGame({ user: { isGM: true }, settings: { [`${MODULE_ID}.gmOnly`]: true } });
    withGame(game, () => {
      const item = { type: "weapon", isOwner: true };
      const a = makeSheet({ item });
      const b = makeSheet({ item });
      for (const s of [a, b]) {
        const foreign = new FakeElement("a");
        foreign.className = "swe-open";
        s.header.appendChild(foreign);
      }
      legacy.injectButton(a.sheet);
      core.injectSheetButton(b.sheet, sweButtonConfigs({ weapon: [], armor: [] }).weapon);
      assert.equal(a.header.querySelectorAll(".swe-open").length, 1);
      assert.equal(b.header.querySelectorAll(".swe-open").length, 2);
    });
  } finally {
    restoreDom();
  }
});
