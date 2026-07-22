const clean = (value) => String(value || "").trim().replace(/^['"]|['"]$/g, "");
export const cargoName = (value) => clean(value).toLowerCase().replace(/_/g, "-");

function inlineTable(value) {
  const fields = new Map();
  for (const match of String(value || "").matchAll(/([A-Za-z][\w.-]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|true|false)/g)) {
    fields.set(match[1], clean(match[2]));
  }
  return fields;
}

// Bounded Cargo.toml parser for package/workspace dependency tables. It intentionally owns
// dependency identity, aliases and concrete versions; feature activation is not treated as usage.
export function parseCargoToml(text) {
  const source = String(text || "");
  const dependencies = [];
  const workspaceDependencies = [];
  let section = "", packageName = "", workspace = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    // Array-of-tables headers ([[bin]], [[example]], [[test]], [[bench]]) are neither the [package]
    // table nor a dependency table. Recognise them so their `name =`/`path =` keys are not mis-read:
    // a [[bin]] renamed to a crate ([[bin]] name = "foo") would otherwise overwrite the package name and
    // make every foo:: import look like a self-reference, and a [[bin]] after [dependencies] would leak
    // phantom "name"/"path" dependencies.
    const arrayHeader = /^\[\[([^\]]+)]]$/.exec(line);
    if (arrayHeader) { section = arrayHeader[1].trim(); continue; }
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header) { section = header[1].trim(); workspace ||= section === "workspace"; continue; }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (section === "package" && kv[1] === "name") { packageName = clean(kv[2]); continue; }
    const dependencyTable = /^(?:target\..+\.)?(dependencies|dev-dependencies|build-dependencies)$/.exec(section);
    const workspaceTable = section === "workspace.dependencies";
    if (!dependencyTable && !workspaceTable) continue;
    const alias = kv[1], value = kv[2].trim();
    const table = value.startsWith("{") ? inlineTable(value) : new Map();
    const version = value.startsWith("{") ? clean(table.get("version")) : clean(value);
    const name = clean(table.get("package")) || alias;
    const record = {
      alias,
      name,
      version: /^\d/.test(version) || /^=?\s*\d/.test(version) ? version.replace(/^=\s*/, "") : "",
      dev: dependencyTable?.[1] === "dev-dependencies",
      build: dependencyTable?.[1] === "build-dependencies",
      optional: table.get("optional") === "true",
      inherited: table.get("workspace") === "true",
    };
    (workspaceTable ? workspaceDependencies : dependencies).push(record);
  }
  return { packageName, workspace, dependencies, workspaceDependencies };
}

// Cargo.lock v3/v4 [[package]] records. Registry packages are exact installed crates; workspace
// and git packages are excluded because OSV crates.io versions must not be inferred for them.
export function parseCargoLockPackages(text) {
  const packages = [];
  let current = null;
  const flush = () => {
    if (current?.name && current.version && /^registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|^registry\+https:\/\/index\.crates\.io\//.test(current.source)) {
      packages.push({ ecosystem: "crates.io", name: current.name, version: current.version, dev: false, integrity: current.checksum || "", source: "cargo-lock" });
    }
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") { flush(); current = { name: "", version: "", source: "", checksum: "" }; continue; }
    if (!current) continue;
    if (/^\[/.test(line)) { flush(); current = null; continue; }
    const match = /^(name|version|source|checksum)\s*=\s*"([^"]+)"/.exec(line);
    if (match) current[match[1]] = match[2];
  }
  flush();
  const seen = new Set();
  return packages.filter((pkg) => {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
