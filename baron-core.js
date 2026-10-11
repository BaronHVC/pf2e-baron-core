/**
 * baron-core: shared helpers for BaronHVC's PF2e modules for Foundry VTT.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 BaronHVC. The MIT License applies to this file wherever
 * it is vendored, paid modules included: see LICENSE in the core repository.
 *
 * Vendored from BaronHVC/pf2e-baron-core. Do not edit copies by hand: run
 * tools/sync-core.mjs from the core repo, which rewrites this file and the
 * module's baron-core.lock.json together (check-module rejects a copy whose
 * hash does not match the lock).
 *
 * Contract: one ES module, named exports only, no side effects at import.
 * Nothing here touches a Foundry global until one of its functions is called,
 * and nothing registers anything (hooks, settings, template helpers, sockets,
 * custom elements): each module wires these helpers up from its own entry
 * files, under its own identifiers, which are always passed in as parameters.
 */

/* -------------------------------------------------------------------------- */
/*  Version                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Version of this file. Equals the core git tag without its "v" and the
 * `version` field of the consuming module's baron-core.lock.json.
 * @type {string}
 */
export const CORE_VERSION = "1.1.0";

/* -------------------------------------------------------------------------- */
/*  i18n                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the module's localizer: keys are written without the prefix at every
 * call site and the prefix is applied in one place. Reads game.i18n only when
 * the returned function is called.
 * @param {string} prefix  Lang key prefix of the module (by convention its id).
 * @returns {(key: string) => string}  Localizes `${prefix}.${key}`; Foundry
 *   returns the full key unchanged when it has no translation.
 */
export function createI18n(prefix) {
  return (key) => game.i18n.localize(`${prefix}.${key}`);
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Slug for a display name. Uses Foundry's String#slugify when it exists and a
 * plain ASCII fallback otherwise.
 * @param {*} name
 * @returns {string}  "" for anything that is not a string.
 */
export function slugOf(name) {
  if (typeof name !== "string") return "";
  return (
    name.slugify?.({ strict: true }) ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  );
}

// Search inputs backed by datalists hand the form a label, not a slug. An exact
// label match (accent-insensitive, for the es locale) resolves to its value;
// anything else comes back slugified so callers can flag it instead of silently
// dropping what was typed.
/**
 * Maps text typed into a datalist-backed input back to an option value.
 * @param {Array<{value: string, label: string}>|null|undefined} options
 * @param {*} text
 * @returns {string}  The matching option's value, slugOf(text) when nothing
 *   matches, or "" for blank text.
 */
export function resolveLabel(options, text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hit = (options ?? []).find((o) => norm(o.label) === norm(t));
  return hit ? hit.value : slugOf(t);
}

/**
 * Turns a CONFIG-style record ({ slug: "I18N.Key" } or { slug: { name } }) into
 * localized options sorted for the current language. A key that never
 * resolves falls back to its slug rather than showing a raw "PF2E.X" key.
 * @param {Record<string, string|{name?: string}>|null|undefined} record
 * @returns {Array<{value: string, label: string}>}
 */
export function locRecord(record) {
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

/**
 * Localized label of one entry of a CONFIG-style record, with the same slug
 * fallback as locRecord.
 * @param {Record<string, string|{name?: string}>|null|undefined} record
 * @param {string} slug
 * @returns {string}
 */
export function labelFor(record, slug) {
  const v = (record ?? {})[slug];
  if (v === undefined) return slug;
  const raw = typeof v === "string" ? v : (v?.name ?? slug);
  const label = game.i18n.localize(raw);
  return label === raw && raw.includes(".") ? slug : label;
}

/* -------------------------------------------------------------------------- */
/*  Values                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Integer from a form value, truncated and clamped to [min, max].
 * @param {*} v
 * @param {number} min
 * @param {number} max
 * @param {*} fallback  Returned for blank or non-numeric input.
 * @returns {number|*}
 */
export function clampInt(v, min, max, fallback) {
  // FormDataExtended hands an emptied number input over as null, and
  // Number(null) is 0: without this a cleared DC became DC 1.
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Escapes the five HTML-special characters (& < > " ') for text placed in
 * markup or attribute values.
 * @param {*} s  null and undefined become "".
 * @returns {string}
 */
export function escHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* -------------------------------------------------------------------------- */
/*  PF2e                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether a PF2e condition carries a value (frightened 2) rather than being
 * on/off (prone). Reads the system's ConditionManager when called; false when
 * it is not available or the slug is unknown.
 * @param {string} slug
 * @returns {boolean}
 */
export function isValuedCondition(slug) {
  return !!game.pf2e?.ConditionManager?.conditions?.get?.(slug)?.system?.value?.isValued;
}

/**
 * Damage die sizes, smallest first. Shared and mutable: treat as read-only.
 * @type {string[]}
 */
export const DIE_SIZES = ["d4", "d6", "d8", "d10", "d12"];

// Typed so the system's own stacking applies: same-type bonuses do not stack
// with each other, untyped ones always do.
/**
 * PF2e modifier types offered for bonuses. Shared and mutable: treat as
 * read-only.
 * @type {string[]}
 */
export const PF2E_MODIFIER_TYPES = ["circumstance", "status", "item", "untyped"];

/* -------------------------------------------------------------------------- */
/*  Permissions and executor                                                  */
/* -------------------------------------------------------------------------- */

// Hooks such as createX/updateX/deleteX, combat turns and new chat messages
// fire on every connected client, so an entry point that writes documents from
// one of them must run on exactly one client: the active GM. Without that guard
// the write is multiplied by the number of people at the table, and players
// who do not own the document hit a permission error.
/**
 * True on exactly one client: the one whose user is the active GM. Gate on it
 * the document-writing handlers of hooks that every client receives. Never
 * gate preCreate/preUpdate/preDelete handlers or local UI handlers: those run
 * only on the client that started the action, so the guard would silently
 * skip them for players and for any GM who is not the active one.
 * @returns {boolean}
 */
export function isSoleExecutor() {
  return !!game.users?.activeGM && game.users.activeGM === game.user;
}

/**
 * Whether the current user may edit an item through a module's editor.
 * @param {{isOwner?: boolean}} item
 * @param {boolean} gmOnly  When true only GMs may edit; otherwise GMs and the
 *   item's owners.
 * @returns {boolean}
 */
export function canEditItem(item, gmOnly) {
  if (gmOnly) return game.user.isGM;
  return game.user.isGM || item.isOwner;
}

/**
 * Binds canEditItem to a module's world setting. The setting is read on every
 * call (never here), and registering it stays the module's job.
 * @param {string} moduleId  Settings namespace (the module id).
 * @param {string} [settingKey="gmOnly"]  Boolean world setting.
 * @returns {(item: {isOwner?: boolean}) => boolean}
 */
export function makeCanEdit(moduleId, settingKey = "gmOnly") {
  return (item) => canEditItem(item, game.settings.get(moduleId, settingKey));
}

/* -------------------------------------------------------------------------- */
/*  Foundry compatibility                                                     */
/*                                                                            */
/*  Foundry v13 moved these classes under foundry.applications.ux; the old    */
/*  globals stay as the fallback. Each shim is resolved when called, never at */
/*  import, so there is one place to patch per Foundry major.                 */
/* -------------------------------------------------------------------------- */

/**
 * The FormDataExtended class of the running Foundry version.
 * @returns {Function|undefined}
 */
export function formDataClass() {
  return foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
}

/**
 * The TextEditor implementation of the running Foundry version.
 * @returns {object|undefined}
 */
export function textEditor() {
  return foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
}

/**
 * Enriches HTML (links, inline rolls, @UUID references) with the running
 * Foundry version's TextEditor. Options are forwarded untouched.
 * @param {string} html
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export function enrichHTML(html, options) {
  return textEditor().enrichHTML(html, options);
}

/**
 * Root HTMLElement of a sheet, whether the sheet exposes it directly
 * (ApplicationV2) or wrapped in jQuery (Application v1).
 * @param {{element?: *}} sheet
 * @returns {HTMLElement|undefined}
 */
export function sheetElement(sheet) {
  return sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
}

/* -------------------------------------------------------------------------- */
/*  Packs                                                                     */
/* -------------------------------------------------------------------------- */

// One promise per pack and field set, shared by every caller in the module:
// building an index is expensive and its content does not change mid-session.
// A rejection stays cached on purpose (no retry), as it always has. The key is
// JSON so no pack id or field name can run into another ("a,b" vs "a" + "b").
const PACK_INDEX = new Map();

/**
 * Memoized compendium index. Callers asking for the same pack and fields (in
 * any order) get the very same promise.
 * @param {string} packId  e.g. "pf2e.equipment-srd".
 * @param {string[]} [fields=[]]  Extra index fields, passed to getIndex as given.
 * @returns {Promise<Iterable<object>|Array>}  Resolves to [] when the world
 *   does not have the pack.
 */
export function packIndex(packId, fields = []) {
  const key = JSON.stringify([packId, [...fields].sort()]);
  let promise = PACK_INDEX.get(key);
  if (!promise) {
    promise = (async () => {
      const pack = game.packs.get(packId);
      if (!pack) return [];
      return pack.getIndex({ fields });
    })();
    PACK_INDEX.set(key, promise);
  }
  return promise;
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

// A field's change event fires when it loses focus, which happens the moment
// a button is pressed. Re-rendering right then swaps the button for a new copy
// between pointerdown and pointerup, the browser sees press and release on two
// different elements, and the click never happens: Save needed several presses
// after typing in a number field (reproduced with real clicks). While a button
// or action link is held down, re-renders wait until its click has gone
// through. Native selects are left out on purpose: their popup does not always
// report the release, which would stall the refresh.

// Per-app guard state lives under a Symbol private to this file, so it cannot
// collide with the app's own fields or with another module's vendored copy.
const GUARD = Symbol("baron-core.clickGuard");

/**
 * Installs the click guard on a rendered app (call it from the first render).
 * Idempotent: does nothing if the app is already guarded or has no element.
 * @param {{element?: HTMLElement, rendered?: boolean, render: Function}} app
 */
export function guardClicks(app) {
  if (app[GUARD] || !app.element) return;
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
  app[GUARD] = g;
}

/**
 * Removes the guard's window listeners (call it from the app's close). Safe to
 * call on an app that was never guarded.
 * @param {object} app
 */
export function releaseClickGuard(app) {
  const g = app[GUARD];
  if (!g) return;
  window.removeEventListener("pointerup", g.onUp, true);
  window.removeEventListener("pointercancel", g.onUp, true);
  app[GUARD] = null;
}

/**
 * Re-renders the app now, or right after the click in progress when a button
 * is held down. Use it instead of app.render() from change handlers.
 * @param {{render: Function}} app
 */
export function renderSoon(app) {
  const g = app[GUARD];
  if (g?.down) {
    g.pending = true;
    return;
  }
  app.render();
}

/**
 * Adds a button to an item sheet's window header, before its close button.
 * Registers nothing: call it from the module's own item sheet render hooks.
 * Skips compendium items, items `match` rejects and users `canShow` rejects,
 * and never adds the same `key` twice to one header (buttons from different
 * keys, e.g. two modules, coexist). Errors are logged, never thrown, so a
 * failure cannot break the sheet's render; a call without a string `key` or
 * without `match`/`onClick` functions is such an error and adds nothing.
 * @param {object} sheet  The rendered item sheet.
 * @param {object} options
 * @param {string} options.key  Unique per module and button: "<moduleId>:<name>".
 * @param {(item: object) => boolean} options.match  Which items get the button.
 * @param {(item: object) => boolean} [options.canShow]  Permission gate, e.g. makeCanEdit(id).
 * @param {string} options.cssClass  Class of the <a>, scoped to the module.
 * @param {string} options.icon  Class of the <i>, e.g. "fa-solid fa-pen".
 * @param {string|((item: object) => string)} options.label  Plain text, never HTML.
 * @param {string|((item: object) => string)} options.title  Tooltip.
 * @param {(item: object) => void} options.onClick
 * @param {string} [options.logPrefix]  Prefix of the console.error on failure.
 */
export function injectSheetButton(sheet, options) {
  try {
    // Destructured inside the try, not in the signature, so even a null
    // options object ends up logged instead of thrown into the render hook.
    const { key, match, canShow, cssClass, icon, label, title, onClick } = options;
    // Without a key every caller that forgot it would share the key
    // "undefined" and hide each other's buttons; without match/onClick the
    // failure would only surface later. Refuse the call up front instead.
    if (typeof key !== "string" || !key || typeof match !== "function" || typeof onClick !== "function") {
      throw new TypeError("injectSheetButton needs a non-empty string key and match/onClick functions");
    }
    const item = sheet.item ?? sheet.document;
    if (!item || !match(item)) return;
    if (item.pack) return;
    if (canShow && !canShow(item)) return;
    const el = sheetElement(sheet);
    const header = el?.querySelector(".window-header");
    // Compared as values, not through an attribute selector, so no key ever
    // needs CSS escaping, whatever characters it holds.
    if (!header || [...header.querySelectorAll("[data-baron-btn]")].some((b) => b.dataset.baronBtn === key)) return;
    const btn = document.createElement("a");
    // Optional parts left out stay off the element instead of reading "undefined".
    if (cssClass != null) btn.className = cssClass;
    btn.dataset.baronBtn = key;
    const iconEl = document.createElement("i");
    if (icon != null) iconEl.className = icon;
    const labelEl = document.createElement("span");
    labelEl.textContent = typeof label === "function" ? label(item) : label;
    btn.appendChild(iconEl);
    btn.appendChild(labelEl);
    btn.setAttribute("role", "button");
    const tip = typeof title === "function" ? title(item) : title;
    if (tip != null) btn.title = tip;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(item);
    });
    const closeBtn = header.querySelector('[data-action="close"], .header-button.close, .close');
    header.insertBefore(btn, closeBtn ?? null);
  } catch (err) {
    console.error(options?.logPrefix ?? "baron-core | header button", err);
  }
}
