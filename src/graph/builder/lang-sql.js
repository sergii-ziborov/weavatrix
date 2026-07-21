// SQL extractor. No SQL grammar ships in the pinned tree-sitter-wasms, so this module is textOnly:
// a dependency-free statement scanner built for the graph's needs (symbols + references), NOT a SQL
// parser. Symbols: CREATE TABLE/VIEW (+ columns as member symbols, ALTER TABLE ADD COLUMN included),
// FUNCTION/PROCEDURE, INDEX, TRIGGER. References: FROM/JOIN/INSERT INTO/UPDATE…SET/DELETE FROM/
// TRUNCATE/REFERENCES/EXECUTE FUNCTION/CALL inside .sql files, plus the same verbs found in string
// literals of every other indexed language (scanEmbeddedSql) — that is what ties the code graph to
// the database schema: a query in app code becomes a `references` edge onto the table it touches.
// Known blind spots (kept honest downstream, see dead-check.js): ORM-generated SQL is invisible,
// `SELECT *` consumes columns namelessly (tables get sql_star), DROP statements are not replayed.
// String literals and comments are blanked before structural scanning so a quoted "SELECT" can
// never fabricate a reference; dollar-quoted function bodies stay scannable on purpose.

const NAME = String.raw`((?:[\`"\[]?[A-Za-z_][\w$]*[\`"\]]?\.)*[\`"\[]?[A-Za-z_][\w$]*[\`"\]]?)`;
const cleanName = (raw) => String(raw || "").replace(/[`"\[\]]/g, "").split(".").pop();
const CONSTRAINT_START = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|KEY|INDEX|LIKE|PERIOD)\b/i;

// strings ('…' with '' doubling) and comments (-- …, /* … */) become spaces of equal length,
// so offsets/line numbers survive and quoted text can't match structural patterns.
function sanitizeSql(text) {
  const out = text.split("");
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (ch === "-" && next === "-") { let j = i; while (j < text.length && text[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (ch === "/" && next === "*") { let j = text.indexOf("*/", i + 2); j = j < 0 ? text.length : j + 2; blank(i, j); i = j; continue; }
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) { if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; } j++; }
      blank(i + 1, Math.min(j, text.length)); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

const lineIndex = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

// split a CREATE TABLE body on top-level commas, keeping each part's offset
function splitColumns(body, base) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push({ text: body.slice(start, i), offset: base + start }); start = i + 1; }
  }
  parts.push({ text: body.slice(start), offset: base + start });
  return parts;
}

const REF_PATTERNS = [
  new RegExp(String.raw`\bFROM\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bJOIN\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bINSERT\s+INTO\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bMERGE\s+INTO\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${NAME}\s+SET\b`, "gi"),
  new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bREFERENCES\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+${NAME}`, "gi"),
];
const STAR_RE = /\bSELECT\s+(?:[A-Za-z_]\w*\.)?\*/i;

export default {
  family: "sql",
  grammars: [],
  exts: { ".sql": "sql" },
  isWeb: false,
  textOnly: true,
  calls: null,
  heritage: [],

  pass1(ctx) {
    const { fileRel, code, addSym, links, sqlRefs } = ctx;
    const text = sanitizeSql(String(code || ""));
    const lineOf = lineIndex(text);
    const fakeNode = (startOffset, endOffset) => ({
      startPosition: { row: lineOf(startOffset) - 1, column: 0 },
      endPosition: { row: lineOf(Math.max(startOffset, endOffset - 1)) - 1, column: 0 },
    });

    // statements with offsets (';' inside dollar-quoted bodies splits early — refs/lines still land right)
    const statements = [];
    let cursor = 0;
    while (cursor <= text.length) {
      let end = text.indexOf(";", cursor);
      if (end < 0) end = text.length;
      if (text.slice(cursor, end).trim()) statements.push({ text: text.slice(cursor, end), offset: cursor });
      cursor = end + 1;
    }

    const addRef = (table, offset, star) => {
      const name = cleanName(table);
      if (/^[A-Za-z_][\w$]*$/.test(name)) sqlRefs.push({ file: fileRel, line: lineOf(offset), table: name, star: !!star });
    };

    for (const stmt of statements) {
      const at = (m) => stmt.offset + m.index;
      const definedHere = new Set();
      const defineSym = (raw, m, callable, extra) => {
        const name = cleanName(raw);
        definedHere.add(name);
        return addSym(name, lineOf(at(m)), callable, {
          sourceNode: fakeNode(at(m), stmt.offset + stmt.text.length),
          exported: true, moduleDeclaration: true, ...extra,
        });
      };

      let m;
      if ((m = stmt.text.match(new RegExp(String.raw`\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s*\(`, "i")))) {
        const tableName = cleanName(m[1]);
        const open = stmt.offset + m.index + m[0].length - 1;
        let depth = 0, close = open;
        for (let i = open; i < text.length; i++) { if (text[i] === "(") depth++; else if (text[i] === ")" && --depth === 0) { close = i; break; } }
        const fieldTypes = {};
        const columns = [];
        for (const part of splitColumns(text.slice(open + 1, close), open + 1)) {
          const trimmed = part.text.trim();
          if (!trimmed || CONSTRAINT_START.test(trimmed)) continue;
          const col = trimmed.match(new RegExp(String.raw`^${NAME}\s+([A-Za-z_]\w*(?:\([^)]*\))?)`));
          if (!col) continue;
          const colName = cleanName(col[1]);
          if (!/^[A-Za-z_][\w$]*$/.test(colName)) continue;
          fieldTypes[colName] = col[2];
          columns.push({ name: colName, offset: part.offset + part.text.indexOf(col[1]) });
        }
        const tableId = defineSym(m[1], m, false, { symbolKind: "table", fieldTypes });
        for (const column of columns) {
          const columnId = addSym(column.name, lineOf(column.offset), false, {
            sourceNode: fakeNode(column.offset, column.offset + 1),
            symbolKind: "column", memberOf: tableName,
          });
          if (tableId && columnId) links.push({ source: tableId, target: columnId, relation: "contains", confidence: "EXTRACTED" });
        }
      } else if ((m = stmt.text.match(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, "i")))) {
        defineSym(m[1], m, false, { symbolKind: "view" });
      } else if ((m = stmt.text.match(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+${NAME}`, "i")))) {
        defineSym(m[1], m, true, { symbolKind: "function" });
      } else if ((m = stmt.text.match(new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s+ON\s+(?:ONLY\s+)?${NAME}`, "i")))) {
        defineSym(m[1], m, false, { symbolKind: "index" });
        addRef(m[2], at(m), false);
      } else if ((m = stmt.text.match(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${NAME}[\s\S]*?\bON\s+${NAME}`, "i")))) {
        defineSym(m[1], m, false, { symbolKind: "trigger" });
        addRef(m[2], at(m), false);
      } else if ((m = stmt.text.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}`, "i")))) {
        const tableName = cleanName(m[1]);
        addRef(m[1], at(m), false);
        const addColumn = new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|PRIMARY\b|FOREIGN\b|UNIQUE\b|CHECK\b|EXCLUDE\b)${NAME}\s+[A-Za-z_]`, "gi");
        for (const colMatch of stmt.text.matchAll(addColumn)) {
          const colName = cleanName(colMatch[1]);
          if (!/^[A-Za-z_][\w$]*$/.test(colName)) continue;
          addSym(colName, lineOf(stmt.offset + colMatch.index), false, {
            sourceNode: fakeNode(stmt.offset + colMatch.index, stmt.offset + colMatch.index + 1),
            symbolKind: "column", memberOf: tableName,
          });
        }
      }

      const star = STAR_RE.test(stmt.text);
      for (const pattern of REF_PATTERNS) {
        pattern.lastIndex = 0;
        for (const refMatch of stmt.text.matchAll(pattern)) {
          const name = cleanName(refMatch[1]);
          if (!definedHere.has(name)) addRef(refMatch[1], stmt.offset + refMatch.index, star);
        }
      }
    }
  },
};

// SQL verbs inside string literals of any host language — the cross-link between app code and schema.
// Runs on RAW text (strings are exactly where the queries live); comments can over-match, which only
// errs toward "referenced" and carries INFERRED confidence.
const EMBEDDED = [
  { re: new RegExp(String.raw`\bSELECT\b[^;]{0,2000}?\bFROM\s+${NAME}`, "gi"), star: true },
  { re: new RegExp(String.raw`\bINSERT\s+INTO\s+${NAME}`, "gi") },
  { re: new RegExp(String.raw`\bUPDATE\s+${NAME}\s+SET\b`, "gi") },
  { re: new RegExp(String.raw`\bDELETE\s+FROM\s+${NAME}`, "gi") },
  { re: new RegExp(String.raw`\bJOIN\s+${NAME}\b`, "gi") },
  { re: new RegExp(String.raw`\bCALL\s+${NAME}\s*\(`, "gi") },
];
const EMBEDDED_PREFILTER = /\b(?:select|insert|update|delete|join|call)\b/i;

export function scanEmbeddedSql(code, fileRel, sqlRefs) {
  const text = String(code || "");
  if (!EMBEDDED_PREFILTER.test(text)) return;
  const lineOf = lineIndex(text);
  for (const { re, star } of EMBEDDED) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = cleanName(m[1]);
      if (!/^[A-Za-z_][\w$]*$/.test(name)) continue;
      sqlRefs.push({ file: fileRel, line: lineOf(m.index), table: name, star: !!(star && STAR_RE.test(m[0])) });
    }
  }
}

// Dead-code policy for SQL schema objects, consumed by analysis/dead-check.js. Static liveness can
// only be judged where the repo demonstrably uses literal SQL the scanner can read: without a single
// embedded-SQL edge from host code, DB consumers (ORMs, external services) are invisible and every
// verdict would be a guess. Indexes and triggers are DB-engine surface — never judged. Columns of a
// `SELECT *`-consumed table are consumed namelessly — never judged by name.
export function createSqlDeadVerdict({ nodes, links, ep, bareName }) {
  const usageFromCode = links.some((l) => l.usage === "sql" && !String(ep(l.source)).split("#")[0].endsWith(".sql"));
  const starTables = new Set(nodes.filter((n) => n.sql_star).map((n) => bareName(n.label)));
  const classify = (n) => {
    if (!String(n.source_file || "").endsWith(".sql")) return null;
    const kind = String(n.symbol_kind || "");
    if (kind === "index" || kind === "trigger" || !usageFromCode) return "veto";
    if (kind === "column" && starTables.has(String(n.member_of || ""))) return "veto";
    return "flag";
  };
  return {
    veto: (n) => classify(n) === "veto",
    reason: (n) => (classify(n) === "flag" ? "no SQL statement in the indexed sources references it" : null),
  };
}

// After both passes: resolve collected refs against every table/view/function DEFINED in .sql files.
// Unknown names drop silently — only schema objects the repo actually declares can gain edges.
export function resolveSqlReferences({ sqlRefs, links, nodeById, perFileSymbols }) {
  if (!sqlRefs?.length) return;
  const index = new Map();
  for (const [file, syms] of perFileSymbols) {
    if (!file.endsWith(".sql")) continue;
    for (const sym of syms) {
      if (!["table", "view", "function"].includes(sym.symbolKind)) continue;
      (index.get(sym.name) || index.set(sym.name, []).get(sym.name)).push(sym.id);
    }
  }
  if (!index.size) return;
  const enclosing = (file, line) => {
    let best = null;
    for (const symbol of perFileSymbols.get(file) || []) {
      if (line < symbol.start || line > symbol.end) continue;
      if (!best || symbol.start > best.start || (symbol.start === best.start && symbol.end < best.end)) best = symbol;
    }
    return best;
  };
  const seen = new Set();
  for (const ref of sqlRefs) {
    const targets = index.get(ref.table);
    if (!targets) continue;
    const source = enclosing(ref.file, ref.line)?.id || ref.file;
    for (const target of targets) {
      if (ref.star) { const node = nodeById.get(target); if (node) node.sql_star = true; }
      if (target === source) continue;
      const key = source + ">" + target;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source, target, relation: "references", confidence: "INFERRED", usage: "sql", line: ref.line });
    }
  }
}
