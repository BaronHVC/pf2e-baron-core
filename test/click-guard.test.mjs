import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { guardClicks, releaseClickGuard, renderSoon } from "../baron-core.js";
import { setGlobals, tick } from "./helpers/foundry-stubs.mjs";
import { installDom, FakeElement, FakeWindow } from "./helpers/fake-dom.mjs";

let restoreDom;
let restoreWin;
let win;

beforeEach(() => {
  restoreDom = installDom();
  win = new FakeWindow();
  restoreWin = setGlobals({ window: win });
});

afterEach(() => {
  restoreWin();
  restoreDom();
});

// An app whose element holds a Save button, an action link with an icon, a
// number input and a select.
function makeApp() {
  const root = new FakeElement("form");
  const save = new FakeElement("button");
  save.setAttribute("type", "submit");
  const link = new FakeElement("a");
  link.setAttribute("data-action", "addRune");
  const icon = new FakeElement("i");
  link.appendChild(icon);
  const input = new FakeElement("input");
  const select = new FakeElement("select");
  root.append(save, link, input, select);
  const app = {
    element: root,
    rendered: true,
    renders: 0,
    render() {
      this.renders++;
    }
  };
  return { app, root, save, link, icon, input, select };
}

test("guardClicks attaches one pointerdown (capture) and two window listeners", () => {
  const { app, root } = makeApp();
  guardClicks(app);
  assert.equal(win.count("pointerup"), 1);
  assert.equal(win.count("pointercancel"), 1);
  assert.ok(win.active.every((l) => l.capture === true));
  assert.deepEqual(
    root.listeners.map((l) => [l.type, l.capture]),
    [["pointerdown", true]]
  );
});

test("guardClicks is idempotent and skips apps without an element", () => {
  const { app, root } = makeApp();
  guardClicks(app);
  guardClicks(app);
  assert.equal(win.count("pointerup"), 1);
  assert.equal(root.listeners.length, 1);

  const bare = { element: null, renders: 0, render() { this.renders++; } };
  guardClicks(bare);
  assert.equal(win.count("pointerup"), 1);
  renderSoon(bare);
  assert.equal(bare.renders, 1);
});

test("renderSoon renders at once when nothing is held", () => {
  const { app } = makeApp();
  renderSoon(app); // not even guarded
  assert.equal(app.renders, 1);
  guardClicks(app);
  renderSoon(app);
  assert.equal(app.renders, 2);
});

test("a held button defers the render until just after pointerup", async () => {
  const { app, save } = makeApp();
  guardClicks(app);
  save.dispatch("pointerdown");
  renderSoon(app);
  renderSoon(app); // several changes while held still render once
  assert.equal(app.renders, 0);
  win.fire("pointerup");
  assert.equal(app.renders, 0, "the click must reach the original button first");
  await tick();
  assert.equal(app.renders, 1);
  renderSoon(app);
  assert.equal(app.renders, 2, "released: back to immediate renders");
});

test("pointercancel releases like pointerup", async () => {
  const { app, save } = makeApp();
  guardClicks(app);
  save.dispatch("pointerdown");
  renderSoon(app);
  win.fire("pointercancel");
  await tick();
  assert.equal(app.renders, 1);
});

test("an icon inside an action link counts as holding it", async () => {
  const { app, icon } = makeApp();
  guardClicks(app);
  icon.dispatch("pointerdown");
  renderSoon(app);
  assert.equal(app.renders, 0);
  win.fire("pointerup");
  await tick();
  assert.equal(app.renders, 1);
});

test("inputs and selects do not hold renders", () => {
  const { app, input, select } = makeApp();
  guardClicks(app);
  input.dispatch("pointerdown");
  renderSoon(app);
  select.dispatch("pointerdown");
  renderSoon(app);
  assert.equal(app.renders, 2);
});

test("no deferred render when nothing was pending or the app closed meanwhile", async () => {
  const { app, save } = makeApp();
  guardClicks(app);
  save.dispatch("pointerdown");
  win.fire("pointerup");
  await tick();
  assert.equal(app.renders, 0, "nothing pending");

  save.dispatch("pointerdown");
  renderSoon(app);
  app.rendered = false;
  win.fire("pointerup");
  await tick();
  assert.equal(app.renders, 0, "app no longer rendered");
});

test("releaseClickGuard removes the window listeners and is idempotent", async () => {
  const { app, save } = makeApp();
  guardClicks(app);
  save.dispatch("pointerdown");
  releaseClickGuard(app);
  assert.equal(win.count("pointerup"), 0);
  assert.equal(win.count("pointercancel"), 0);
  renderSoon(app);
  assert.equal(app.renders, 1, "released apps render at once");
  win.fire("pointerup");
  await tick();
  assert.equal(app.renders, 1);
  assert.doesNotThrow(() => releaseClickGuard(app));
  assert.doesNotThrow(() => releaseClickGuard({}));
});

test("an app can be guarded again after release (re-opened editor)", () => {
  const { app } = makeApp();
  guardClicks(app);
  releaseClickGuard(app);
  guardClicks(app);
  assert.equal(win.count("pointerup"), 1);
});

test("guard state hides under a private, unregistered Symbol", () => {
  const { app } = makeApp();
  const keysBefore = Object.keys(app);
  guardClicks(app);
  assert.deepEqual(Object.keys(app), keysBefore, "no string key added to the app");
  const syms = Object.getOwnPropertySymbols(app);
  assert.equal(syms.length, 1);
  assert.equal(syms[0].description, "baron-core.clickGuard");
  assert.equal(Symbol.keyFor(syms[0]), undefined, "not in the global Symbol registry");
});

test("two vendored copies keep independent guards", async () => {
  const other = await import(new URL("../baron-core.js?copy=other", import.meta.url).href);
  const { app, save } = makeApp();
  guardClicks(app);
  save.dispatch("pointerdown");
  other.renderSoon(app);
  assert.equal(app.renders, 1, "the other copy does not see this copy's held state");
  other.guardClicks(app);
  assert.equal(win.count("pointerup"), 2);
});
