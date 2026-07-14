import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  depMatches, normImageRepo, imageMatches, envMatches, depsFromManifest, detectInfraFromScan,
} from "../src/infra/infra.js";

// ---- depMatches: exact + separator-prefix (scoped npm, versioned go, maven coords) --------------
test("depMatches: exact name, scoped npm, versioned go path, maven coord", () => {
  assert.equal(depMatches("mongoose", "mongoose"), true);
  assert.equal(depMatches("@clickhouse/client", "@clickhouse/client"), true);
  assert.equal(depMatches("github.com/ClickHouse/clickhouse-go/v2", "github.com/ClickHouse/clickhouse-go"), true); // go path + /v2
  assert.equal(depMatches("org.apache.kafka:kafka-clients", "org.apache.kafka:kafka-clients"), true);
});

test("depMatches: does NOT match unrelated longer names (pg ≠ pg-promise)", () => {
  assert.equal(depMatches("pg-promise", "pg"), false); // pg-promise is its own registry token
  assert.equal(depMatches("postgresql-client", "postgres"), false);
});

// ---- image matching: path-segment suffix -------------------------------------------------------
test("normImageRepo strips tag/digest but keeps host:port-free repo path", () => {
  assert.equal(normImageRepo("clickhouse/clickhouse-server:23.8"), "clickhouse/clickhouse-server");
  assert.equal(normImageRepo("redis:7-alpine"), "redis");
  assert.equal(normImageRepo("mongo@sha256:abc"), "mongo");
  assert.equal(normImageRepo("my.registry:5000/team/app:1.2"), "my.registry:5000/team/app");
});

test("imageMatches: token matches as a trailing path segment, not a substring", () => {
  assert.equal(imageMatches(["bitnami", "redis"], "redis"), true);
  assert.equal(imageMatches(["redis"], "redis"), true);
  assert.equal(imageMatches(["confluentinc", "cp-kafka"], "confluentinc/cp-kafka"), true);
  assert.equal(imageMatches(["mongo-express"], "mongo"), false); // admin UI ≠ the mongo DB
});

// ---- env matching: strong prefixes fire, generic prefixes need an infra suffix ------------------
test("envMatches: specific prefix fires on prefixed key", () => {
  assert.equal(envMatches("MONGO_HOST", "MONGO", false), true);
  assert.equal(envMatches("INFLUX_DB_HOST", "INFLUX", false), true);
  assert.equal(envMatches("KAFKA_BOOTSTRAP_SERVERS", "KAFKA", false), true);
  assert.equal(envMatches("INFLUXION_RATE", "INFLUX", false), false); // underscore boundary protects
});

test("envMatches: generic/weak prefix only counts with an infra suffix", () => {
  assert.equal(envMatches("PG", "PG", true), false); // bare prefix proves nothing
  assert.equal(envMatches("PG_HOST", "PG", true), true);
  assert.equal(envMatches("PGADMIN_THEME", "PG", true), false); // _ADMIN... isn't an infra suffix
  assert.equal(envMatches("DATABASE_URL", "DATABASE", true), true);
});

// ---- manifest parsing: prod deps only; dev-only test clients excluded ---------------------------
test("depsFromManifest(package.json): prod/peer/optional deps only — dev clients excluded", () => {
  const pkg = JSON.stringify({
    dependencies: { mongoose: "^9", ioredis: "^5", "@clickhouse/client": "^1" },
    devDependencies: { "ioredis-mock": "^8", "mongodb-memory-server": "^11", jest: "^30" },
  });
  const deps = depsFromManifest("package.json", pkg);
  assert.ok(deps.has("mongoose") && deps.has("ioredis") && deps.has("@clickhouse/client"));
  assert.ok(!deps.has("ioredis-mock"), "dev-only mock must not be detected");
  assert.ok(!deps.has("mongodb-memory-server"), "dev-only memory server must not be detected");
});

test("depsFromManifest(go.mod): extracts versioned module paths", () => {
  const gomod = "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/redis/go-redis/v9 v9.5.0\n\tgo.mongodb.org/mongo-driver v1.14.0\n)\n";
  const deps = depsFromManifest("go.mod", gomod);
  assert.ok(deps.has("github.com/redis/go-redis/v9"));
  assert.ok(deps.has("go.mongodb.org/mongo-driver"));
});

// ---- end-to-end over a synthetic scan: confidence + the controller-rest-api shape ---------------
function scanFrom({ deps = [], images = [], envKeys = [], codeFiles = [] }) {
  return {
    deps: new Set(deps),
    imageSegs: images.map((r) => ({ raw: r, segs: r.split("/") })),
    envKeys: new Set(envKeys.map((k) => k.toUpperCase())),
    codeFiles,
  };
}

test("detectInfraFromScan: manifest dep ⇒ high confidence; env-only ⇒ medium", () => {
  const reg = [
    { id: "mongodb", name: "MONGO", kind: "db", color: 1, deps: ["mongoose"], imports: [], images: ["mongo"], envPrefixes: ["MONGO"], envWeak: [] },
    { id: "redis", name: "REDIS", kind: "cache", color: 2, deps: ["ioredis"], imports: [], images: ["redis"], envPrefixes: ["REDIS"], envWeak: [] },
  ];
  const out = detectInfraFromScan(scanFrom({ deps: ["mongoose"], envKeys: ["REDIS_HOST"] }), reg);
  const mongo = out.find((s) => s.id === "mongodb");
  const redis = out.find((s) => s.id === "redis");
  assert.equal(mongo.confidence, "high"); // manifest dep
  assert.equal(redis.confidence, "medium"); // env only
  assert.ok(mongo.signals.includes("dep:mongoose"));
  assert.ok(redis.signals.includes("env:REDIS_HOST"));
});

test("detectInfraFromScan: ground truth — controller-rest-api surfaces all five datastores", () => {
  // the real registry shipped in infra-registry.js
  const scan = scanFrom({
    deps: ["@clickhouse/client", "influx", "ioredis", "kafkajs", "mongoose", "@keycloak/keycloak-admin-client"],
    images: ["influxdb"],
    envKeys: ["MONGO_HOST", "REDIS_HOST", "KAFKA_BOOTSTRAP_SERVERS", "INFLUXDB_URL", "INFLUX_DB_HOST"],
  });
  const ids = new Set(detectInfraFromScan(scan).map((s) => s.id)); // uses default INFRA_SERVICES
  for (const id of ["clickhouse", "influxdb", "mongodb", "redis", "kafka", "keycloak"]) {
    assert.ok(ids.has(id), `expected to detect ${id}`);
  }
});

test("detectInfraFromScan: MongoDB surfaces collections/models as tower items", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-infra-"));
  try {
    const full = join(dir, "mongo.js");
    writeFileSync(full, `
      import mongoose from "mongoose";
      const User = mongoose.model("User", new Schema({}, { collection: "users" }));
      export const load = (db) => db.collection("orders").find({}).toArray();
    `);
    const mongo = detectInfraFromScan(scanFrom({
      deps: ["mongoose"],
      codeFiles: [{ path: "src/mongo.js", full }],
    })).find((s) => s.id === "mongodb");

    assert.ok(mongo, "expected mongodb service");
    assert.equal(mongo.itemLabel, "COLLECTIONS");
    assert.equal(mongo.unit, "docs");
    const names = new Set(mongo.items.map((item) => item.name));
    assert.ok(names.has("users"));
    assert.ok(names.has("orders"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInfraFromScan: ClickHouse items come from SQL, not JS imports/prose", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-infra-"));
  try {
    const full = join(dir, "mixed.js");
    writeFileSync(full, `
      import { test } from "bun:test";
      import mongoose from "mongoose";
      import { createClient } from "@clickhouse/client";
      const User = mongoose.model("User", new Schema({}, { collection: "users" }));
      const prose = "from the widget query";
      const sql = \`
        WITH base AS (SELECT target, path FROM netflows.flows)
        SELECT target, count()
        FROM base
        JOIN path_metrics ON path_metrics.path = netflows.flows.path
        WHERE target != ''
      \`;
      export const run = (client) => client.query({ query: sql });
    `);
    const out = detectInfraFromScan(scanFrom({
      deps: ["@clickhouse/client", "mongoose"],
      codeFiles: [{ path: "src/mixed.js", full }],
    }));
    const clickhouse = out.find((s) => s.id === "clickhouse");
    const mongodb = out.find((s) => s.id === "mongodb");
    const clickNames = new Set(clickhouse.items.map((item) => item.name));
    const mongoNames = new Set(mongodb.items.map((item) => item.name));

    assert.ok(clickNames.has("netflows.flows"));
    assert.ok(clickNames.has("path_metrics"));
    assert.equal(clickNames.has("base"), false, "CTE aliases must not be ClickHouse items");
    for (const bad of ["mongoose", "bun", "the", "is", "query", "widget"]) {
      assert.equal(clickNames.has(bad), false, `${bad} must not be a ClickHouse item`);
    }
    assert.ok(mongoNames.has("users"));
    assert.ok(mongoNames.has("User"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInfraFromScan: Kafka and Valkey surface repo-used topics and keyspaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-infra-"));
  try {
    const full = join(dir, "main.go");
    writeFileSync(full, `
      package main
      import (
        kafka "github.com/segmentio/kafka-go"
        valkey "github.com/valkey-io/valkey-go"
      )
      func run(ctx context.Context) {
        _ = kafka.Writer{Topic: "orders.created"}
        _ = kafka.ReaderConfig{Topic: "orders.created", GroupTopics: []string{"orders.created", "orders.cancelled"}, GroupID: "billing"}
        producer.send({ topic: "orders.updated", messages: [] })
        consumer.subscribe({ topic: "orders.created" })
        _ = valkey.Client{}
        rdb.Set(ctx, "session:*", "x", 0)
        rdb.HGet(ctx, "user:profile", "name")
        rdb.XReadGroup(ctx, &redis.XReadGroupArgs{Streams: []string{"events", ">"}, Group: "workers"})
      }
    `);
    const out = detectInfraFromScan(scanFrom({
      deps: ["github.com/segmentio/kafka-go", "github.com/valkey-io/valkey-go"],
      codeFiles: [{ path: "cmd/main.go", full }],
    }));
    const kafka = out.find((s) => s.id === "kafka");
    const valkey = out.find((s) => s.id === "valkey");
    assert.ok(kafka, "expected kafka service");
    assert.ok(valkey, "expected valkey service");
    const kafkaItems = new Map(kafka.items.map((item) => [item.name, item]));
    assert.ok(kafkaItems.has("orders.created"));
    assert.ok(kafkaItems.has("orders.cancelled"));
    assert.ok(kafkaItems.has("orders.updated"));
    assert.ok(kafkaItems.get("orders.created").ops.includes("consume"));
    const valkeyItems = new Map(valkey.items.map((item) => [item.name, item]));
    assert.ok(valkeyItems.has("session:*"));
    assert.ok(valkeyItems.has("user:profile"));
    assert.ok(valkeyItems.has("events"));
    assert.ok(valkeyItems.get("session:*").ops.includes("write"));
    assert.ok(valkeyItems.get("user:profile").ops.includes("hash read"));
    assert.ok(valkeyItems.get("events").ops.includes("stream"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectInfraFromScan: Go flag DEFAULTS carry topics/keyspaces (bgp-speaker style)", () => {
  // CLI services declare their topics/keys as flag defaults, not literals at the call site — the
  // flag NAME says what the default VALUE is. Unrelated flags (host:port, master name) must not leak.
  const dir = mkdtempSync(join(tmpdir(), "weavatrix-infra-"));
  try {
    const full = join(dir, "main.go");
    writeFileSync(full, `
      package main
      import (
        kafka "github.com/segmentio/kafka-go"
        valkey "github.com/valkey-io/valkey-go"
      )
      var (
        flagConfigTopic = flag.String("bgp_config_kafka_topic", "bgp_speaker_configurations", "config updates topic")
        flagNotifyTopic = flag.String("notify_topic", "events2notify", "events notifications topic")
        flagKeyBase     = flag.String("redis_key_base", "bgp:mitigators", "redis keyspace for updates")
        flagIpPort      = flag.String("redis_ipport", "redis:6379", "Host:Port of Redis")
        flagMaster      = flag.String("redis_sentinel_master", "masteredis", "sentinel master name")
      )
    `);
    const out = detectInfraFromScan(scanFrom({
      deps: ["github.com/segmentio/kafka-go", "github.com/valkey-io/valkey-go"],
      codeFiles: [{ path: "main.go", full }],
    }));
    const kafka = out.find((s) => s.id === "kafka");
    const valkey = out.find((s) => s.id === "valkey");
    const kafkaNames = new Set((kafka?.items || []).map((i) => i.name));
    const valkeyNames = new Set((valkey?.items || []).map((i) => i.name));
    assert.ok(kafkaNames.has("bgp_speaker_configurations"), "topic-named flag default becomes a topic");
    assert.ok(kafkaNames.has("events2notify"));
    assert.ok(valkeyNames.has("bgp:mitigators"), "key-named flag default becomes a keyspace");
    assert.ok(!valkeyNames.has("redis:6379"), "host:port flags are not keyspaces");
    assert.ok(!valkeyNames.has("masteredis"), "sentinel master name is not a keyspace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- registry-level false-positive guards (lock in the adversarial-verify fixes) ----------------
test("registry FP guards: ORMs / AWS-SDK monoliths / instrumentation / generic env never manufacture a service", () => {
  const ids = (o) => new Set(detectInfraFromScan(scanFrom(o)).map((s) => s.id)); // default registry
  // an ORM doesn't identify a specific DB → Sequelize+mysql2 must yield MySQL, never Postgres
  const orm = ids({ deps: ["sequelize", "typeorm", "prisma", "mysql2"], envKeys: ["DATABASE_URL"] });
  assert.ok(orm.has("mysql"), "mysql2 should detect MySQL");
  assert.ok(!orm.has("postgres"), "an ORM + DATABASE_URL must NOT be attributed to Postgres");
  // AWS multi-service SDK monoliths can't attribute one service
  assert.equal(detectInfraFromScan(scanFrom({ deps: ["aws-sdk", "boto3", "botocore"] })).length, 0);
  // instrumentation libs mean 'this app is scraped', not 'depends on a metrics store'
  assert.equal(detectInfraFromScan(scanFrom({ deps: ["prom-client", "@opentelemetry/api"] })).length, 0);
  // a bare generic env key alone proves nothing
  assert.equal(detectInfraFromScan(scanFrom({ envKeys: ["DATABASE_URL", "DB_HOST"] })).length, 0);
  // but a service-scoped AWS client DOES fire
  assert.ok(ids({ deps: ["@aws-sdk/client-s3"] }).has("s3"));
});
