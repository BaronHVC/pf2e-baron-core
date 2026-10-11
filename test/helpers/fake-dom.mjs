// Minimal DOM for the tests, just enough for the header button and the click
// guard: an element tree with attributes, class/title/dataset/textContent, a
// parser for the small innerHTML SWE's legacy button writes, querySelector /
// closest over comma-separated compound selectors (tag, .class, #id, [attr],
// [attr="v"]), and capture/bubble event dispatch. It is not a DOM: anything
// the code under test needs beyond this should fail loudly, not be faked.

export class FakeText {
  constructor(data) {
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);

export class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = [];
  }

  get localName() {
    return this.tagName.toLowerCase();
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(v) {
    this.setAttribute("class", v);
  }

  get classList() {
    const el = this;
    return {
      contains: (c) => el.className.split(/\s+/).includes(c),
      add: (...cs) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        for (const c of cs) set.add(c);
        el.className = [...set].join(" ");
      }
    };
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(v) {
    this.setAttribute("id", v);
  }

  get title() {
    return this.getAttribute("title") ?? "";
  }

  set title(v) {
    this.setAttribute("title", v);
  }

  // Real dataset semantics: camelCase property <-> data-kebab-case attribute.
  get dataset() {
    const el = this;
    const attr = (prop) => "data-" + String(prop).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    return new Proxy(
      {},
      {
        get: (_, prop) => (typeof prop === "string" ? (el.getAttribute(attr(prop)) ?? undefined) : undefined),
        set: (_, prop, value) => {
          el.setAttribute(attr(prop), value);
          return true;
        },
        has: (_, prop) => el.hasAttribute(attr(prop)),
        deleteProperty: (_, prop) => {
          el.removeAttribute(attr(prop));
          return true;
        }
      }
    );
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }

  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    const s = String(v ?? "");
    if (s) this.appendChild(new FakeText(s));
  }

  set innerHTML(html) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    for (const n of parseHTML(String(html))) this.appendChild(n);
  }

  get innerHTML() {
    return this.childNodes.map(serialize).join("");
  }

  get outerHTML() {
    return serialize(this);
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode._detach(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === "string" ? new FakeText(n) : n);
  }

  insertBefore(node, ref) {
    if (ref === null || ref === undefined) return this.appendChild(node);
    const at = this.childNodes.indexOf(ref);
    if (at < 0) {
      const err = new Error("The node before which the new node is to be inserted is not a child of this node.");
      err.name = "NotFoundError";
      throw err;
    }
    if (node.parentNode) node.parentNode._detach(node);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    node.parentNode = this;
    return node;
  }

  remove() {
    this.parentNode?._detach(this);
  }

  _detach(node) {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
  }

  *_descendants() {
    for (const c of this.children) {
      yield c;
      yield* c._descendants();
    }
  }

  matches(selector) {
    return parseSelectorList(selector).some((compound) => matchCompound(this, compound));
  }

  querySelector(selector) {
    const list = parseSelectorList(selector);
    for (const el of this._descendants()) {
      if (list.some((compound) => matchCompound(el, compound))) return el;
    }
    return null;
  }

  querySelectorAll(selector) {
    const list = parseSelectorList(selector);
    return [...this._descendants()].filter((el) => list.some((compound) => matchCompound(el, compound)));
  }

  closest(selector) {
    for (let n = this; n instanceof FakeElement; n = n.parentNode) {
      if (n.matches(selector)) return n;
    }
    return null;
  }

  addEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    if (this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return;
    this.listeners.push({ type, fn, capture });
  }

  removeEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }

  // Dispatches a synthetic event along the ancestor path: capture listeners
  // root -> target, then bubble listeners target -> root.
  dispatch(type, init = {}) {
    const ev = {
      type,
      target: this,
      currentTarget: null,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...init
    };
    const path = [];
    for (let n = this; n instanceof FakeElement; n = n.parentNode) path.unshift(n);
    const run = (node, wantCapture) => {
      for (const l of [...node.listeners]) {
        if (l.type !== type) continue;
        if (wantCapture !== null && l.capture !== wantCapture) continue;
        ev.currentTarget = node;
        l.fn.call(node, ev);
      }
    };
    for (const node of path.slice(0, -1)) {
      if (ev.propagationStopped) return ev;
      run(node, true);
    }
    if (!ev.propagationStopped) run(this, null);
    for (const node of path.slice(0, -1).reverse()) {
      if (ev.propagationStopped) break;
      run(node, false);
    }
    return ev;
  }

  click() {
    return this.dispatch("click");
  }
}

export class FakeDocument {
  createElement(tag) {
    return new FakeElement(tag);
  }

  createTextNode(data) {
    return new FakeText(data);
  }
}

/* ------------------------------------------------------------ selectors */

function unescapeCSS(s) {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_, hex, ch) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch
  );
}

// Splits on top-level commas, leaving commas inside [] and quotes alone.
function splitTopLevel(selector) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "\\") {
      cur += c + (selector[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

const IDENT = /^(?:\\[\s\S]|[\w-])+/;

function parseCompound(src) {
  const out = { tag: null, classes: [], ids: [], attrs: [] };
  let s = src;
  const m = /^[a-zA-Z][\w-]*/.exec(s);
  if (m) {
    out.tag = m[0].toLowerCase();
    s = s.slice(m[0].length);
  }
  while (s.length) {
    if (s[0] === "." || s[0] === "#") {
      const id = IDENT.exec(s.slice(1));
      if (!id) throw new SyntaxError(`fake-dom: bad selector "${src}"`);
      (s[0] === "." ? out.classes : out.ids).push(unescapeCSS(id[0]));
      s = s.slice(1 + id[0].length);
    } else if (s[0] === "[") {
      const a = /^\[\s*([\w-]+)\s*(?:=\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[\w-])+)))?\s*\]/.exec(s);
      if (!a) throw new SyntaxError(`fake-dom: bad selector "${src}"`);
      const raw = a[2] ?? a[3] ?? a[4];
      out.attrs.push({ name: a[1].toLowerCase(), value: raw === undefined ? undefined : unescapeCSS(raw) });
      s = s.slice(a[0].length);
    } else {
      // Combinators and pseudo-classes are not supported on purpose.
      throw new SyntaxError(`fake-dom: unsupported selector "${src}"`);
    }
  }
  return out;
}

const SELECTOR_CACHE = new Map();
function parseSelectorList(selector) {
  if (!SELECTOR_CACHE.has(selector)) SELECTOR_CACHE.set(selector, splitTopLevel(selector).map(parseCompound));
  return SELECTOR_CACHE.get(selector);
}

function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- HTML */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ENTITIES[e]);
const encodeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const encodeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// Parses the flat, well-formed markup the code under test writes.
export function parseHTML(html) {
  const root = new FakeElement("template");
  const stack = [root];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      if (stack.length > 1 && top.localName === m[1].toLowerCase()) stack.pop();
      else throw new SyntaxError(`fake-dom: unexpected </${m[1]}>`);
    } else if (m[2]) {
      const el = new FakeElement(m[2]);
      const attrRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(m[3] ?? ""))) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
      top.appendChild(el);
      if (!VOID.has(el.localName) && !m[0].endsWith("/>")) stack.push(el);
    } else if (m[4]) {
      top.appendChild(new FakeText(decode(m[4])));
    }
  }
  if (stack.length !== 1) throw new SyntaxError("fake-dom: unclosed element");
  const nodes = [...root.childNodes];
  for (const n of nodes) n.parentNode = null;
  return nodes;
}

export function serialize(node) {
  if (node instanceof FakeText) return encodeText(node.data);
  const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${encodeAttr(v)}"`).join("");
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serialize).join("")}</${node.localName}>`;
}

/**
 * Structural snapshot for deep-equality: tag, attributes (minus `omitAttrs`)
 * in insertion order, and children. Text nodes become strings.
 */
export function shapeOf(node, omitAttrs = []) {
  if (node instanceof FakeText) return node.data;
  return {
    tag: node.localName,
    attrs: [...node.attributes].filter(([k]) => !omitAttrs.includes(k)),
    children: node.childNodes.map((c) => shapeOf(c, omitAttrs))
  };
}

/* ------------------------------------------------------------------ CSS */

// CSS.escape per the CSSOM spec (serialize an identifier).
export function cssEscape(value) {
  const s = String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (code === 0) out += String.fromCharCode(0xfffd); // REPLACEMENT CHARACTER
    else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && s.charCodeAt(0) === 0x2d)
    )
      out += "\\" + code.toString(16) + " ";
    else if (i === 0 && s.length === 1 && code === 0x2d) out += "\\" + ch;
    else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    )
      out += ch;
    else out += "\\" + ch;
  }
  return out;
}

/* -------------------------------------------------------------- windows */

/**
 * EventTarget-based stand-in for window that also reports which listeners
 * are currently attached, so tests can see the guard add and remove them.
 */
export class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.active = [];
  }

  addEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    if (!this.active.some((l) => l.type === type && l.fn === fn && l.capture === capture)) {
      this.active.push({ type, fn, capture });
    }
    super.addEventListener(type, fn, options);
  }

  removeEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.active = this.active.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
    super.removeEventListener(type, fn, options);
  }

  count(type) {
    return this.active.filter((l) => l.type === type).length;
  }

  fire(type) {
    return this.dispatchEvent(new Event(type));
  }
}

/**
 * Installs document, HTMLElement and CSS on globalThis; returns a restore fn.
 */
export function installDom({ css = true } = {}) {
  const saved = {};
  const set = { document: new FakeDocument(), HTMLElement: FakeElement };
  if (css) set.CSS = { escape: cssEscape };
  for (const [k, v] of Object.entries(set)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return () => {
    for (const k of Object.keys(set)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
}

/**
 * Builds an item sheet whose window header holds a title, one unrelated
 * header button and (depending on `close`) a close control.
 * @param {object} o
 * @param {object|null} o.item
 * @param {"action"|"header-button"|"close"|"none"} [o.close="action"]
 * @param {"direct"|"jquery"|"none"} [o.wrap="direct"]  How sheet.element is exposed.
 * @param {boolean} [o.header=true]
 * @param {boolean} [o.asDocument=false]  Expose the item as sheet.document instead of sheet.item.
 */
export function makeSheet({ item, close = "action", wrap = "direct", header = true, asDocument = false } = {}) {
  const root = new FakeElement("div");
  root.className = "application sheet item";
  let head = null;
  let closeEl = null;
  if (header) {
    head = new FakeElement("header");
    head.className = "window-header";
    const title = new FakeElement("h1");
    title.className = "window-title";
    title.textContent = "Sheet";
    head.appendChild(title);
    const other = new FakeElement("button");
    other.className = "header-control";
    other.setAttribute("data-action", "toggleControls");
    head.appendChild(other);
    if (close === "action") {
      closeEl = new FakeElement("button");
      closeEl.className = "header-control";
      closeEl.setAttribute("data-action", "close");
    } else if (close === "header-button") {
      closeEl = new FakeElement("a");
      closeEl.className = "header-button control close";
    } else if (close === "close") {
      closeEl = new FakeElement("a");
      closeEl.className = "close";
    }
    if (closeEl) head.appendChild(closeEl);
    root.appendChild(head);
  }
  const body = new FakeElement("section");
  body.className = "window-content";
  root.appendChild(body);
  const sheet = {};
  if (asDocument) sheet.document = item;
  else sheet.item = item;
  if (wrap === "direct") sheet.element = root;
  else if (wrap === "jquery") sheet.element = { 0: root, length: 1 };
  return { sheet, root, header: head, close: closeEl };
}
