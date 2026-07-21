import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";
import { computeDead } from "../src/analysis/dead-check.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "wx-sql-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const SCHEMA = `-- users and their orders
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    legacy_fax VARCHAR(32),
    CONSTRAINT users_email_uniq UNIQUE (email)
);

CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users (id),
    total NUMERIC(12, 2)
);

CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    payload JSONB
);

CREATE VIEW active_users AS
    SELECT id, email FROM users WHERE email IS NOT NULL;

CREATE INDEX idx_orders_user ON orders (user_id);

CREATE FUNCTION touch_updated() RETURNS trigger AS 'BEGIN RETURN NEW; END' LANGUAGE plpgsql;

CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated();

ALTER TABLE users ADD COLUMN nickname TEXT;
`;

const DB_JS = `export function getUser(db, id) {
  return db.query("SELECT id, email, nickname FROM users WHERE id = $1", [id]);
}

export function addOrder(db, order) {
  return db.query("INSERT INTO orders (user_id, total) VALUES ($1, $2)", [order.userId, order.total]);
}

export function dumpAudit(db) {
  return db.query("SELECT * FROM audit_log");
}
`;

test("lang-sql: schema symbols, code→table edges, star marking, honest dead verdicts", async () => {
  const dir = repoWith({ "db/schema.sql": SCHEMA, "src/db.js": DB_JS });
  try {
    const g = await buildInternalGraph(dir);
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    for (const name of ["users", "orders", "audit_log", "active_users", "idx_orders_user", "touch_updated", "orders_touch", "email", "legacy_fax", "payload", "nickname"]) {
      assert.ok(sym(name), `symbol ${name} extracted`);
    }
    assert.equal(sym("users").symbol_kind, "table");
    assert.equal(sym("active_users").symbol_kind, "view");
    assert.equal(sym("idx_orders_user").symbol_kind, "index");
    assert.equal(sym("touch_updated").symbol_kind, "function");
    assert.equal(sym("orders_touch").symbol_kind, "trigger");
    assert.equal(sym("email").symbol_kind, "column");
    assert.equal(sym("email").member_of, "users");
    assert.equal(sym("nickname").member_of, "users", "ALTER TABLE ADD COLUMN lands on its table");
    assert.equal(sym("users").field_types.email, "TEXT");
    assert.ok(!sym("users_email_uniq"), "constraint rows are not columns");

    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const sqlEdge = (srcIncludes, tgtName) => g.links.find((l) => l.usage === "sql"
      && ep(l.source).includes(srcIncludes) && ep(l.target).includes("#" + tgtName + "@"));
    assert.ok(g.links.some((l) => l.relation === "contains" && ep(l.source).includes("#users@") && ep(l.target).includes("#email@")), "table contains its columns");
    assert.ok(sqlEdge("#active_users@", "users"), "view SELECT resolves to its base table");
    assert.ok(sqlEdge("#idx_orders_user@", "orders"), "index targets its table");
    assert.ok(sqlEdge("#orders_touch@", "touch_updated"), "trigger EXECUTE FUNCTION resolves");
    assert.ok(sqlEdge("#orders_touch@", "orders"), "trigger targets its table");
    assert.ok(sqlEdge("#getUser@", "users"), "embedded SELECT links the enclosing JS function to the table");
    assert.ok(sqlEdge("#addOrder@", "orders"), "embedded INSERT links to the table");
    assert.ok(sqlEdge("#dumpAudit@", "audit_log"), "embedded SELECT * links to the table");
    assert.equal(sym("audit_log").sql_star, true, "SELECT * consumption is marked on the table");
    assert.ok(!sym("users").sql_star, "explicit column list is not star consumption");
    assert.ok(g.links.some((l) => l.usage === "sql" && ep(l.source).includes("#users@") && ep(l.target).includes("#users@")) === false, "no self references");

    const sources = new Map([
      ["db/schema.sql", readFileSync(join(dir, "db/schema.sql"), "utf8")],
      ["src/db.js", readFileSync(join(dir, "src/db.js"), "utf8")],
    ]);
    const dead = computeDead(g, sources);
    const deadNames = dead.deadSymbols.map((s) => String(s.id).replace(/^.*#/, "").replace(/@.*$/, ""));
    assert.ok(deadNames.includes("legacy_fax"), "column never named anywhere is reported dead");
    const legacyFax = dead.deadSymbols.find((s) => String(s.id).includes("#legacy_fax@"));
    assert.equal(legacyFax.reason, "no SQL statement in the indexed sources references it");
    assert.ok(!deadNames.includes("email"), "column named in embedded SQL is alive");
    assert.ok(!deadNames.includes("payload"), "columns behind SELECT * are never judged by name");
    assert.ok(!deadNames.includes("idx_orders_user") && !deadNames.includes("orders_touch"), "indexes and triggers are DB-engine surface, never dead");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lang-sql: without literal-SQL evidence from code, schema objects are never judged", async () => {
  const dir = repoWith({
    "db/schema.sql": "CREATE TABLE orphan_tbl (\n    id BIGINT,\n    stale_col TEXT\n);\n",
    "src/app.js": "export function run() { return orm.models.OrphanTbl.findAll(); }\n",
  });
  try {
    const g = await buildInternalGraph(dir);
    const sources = new Map([
      ["db/schema.sql", readFileSync(join(dir, "db/schema.sql"), "utf8")],
      ["src/app.js", readFileSync(join(dir, "src/app.js"), "utf8")],
    ]);
    const dead = computeDead(g, sources);
    const deadIds = dead.deadSymbols.map((s) => String(s.id));
    assert.ok(!deadIds.some((id) => id.includes("#orphan_tbl@") || id.includes("#stale_col@")),
      "ORM-style repo shows no literal SQL — weavatrix cannot see DB consumers, so it stays silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
