import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { injectSheetButton } from "../baron-core.js";
import { setGlobals } from "./helpers/foundry-stubs.mjs";
import { installDom, makeSheet, shapeOf, FakeElement } from "./helpers/fake-dom.mjs";

let restoreDom;
beforeEach(() => {
  restoreDom = installDom();
});
afterEach(() => restoreDom());

const weapon = (extra = {}) => ({ type: "weapon", name: "Longsword", isOwner: true, ...extra });

function opts(extra = {}) {
  const clicked = [];
  return {
    clicked,
    options: {
      key: "my-mod:open",
      match: (item) => item.type === "weapon",
      canShow: () => true,
      cssClass: "mymod-open",
      icon: "fa-solid fa-pen",
      label: "Edit",
      title: "Edit item",
      onClick: (item) => clicked.push(item),
      logPrefix: "my-mod | header button",
      ...extra
    }
  };
}

const buttons = (header, key) =>
  header.querySelectorAll(key === undefined ? "[data-baron-btn]" : `[data-baron-btn="${key}"]`);

test("builds <a role=button> with icon and label, before the close button", () => {
  const { sheet, header, close } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, opts().options);
  const btn = buttons(header)[0];
  assert.ok(btn);
  assert.deepEqual(shapeOf(btn), {
    tag: "a",
    attrs: [
      ["class", "mymod-open"],
      ["data-baron-btn", "my-mod:open"],
      ["role", "button"],
      ["title", "Edit item"]
    ],
    children: [
      { tag: "i", attrs: [["class", "fa-solid fa-pen"]], children: [] },
      { tag: "span", attrs: [], children: ["Edit"] }
    ]
  });
  const kids = header.children;
  assert.equal(kids.indexOf(btn), kids.indexOf(close) - 1);
});

test("finds each kind of close control, or appends when there is none", () => {
  for (const close of ["action", "header-button", "close"]) {
    const s = makeSheet({ item: weapon(), close });
    injectSheetButton(s.sheet, opts().options);
    const kids = s.header.children;
    assert.equal(kids.indexOf(buttons(s.header)[0]), kids.indexOf(s.close) - 1, close);
  }
  const s = makeSheet({ item: weapon(), close: "none" });
  injectSheetButton(s.sheet, opts().options);
  assert.equal(s.header.children.at(-1), buttons(s.header)[0]);
});

test("works with jQuery-wrapped elements and with sheet.document", () => {
  const a = makeSheet({ item: weapon(), wrap: "jquery" });
  injectSheetButton(a.sheet, opts().options);
  assert.equal(buttons(a.header).length, 1);
  const b = makeSheet({ item: weapon(), asDocument: true });
  injectSheetButton(b.sheet, opts().options);
  assert.equal(buttons(b.header).length, 1);
});

test("sheets without an element or a header are left alone", (t) => {
  const err = t.mock.method(console, "error", () => {});
  const a = makeSheet({ item: weapon(), wrap: "none" });
  injectSheetButton(a.sheet, opts().options);
  assert.equal(buttons(a.root).length, 0);
  const b = makeSheet({ item: weapon(), header: false });
  injectSheetButton(b.sheet, opts().options);
  assert.equal(buttons(b.root).length, 0);
  assert.equal(err.mock.callCount(), 0);
});

test("dedupes by key: repeated renders and both render hooks add one button", () => {
  const { sheet, header } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, opts().options);
  injectSheetButton(sheet, opts().options);
  injectSheetButton(sheet, opts({ cssClass: "something-else" }).options);
  assert.equal(buttons(header).length, 1);
});

test("different keys coexist, in insertion order, before the close button", () => {
  const { sheet, header, close } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, opts().options);
  injectSheetButton(sheet, opts({ key: "other-mod:open", cssClass: "other-open" }).options);
  injectSheetButton(sheet, opts({ key: "other-mod:open", cssClass: "other-open" }).options);
  const all = buttons(header);
  assert.deepEqual(
    all.map((b) => b.dataset.baronBtn),
    ["my-mod:open", "other-mod:open"]
  );
  const kids = header.children;
  assert.deepEqual(
    [kids.indexOf(all[0]), kids.indexOf(all[1])],
    [kids.indexOf(close) - 2, kids.indexOf(close) - 1]
  );
});

test("dedupe is by key, not by class: a foreign element with the same class does not block it", () => {
  const { sheet, header } = makeSheet({ item: weapon() });
  const foreign = new FakeElement("a");
  foreign.className = "mymod-open";
  header.appendChild(foreign);
  injectSheetButton(sheet, opts().options);
  assert.equal(header.querySelectorAll(".mymod-open").length, 2);
  assert.equal(buttons(header).length, 1);
});

test("keys with selector-special characters still dedupe", () => {
  const key = `my-mod:open "x" [y].z\\w`;
  const { sheet, header } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, opts({ key }).options);
  injectSheetButton(sheet, opts({ key }).options);
  const all = buttons(header);
  assert.equal(all.length, 1);
  assert.equal(all[0].dataset.baronBtn, key);
});

test("plain keys work without a CSS global", () => {
  restoreDom();
  restoreDom = installDom({ css: false });
  assert.equal(globalThis.CSS, undefined);
  const { sheet, header } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, opts().options);
  injectSheetButton(sheet, opts().options);
  assert.equal(buttons(header).length, 1);
});

test("keys with quotes, backslashes and line breaks dedupe without a CSS global", (t) => {
  restoreDom();
  restoreDom = installDom({ css: false });
  const err = t.mock.method(console, "error", () => {});
  for (const key of ['a"b', "a\\b", "line\nbreak", "a]b", "mod:open"]) {
    const { sheet, header } = makeSheet({ item: weapon() });
    for (let i = 0; i < 3; i++) injectSheetButton(sheet, opts({ key }).options);
    const all = buttons(header);
    assert.equal(all.length, 1, JSON.stringify(key));
    assert.equal(all[0].dataset.baronBtn, key);
  }
  assert.equal(err.mock.callCount(), 0);
});

test("a call without a string key or without match/onClick functions is logged and adds nothing", (t) => {
  const err = t.mock.method(console, "error", () => {});
  const { sheet, header } = makeSheet({ item: weapon() });
  const bad = [
    { key: undefined },
    { key: "" },
    { key: 42 },
    { match: undefined },
    { match: "weapon" },
    { onClick: undefined }
  ];
  for (const extra of bad) injectSheetButton(sheet, opts(extra).options);
  assert.equal(buttons(header).length, 0);
  assert.equal(err.mock.callCount(), bad.length);
  for (const call of err.mock.calls) {
    assert.equal(call.arguments[0], "my-mod | header button");
    assert.ok(call.arguments[1] instanceof TypeError);
  }
  // Two modules that both forgot the key no longer hide each other: both are
  // refused, and a correct call afterwards still gets its button.
  injectSheetButton(sheet, opts({ key: "my-mod:open" }).options);
  assert.equal(buttons(header).length, 1);
});

test("cssClass, icon and title left out stay off the element", () => {
  const { sheet, header } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, { key: "m:x", match: () => true, onClick() {}, label: "Go" });
  assert.deepEqual(shapeOf(buttons(header)[0]), {
    tag: "a",
    attrs: [
      ["data-baron-btn", "m:x"],
      ["role", "button"]
    ],
    children: [
      { tag: "i", attrs: [], children: [] },
      { tag: "span", attrs: [], children: ["Go"] }
    ]
  });
  const titled = makeSheet({ item: weapon() });
  injectSheetButton(titled.sheet, { key: "m:x", match: () => true, onClick() {}, title: () => null });
  assert.equal(buttons(titled.header)[0].getAttribute("title"), null);
});

test("skips compendium items, non-matching items and users canShow rejects, in that order", () => {
  const log = [];
  const tracked = (extra) =>
    opts({
      match: (item) => (log.push("match"), item.type === "weapon"),
      canShow: (item) => (log.push("canShow"), item.isOwner),
      ...extra
    }).options;

  let s = makeSheet({ item: weapon({ pack: "world.items" }) });
  injectSheetButton(s.sheet, tracked());
  assert.equal(buttons(s.header).length, 0, "compendium item");
  assert.deepEqual(log.splice(0), ["match"]);

  s = makeSheet({ item: { type: "armor", isOwner: true } });
  injectSheetButton(s.sheet, tracked());
  assert.equal(buttons(s.header).length, 0, "match false");
  assert.deepEqual(log.splice(0), ["match"]);

  s = makeSheet({ item: weapon({ isOwner: false }) });
  injectSheetButton(s.sheet, tracked());
  assert.equal(buttons(s.header).length, 0, "canShow false");
  assert.deepEqual(log.splice(0), ["match", "canShow"]);

  s = makeSheet({ item: weapon() });
  injectSheetButton(s.sheet, tracked({ canShow: undefined }));
  assert.equal(buttons(s.header).length, 1, "canShow omitted");
});

test("sheets without an item are skipped silently", (t) => {
  const err = t.mock.method(console, "error", () => {});
  const { sheet, header } = makeSheet({ item: null });
  const o = opts({ match: () => assert.fail("match must not run without an item") }).options;
  injectSheetButton(sheet, o);
  assert.equal(buttons(header).length, 0);
  assert.equal(err.mock.callCount(), 0);
});

test("label and title may be functions of the item", () => {
  const { sheet, header } = makeSheet({ item: weapon({ type: "weapon", name: "Pick" }) });
  injectSheetButton(
    sheet,
    opts({ label: (item) => `Edit ${item.name}`, title: (item) => `${item.type} editor` }).options
  );
  const btn = buttons(header)[0];
  assert.equal(btn.querySelector("span").textContent, "Edit Pick");
  assert.equal(btn.title, "weapon editor");
});

test("the label is text, never parsed as HTML", () => {
  const { sheet, header } = makeSheet({ item: weapon() });
  injectSheetButton(sheet, opts({ label: "<b>Edit</b> & go" }).options);
  const span = buttons(header)[0].querySelector("span");
  assert.equal(span.textContent, "<b>Edit</b> & go");
  assert.equal(span.children.length, 0);
});

test("a click opens the item and goes no further", () => {
  const item = weapon();
  const { sheet, header } = makeSheet({ item });
  const { clicked, options } = opts();
  injectSheetButton(sheet, options);
  const bubbled = [];
  header.addEventListener("click", () => bubbled.push(true));
  const ev = buttons(header)[0].click();
  assert.deepEqual(clicked, [item]);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(bubbled, []);
});

test("data-baron-btn is set before the button enters the header", () => {
  const { sheet, header } = makeSheet({ item: weapon() });
  const seen = [];
  const original = header.insertBefore.bind(header);
  header.insertBefore = (node, ref) => {
    seen.push(node.getAttribute("data-baron-btn"));
    return original(node, ref);
  };
  injectSheetButton(sheet, opts().options);
  assert.deepEqual(seen, ["my-mod:open"]);
});

test("errors are logged with the caller's prefix and never thrown", (t) => {
  const err = t.mock.method(console, "error", () => {});
  assert.doesNotThrow(() => injectSheetButton(null, opts().options));
  assert.equal(err.mock.calls[0].arguments[0], "my-mod | header button");
  assert.ok(err.mock.calls[0].arguments[1] instanceof TypeError);

  const { sheet } = makeSheet({ item: weapon() });
  const boom = new Error("match exploded");
  assert.doesNotThrow(() =>
    injectSheetButton(sheet, opts({ match: () => { throw boom; }, logPrefix: undefined }).options)
  );
  assert.deepEqual(err.mock.calls[1].arguments, ["baron-core | header button", boom]);

  assert.doesNotThrow(() => injectSheetButton(sheet));
  assert.equal(err.mock.callCount(), 3, "missing options are an error, logged");

  assert.doesNotThrow(() => injectSheetButton(sheet, null));
  assert.equal(err.mock.callCount(), 4, "null options too");
  assert.equal(err.mock.calls[3].arguments[0], "baron-core | header button");
  assert.ok(err.mock.calls[3].arguments[1] instanceof TypeError);
});

test("registers nothing: works with no Hooks, game or ui defined", () => {
  const restore = setGlobals({});
  for (const name of ["Hooks", "game", "ui", "Handlebars"]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error(`${name} touched`);
      }
    });
  }
  try {
    const { sheet, header } = makeSheet({ item: weapon() });
    injectSheetButton(sheet, opts().options);
    assert.equal(buttons(header).length, 1);
  } finally {
    for (const name of ["Hooks", "game", "ui", "Handlebars"]) delete globalThis[name];
    restore();
  }
});
