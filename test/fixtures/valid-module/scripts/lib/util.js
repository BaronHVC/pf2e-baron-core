// Nested on purpose: check-module walks scripts/ recursively.

/** A static key written out in full, outside any i18n() call. */
export function noticeKey() {
  return "baron-fixture.Notice";
}

/** A persisted slug prefix built at runtime: baron.json lists "bfx-p-". */
export function ruleSlug(i) {
  return `bfx-p-${i}`;
}
