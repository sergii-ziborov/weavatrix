// duplicates.tokenize.js — lexical layer of the clone detector (split from duplicates.js): comment &
// string stripping, body-end detection, strict/renamed tokenization, and winnowing fingerprints.

const K = 8;               // k-gram length (tokens)
const W = 4;               // winnowing window → guaranteed detection of matches ≥ K+W-1 tokens
const STRLIT = String.fromCharCode(0); // opaque-literal sentinel for every string/regex body: a NUL
                           // its own class (never an identifier "I" nor a number "N"), so a literal can
                           // never masquerade as code in either mode

const KEYWORDS = new Set(("if else for while do switch case break continue return function const let var new class extends async await try catch finally throw import from export default typeof instanceof in of delete void yield static get set this super null undefined true false def elif except lambda pass raise with as is not and or None True False func go defer chan map range struct interface type package nil err string int bool byte float64 public private protected final void long double boolean").split(" "));

// A leading `/` is a REGEX literal (not division) when the previous significant char is one of these
// or the fragment start; after a word char / ) / ] it is division. Covers .match(/…/), = /…/, (/…/),
// and arrow `x => /…/`. NOTE: `+` and `-` are deliberately EXCLUDED — a regex never legitimately
// follows them, but `i++ / 2` and `a - b / c` do, and including them mis-scanned the division as a
// regex and ate the rest of the line.
const REGEX_PREV = new Set("(,=:[!&|?{};~*%^<>".split(""));

// Replace comments with nothing and string/regex BODIES with the sentinel, so their contents never
// count as code. Handles Python triple-quoted docstrings (embedded quotes no longer desync the scan)
// and JS regex literals (a quote inside /['"]/ no longer opens a phantom string).
export function stripNonCode(text, py) {
  let out = "", i = 0, prevSig = "";
  const s = String(text || "");
  const push = (c) => { out += c; const t = c.trim(); if (t) prevSig = t[t.length - 1]; };
  while (i < s.length) {
    const ch = s[i], two = s.slice(i, i + 2), three = s.slice(i, i + 3);
    if (py && ch === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (py && (three === "'''" || three === '"""')) {
      i += 3;
      while (i < s.length && s.slice(i, i + 3) !== three) i++;
      i += 3; push(` ${STRLIT} `); continue;
    }
    if (!py && two === "//") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (!py && two === "/*") { i += 2; while (i < s.length && s.slice(i, i + 2) !== "*/") i++; i += 2; continue; }
    if (!py && ch === "/" && REGEX_PREV.has(prevSig)) {
      i++; let inClass = false; // '/' inside a [...] char class is literal, not the terminator
      while (i < s.length && s[i] !== "\n") {
        const c = s[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { i++; break; }
        i++;
      }
      while (i < s.length && /[a-z]/i.test(s[i])) i++; // regex flags (gimsuy)
      push(` ${STRLIT} `); continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      i++; push(` ${STRLIT} `); continue;
    }
    push(ch); i++;
  }
  return out;
}

// Where a symbol's body ends — so the LAST symbol in a file doesn't swallow trailing module-level code
// (module.exports tables, main() calls, handler registrations) up to EOF and dilute/misattribute
// clones. Brace/bracket depth for brace langs (body ends when {}()[] balance after first opening);
// indentation for Python. Returns a 1-based line count within bodyLines (≤ its length; = its length
// when the construct never closes, so the caller's cap stands).
export function bodyEndLineCount(bodyLines, py) {
  if (py) {
    const base = bodyLines[0].match(/^[ \t]*/)[0].length;
    let last = 1;
    for (let k = 1; k < bodyLines.length; k++) {
      const ln = bodyLines[k];
      if (!ln.trim()) continue; // blank lines never end a block
      if (ln.match(/^[ \t]*/)[0].length <= base) return last; // dedent to ≤ the def → body ended above
      last = k + 1;
    }
    return bodyLines.length;
  }
  const text = bodyLines.join("\n");
  let depth = 0, opened = false, i = 0, line = 1, prevSig = "";
  while (i < text.length) {
    const ch = text[i], two = text.slice(i, i + 2);
    if (ch === "\n") { line++; i++; continue; }
    if (two === "//") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (two === "/*") { i += 2; while (i < text.length && text.slice(i, i + 2) !== "*/") { if (text[i] === "\n") line++; i++; } i += 2; continue; }
    if (ch === "/" && REGEX_PREV.has(prevSig)) {
      i++; let inClass = false;
      while (i < text.length && text[i] !== "\n") { const c = text[i]; if (c === "\\") { i += 2; continue; } if (c === "[") inClass = true; else if (c === "]") inClass = false; else if (c === "/" && !inClass) { i++; break; } i++; }
      prevSig = "/"; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { const q = ch; i++; while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; else if (text[i] === "\n") line++; i++; } i++; prevSig = q; continue; }
    // depth tracks all brackets, but only a { or [ opens the BODY — a bare (param list) returning to
    // depth 0 must not be read as the construct closing on line 1
    if (ch === "{" || ch === "(" || ch === "[") { depth++; if (ch === "{" || ch === "[") opened = true; }
    else if (ch === "}" || ch === ")" || ch === "]") { depth--; if (opened && depth <= 0) return line; }
    if (ch.trim()) prevSig = ch;
    i++;
  }
  return bodyLines.length;
}

// Large multi-line string literals — the OPPOSITE selection to stripNonCode: everything the code
// scan throws away. Embedded DSLs (inline C#/SQL/PowerShell templates) are invisible to the normal
// clone pass because their bodies are stripped; this extractor feeds them back in as their own
// fragments when the caller opts in (find_duplicates include_strings). Comment/regex handling
// mirrors stripNonCode so a quote inside a comment never opens a phantom literal.
export function extractLargeStrings(text, { py = false, cs = false, minLines = 6 } = {}) {
  const s = String(text || "");
  const out = [];
  let i = 0, line = 1, prevSig = "";
  const capture = (from, to, startLine) => {
    const content = s.slice(from, to);
    const nl = (content.match(/\n/g) || []).length;
    if (nl + 1 >= minLines) out.push({ start: startLine, end: startLine + nl, content });
  };
  while (i < s.length) {
    const ch = s[i], two = s.slice(i, i + 2), three = s.slice(i, i + 3);
    if (ch === "\n") { line++; i++; continue; }
    if (py && ch === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (py && (three === "'''" || three === '"""')) {
      const startLine = line; i += 3; const from = i;
      while (i < s.length && s.slice(i, i + 3) !== three) { if (s[i] === "\n") line++; i++; }
      capture(from, i, startLine); i += 3; continue;
    }
    if (!py && two === "//") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (!py && two === "/*") { i += 2; while (i < s.length && s.slice(i, i + 2) !== "*/") { if (s[i] === "\n") line++; i++; } i += 2; continue; }
    if (!py && ch === "/" && REGEX_PREV.has(prevSig)) {
      i++; let inClass = false;
      while (i < s.length && s[i] !== "\n") { const c = s[i]; if (c === "\\") { i += 2; continue; } if (c === "[") inClass = true; else if (c === "]") inClass = false; else if (c === "/" && !inClass) { i++; break; } i++; }
      prevSig = "/"; continue;
    }
    if (cs && two === '@"') { // C# verbatim string; "" is the escaped quote
      const startLine = line; i += 2; const from = i;
      while (i < s.length) { if (s.slice(i, i + 2) === '""') { i += 2; continue; } if (s[i] === '"') break; if (s[i] === "\n") line++; i++; }
      capture(from, i, startLine); i++; continue;
    }
    if (!py && ch === "`") { // JS/TS template literal — the main multi-line carrier
      const startLine = line; i++; const from = i;
      while (i < s.length && s[i] !== "`") { if (s[i] === "\\") { i++; if (s[i] === "\n") line++; i++; continue; } if (s[i] === "\n") line++; i++; }
      capture(from, i, startLine); i++; continue;
    }
    if (ch === '"' || ch === "'") { // single-line strings can't span minLines — just skip past
      const q = ch; i++;
      while (i < s.length && s[i] !== q && s[i] !== "\n") { if (s[i] === "\\") i++; i++; }
      if (s[i] === q) i++; continue;
    }
    if (ch.trim()) prevSig = ch;
    i++;
  }
  return out;
}

// one raw token stream; the two modes differ only in identifier canonicalization
export function tokenize(text) {
  const raw = text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) || [];
  const strict = [];
  const renamed = [];
  for (const t of raw) {
    if (/^\d/.test(t)) { strict.push("N"); renamed.push("N"); continue; }
    if (/^[A-Za-z_$]/.test(t) && !KEYWORDS.has(t)) { strict.push(t); renamed.push("I"); continue; }
    strict.push(t); renamed.push(t);
  }
  return { strict, renamed };
}

export function fingerprints(toks) {
  if (toks.length < K + W - 1) return new Set();
  const hashes = [];
  for (let i = 0; i + K <= toks.length; i++) {
    let h = 0;
    for (let j = i; j < i + K; j++) {
      const s = toks[j];
      for (let c = 0; c < s.length; c++) h = (h * 31 + s.charCodeAt(c)) | 0;
      h = (h * 131) | 0;
    }
    hashes.push(h >>> 0);
  }
  const fp = new Set();
  for (let i = 0; i + W <= hashes.length + 1; i++) {
    let min = Infinity;
    for (let j = i; j < Math.min(i + W, hashes.length); j++) if (hashes[j] < min) min = hashes[j];
    fp.add(min);
  }
  return fp;
}
