// infra-items.js — extract concrete infra items (DB tables, cache keysets, queue topics, cloud files, SQL
// tables, env-declared endpoints) from source text for the detected services. Split out of infra.js; it owns
// the shared leaf helpers (lc/safeRead/size caps) as the lower module — infra.js imports them back.
import { safeRead, MAX_FILE_BYTES } from "../util.js";

const IMPORT_SCAN_MAX_FILES = 2000; // cap the synchronous import-scan pass (connector attribution only) so the
const lc = (s) => String(s || "").toLowerCase();

export { safeRead };

const ITEM_META = {
  db: { label: "TABLES", unit: "rows" },
  ts: { label: "SERIES", unit: "pts" },
  cache: { label: "KEYSETS", unit: "keys" },
  queue: { label: "TOPICS", unit: "msg/s" },
  cloud: { label: "FILES", unit: "KB" },
  fs: { label: "FILES", unit: "KB" },
  logs: { label: "STREAMS", unit: "l/s" },
  api: { label: "ENDPOINTS", unit: "req/s" },
};
const ITEM_VALUE = { db: 42, ts: 120, cache: 700, queue: 22, cloud: 120, fs: 80, logs: 55, api: 24 };
const SQL_RESERVED = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "full", "cross",
  "on", "and", "or", "by", "group", "order", "limit", "offset", "as", "with", "values",
  "set", "returning", "true", "false", "null", "undefined", "if", "case", "when", "then",
  "else", "end", "having", "over", "partition", "distinct", "the", "is",
  "count", "sum", "avg", "min", "max", "uniq", "array", "date", "datetime", "string", "number",
]);

export function itemMetaFor(service) {
  if (service.id === "mongodb") return { label: "COLLECTIONS", unit: "docs" };
  if (service.id === "dynamodb") return { label: "TABLES", unit: "items" };
  if (service.id === "elasticsearch" || service.id === "solr" || service.id === "meilisearch" || service.id === "typesense") {
    return { label: "INDEXES", unit: "docs" };
  }
  return ITEM_META[service.kind] || { label: "ITEMS", unit: "" };
}

function cleanInfraItemName(raw) {
  const name = String(raw || "").trim().replace(/^(?:["'`]|\[)+|(?:["'`]|])+$/g, "").replace(/[;,]+$/g, "").trim();
  if (!name || name.length < 2 || name.length > 64) return "";
  if (name.includes("://") || name.includes("${") || name.includes("#{")) return "";
  if (/[\s(){}+$]/.test(name)) return "";
  if (!/^[A-Za-z0-9_./:\-*]+$/.test(name)) return "";
  if (/^\d+$/.test(name) || SQL_RESERVED.has(name.toLowerCase())) return "";
  return name;
}

function addInfraItem(map, raw, weight = 1, sourcePath = "", op = "") {
  const name = cleanInfraItemName(raw);
  if (!name) return;
  const cur = map.get(name) || { name, refs: 0, files: new Set(), ops: new Set() };
  cur.refs += Math.max(1, weight);
  if (sourcePath) cur.files.add(sourcePath);
  if (op) cur.ops.add(op);
  map.set(name, cur);
}

// One regex-walk adder factory shared by the two matchers below — the only difference is how a
// captured group becomes items (a single name vs a string-array body).
const matchAdder = (add) => (map, text, re, group = 1, weight = 1, sourcePath = "", op = "") => {
  for (const m of text.matchAll(re)) add(map, m[group], weight, sourcePath, op);
};

function addStringArrayItems(map, raw, weight = 1, sourcePath = "", op = "") {
  const body = String(raw || "");
  for (const m of body.matchAll(/["'`]([^"'`]+)["'`]/g)) addInfraItem(map, m[1], weight, sourcePath, op);
}

const addMatches = matchAdder(addInfraItem);
const addStructArrayMatches = matchAdder(addStringArrayItems);

function addSqlTableMatches(map, text, re, cteAliases, group = 1, weight = 1, sourcePath = "", op = "") {
  for (const m of String(text || "").matchAll(re)) {
    const name = String(m[group] || "");
    if (cteAliases.has(name.toLowerCase())) continue;
    addInfraItem(map, name, weight, sourcePath, op);
  }
}

function looksLikeSqlSnippet(raw) {
  const text = String(raw || "").replace(/\$\{[\s\S]*?\}/g, " ");
  if (!/[A-Za-z]/.test(text)) return false;
  const statementStart = "(?:^|[\\r\\n;])\\s*";
  return (
    new RegExp(`${statementStart}(?:select|with)\\b[\\s\\S]{0,600}\\bfrom\\b`, "i").test(text) ||
    new RegExp(`${statementStart}(?:insert\\s+into|delete\\s+from|alter\\s+table|create\\s+(?:or\\s+replace\\s+)?table|truncate\\s+table|update\\s+["'\`\\[]?[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)?["'\`\\]]?\\s+set)\\b`, "i").test(text)
  );
}

function stringLiteralBody(match) {
  for (let i = 1; i < match.length; i++) if (match[i] != null) return match[i];
  return "";
}

function extractSqlSnippets(text) {
  const out = [];
  const src = String(text || "");
  const add = (body) => {
    const snippet = String(body || "");
    if (looksLikeSqlSnippet(snippet)) out.push(snippet);
  };

  for (const match of src.matchAll(/"""([\s\S]*?)"""|'''([\s\S]*?)'''/g)) add(stringLiteralBody(match));
  for (const match of src.matchAll(/`([\s\S]*?)`|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)) add(stringLiteralBody(match));
  return out.join("\n");
}

function sqlCteAliases(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(/(?:\bwith|,)\s+([A-Za-z_][\w$]*)\s+as\s*\(/gi)) {
    out.add(String(match[1] || "").toLowerCase());
  }
  return out;
}

function hasServiceHint(service, text) {
  const lower = lc(text);
  const tokens = [service.id, service.name, ...(service.imports || []), ...(service.deps || [])]
    .map((x) => lc(x))
    .filter((x) => x && x.length > 2);
  return tokens.some((token) => lower.includes(token));
}

function finalizeInfraItems(map, kind) {
  const base = ITEM_VALUE[kind] || 40;
  return [...map.values()]
    .sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name))
    .slice(0, 24)
    .map((item) => ({
      name: item.name,
      val: Math.round(Math.max(4, base * (1 + Math.log2(item.refs + 1) * 0.55))),
      health: Math.max(0.42, Math.min(0.96, 0.94 - Math.log2(item.refs + 1) * 0.08)),
      refs: item.refs,
      fileCount: item.files ? item.files.size : 0,
      files: item.files ? [...item.files].sort().slice(0, 12) : [],
      ops: item.ops ? [...item.ops].sort().slice(0, 12) : [],
    }));
}

function extractInfraItemsForService(service, text, out, sourcePath = "") {
  const id = service.id;
  const kind = service.kind;
  const hit = (re, group = 1, weight = 1, op = "") => addMatches(out, text, re, group, weight, sourcePath, op);
  const hitSql = (target, re, cteAliases, group = 1, weight = 1, op = "") => addSqlTableMatches(out, target, re, cteAliases, group, weight, sourcePath, op);
  const hitArrays = (re, group = 1, weight = 1, op = "") => addStructArrayMatches(out, text, re, group, weight, sourcePath, op);
  // Go/CLI services often carry their topics/keyspaces as FLAG DEFAULTS, not literals at the call
  // site (bgp-speaker: flag.String("bgp_update_kafka_topic", "bgp_updates", …), flag.String(
  // "redis_key_base", "bgp:mitigators", …)) — the flag NAME says what the default VALUE is.
  const hitFlagDefaults = (nameRe, weight = 2, op = "configured") => {
    for (const m of text.matchAll(/\b(?:flag|pflag)\.String(?:Var)?\s*\(\s*(?:&[\w.]+\s*,\s*)?"([^"]+)"\s*,\s*"([^"]+)"/g)) {
      if (nameRe.test(m[1])) addInfraItem(out, m[2], weight, sourcePath, op);
    }
    for (const m of text.matchAll(/\badd_argument\s*\(\s*["']--?([^"']+)["'][^)]{0,200}?\bdefault\s*=\s*["']([^"']+)["']/g)) {
      if (nameRe.test(m[1])) addInfraItem(out, m[2], weight, sourcePath, op);
    }
  };

  if (id === "mongodb") {
    hit(/\.collection\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi, 1, 2);
    hit(/\.Collection\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, 1, 2);
    hit(/\bgetCollection\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi, 1, 2);
    hit(/\bcollection\s*:\s*["'`]([^"'`]+)["'`]/gi);
    hit(/\b(?:mongoose\.)?model\s*\(\s*["'`]([^"'`]+)["'`]/gi);
    hit(/\bdb\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/gi);
    return;
  }

  if (id === "dynamodb") {
    hit(/\bTableName\s*:\s*["'`]([^"'`]+)["'`]/g, 1, 2);
    hit(/\btableName\s*[:=]\s*["'`]([^"'`]+)["'`]/g, 1, 2);
  }

  if (id === "elasticsearch" || id === "solr" || id === "meilisearch" || id === "typesense") {
    hit(/\bindex(?:Name)?\s*[:=]\s*["'`]([^"'`]+)["'`]/gi, 1, 2);
    hit(/\.index\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi, 1, 2);
  }

  if (kind === "db" || kind === "ts") {
    const sqlText = extractSqlSnippets(text);
    if (sqlText) {
      const cteAliases = sqlCteAliases(sqlText);
      hitSql(sqlText, /\b(?:insert\s+into|delete\s+from|alter\s+table|create\s+(?:or\s+replace\s+)?table|truncate\s+table)\s+(?:["'`]|\[)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:["'`]|])?/gi, cteAliases, 1, 2);
      hitSql(sqlText, /\b(?:from|join|into|update|table)\s+(?:["'`]|\[)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:["'`]|])?/gi, cteAliases);
    }
    if (id !== "clickhouse" && hasServiceHint(service, text)) {
      hit(/\b(?:table|tableName|measurement|bucket)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi);
    }
  }

  if (kind === "cache") {
    hit(/\b(?:get|getBuffer|getdel|exists|ttl|pttl)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 1, "read");
    hit(/\b(?:set|setex|psetex|setnx|incr|decr|expire|persist)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 2, "write");
    hit(/\b(?:del|delete|unlink|expireat|pexpireat)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 2, "delete");
    hit(/\b(?:hget|hmget|hgetall|hexists)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 1, "hash read");
    hit(/\b(?:hset|hmset|hdel)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 2, "hash write");
    hit(/\b(?:lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 2, "collection");
    hit(/\b(?:xadd|xread|xreadgroup|xgroup)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 2, "stream");
    hit(/\b(?:publish|subscribe|psubscribe)\s*\(\s*(?:ctx\s*,\s*)?["'`]([^"'`]+)["'`]/gi, 1, 1, "pub/sub");
    hit(/\b(?:cacheKey|redisKey|valkeyKey|redisPrefix|valkeyPrefix|keyPrefix|lockKey|rateLimitKey|sessionKey)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi, 1, 2, "key pattern");
    hitArrays(/\b(?:Streams|streams)\s*:\s*\[\]string\s*\{([^}]+)\}/g, 1, 2, "stream");
    hitFlagDefaults(/key|keyspace|prefix/i, 2, "key pattern");
  }

  if (kind === "queue") {
    hit(/\b(?:topic|topics|queue|subject|stream|channel|Topic|Queue|Subject|Stream|Channel)\s*[:=]\s*["'`]([^"'`]+)["'`]/g, 1, 2, "configured");
    hit(/\b(?:publish|produce|send|sendMessage|writeMessage|writeMessages|emit)\s*\(\s*["'`]([^"'`]+)["'`]/gi, 1, 2, "produce");
    hit(/\b(?:subscribe|consume|consumer|listen|readMessage|readMessages)\s*\(\s*["'`]([^"'`]+)["'`]/gi, 1, 1, "consume");
    hit(/\b(?:producer\.send|sendBatch)\s*\(\s*\{[\s\S]{0,500}?\btopic\s*:\s*["'`]([^"'`]+)["'`]/gi, 1, 2, "produce");
    hit(/\bconsumer\.subscribe\s*\(\s*\{[\s\S]{0,320}?\btopic\s*:\s*["'`]([^"'`]+)["'`]/gi, 1, 2, "consume");
    hit(/\b(?:KafkaConsumer|NewConsumer|NewReader|NewWriter|NewTopic)\s*\(\s*["'`]([^"'`]+)["'`]/g, 1, 2, "configured");
    hit(/@KafkaListener\s*\([^)]*\btopics?\s*=\s*["'`]([^"'`]+)["'`]/g, 1, 2, "consume");
    hit(/\bkafkaTemplate\.send\s*\(\s*["'`]([^"'`]+)["'`]/g, 1, 2, "produce");
    hitArrays(/\b(?:topics|Topics|GroupTopics|SubscribeTopics|streams|Streams)\s*[:=]\s*(?:\[\]string)?\s*\{([^}]+)\}/g, 1, 2, "configured");
    hitArrays(/\b(?:subscribe|Consume|SubscribeTopics)\s*\(\s*(?:ctx\s*,\s*)?\[\]string\s*\{([^}]+)\}/g, 1, 2, "consume");
    hitFlagDefaults(/topic|queue|subject|stream|channel/i, 2, "configured");
  }

  if (kind === "cloud" || kind === "fs") {
    hit(/\b(?:bucket|bucketName|container|containerName)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi, 1, 2);
  }
}

export function collectInfraItems(scan, entries, filesByService) {
  const result = new Map();
  const allFiles = (scan.codeFiles || []).slice(0, IMPORT_SCAN_MAX_FILES);
  const textCache = new Map();
  const readText = (f) => {
    if (!f || !f.full) return "";
    if (!textCache.has(f.full)) textCache.set(f.full, safeRead(f.full));
    return textCache.get(f.full);
  };

  for (const { service } of entries) {
    const meta = itemMetaFor(service);
    const wanted = filesByService.get(service.id);
    const preferred = wanted && wanted.size ? allFiles.filter((f) => wanted.has(f.path)) : [];
    const candidateFiles = preferred.length ? [...preferred, ...allFiles.filter((f) => !wanted.has(f.path))] : allFiles;
    const itemMap = new Map();
    for (const f of candidateFiles) {
      const text = readText(f);
      if (!text) continue;
      extractInfraItemsForService(service, text, itemMap, f.path);
    }
    result.set(service.id, {
      itemLabel: meta.label,
      unit: meta.unit,
      items: finalizeInfraItems(itemMap, service.kind),
    });
  }
  return result;
}


export { MAX_FILE_BYTES, IMPORT_SCAN_MAX_FILES, lc };
