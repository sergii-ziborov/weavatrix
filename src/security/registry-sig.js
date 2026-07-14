// Curated malware-heuristic signature table (defensive scanning of INSTALLED dependencies) + pure
// classifiers. Same philosophy as infra-registry.js: deterministic patterns, near-zero-FP rules marked
// explicitly, and an allowlist that downgrades ONLY the noisy rules — NEVER the smoking-gun ones
// (miners, fetch+exec): supply-chain attacks trojan previously-good packages (event-stream lesson).
// DEPS_SECURITY_PLAN P5.

// Packages with famously "suspicious-looking but legit" behavior: native builds, postinstall banners,
// heavily-minified bundles. Downgrades obfuscation-style signals only.
export const MALWARE_ALLOWLIST = new Set([
  "esbuild", "sharp", "node-gyp", "husky", "playwright", "@playwright/test", "puppeteer", "electron",
  "better-sqlite3", "bcrypt", "fsevents", "core-js", "styled-components", "cypress", "sentry-cli",
  "@sentry/cli", "node-sass", "sqlite3", "grpc", "@grpc/grpc-js", "protobufjs", "swc", "@swc/core",
  "workerd", "sass-embedded", "canvas", "re2", "cpu-features", "ssh2", "argon2", "tree-sitter",
]);

// One source of truth for beacon/exfil endpoints: exfil-url MATCHES them, the weaker URL rules
// EXCLUDE them (lookahead) so a single URL never counts as two distinct escalation keys.
// webhook.site / oast.* / canarytokens / dnslog.cn: Shai-Hulud-era exfil + OOB-callback services.
const EXFIL_HOSTS = "discord(app)?\\.com/api/webhooks|hooks\\.slack\\.com/services|api\\.telegram\\.org/bot|pastebin\\.com/raw|burpcollaborator|oastify\\.com|oast\\.(pro|live|fun|me|site|online)|interact\\.sh|pipedream\\.net|requestbin|webhook\\.site|canarytokens\\.(com|org)|dnslog\\.cn";
// external URL that is NOT an exfil endpoint (owned by exfil-url) and NOT a raw IP (owned by exfil-ip)
const PLAIN_EXTERNAL_URL = `https?://(?!(${EXFIL_HOSTS})|[0-9]{1,3}\\.|localhost\\b|127\\.|0\\.0\\.0\\.0|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.)[^'"\`\\s)\\\\]+`;

// ---- content rules (scanned over node_modules file text; `pattern` is ripgrep-safe ERE, `re` is the
// JS validator used both to classify rg hits and by the no-rg fallback) ----
export const CONTENT_RULES = [
  {
    key: "crypto-miner",
    severity: "critical",
    nearZeroFp: true,
    // mining-pool protocol + specific miner names / pool hosts / xmrig flags. Deliberately NO generic
    // words ("miner", "hash") — those false-positive on legit crypto/hashing libs.
    pattern: "stratum\\+(tcp|ssl)://|xmrig|cryptonight|randomx|coinhive|coinimp|cryptoloot|jsecoin|webminepool|minexmr|supportxmr|nanopool\\.org|nicehash\\.com|minergate|--donate-level|--coin\\s+monero",
    re: /stratum\+(tcp|ssl):\/\/|xmrig|cryptonight|randomx|coinhive|coinimp|cryptoloot|jsecoin|webminepool|minexmr|supportxmr|nanopool\.org|nicehash\.com|minergate|--donate-level|--coin\s+monero/i,
    what: "crypto-miner signature (mining pool protocol / miner name / xmrig flag)",
  },
  {
    key: "reverse-shell",
    severity: "critical",
    nearZeroFp: true,
    // canonical reverse/bind shells — a shell wired to a socket. Essentially never legitimate inside a
    // published package: /dev/tcp redirection, netcat -e, interactive-shell redirect, mkfifo pipe shell.
    pattern: "/dev/tcp/[0-9]|\\bnc(at)?\\s+-e\\b|\\b(ba)?sh\\s+-i\\b\\s*(2)?>&|mkfifo\\b.{0,60}(ba)?sh\\b|0<&196|socket\\.socket\\(.{0,40}(SOCK_STREAM).{0,80}(/bin/sh|exec)",
    re: /\/dev\/tcp\/[0-9]|\bnc(at)?\s+-e\b|\b(ba)?sh\s+-i\b\s*(2)?>&|mkfifo\b[\s\S]{0,60}?\b(ba)?sh\b|0<&196|socket\.socket\([\s\S]{0,120}?(connect|SOCK_STREAM)[\s\S]{0,180}?(\/bin\/sh|subprocess|pty\.spawn|os\.dup2)/i,
    what: "reverse/bind-shell pattern (interactive shell wired to a socket)",
  },
  {
    key: "sensitive-file-read",
    severity: "medium", // strong signal, but backup/dotfile tools touch these too → escalates via co-occurrence
    nearZeroFp: false,
    // rg pre-filter is the bare path; the JS re REQUIRES a read/copy/exfil verb on the same line — a
    // credential PATH alone (docs, READMEs, comments) is not a read (that was the app-builder-lib /
    // bun-types false positive). /etc/passwd + .netrc dropped (too common in prose).
    pattern: "\\.ssh/(id_rsa|id_ed25519|id_dsa|authorized_keys)|\\.aws/credentials|\\.git-credentials|/etc/shadow|\\.docker/config\\.json|\\.kube/config",
    re: /(readFileSync|readFile|createReadStream|openSync|\.read\(|copyFile|readlink|Get-Content|\bcat\s|\bscp\s|\bcurl\b[^\n]*-[TF])[\s\S]{0,80}?(\.ssh\/(id_(rsa|ed25519|dsa)|authorized_keys)|\.aws\/credentials|\.git-credentials|\/etc\/shadow|\.docker\/config\.json|\.kube\/config)/,
    what: "reads a credential/secret file (SSH key, cloud creds) in a filesystem-read context",
  },
  {
    key: "dynamic-require",
    severity: "medium",
    nearZeroFp: false,
    noisy: true,
    // require() of a DECODED/obfuscated name — NOT process.binding (legit legacy Node API in lodash/
    // safer-buffer/jest, often only in a comment → was a false positive).
    pattern: "require\\(\\s*(Buffer\\.from|atob)\\(|module\\.constructor\\._load|globalThis\\[['\"]require|require\\(\\s*_0x",
    re: /require\(\s*(Buffer\.from|atob)\(|module\.constructor\._load|globalThis\[['"]require|require\(\s*_0x[a-f0-9]/,
    what: "obfuscated module load (require of a base64/hex-decoded name)",
  },
  {
    key: "exfil-url",
    severity: "high",
    nearZeroFp: false,
    pattern: EXFIL_HOSTS,
    re: new RegExp(EXFIL_HOSTS, "i"),
    what: "beacon/exfiltration endpoint (webhook / paste / OOB-callback service)",
  },
  {
    key: "exfil-ip",
    severity: "medium", // raw-IP URLs have some legit uses (local tooling) — escalates via co-occurrence
    nearZeroFp: false,
    pattern: "https?://[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}",
    re: /https?:\/\/(?!127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/i, // /i: rg sweeps -i; URL schemes are case-insensitive (HTTP:// is a known evasion)
    what: "hardcoded raw-IP URL (loopback/private/link-local ranges excluded)", // 169.254.169.254 = cloud IMDS (AWS/GCP/Azure SDK metadata) — benign, was a hot FP
  },
  {
    key: "cloud-metadata-url",
    severity: "medium",
    nearZeroFp: false,
    pattern: "169\\.254\\.169\\.254|metadata\\.google\\.internal|metadata\\.azure\\.com|latest/meta-data|metadata/identity/oauth2/token|https?://metadata/computeMetadata",
    re: /169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com|latest\/meta-data|metadata\/identity\/oauth2\/token|https?:\/\/metadata\/computeMetadata/i,
    what: "cloud metadata service URL (credential-bearing endpoint; can be legit in cloud auth code)",
  },
  {
    key: "network-url",
    severity: "low",
    nearZeroFp: false,
    noisy: true,
    pattern: "(fetch|axios\\.|XMLHttpRequest|sendBeacon|https?\\.request|request\\(|curl\\b|wget\\b).{0,220}https?://",
    re: new RegExp(`\\b(fetch|axios\\.(get|post|put|patch|request)|XMLHttpRequest|sendBeacon|https?\\.request|http\\.request|request\\(|curl\\b|wget\\b)[\\s\\S]{0,220}?${PLAIN_EXTERNAL_URL}`, "i"),
    what: "network call to hardcoded external URL",
  },
  {
    key: "hardcoded-url",
    severity: "low",
    nearZeroFp: false,
    noisy: true,
    weak: true,
    pattern: "https?://",
    re: new RegExp(PLAIN_EXTERNAL_URL, "i"),
    what: "hardcoded external URL in installed package source",
  },
  {
    key: "env-exfil",
    severity: "medium",
    nearZeroFp: false,
    pattern: "JSON\\.stringify\\(process\\.env\\)|Object\\.entries\\(process\\.env\\)|dict\\(os\\.environ\\)|os\\.environ\\.copy\\(\\)|os\\.Environ\\(\\)",
    re: /JSON\.stringify\(process\.env\)|Object\.entries\(process\.env\)|dict\(os\.environ\)|os\.environ\.copy\(\)|os\.Environ\(\)/,
    what: "whole-environment serialization (secrets harvesting favorite)",
  },
  {
    key: "npm-token-or-publish",
    severity: "high",
    nearZeroFp: false,
    pattern: "NPM_TOKEN|NODE_AUTH_TOKEN|\\.npmrc|npm\\s+(publish|token)|registry\\.npmjs\\.org",
    re: /((NPM_TOKEN|NODE_AUTH_TOKEN|\.npmrc)[\s\S]{0,260}?(npm\s+(publish|token)|registry\.npmjs\.org)|((npm\s+(publish|token)|registry\.npmjs\.org)[\s\S]{0,260}?(NPM_TOKEN|NODE_AUTH_TOKEN|\.npmrc)))/i,
    what: "npm registry token/publish behavior in an installed package",
  },
  {
    key: "workflow-write",
    severity: "high",
    nearZeroFp: false,
    pattern: "\\.github/workflows|workflow_dispatch",
    re: /(writeFile(Sync)?|appendFile(Sync)?|copyFile(Sync)?|mkdir(Sync)?|createWriteStream|fs\.)[\s\S]{0,220}?\.github\/workflows|\.github\/workflows[\s\S]{0,220}?(writeFile(Sync)?|appendFile(Sync)?|copyFile(Sync)?|mkdir(Sync)?|createWriteStream|fs\.)/i,
    what: "writes GitHub Actions workflow files from a dependency",
  },
  {
    key: "python-obfuscated-exec",
    severity: "high",
    nearZeroFp: false,
    pattern: "exec\\(|eval\\(|marshal\\.loads|base64\\.b64decode|zlib\\.decompress|codecs\\.decode",
    re: /\b(exec|eval)\s*\(\s*(base64\.b64decode|b64decode|marshal\.loads|zlib\.decompress|codecs\.decode)\b|\bmarshal\.loads\s*\(|compile\s*\(\s*(base64\.b64decode|b64decode|zlib\.decompress|codecs\.decode)/i,
    what: "Python decoded/marshaled payload execution",
  },
  {
    key: "python-native-loader",
    severity: "high",
    nearZeroFp: false,
    pattern: "ctypes|VirtualAlloc|mmap\\.PROT_EXEC|CFUNCTYPE|windll\\.kernel32",
    re: /(ctypes|windll\.kernel32|CFUNCTYPE)[\s\S]{0,360}?(VirtualAlloc|mmap\.PROT_EXEC|memmove|CreateThread)|(VirtualAlloc|mmap\.PROT_EXEC|memmove|CreateThread)[\s\S]{0,360}?(ctypes|windll\.kernel32|CFUNCTYPE)/i,
    what: "Python native-memory loader pattern",
  },
  {
    key: "go-download-exec",
    severity: "high",
    nearZeroFp: false,
    pattern: "exec\\.Command|http\\.Get|http\\.Client|os\\.StartProcess",
    re: /(http\.(Get|Post|Client)|urlretrieve|io\.Copy)[\s\S]{0,420}?(exec\.Command|os\.StartProcess|syscall\.Exec)|(exec\.Command|os\.StartProcess|syscall\.Exec)[\s\S]{0,420}?(http\.(Get|Post|Client)|urlretrieve|io\.Copy)/i,
    what: "download plus process execution in Go/Python package code",
  },
  {
    key: "destructive-command",
    severity: "critical",
    nearZeroFp: true,
    pattern: "rm\\s+-rf\\s+/|mkfs\\.|dd\\s+.*of=/dev/|Remove-Item\\s+.*-Recurse|del\\s+/[sq]",
    re: /\brm\s+-rf\s+\/(?:\s|$)|\bmkfs\.[a-z0-9]+\b|\bdd\s+[^\n]*(of=\/dev\/(sd|hd|vd|nvme|disk)|if=\/dev\/zero)|Remove-Item\s+[^\n]*-Recurse|\bdel\s+\/[sq]\b/i,
    what: "destructive filesystem command embedded in a dependency",
  },
  {
    key: "crypto-clipper",
    severity: "high",
    nearZeroFp: false,
    pattern: "clipboard|writeText|execCommand\\(['\"]copy|bc1[a-z0-9]{11}|0x[a-fA-F0-9]{40}",
    re: /(clipboard|writeText|execCommand\(['"]copy|clipboardy)[\s\S]{0,520}?\b(0x[a-fA-F0-9]{40}|bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b|\b(0x[a-fA-F0-9]{40}|bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b[\s\S]{0,520}?(clipboard|writeText|execCommand\(['"]copy|clipboardy)/i,
    what: "clipboard rewrite paired with a cryptocurrency wallet address",
  },
  {
    key: "hidden-unicode",
    severity: "medium",
    nearZeroFp: false,
    pattern: "[\\x{202A}-\\x{202E}\\x{2066}-\\x{2069}\\x{FE00}-\\x{FE0F}]",
    re: new RegExp("\\u202A|\\u202B|\\u202C|\\u202D|\\u202E|\\u2066|\\u2067|\\u2068|\\u2069|\\uFE00|\\uFE01|\\uFE02|\\uFE03|\\uFE04|\\uFE05|\\uFE06|\\uFE07|\\uFE08|\\uFE09|\\uFE0A|\\uFE0B|\\uFE0C|\\uFE0D|\\uFE0E|\\uFE0F", "u"),
    what: "hidden Unicode control/variation character in package source",
  },
  {
    key: "obfuscated-code",
    severity: "low", // minified/legit code look-alikes — only escalates with a second signal
    nearZeroFp: false,
    noisy: true,
    pattern: "eval\\(atob\\(|eval\\(Buffer\\.from\\(|_0x[a-f0-9]{4}",
    re: /eval\(atob\(|eval\(Buffer\.from\([^)]*base64|_0x[a-f0-9]{4,}/,
    what: "obfuscation marker (eval-of-decoded payload / string-array obfuscator)",
  },
];

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
