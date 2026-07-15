// Pure classifiers for registry-sig.js: install-script/content/.pth/resolved-URL classification and
// the doc/benign-URL noise filters.

import { CONTENT_RULES } from "./registry-sig.rules.js";

// ---- install-script classification (package.json preinstall/install/postinstall) ----
const FETCH_RE = /\b(curl|wget|iwr|invoke-webrequest|certutil\s+-urlcache)\b|https?:\/\//i;
const EXEC_RE = /\|\s*(sh|bash|node|cmd|powershell|pwsh)\b|\b(node|python[0-9]?|perl|ruby|deno)\s+-e\s|python[0-9]?\s+-c\s|base64\s+(-d|--decode)|\beval\b|frombase64string|-enc(odedcommand)?\b|\biex\b|invoke-expression/i;
// routine native-build steps — never signals on their own
const BENIGN_ARG = "[\\w./:@=+,-]+";
const BENIGN_RE = new RegExp(`^(node-gyp\\s+rebuild|node-pre-gyp\\s+install(\\s+${BENIGN_ARG})*|prebuild-install(\\s+${BENIGN_ARG})*|node\\s+(scripts?|install|postinstall|lib)\\/[\\w./-]+\\.js(\\s+${BENIGN_ARG})*|electron-rebuild(\\s+${BENIGN_ARG})*|patch-package|husky(\\s+install)?|opencollective(\\s+${BENIGN_ARG})*|is-ci(\\s+${BENIGN_ARG})*)$`, "i");
const SHELL_CHAIN_RE = /&&|\|\||[;|`]|[$]\(|\r|\n/i;
function isBenignLifecycleScript(script) {
  return !SHELL_CHAIN_RE.test(script) && BENIGN_RE.test(script);
}

// → [{key, severity, nearZeroFp, what, snippet}] for one package's scripts object
export function classifyInstallScript(scripts = {}) {
  const signals = [];
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    const s = String(scripts[hook] || "").trim();
    if (!s || isBenignLifecycleScript(s)) continue;
    const fetches = FETCH_RE.test(s);
    const execs = EXEC_RE.test(s);
    if (fetches && execs) {
      signals.push({ key: "install-script-beacon", severity: "critical", nearZeroFp: true, what: `${hook} downloads AND executes (fetch+exec)`, snippet: s.slice(0, 200) });
    } else if (fetches) {
      signals.push({ key: "install-script-fetch", severity: "high", nearZeroFp: false, what: `${hook} reaches the network`, snippet: s.slice(0, 200) });
    } else if (execs) {
      signals.push({ key: "install-script-exec", severity: "medium", nearZeroFp: false, noisy: true, what: `${hook} uses eval/inline-node/base64`, snippet: s.slice(0, 200) });
    }
  }
  return signals;
}

// → signals[] for a chunk of file text (fallback scanning + rg-hit validation)
export function classifyContent(text) {
  const t = String(text || "");
  let out = [];
  for (const r of CONTENT_RULES) if (r.re.test(t)) out.push(r);
  const strongerUrl = out.some((r) => ["exfil-url", "exfil-ip", "cloud-metadata-url", "network-url"].includes(r.key));
  const docOnlyUrl = /\b(see|readme|docs?|documentation)\b[\s\S]{0,80}https?:\/\//i.test(t) || /https?:\/\/[^'"`\s)\\]+\/docs\b/i.test(t);
  if (strongerUrl || docOnlyUrl) out = out.filter((r) => r.key !== "hardcoded-url");
  return out;
}

const PTH_SUSPICIOUS_IMPORT_RE = /^\s*import\s+.*\b(exec|eval|compile|__import__|os\.system|subprocess|socket|requests|urllib|httpx|base64|b64decode|marshal|zlib|ctypes)\b/i;
export function classifyPythonPth(text) {
  const signals = [];
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!PTH_SUSPICIOUS_IMPORT_RE.test(line)) return;
    signals.push({
      key: "python-pth-startup-exec",
      severity: "high",
      nearZeroFp: false,
      what: "Python .pth startup import with executable/network/decoder behavior",
      snippet: line.trim().slice(0, 200),
      line: i + 1,
    });
  });
  return signals;
}

// ---- noise filters for the WEAK URL rules only (hardcoded-url, network-url). LICENSE files,
// comments and doc-links are where ~100% of their false positives live; the strong rules
// (miner/shell/exfil-url) still scan those files — a payload hidden in LICENSE stays caught. ----
export const NOISY_URL_KEYS = new Set(["hardcoded-url", "network-url"]);

const DOC_BASENAME_RE = /^((license|licence|notice|copying|copyright|authors|contributors|changelog|changes|history|readme|third[-_]?party[-_]?notices?|code[-_]?of[-_]?conduct)(\.(md|markdown|mdown|mkd|txt|rst|adoc|html?))?|licen[cs]es?[-_][\w.-]+|patents)$/i;
const DOC_EXT_RE = /\.(markdown|mdown|mkd|txt|rst|adoc|asciidoc|pod)$/i;

// prose/license file → URL evidence there is documentation, not behavior
export function isDocFile(file) {
  const base = String(file || "").replace(/\\/g, "/").split("/").pop() || "";
  return DOC_BASENAME_RE.test(base) || DOC_EXT_RE.test(base);
}

// comment openers BEFORE a URL ("// see", "* {@link", "# docs"); `//` not preceded by ':'/quote so
// protocol tails and '//'-in-string don't count; '#' not a hex color / shebang
const COMMENT_MARKER_RE = /(^|[^:'"`/])\/\/|\/\*|<!--|^\s*\*\s|\n\s*\*\s|(^|[\s({;,=])#(?!!|[0-9a-f]{3,8}\b)/i;
const DOC_WORD_PRE_RE = /\b(see|docs?|documentation|learn more|read more|more info(rmation)?|for details|refer(ence)? to|guide|manual|tutorial|homepage|website|link|visit|licen[cs]ed?|copyright|spec(ification)?|polyfill|based on|inspired by|ported from|wiki|report(ed)?\s+(at|to|bugs?|issues?)|file (an? )?(issue|bug)|available at|found at|thanks to)\b|@(see|link|license)\b|["']?\$schema["']?\s*:|\]\(\s*$/i;
const DOC_WORD_POST_RE = /^[):,'"`\]\s]{0,6}\b(spec(ification)?|docs?|documentation|standard|for (more|details)|page)\b/i;
// hosts that only serve standards/licenses/docs/registry pages — not attacker-controllable payload hosts
const BENIGN_URL_HOSTS = [
  "w3.org", "ietf.org", "rfc-editor.org", "iana.org", "whatwg.org", "ecma-international.org", "tc39.es",
  "unicode.org", "schema.org", "json-schema.org", "schemastore.org", "spdx.org", "semver.org",
  "apache.org", "opensource.org", "gnu.org", "creativecommons.org", "choosealicense.com",
  "mozilla.org", "nodejs.org", "npmjs.com", "npmjs.org", "yarnpkg.com", "python.org", "pypi.org",
  "golang.org", "go.dev", "godoc.org", "readthedocs.io", "readthedocs.org", "editorconfig.org",
];
const DOC_URL_PATH_RE = /\/(docs?|documentation|wiki|issues?|pull|blob|tree|releases|licenses?|rfc\d*|help|manual|guide|spec|schemas?)([/#?.]|$)/i;
const URL_TOKEN_RE = /https?:\/\/[^\s'"`)\\<>]+/gi;

function isBenignUrl(url) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "").replace(/:\d+$/, "").toLowerCase();
    if (BENIGN_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    return DOC_URL_PATH_RE.test(u.pathname);
  } catch { return false; }
}

// snippet-level classifier: true when EVERY URL in the snippet sits in doc/comment context — a
// comment opener before the first URL comments out the rest of the line; otherwise each URL needs
// its own doc-word neighborhood or a benign standards/docs host. Conservative on purpose: one
// non-benign URL keeps the whole snippet as evidence.
export function isBenignUrlContext(text) {
  const s = String(text || "");
  const urls = [...s.matchAll(URL_TOKEN_RE)];
  if (!urls.length) return false;
  if (COMMENT_MARKER_RE.test(s.slice(Math.max(0, urls[0].index - 80), urls[0].index))) return true;
  return urls.every((m) => {
    const pre = s.slice(Math.max(0, m.index - 80), m.index);
    const post = s.slice(m.index + m[0].length, m.index + m[0].length + 48);
    return DOC_WORD_PRE_RE.test(pre) || DOC_WORD_POST_RE.test(post) || isBenignUrl(m[0]);
  });
}

// packages whose JOB is talking to cloud endpoints (IMDS auth, vault, STS) — mutes cloud-metadata-url
// and the weak hardcoded-url for them ONLY. hardcoded-url never escalates (weak) and is hidden whenever
// a stronger URL rule fires, so nothing real is lost; a trojaned version still trips every other rule.
const CLOUD_SDK_PKG_RE = /^(aws-sdk|gcp-metadata|google-auth-library|azure-identity|boto3|botocore|google-auth|msrestazure|cloud\.google\.com\/go(\/.*)?|github\.com\/aws\/aws-sdk-go(-v2)?(\/.*)?|github\.com\/[aA]zure\/azure-sdk-for-go(\/.*)?)$|^@(aws-sdk|azure|google-cloud)\//;
const CLOUD_SDK_MUTED_KEYS = new Set(["cloud-metadata-url"]);
export function isCloudSdkMetadataUse(pkg, ruleKey) {
  return CLOUD_SDK_MUTED_KEYS.has(ruleKey) && CLOUD_SDK_PKG_RE.test(String(pkg || ""));
}

// package-lock `resolved` origin check: anything outside the big registries is worth a look.
const REGISTRY_RE = /^https:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com)\//i;
export function classifyResolvedUrl(resolved) {
  const r = String(resolved || "");
  if (!r || REGISTRY_RE.test(r) || r.startsWith("file:")) return null; // file: = workspace/link, common
  if (/^git\+|^git:|github\.com\//i.test(r)) return { key: "non-registry-source", severity: "medium", nearZeroFp: false, what: "installed from git, not the npm registry (no registry audit trail)", snippet: r.slice(0, 200) };
  return { key: "non-registry-source", severity: "medium", nearZeroFp: false, what: "installed from a non-registry URL", snippet: r.slice(0, 200) };
}
