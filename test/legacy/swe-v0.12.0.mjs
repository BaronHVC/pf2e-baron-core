// Verbatim copies of the helpers baron-core 1.0.0-rc.1 was extracted from:
// pf2e-simple-weapon-editor v0.12.0 (commit d15a90a), scripts/main.js and
// scripts/armor.js. test/parity.test.mjs runs these and the core exports over
// the same inputs; test/legacy-verbatim.test.mjs (through verify-legacy.mjs)
// checks that every "@verbatim" region below appears line for line in
// `git show d15a90a:scripts/<file>` (line endings normalized to LF). The
// "@verbatim-statements" regions are statements cut out of a method body, so
// they are compared without their common indentation, which differs per file.
//
// Adaptations, all OUTSIDE the verbatim regions, so the copies can run in Node:
// - Exports go through one `export { ... }` list at the end, so the copied
//   declarations stay byte-identical (SWE exports few of them).
// - SimpleWeaponEditor and SimpleArmorEditor are stubs that only record the
//   item passed to open(); the injected header buttons call them on click.
//   The SimpleWeaponEditor stub also hosts SWE's verbatim static runeIndex().
// - The FormDataExtended, TextEditor and sheet-element shims are inline
//   statements inside SWE methods; each is wrapped in a legacy* function that
//   runs the verbatim statement(s) and returns the result.
// - armor.js imports MODULE_ID, i18n and canEdit from main.js; here the
//   functions of both files share the single copies below, as they do in SWE.
// Globals (game, foundry, window, document, HTMLElement, setTimeout, console)
// are whatever the test installs, as Foundry provides them at runtime.

// @verbatim main.js
const MODULE_ID = "pf2e-simple-weapon-editor";
const DIES = ["d4", "d6", "d8", "d10", "d12"];
// @end

// @verbatim main.js
// Typed so the system's own stacking applies: same-type bonuses do not stack
// with each other, untyped ones always do.
const BONUS_TYPES = ["circumstance", "status", "item", "untyped"];
// @end

// @verbatim main.js
function isValuedCondition(slug) {
  return !!game.pf2e?.ConditionManager?.conditions?.get?.(slug)?.system?.value?.isValued;
}

function slugOf(name) {
  if (typeof name !== "string") return "";
  return (
    name.slugify?.({ strict: true }) ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  );
}
// @end

// @verbatim main.js
// Search inputs backed by datalists hand the form a label, not a slug. An exact
// label match (accent-insensitive, for the es locale) resolves to its value;
// anything else comes back slugified so callers can flag it instead of silently
// dropping what was typed.
function resolveLabel(options, text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hit = (options ?? []).find((o) => norm(o.label) === norm(t));
  return hit ? hit.value : slugOf(t);
}
// @end

// @verbatim main.js
function i18n(key) {
  return game.i18n.localize(`SWE.${key}`);
}

function locRecord(record) {
  const out = [];
  for (const [k, v] of Object.entries(record ?? {})) {
    const raw = typeof v === "string" ? v : (v?.name ?? String(k));
    let label = game.i18n.localize(raw);
    if (label === raw && raw.includes(".")) label = k;
    out.push({ value: k, label });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  return out;
}
// @end

// @verbatim main.js
function labelFor(record, slug) {
  const v = (record ?? {})[slug];
  if (v === undefined) return slug;
  const raw = typeof v === "string" ? v : (v?.name ?? slug);
  const label = game.i18n.localize(raw);
  return label === raw && raw.includes(".") ? slug : label;
}
// @end

// @verbatim main.js
function clampInt(v, min, max, fallback) {
  // FormDataExtended hands an emptied number input over as null, and
  // Number(null) is 0: without this a cleared DC became DC 1.
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
// @end

// @verbatim main.js
// A field's change event fires when it loses focus, which happens the moment
// a button is pressed. Re-rendering right then swaps the button for a new copy
// between pointerdown and pointerup, the browser sees press and release on two
// different elements, and the click never happens: Save needed several presses
// after typing in a number field (reproduced with real clicks). While a button
// or action link is held down, re-renders wait until its click has gone
// through. Native selects are left out on purpose: their popup does not always
// report the release, which would stall the refresh.
function guardClicks(app) {
  if (app._sweGuard || !app.element) return;
  const g = { down: false, pending: false };
  g.onDown = (ev) => {
    if (ev.target?.closest?.('button, a[data-action], [data-action]')) g.down = true;
  };
  g.onUp = () => {
    if (!g.down) return;
    g.down = false;
    // The click is dispatched right after pointerup; a zero delay lets it
    // reach the original button before the deferred re-render runs.
    setTimeout(() => {
      if (!g.pending) return;
      g.pending = false;
      if (app.rendered) app.render();
    }, 0);
  };
  app.element.addEventListener("pointerdown", g.onDown, true);
  window.addEventListener("pointerup", g.onUp, true);
  window.addEventListener("pointercancel", g.onUp, true);
  app._sweGuard = g;
}

function releaseClickGuard(app) {
  const g = app._sweGuard;
  if (!g) return;
  window.removeEventListener("pointerup", g.onUp, true);
  window.removeEventListener("pointercancel", g.onUp, true);
  app._sweGuard = null;
}

function renderSoon(app) {
  const g = app._sweGuard;
  if (g?.down) {
    g.pending = true;
    return;
  }
  app.render();
}
// @end

// Stub: records what the header button opens. Hosts the verbatim runeIndex.
class SimpleWeaponEditor {
  static opened = [];
  static open(item) {
    SimpleWeaponEditor.opened.push(item);
  }

  // @verbatim main.js
  static async runeIndex() {
    if (!this._runeIndexPromise) {
      this._runeIndexPromise = (async () => {
        const pack = game.packs.get("pf2e.equipment-srd");
        if (!pack) return [];
        return await pack.getIndex({ fields: ["system.slug", "type"] });
      })();
    }
    return this._runeIndexPromise;
  }
  // @end
}

// Stub: records what the armor header button opens.
class SimpleArmorEditor {
  static opened = [];
  static open(item) {
    SimpleArmorEditor.opened.push(item);
  }
}

// Wrapper: SWE runs this inside TextEditor-using methods (main 607-608, armor 454-455).
async function legacyEnrich(desc) {
  const info = {};
  // @verbatim-statements main.js armor.js
          const TE = foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
          info.descHTML = await TE.enrichHTML(desc, { async: true });
  // @end
  return { TE, descHTML: info.descHTML };
}

// Wrapper: SWE runs this inside syncFromForm (main 1081, armor 891).
function legacyFormDataClass() {
  // @verbatim-statements main.js armor.js
    const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
  // @end
  return FDE;
}

// @verbatim main.js
/* -------------------------------------------------------------------------- */
/*  Healing engine                                                             */
/*                                                                             */
/*  PF2e has no rule element for "heal when you hit", and FastHealing only     */
/*  takes a flat number, so healing is applied by the module itself. Hooks fire */
/*  on every connected client, so every entry point is gated on being the one   */
/*  active GM: without that guard the healing is multiplied by the number of    */
/*  people at the table, and non-owning players hit a permission error.         */
/* -------------------------------------------------------------------------- */

function isSoleExecutor() {
  return !!game.users?.activeGM && game.users.activeGM === game.user;
}
// @end

// @verbatim main.js
function escHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
// @end

// @verbatim main.js
function canEdit(item) {
  const gmOnly = game.settings.get(MODULE_ID, "gmOnly");
  if (gmOnly) return game.user.isGM;
  return game.user.isGM || item.isOwner;
}

function injectButton(sheet) {
  try {
    const item = sheet.item ?? sheet.document;
    if (!item || item.type !== "weapon") return;
    if (item.pack) return;
    if (!canEdit(item)) return;
    const el = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
    const header = el?.querySelector(".window-header");
    if (!header || header.querySelector(".swe-open")) return;
    const btn = document.createElement("a");
    btn.className = "swe-open";
    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>${i18n("Open")}</span>`;
    btn.setAttribute("role", "button");
    btn.title = i18n("Title");
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      SimpleWeaponEditor.open(item);
    });
    const closeBtn = header.querySelector('[data-action="close"], .header-button.close, .close');
    header.insertBefore(btn, closeBtn ?? null);
  } catch (err) {
    console.error(`${MODULE_ID} | header button`, err);
  }
}
// @end

// Wrapper: SWE runs this inside both header-button functions (main 2369, armor 1194).
function legacySheetElement(sheet) {
  // @verbatim-statements main.js armor.js
    const el = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
  // @end
  return el;
}

// @verbatim armor.js
let _equipIndex = null;
async function equipmentIndex() {
  if (!_equipIndex) {
    _equipIndex = (async () => {
      const pack = game.packs.get("pf2e.equipment-srd");
      if (!pack) return [];
      return pack.getIndex({ fields: ["system.slug", "type"] });
    })();
  }
  return _equipIndex;
}
// @end

// @verbatim armor.js
function injectArmorButton(sheet) {
  try {
    const item = sheet.item ?? sheet.document;
    if (!item || (item.type !== "armor" && item.type !== "shield")) return;
    if (item.pack) return;
    if (!canEdit(item)) return;
    const el = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
    const header = el?.querySelector(".window-header");
    if (!header || header.querySelector(".swe-open")) return;
    const btn = document.createElement("a");
    btn.className = "swe-open";
    btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i><span>${i18n("Open")}</span>`;
    btn.setAttribute("role", "button");
    btn.title = i18n(item.type === "shield" ? "ShTitle" : "ArmTitle");
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      SimpleArmorEditor.open(item);
    });
    const closeBtn = header.querySelector('[data-action="close"], .header-button.close, .close');
    header.insertBefore(btn, closeBtn ?? null);
  } catch (err) {
    console.error(`${MODULE_ID} | armor header button`, err);
  }
}
// @end

export {
  MODULE_ID,
  DIES,
  BONUS_TYPES,
  isValuedCondition,
  slugOf,
  resolveLabel,
  i18n,
  locRecord,
  labelFor,
  clampInt,
  guardClicks,
  releaseClickGuard,
  renderSoon,
  SimpleWeaponEditor,
  SimpleArmorEditor,
  legacyEnrich,
  legacyFormDataClass,
  isSoleExecutor,
  escHTML,
  canEdit,
  injectButton,
  legacySheetElement,
  equipmentIndex,
  injectArmorButton
};
