import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createI18n, slugOf, resolveLabel, locRecord, labelFor } from "../baron-core.js";
import { setGlobals, makeGame } from "./helpers/foundry-stubs.mjs";

let restore = () => {};
afterEach(() => {
  restore();
  restore = () => {};
  delete String.prototype.slugify;
});

/* ------------------------------------------------------------ createI18n */

test("createI18n prefixes the key and localizes it", () => {
  restore = setGlobals({ game: makeGame({ translations: { "my-mod.Open": "Edit" } }) });
  const i18n = createI18n("my-mod");
  assert.equal(i18n("Open"), "Edit");
});

test("createI18n returns the full key when there is no translation", () => {
  restore = setGlobals({ game: makeGame() });
  assert.equal(createI18n("my-mod")("Missing"), "my-mod.Missing");
});

test("createI18n reads game only when the localizer is called", () => {
  const i18n = createI18n("my-mod"); // no game defined yet: must not throw
  restore = setGlobals({ game: makeGame({ translations: { "my-mod.Title": "Title!" } }) });
  assert.equal(i18n("Title"), "Title!");
});

/* ---------------------------------------------------------------- slugOf */

test("slugOf without String#slugify uses the ASCII fallback", () => {
  assert.equal(String.prototype.slugify, undefined);
  assert.equal(slugOf("Long Sword"), "long-sword");
  assert.equal(slugOf("  Hello, World!  "), "hello-world");
  assert.equal(slugOf("a__b"), "a-b");
  assert.equal(slugOf("---"), "");
  assert.equal(slugOf(""), "");
  // Non-ASCII letters are dropped by the fallback (Foundry's slugify keeps
  // more); this is SWE's shipped behaviour and stays as is.
  assert.equal(slugOf("Élfico"), "lfico");
  assert.equal(slugOf("Ñandú 2"), "and-2");
});

test("slugOf returns '' for anything that is not a string", () => {
  for (const v of [undefined, null, 42, {}, [], true]) assert.equal(slugOf(v), "");
});

test("slugOf prefers String#slugify({ strict: true }) when Foundry provides it", () => {
  const calls = [];
  // eslint-disable-next-line no-extend-native
  String.prototype.slugify = function (opts) {
    calls.push([String(this), opts]);
    return `stub:${this}`;
  };
  assert.equal(slugOf("Élfico"), "stub:Élfico");
  assert.deepEqual(calls, [["Élfico", { strict: true }]]);
});

test("slugOf falls back when slugify returns null or undefined", () => {
  String.prototype.slugify = () => undefined;
  assert.equal(slugOf("Long Sword"), "long-sword");
});

/* ---------------------------------------------------------- resolveLabel */

const OPTIONS = [
  { value: "elf", label: "Élfico" },
  { value: "dwarf", label: "Enano" },
  { value: "half-elf", label: "Semielfo" }
];

test("resolveLabel matches labels ignoring accents, case and outer spaces", () => {
  assert.equal(resolveLabel(OPTIONS, "Élfico"), "elf");
  assert.equal(resolveLabel(OPTIONS, "elfico"), "elf");
  assert.equal(resolveLabel(OPTIONS, "ELFICO"), "elf");
  assert.equal(resolveLabel(OPTIONS, "  élFico "), "elf");
  assert.equal(resolveLabel(OPTIONS, "enano"), "dwarf");
});

test("resolveLabel slugifies unknown text so callers can flag it", () => {
  assert.equal(resolveLabel(OPTIONS, "Hill Giant"), "hill-giant");
  assert.equal(resolveLabel(OPTIONS, "Gnomo Feérico"), slugOf("Gnomo Feérico"));
  assert.equal(resolveLabel(OPTIONS, "elf"), "elf"); // a value is not a label
  assert.equal(resolveLabel(null, "Élfico"), slugOf("Élfico"));
  assert.equal(resolveLabel(undefined, "x y"), "x-y");
  assert.equal(resolveLabel(OPTIONS, 42), "42");
});

test("resolveLabel returns '' for blank input", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(resolveLabel(OPTIONS, v), "");
});

/* ------------------------------------------------------------- locRecord */

const TRANSLATIONS = { "PF2E.TraitElf": "Elf", "PF2E.TraitDwarf": "Dwarf" };

test("locRecord localizes string and {name} values, sorted by label", () => {
  restore = setGlobals({ game: makeGame({ translations: TRANSLATIONS }) });
  const out = locRecord({ elf: "PF2E.TraitElf", dwarf: { name: "PF2E.TraitDwarf" } });
  assert.deepEqual(out, [
    { value: "dwarf", label: "Dwarf" },
    { value: "elf", label: "Elf" }
  ]);
});

test("locRecord falls back to the slug for unresolved dotted keys", () => {
  restore = setGlobals({ game: makeGame({ translations: TRANSLATIONS }) });
  const out = locRecord({
    gnome: "PF2E.TraitGnomeMissing",
    orc: {},
    plain: "Plain Text",
    goblin: { name: "PF2E.Nope" },
    kobold: null
  });
  assert.deepEqual(out, [
    { value: "gnome", label: "gnome" },
    { value: "goblin", label: "goblin" },
    { value: "kobold", label: "kobold" },
    { value: "orc", label: "orc" },
    { value: "plain", label: "Plain Text" }
  ]);
});

test("locRecord sorts with the current language's collation", () => {
  const record = { a: "nube", b: "ñu", c: "oso" };
  restore = setGlobals({ game: makeGame({ lang: "es" }) });
  assert.deepEqual(
    locRecord(record).map((o) => o.label),
    ["nube", "ñu", "oso"]
  );
  restore();
  restore = setGlobals({ game: makeGame({ lang: "en" }) });
  assert.deepEqual(
    locRecord(record).map((o) => o.label),
    ["ñu", "nube", "oso"]
  );
});

test("locRecord of null or undefined is empty", () => {
  restore = setGlobals({ game: makeGame() });
  assert.deepEqual(locRecord(null), []);
  assert.deepEqual(locRecord(undefined), []);
});

/* -------------------------------------------------------------- labelFor */

test("labelFor localizes string and {name} values", () => {
  restore = setGlobals({ game: makeGame({ translations: TRANSLATIONS }) });
  assert.equal(labelFor({ elf: "PF2E.TraitElf" }, "elf"), "Elf");
  assert.equal(labelFor({ dwarf: { name: "PF2E.TraitDwarf" } }, "dwarf"), "Dwarf");
  assert.equal(labelFor({ plain: "Plain Text" }, "plain"), "Plain Text");
});

test("labelFor falls back to the slug", () => {
  restore = setGlobals({ game: makeGame({ translations: TRANSLATIONS }) });
  assert.equal(labelFor(undefined, "elf"), "elf");
  assert.equal(labelFor(null, "elf"), "elf");
  assert.equal(labelFor({}, "elf"), "elf");
  assert.equal(labelFor({ gnome: "PF2E.TraitGnomeMissing" }, "gnome"), "gnome");
  assert.equal(labelFor({ orc: {} }, "orc"), "orc");
  assert.equal(labelFor({ orc: null }, "orc"), "orc");
});

test("labelFor does not touch game when the slug is not in the record", () => {
  assert.equal(labelFor({}, "elf"), "elf"); // no game defined
});
