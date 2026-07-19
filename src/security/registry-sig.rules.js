// Signature tables for registry-sig.js: the malware allowlist and the content-rule set.

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
const PLAIN_EXTERNAL_URL = `https?://(?!(${EXFIL_HOSTS})|[0-9]{1,3}\\.|localhost\\b|127\\.|0\\.0\\.0\\.0|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.)[a-z0-9][^'"\`\\s)\\\\]+`;

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
    pattern: "eval\\(atob\\(|eval\\(Buffer\\.from\\(|\\b_0x[a-f0-9]{4,}\\b",
    re: /eval\(atob\(|eval\(Buffer\.from\([^)]*base64|\b_0x[a-f0-9]{4,}\b/,
    what: "obfuscation marker (eval-of-decoded payload / string-array obfuscator)",
  },
];
