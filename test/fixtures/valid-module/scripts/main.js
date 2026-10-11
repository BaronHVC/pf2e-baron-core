// Fixture for check-module: a module that passes every check. Bare
// `node --test` imports every .js under test/, so Foundry globals are touched
// only inside functions and nothing runs at import.
//
// Each construct below is a trap the scanner must get right:
// import "/modules/other-module/api.js";   <- in a comment: not an import
import { noticeKey } from "./lib/util.js";

export const MODULE_ID = "baron-fixture";

// Own template through an interpolated module path: must exist on disk.
const TEMPLATE = `modules/${MODULE_ID}/templates/panel.hbs`;
// Another module's or the system's templates are not ours to check.
const FOREIGN_TEMPLATES = [
  "modules/someone-else/templates/not-ours.hbs",
  "systems/pf2e/templates/items/weapon-sheet.hbs",
];

export const i18n = (key) => game.i18n.localize(`${MODULE_ID}.${key}`);

export function labels(kind) {
  return {
    title: i18n("Title"),
    open: game.i18n.localize("baron-fixture.Open"),
    notice: game.i18n.localize(noticeKey()),
    // Built at runtime: cannot be traced, must not be flagged.
    kind: i18n(`Kind_${kind}`),
    // Prose that starts with the prefix is not a key.
    prose: "baron-fixture. is the prefix, not a key",
    // Words inside strings and regexes are not imports.
    hint: "the words import '/modules/x/y.js' and export * from '../../z.js' are just text",
    quoted: /import ".\.\/nope"/.test(kind),
    flagScope: "bfx-flag",
    foreign: FOREIGN_TEMPLATES.length,
  };
}

// A template literal whose lines start with "await" is not top-level await.
export const multiline = `first line
await is just text here
const x = await nothing;
`;

export function renderPanel(data) {
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, data);
}

export function lateLoad() {
  return import("./lib/util.js");
}
