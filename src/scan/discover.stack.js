// Stack detection for repo cards: frameworks, languages/runtimes, test/infra/deploy badges.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INFRA_SERVICES } from "../infra/infra-registry.js";
import { depMatches, depsFromManifest } from "../infra/infra.js";
import { repoInventory } from "./discover.inventory.js";

// Web/app frameworks worth surfacing on the repo card, per ecosystem. token → display name; first
// match (in array order) wins, so list server frameworks before generic UI libs. Versions come from
// the manifest's declared range (not the installed lockfile — close enough for "which version").
const FRAMEWORKS = {
  node: [
    ["@nestjs/core", "NestJS"], ["express", "Express"], ["fastify", "Fastify"], ["koa", "Koa"],
    ["@hapi/hapi", "Hapi"], ["hapi", "Hapi"], ["restify", "Restify"], ["hono", "Hono"],
    ["@adonisjs/core", "AdonisJS"], ["@feathersjs/feathers", "Feathers"], ["sails", "Sails"],
    ["next", "Next.js"], ["nuxt", "Nuxt"], ["@sveltejs/kit", "SvelteKit"], ["@remix-run/server-runtime", "Remix"],
    ["@angular/core", "Angular"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"],
  ],
  python: [
    ["django", "Django"], ["fastapi", "FastAPI"], ["flask", "Flask"], ["sanic", "Sanic"],
    ["tornado", "Tornado"], ["aiohttp", "aiohttp"], ["falcon", "Falcon"], ["bottle", "Bottle"],
  ],
  go: [
    ["github.com/gin-gonic/gin", "Gin"], ["github.com/labstack/echo", "Echo"], ["github.com/gofiber/fiber", "Fiber"],
    ["github.com/go-chi/chi", "Chi"], ["github.com/gorilla/mux", "Gorilla"], ["github.com/beego/beego", "Beego"],
  ],
};

// "^5.2.0" / "~4.18" / "v1.9.1" / ">=2,<3" / "==4.2" → "5.2" (major.minor, range operators stripped).
export function cleanVersion(raw) {
  const m = String(raw || "").match(/(\d+)(?:\.(\d+))?/);
  return m ? (m[2] != null ? `${m[1]}.${m[2]}` : m[1]) : "";
}

// Read a manifest and return the first framework {name, version} it declares. Cheap: one file read.
export function detectFramework(dir, runtime) {
  const read = (file) => { try { return readFileSync(join(dir, file), "utf8"); } catch { return ""; } };
  const list = FRAMEWORKS[runtime];
  if (!list) return null;
  if (runtime === "node") {
    let pkg;
    try { pkg = JSON.parse(read("package.json")); } catch { return null; }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [tok, label] of list) if (deps[tok] != null) return { name: label, version: cleanVersion(deps[tok]) };
  } else if (runtime === "python") {
    const text = (read("requirements.txt") + "\n" + read("pyproject.toml") + "\n" + read("Pipfile")).toLowerCase();
    for (const [tok, label] of list) {
      const m = text.match(new RegExp(`(?:^|[\\s"'\\[])${tok}\\s*[~^>=<! ]*\\s*([0-9][0-9.]*)`, "m"));
      if (m || new RegExp(`(?:^|[\\s"'\\[])${tok}(?:$|[\\s"'\\],~^>=<])`, "m").test(text)) return { name: label, version: m ? cleanVersion(m[1]) : "" };
    }
  } else if (runtime === "go") {
    const text = read("go.mod");
    for (const [tok, label] of list) {
      const m = text.match(new RegExp(`${tok.replace(/[.\\]/g, "\\$&")}(?:/v\\d+)?\\s+v([0-9][0-9.]*)`));
      if (m) return { name: label, version: cleanVersion(m[1]) };
    }
  }
  return null;
}

function readRootFile(dir, file) {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return "";
  }
}

function readPackage(dir) {
  try {
    return JSON.parse(readRootFile(dir, "package.json"));
  } catch {
    return null;
  }
}

function packageDeps(pkg, includeDev = true) {
  if (!pkg || typeof pkg !== "object") return {};
  return {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
    ...(pkg.peerDependencies || {}),
    ...(includeDev ? pkg.devDependencies || {} : {})
  };
}

function manifestDeps(dir) {
  const out = new Set();
  for (const file of [
    "package.json", "go.mod", "go.sum", "requirements.txt", "constraints.txt", "pyproject.toml",
    "Pipfile", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile"
  ]) {
    if (!existsSync(join(dir, file))) continue;
    for (const dep of depsFromManifest(file, readRootFile(dir, file))) out.add(dep);
  }
  return out;
}

function addBadge(list, seen, id, label, extra = {}) {
  if (!id || seen.has(id)) return;
  seen.add(id);
  list.push({ id, label, ...extra });
}

function infraDisplayName(service) {
  const names = {
    postgres: "Postgres",
    mysql: "MySQL",
    mariadb: "MariaDB",
    sqlserver: "SQL Server",
    sqlite: "SQLite",
    mongodb: "MongoDB",
    dynamodb: "DynamoDB",
    elasticsearch: "Elastic",
    clickhouse: "ClickHouse",
    influxdb: "InfluxDB",
    timescaledb: "Timescale",
    redis: "Redis",
    valkey: "Valkey",
    memcached: "Memcached",
    kafka: "Kafka",
    rabbitmq: "RabbitMQ",
    "gcp-pubsub": "Pub/Sub",
    "azure-servicebus": "Service Bus",
    keycloak: "Keycloak",
    "firebase-auth": "Firebase Auth",
    "oidc-generic": "OIDC",
    "azure-blob": "Azure Blob"
  };
  return names[service.id] || String(service.name || service.id || "").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function detectInfraBadges(prodDeps) {
  const badges = [];
  const seen = new Set();
  const visibleKinds = new Set(["db", "ts", "cache", "queue", "cloud"]);
  for (const service of INFRA_SERVICES) {
    if (!visibleKinds.has(service.kind)) continue;
    const hit = (service.deps || []).some((token) => [...prodDeps].some((dep) => depMatches(dep, token)));
    if (hit) addBadge(badges, seen, service.id, infraDisplayName(service), { kind: service.kind });
  }
  return badges;
}

function detectTestBadges({ dir, pkg, inventory, allDeps }) {
  const badges = [];
  const seen = new Set();
  const deps = new Set(Object.keys(allDeps || {}).map((x) => x.toLowerCase()));
  const scripts = Object.values(pkg?.scripts || {}).join("\n").toLowerCase();
  const hasDep = (...names) => names.some((name) => deps.has(name.toLowerCase()));
  const hasFile = (re) => [...(inventory.files || [])].some((file) => re.test(file));
  const hasScript = (re) => re.test(scripts);

  if (hasDep("@playwright/test", "playwright") || hasFile(/(^|\/)playwright\.config\.[cm]?[jt]s$/) || hasScript(/\bplaywright\b/)) {
    addBadge(badges, seen, "playwright", "Playwright", { kind: "e2e" });
  }
  if (hasDep("vitest") || hasFile(/(^|\/)vitest\.config\.[cm]?[jt]s$/) || hasScript(/\bvitest\b/)) {
    addBadge(badges, seen, "vitest", "Vitest", { kind: "unit" });
  }
  if (hasDep("jest", "@jest/globals", "ts-jest") || hasFile(/(^|\/)jest\.config\.[cm]?[jt]s$/) || hasScript(/\bjest\b/)) {
    addBadge(badges, seen, "jest", "Jest", { kind: "unit" });
  }
  if (hasDep("cypress") || hasFile(/(^|\/)cypress\.config\.[cm]?[jt]s$/) || hasScript(/\bcypress\b/)) {
    addBadge(badges, seen, "cypress", "Cypress", { kind: "e2e" });
  }
  if (hasDep("mocha") || hasScript(/\bmocha\b/)) addBadge(badges, seen, "mocha", "Mocha", { kind: "unit" });
  if (hasDep("ava") || hasScript(/\bava\b/)) addBadge(badges, seen, "ava", "AVA", { kind: "unit" });
  if (hasDep("pytest") || existsSync(join(dir, "pytest.ini")) || hasFile(/(^|\/)test_.*\.py$/)) {
    addBadge(badges, seen, "pytest", "pytest", { kind: "unit" });
  }
  if (existsSync(join(dir, "go.mod")) && hasFile(/_test\.go$/)) addBadge(badges, seen, "go-test", "go test", { kind: "unit" });
  if (existsSync(join(dir, "Cargo.toml")) && hasFile(/(^|\/)tests\/.*\.rs$/)) addBadge(badges, seen, "cargo-test", "cargo test", { kind: "unit" });
  return badges;
}

// Deployment / infra-as-code tooling, detected by file presence. inventory.files is a lowercased,
// "/"-joined recursive path list (vendored/build dirs already skipped), so a repo's Dockerfile,
// skaffold.yaml, k8s manifests, helm chart or *.tf light up even when nested.
function detectDeployBadges(inventory) {
  const badges = [];
  const seen = new Set();
  const files = [...(inventory.files || [])];
  const hasFile = (re) => files.some((file) => re.test(file));
  if (hasFile(/(^|\/)(dockerfile|containerfile)(\.[\w.-]+)?$/) || hasFile(/\.dockerfile$/)) addBadge(badges, seen, "docker", "Docker", { kind: "container" });
  if (hasFile(/(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/)) addBadge(badges, seen, "compose", "Compose", { kind: "container" });
  if (hasFile(/(^|\/)skaffold(\.[\w.-]+)?\.ya?ml$/)) addBadge(badges, seen, "skaffold", "Skaffold", { kind: "deploy" });
  if (hasFile(/(^|\/)chart\.ya?ml$/) || hasFile(/(^|\/)helm\//)) addBadge(badges, seen, "helm", "Helm", { kind: "orchestration" });
  if (hasFile(/(^|\/)kustomization\.ya?ml$/) || hasFile(/(^|\/)(k8s|kubernetes|manifests)\/.*\.ya?ml$/)) addBadge(badges, seen, "kubernetes", "K8s", { kind: "orchestration" });
  if (hasFile(/(^|\/)[^/]+\.tf$/)) addBadge(badges, seen, "terraform", "Terraform", { kind: "iac" });
  return badges;
}

export function detectRepoStack(dir, inventory = repoInventory(dir)) {
  const has = (file) => existsSync(join(dir, file));
  const pkg = readPackage(dir);
  const allDeps = packageDeps(pkg, true);
  const prodDeps = manifestDeps(dir);
  const ext = inventory.ext || {};
  const languages = [];
  const runtimes = [];
  const seenLang = new Set();
  const seenRuntime = new Set();
  const depNames = new Set(Object.keys(allDeps).map((x) => x.toLowerCase()));

  const hasTs = !!(ext[".ts"] || ext[".tsx"] || has("tsconfig.json") || depNames.has("typescript"));
  const hasJs = !!(ext[".js"] || ext[".jsx"] || ext[".mjs"] || ext[".cjs"] || pkg);
  if (hasTs) addBadge(languages, seenLang, "typescript", "TS", { title: "TypeScript" });
  if (hasJs) addBadge(languages, seenLang, "javascript", "JS", { title: "JavaScript" });
  if (ext[".go"] || has("go.mod")) addBadge(languages, seenLang, "go", "Go", { title: "Go" });
  if (ext[".py"] || has("requirements.txt") || has("pyproject.toml") || has("setup.py") || has("Pipfile")) addBadge(languages, seenLang, "python", "Python");
  if (ext[".java"] || has("pom.xml") || has("build.gradle")) addBadge(languages, seenLang, "java", "Java");
  if (ext[".rs"] || has("Cargo.toml")) addBadge(languages, seenLang, "rust", "Rust");
  if (ext[".php"] || has("composer.json")) addBadge(languages, seenLang, "php", "PHP");
  if (ext[".rb"] || has("Gemfile")) addBadge(languages, seenLang, "ruby", "Ruby");

  if (has("bun.lock") || has("bun.lockb") || has("bunfig.toml")) addBadge(runtimes, seenRuntime, "bun", "Bun");
  if (has("deno.json") || has("deno.jsonc") || has("deno.lock")) addBadge(runtimes, seenRuntime, "deno", "Deno");
  if (pkg && !seenRuntime.has("bun") && !seenRuntime.has("deno")) addBadge(runtimes, seenRuntime, "node", "Node");

  return {
    languages,
    runtimes,
    tests: detectTestBadges({ dir, pkg, inventory, allDeps }),
    infra: detectInfraBadges(prodDeps),
    deploy: detectDeployBadges(inventory)
  };
}
