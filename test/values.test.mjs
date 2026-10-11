import { test } from "node:test";
import assert from "node:assert/strict";
import { clampInt, escHTML } from "../baron-core.js";

/* --------------------------------------------------------------- clampInt */

test("clampInt returns the fallback for blank or non-numeric input", () => {
  const cases = [null, undefined, "", "  ", "\t\n", "abc", NaN, Infinity, -Infinity, "Infinity", {}, "1e400"];
  for (const v of cases) assert.equal(clampInt(v, 0, 10, 5), 5, `input ${String(v)}`);
});

test("clampInt keeps a non-numeric fallback as given", () => {
  assert.equal(clampInt(null, 0, 10, null), null);
  assert.equal(clampInt("", 0, 10, undefined), undefined);
  assert.equal(clampInt("abc", 0, 10, "keep"), "keep");
});

test("clampInt truncates toward zero", () => {
  assert.equal(clampInt("3.9", 0, 10, 5), 3);
  assert.equal(clampInt(3.9, 0, 10, 5), 3);
  assert.equal(clampInt("-3.9", -10, 10, 5), -3);
  assert.equal(clampInt(" 7 ", 0, 10, 5), 7);
});

test("clampInt clamps to the bounds", () => {
  assert.equal(clampInt(-4, 0, 10, 5), 0);
  assert.equal(clampInt(99, 0, 10, 5), 10);
  assert.equal(clampInt("99", 1, 60, 15), 60);
  assert.equal(clampInt(0, 1, 60, 15), 1); // a real 0 is a value, not blank
  assert.equal(clampInt(7, 0, 10, 5), 7);
});

test("clampInt follows Number() for other types (SWE's behaviour)", () => {
  assert.equal(clampInt(true, 0, 10, 5), 1);
  assert.equal(clampInt(false, 0, 10, 5), 0);
  assert.equal(clampInt([], 0, 10, 5), 0);
  assert.equal(clampInt("0x10", 0, 100, 5), 16);
});

/* ---------------------------------------------------------------- escHTML */

test("escHTML escapes all five special characters", () => {
  assert.equal(escHTML(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(
    escHTML(`<a href="x" title='y'>Tom & Jerry</a>`),
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;"
  );
});

test("escHTML leaves other text alone and escapes again what is already escaped", () => {
  assert.equal(escHTML("Élfico +1 d8"), "Élfico +1 d8");
  assert.equal(escHTML("&amp;"), "&amp;amp;");
});

test("escHTML stringifies non-strings, null and undefined become ''", () => {
  assert.equal(escHTML(null), "");
  assert.equal(escHTML(undefined), "");
  assert.equal(escHTML(0), "0");
  assert.equal(escHTML(false), "false");
});
