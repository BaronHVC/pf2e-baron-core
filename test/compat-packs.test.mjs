import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { formDataClass, textEditor, sheetElement, enrichHTML } from "../baron-core.js";
import { setGlobals, makeGame, makePack } from "./helpers/foundry-stubs.mjs";
import { installDom, FakeElement } from "./helpers/fake-dom.mjs";

let restore = () => {};
afterEach(() => {
  restore();
  restore = () => {};
});

// packIndex keeps its cache in a Map private to the module, so each packIndex
// test imports its own copy of the file to start from an empty cache.
let copies = 0;
const freshCore = () => import(new URL(`../baron-core.js?copy=${++copies}`, import.meta.url).href);

/* ------------------------------------------------------- formDataClass */

test("formDataClass prefers foundry.applications.ux, then the global", () => {
  class UxFDE {}
  class GlobalFDE {}
  restore = setGlobals({ foundry: { applications: { ux: { FormDataExtended: UxFDE } } }, FormDataExtended: GlobalFDE });
  assert.equal(formDataClass(), UxFDE);
  restore();
  restore = setGlobals({ foundry: { applications: {} }, FormDataExtended: GlobalFDE });
  assert.equal(formDataClass(), GlobalFDE);
  restore();
  restore = setGlobals({ foundry: { applications: { ux: {} } } });
  assert.equal(formDataClass(), undefined);
});

/* ---------------------------------------------------------- textEditor */

test("textEditor prefers ux.TextEditor.implementation, then the global", () => {
  const impl = { name: "impl" };
  const globalTE = { name: "global" };
  restore = setGlobals({
    foundry: { applications: { ux: { TextEditor: { implementation: impl } } } },
    TextEditor: globalTE
  });
  assert.equal(textEditor(), impl);
  restore();
  restore = setGlobals({ foundry: { applications: { ux: { TextEditor: {} } } }, TextEditor: globalTE });
  assert.equal(textEditor(), globalTE);
  restore();
  restore = setGlobals({ foundry: { applications: {} }, TextEditor: globalTE });
  assert.equal(textEditor(), globalTE);
});

test("the compat shims resolve on every call, not once", () => {
  const a = { name: "a" };
  const b = { name: "b" };
  const foundry = { applications: { ux: { TextEditor: { implementation: a } } } };
  restore = setGlobals({ foundry });
  assert.equal(textEditor(), a);
  foundry.applications.ux.TextEditor.implementation = b;
  assert.equal(textEditor(), b);
});

/* -------------------------------------------------------- sheetElement */

test("sheetElement handles ApplicationV2 and jQuery-wrapped elements", () => {
  restore = installDom();
  const el = new FakeElement("div");
  assert.equal(sheetElement({ element: el }), el);
  assert.equal(sheetElement({ element: { 0: el, length: 1 } }), el);
  assert.equal(sheetElement({ element: [el] }), el);
  assert.equal(sheetElement({}), undefined);
  assert.equal(sheetElement({ element: null }), undefined);
});

/* ---------------------------------------------------------- enrichHTML */

test("enrichHTML forwards html and options untouched and returns the result", async () => {
  const calls = [];
  const result = Promise.resolve("<p>enriched</p>");
  const impl = {
    enrichHTML(html, options) {
      calls.push([html, options]);
      return result;
    }
  };
  restore = setGlobals({ foundry: { applications: { ux: { TextEditor: { implementation: impl } } } } });
  const options = { async: true, relativeTo: { id: "x" } };
  const out = enrichHTML("<p>@UUID[x]</p>", options);
  assert.equal(out, result);
  assert.equal(await out, "<p>enriched</p>");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "<p>@UUID[x]</p>");
  assert.equal(calls[0][1], options);
});

/* ----------------------------------------------------------- packIndex */

test("packIndex returns the same promise for the same pack, fields in any order", async () => {
  const { packIndex } = await freshCore();
  const index = [{ _id: "a", type: "weapon" }];
  const pack = makePack(index);
  restore = setGlobals({ game: makeGame({ packs: { "pf2e.equipment-srd": pack } }) });
  const fields = ["type", "system.slug"];
  const p1 = packIndex("pf2e.equipment-srd", fields);
  const p2 = packIndex("pf2e.equipment-srd", ["system.slug", "type"]);
  assert.equal(p1, p2);
  assert.equal(await p1, index); // returned unmodified
  assert.deepEqual(pack.calls, [{ fields }]); // built once, with the first caller's array
  assert.equal(pack.calls[0].fields, fields);
  assert.deepEqual(fields, ["type", "system.slug"]); // caller's array not sorted in place
});

test("packIndex keeps separate promises per pack and per field set", async () => {
  const { packIndex } = await freshCore();
  const a = makePack(["a"]);
  const b = makePack(["b"]);
  restore = setGlobals({ game: makeGame({ packs: { "x.a": a, "x.b": b } }) });
  const pa = packIndex("x.a", ["type"]);
  const pb = packIndex("x.b", ["type"]);
  const pa2 = packIndex("x.a", ["type", "system.level.value"]);
  assert.notEqual(pa, pb);
  assert.notEqual(pa, pa2);
  assert.deepEqual(await Promise.all([pa, pb, pa2]), [["a"], ["b"], ["a"]]);
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 1);
});

test("packIndex resolves [] for a missing pack, and that result stays cached", async () => {
  const { packIndex } = await freshCore();
  const packs = {};
  restore = setGlobals({ game: makeGame({ packs }) });
  const p = packIndex("pf2e.equipment-srd", ["type"]);
  assert.deepEqual(await p, []);
  packs["pf2e.equipment-srd"] = makePack(["late"]);
  assert.equal(packIndex("pf2e.equipment-srd", ["type"]), p);
  assert.deepEqual(await packIndex("pf2e.equipment-srd", ["type"]), []);
});

test("packIndex keeps a rejected promise cached (no retry)", async () => {
  const { packIndex } = await freshCore();
  const boom = new Error("index failed");
  const pack = makePack(boom, { reject: true });
  restore = setGlobals({ game: makeGame({ packs: { "x.bad": pack } }) });
  const p1 = packIndex("x.bad", ["type"]);
  await assert.rejects(p1, boom);
  const p2 = packIndex("x.bad", ["type"]);
  assert.equal(p2, p1);
  await assert.rejects(p2, boom);
  assert.equal(pack.calls.length, 1);
});

test("packIndex never throws synchronously; a missing game rejects", async () => {
  const { packIndex } = await freshCore();
  let p;
  assert.doesNotThrow(() => {
    p = packIndex("x.none", ["type"]);
  });
  await assert.rejects(p, ReferenceError);
});

test("packIndex defaults fields to []", async () => {
  const { packIndex } = await freshCore();
  const pack = makePack(["i"]);
  restore = setGlobals({ game: makeGame({ packs: { "x.a": pack } }) });
  assert.deepEqual(await packIndex("x.a"), ["i"]);
  assert.equal(packIndex("x.a"), packIndex("x.a", []));
  assert.deepEqual(pack.calls, [{ fields: [] }]);
});
