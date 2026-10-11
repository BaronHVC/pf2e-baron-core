// Splits JavaScript source into code, comment, string, template and regex
// segments, so the grep guard can look at code without tripping over prose in
// comments or text inside literals. Template literals come out as template
// pieces with their ${...} expressions scanned as code in between.
//
// Regex literals are told apart from division the usual heuristic way, by
// what precedes the slash. That is enough for baron-core.js, and the guard
// proves it on every run: joining the segments must give the source back, and
// the comment-free code must still import with the same exports.

const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await"
]);
const REGEX_AFTER_PUNCT = "(,=:[!&|?{};+-*%<>~^";

/**
 * @param {string} src
 * @returns {Array<{type: "code"|"comment"|"string"|"template"|"regex", text: string}>}
 *   Concatenating every `text` gives `src` back.
 */
export function scanJs(src) {
  const out = [];
  let pos = 0;

  const emit = (type, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (type === "code" && last?.type === "code") last.text += text;
    else out.push({ type, text });
  };

  const fail = (what) => {
    const line = src.slice(0, pos).split("\n").length;
    throw new SyntaxError(`js-scan: ${what} at line ${line}`);
  };

  // Scans code until the end, or, inside a template, until the "}" that
  // closes the current ${ expression (left unconsumed).
  function code(inTemplate) {
    let start = pos;
    let depth = 0;
    let prev = ""; // last significant token: a punctuator char, a word, or "lit"
    const flush = () => emit("code", src.slice(start, pos));
    while (pos < src.length) {
      const c = src[pos];
      const n = src[pos + 1];
      if (c === "/" && n === "/") {
        flush();
        const end = src.indexOf("\n", pos);
        const stop = end < 0 ? src.length : end;
        emit("comment", src.slice(pos, stop));
        pos = stop;
        start = pos;
      } else if (c === "/" && n === "*") {
        flush();
        const end = src.indexOf("*/", pos + 2);
        if (end < 0) fail("unterminated comment");
        emit("comment", src.slice(pos, end + 2));
        pos = end + 2;
        start = pos;
      } else if (c === '"' || c === "'") {
        flush();
        string(c);
        start = pos;
        prev = "lit";
      } else if (c === "`") {
        flush();
        template();
        start = pos;
        prev = "lit";
      } else if (c === "/" && (prev === "" || REGEX_AFTER_PUNCT.includes(prev) || REGEX_AFTER_WORD.has(prev))) {
        flush();
        regex();
        start = pos;
        prev = "lit";
      } else if (/[A-Za-z0-9_$]/.test(c)) {
        const word = /^[A-Za-z0-9_$]+/.exec(src.slice(pos, pos + 64))[0];
        pos += word.length;
        prev = word;
      } else if (/\s/.test(c)) {
        pos++;
      } else {
        if (inTemplate && c === "{") depth++;
        if (inTemplate && c === "}") {
          if (depth === 0) {
            flush();
            return;
          }
          depth--;
        }
        prev = c;
        pos++;
      }
    }
    if (inTemplate) fail("unterminated template expression");
    flush();
  }

  function string(quote) {
    const begin = pos++;
    while (pos < src.length && src[pos] !== quote) {
      if (src[pos] === "\\") pos++;
      else if (src[pos] === "\n") fail("unterminated string");
      pos++;
    }
    if (pos >= src.length) fail("unterminated string");
    pos++;
    emit("string", src.slice(begin, pos));
  }

  function template() {
    let begin = pos++;
    while (pos < src.length) {
      const c = src[pos];
      if (c === "\\") pos += 2;
      else if (c === "`") {
        pos++;
        emit("template", src.slice(begin, pos));
        return;
      } else if (c === "$" && src[pos + 1] === "{") {
        pos += 2;
        emit("template", src.slice(begin, pos));
        code(true);
        begin = pos; // the closing "}" starts the next piece
        pos++;
      } else pos++;
    }
    fail("unterminated template");
  }

  function regex() {
    const begin = pos++;
    let inClass = false;
    while (pos < src.length) {
      const c = src[pos];
      if (c === "\n") fail("unterminated regex");
      if (c === "\\") pos++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      pos++;
    }
    if (pos >= src.length) fail("unterminated regex");
    pos++;
    while (pos < src.length && /[a-z]/.test(src[pos])) pos++;
    emit("regex", src.slice(begin, pos));
  }

  code(false);
  return out;
}

/** The source without comments (block comments become one space). */
export function stripComments(src) {
  return scanJs(src)
    .map((s) => (s.type !== "comment" ? s.text : s.text.startsWith("/*") ? " " : ""))
    .join("");
}

/**
 * Code only: comments become a space and every literal (string, template
 * piece, regex) becomes "" so what is left can be grepped for identifiers.
 * Template expressions stay, since they are code.
 */
export function codeSkeleton(src) {
  return scanJs(src)
    .map((s) => (s.type === "code" ? s.text : s.type === "comment" ? " " : '""'))
    .join("");
}

/**
 * Identifiers that appear outside every (), [] and {} of a skeleton: what
 * runs, or is named, when the module is evaluated. Property names after a dot
 * are left out.
 * @param {string} skeleton  Output of codeSkeleton.
 * @returns {Set<string>}
 */
export function topLevelIdentifiers(skeleton) {
  const found = new Set();
  let depth = 0;
  // Numbers are matched first so "1e3" is not read as an identifier "e3".
  const re = /\d[\w$.]*|[A-Za-z_$][\w$]*|[()[\]{}]|\.\s*[A-Za-z_$][\w$]*/g;
  for (const m of skeleton.matchAll(re)) {
    const t = m[0];
    if (t === "(" || t === "[" || t === "{") depth++;
    else if (t === ")" || t === "]" || t === "}") depth--;
    else if (depth === 0 && !t.startsWith(".") && !/^\d/.test(t)) found.add(t);
  }
  return found;
}
