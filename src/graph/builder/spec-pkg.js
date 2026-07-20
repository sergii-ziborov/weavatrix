// specToPkg(spec) — map an import specifier to its npm package name, a Node builtin, or null for
// relative/absolute/URL specifiers. The core primitive for dependency analysis (unused/missing deps):
// "axios/lib/core" → axios, "@scope/name/sub" → @scope/name, "node:fs/promises" + "fs/promises" → fs
// (builtin), "./x" → null. See DEPS_SECURITY_PLAN.md (P0).

// Builtins importable WITHOUT the node: prefix. Prefix-only builtins (node:test, node:sea, node:sqlite)
// are deliberately NOT here — bare "test" is a legitimate npm package name; node:-prefixed specifiers
// are always classified builtin regardless of this set.
export const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm",
  "wasi", "worker_threads", "zlib",
]);

export function specToPkg(spec) {
  const s = String(spec || "").trim();
  if (!s || s.startsWith(".") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) return null; // relative/absolute/local
  if (s.startsWith("#")) return null; // package.json "imports" subpath (self-internal), not a dependency
  if (/^(https?|data|file):/.test(s)) return null; // URL-style imports aren't manifest deps
  if (s.startsWith("node:")) return { pkg: s.slice(5).split("/")[0], builtin: true };
  if (s === "bun" || s.startsWith("bun:")) return { pkg: s, builtin: true }; // Bun runtime modules (bun:test, bun:sqlite) — never npm deps
  if (s.startsWith("npm:")) return specToPkg(s.slice(4)); // Deno/import-map npm: specifiers alias real npm packages
  if (/^[a-z][\w+.-]*:/.test(s)) return null; // other scheme-style specifiers (jsr:, deno:, virtual:, …) aren't manifest deps
  const parts = s.split("/");
  const pkg = s.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s) : parts[0];
  if (NODE_BUILTINS.has(pkg)) return { pkg, builtin: true };
  return { pkg, builtin: false };
}

// ---- Go: import path → module (declared in go.mod) or stdlib. Stdlib packages have a dotless first
// segment (fmt, net/http, encoding/json — and cgo's "C"); everything else is a module path. Prefer the
// longest go.mod require prefix (exact module identity); fall back to a host-convention guess so
// MISSING modules still get a sane name (github.com/owner/repo, gopkg.in/pkg.v3, k8s.io/client-go).
const GO_DEEP_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "golang.org", "go.googlesource.com"]);
export function goSpecToPkg(importPath, { requires = [], ownModule = "" } = {}) {
  const s = String(importPath || "").trim();
  if (!s) return null;
  const segs = s.split("/");
  if (!segs[0].includes(".")) return { pkg: s, builtin: true }; // stdlib + "C"
  if (ownModule && (s === ownModule || s.startsWith(ownModule + "/"))) return null; // own module → internal (broken path, not a dep)
  let best = "";
  for (const r of requires) { const p = typeof r === "string" ? r : r.path; if ((s === p || s.startsWith(p + "/")) && p.length > best.length) best = p; }
  if (best) return { pkg: best, builtin: false };
  let n = GO_DEEP_HOSTS.has(segs[0]) ? 3 : 2;
  if (segs[0] === "gopkg.in") n = /\.v\d+$/.test(segs[1] || "") ? 2 : 3;
  return { pkg: segs.slice(0, Math.min(n, segs.length)).join("/"), builtin: false };
}

// ---- Python: top-level imported module → PyPI distribution (or stdlib). PY_STDLIB ≈ CPython 3.12
// sys.stdlib_module_names (public names) + legacy stalwarts, so old codebases classify cleanly too.
export const PY_STDLIB = new Set(("__future__ __main__ _thread abc aifc argparse array ast asyncio atexit audioop base64 bdb binascii bisect builtins bz2 " +
  "calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses " +
  "dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools " +
  "gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib imghdr imp importlib inspect io ipaddress itertools json keyword " +
  "linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nntplib ntpath numbers " +
  "operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri " +
  "random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib sndhdr socket socketserver spwd sqlite3 ssl stat statistics " +
  "sre_compile sre_constants sre_parse string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize tomllib " +
  "trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo").split(" "));

// import name → PyPI dist where they differ. Generic python-X / X-python / X[2]-binary equivalence is
// handled by the matcher in dep-check; this map covers the truly irregular names.
const PY_IMPORT_TO_DIST = {
  yaml: "PyYAML", cv2: "opencv-python", PIL: "Pillow", sklearn: "scikit-learn", skimage: "scikit-image",
  bs4: "beautifulsoup4", dateutil: "python-dateutil", dotenv: "python-dotenv", jose: "python-jose",
  magic: "python-magic", multipart: "python-multipart", docx: "python-docx", pptx: "python-pptx",
  fitz: "PyMuPDF", OpenSSL: "pyOpenSSL", Crypto: "pycryptodome", nacl: "PyNaCl", jwt: "PyJWT",
  MySQLdb: "mysqlclient", attr: "attrs", attrs: "attrs", git: "GitPython", github: "PyGithub",
  kafka: "kafka-python", grpc: "grpcio", serial: "pyserial", usb: "pyusb", zmq: "pyzmq",
  websocket: "websocket-client", socks: "PySocks", telegram: "python-telegram-bot",
  speech_recognition: "SpeechRecognition", wx: "wxPython", cairo: "pycairo", gi: "PyGObject",
  mpl_toolkits: "matplotlib", pkg_resources: "setuptools", Levenshtein: "python-Levenshtein",
  ldap: "python-ldap", memcache: "python-memcached", slugify: "python-slugify", decouple: "python-decouple",
  engineio: "python-engineio", socketio: "python-socketio", ruamel: "ruamel.yaml", flask: "Flask",
  win32api: "pywin32", win32com: "pywin32", win32con: "pywin32", win32gui: "pywin32", pythoncom: "pywin32", pywintypes: "pywin32",
};
// namespace roots shared by many dists (google.protobuf/google.cloud.* …) — too ambiguous to name one
// package; "src" is a repo-layout artifact (stale sys.path import), never a PyPI dist.
const PY_AMBIGUOUS_TOP = new Set(["google", "src"]);
export function pySpecToPkg(topModule) {
  const t = String(topModule || "").trim();
  if (!t) return null;
  if (PY_STDLIB.has(t)) return { pkg: t, builtin: true };
  return { pkg: PY_IMPORT_TO_DIST[t] || t, builtin: false, ambiguous: PY_AMBIGUOUS_TOP.has(t) };
}
