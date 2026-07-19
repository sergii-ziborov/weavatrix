// Conservative source-level correctness review signals. These checks deliberately recognize only
// a few grounded patterns with local evidence; they are not a compiler, race detector, or proof that
// the surrounding behavior is wrong.
import { makeFinding } from "./findings.js";
import {retryFindings} from './source-correctness/retry-patterns.js'

const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
};

const lineText = (text, index) => {
  const start = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 300);
};

// Preserve byte offsets/newlines while removing comments and string contents from regex input.
function maskNonCode(text, { hashComments = false } = {}) {
  const chars = String(text || "").split("");
  let quote = "", escaped = false, lineComment = false, blockComment = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], next = chars[i + 1];
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      else chars[i] = " ";
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { chars[i] = chars[i + 1] = " "; i++; blockComment = false; }
      else if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      continue;
    }
    if (quote) {
      if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; chars[i] = " "; continue; }
    if (hashComments && ch === "#") { chars[i] = " "; lineComment = true; continue; }
    if (ch === "/" && next === "/") { chars[i] = chars[i + 1] = " "; i++; lineComment = true; continue; }
    if (ch === "/" && next === "*") { chars[i] = chars[i + 1] = " "; i++; blockComment = true; }
  }
  return chars.join("");
}

function balancedEnd(text, openAt) {
  if (text[openAt] !== "{") return -1;
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const upperSnake = (value) => String(value || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
  .replace(/[^A-Za-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .toUpperCase();

function goFunctions(masked) {
  const functions = [];
  const re = /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)[^{]*\{/g;
  let match;
  while ((match = re.exec(masked))) {
    const open = re.lastIndex - 1;
    const end = balancedEnd(masked, open);
    if (end < 0) continue;
    functions.push({ name: match[1], params: match[2], open, end, body: masked.slice(open + 1, end - 1) });
    re.lastIndex = end;
  }
  return functions;
}

function goSliceFindings(text, masked, file) {
  const findings = [];
  for (const fn of goFunctions(masked)) {
    const sliceParams = [...fn.params.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s+\[\][^,)]*/g)].map((match) => match[1]);
    for (const parameter of sliceParams) {
      const slice = new RegExp(`\\b${escapeRegex(parameter)}\\s*\\[\\s*(?:0\\s*)?:\\s*(\\d+)\\s*\\]`, "g").exec(fn.body);
      if (!slice || Number(slice[1]) < 1) continue;
      const before = fn.body.slice(0, slice.index);
      const lenGuard = new RegExp(`\\blen\\s*\\(\\s*${escapeRegex(parameter)}\\s*\\)`).test(before);
      if (lenGuard) continue;
      const index = fn.open + 1 + slice.index;
      findings.push(makeFinding({
        category: "structure",
        rule: "go-unguarded-fixed-slice",
        severity: "medium",
        confidence: "high",
        title: `Potential slice-bounds panic in ${fn.name}: ${parameter}[:${slice[1]}]`,
        detail: `The slice parameter "${parameter}" is read to a fixed upper bound before any visible len(${parameter}) guard in this function. Confirm every caller guarantees at least ${slice[1]} element(s), or guard the access locally.`,
        file,
        line: lineAt(text, index),
        symbol: `${fn.name}()`,
        evidence: [{ file, line: lineAt(text, index), snippet: lineText(text, index) }],
        fixHint: `validate len(${parameter}) >= ${slice[1]} before slicing`,
      }));
    }
  }
  return findings;
}

function goConstructorTypeFindings(text, masked, file) {
  const findings = [];
  for (const fn of goFunctions(masked)) {
    if (!/^New[A-Z]/.test(fn.name)) continue;
    const suffix = upperSnake(fn.name.slice(3));
    if (!suffix) continue;
    const assigned = /\b(?:Type|Kind)\s*:\s*([A-Z][A-Z0-9_]*(?:_TYPE_|_KIND_)[A-Z0-9_]+)\b/g.exec(fn.body);
    if (!assigned) continue;
    const markerAt = Math.max(assigned[1].lastIndexOf("_TYPE_"), assigned[1].lastIndexOf("_KIND_"));
    const markerLength = 6;
    const expected = `${assigned[1].slice(0, markerAt + markerLength)}${suffix}`;
    if (expected === assigned[1] || !new RegExp(`\\b${escapeRegex(expected)}\\b`).test(masked)) continue;
    const index = fn.open + 1 + assigned.index;
    findings.push(makeFinding({
      category: "structure",
      rule: "constructor-enum-mismatch",
      severity: "medium",
      confidence: "high",
      title: `Constructor/type discriminator mismatch: ${fn.name} uses ${assigned[1]}`,
      detail: `The constructor name corresponds to the declared discriminator ${expected}, but the returned literal assigns ${assigned[1]}. This is a focused copy/paste review signal; confirm the intended wire type before changing it.`,
      file,
      line: lineAt(text, index),
      symbol: `${fn.name}()`,
      evidence: [{ file, line: lineAt(text, index), snippet: lineText(text, index) }],
      fixHint: `verify whether the discriminator should be ${expected}`,
    }));
  }
  return findings;
}

function javaInterruptFindings(text, masked, file) {
  const findings = [];
  const re = /\bcatch\s*\(\s*InterruptedException\s+([A-Za-z_]\w*)\s*\)\s*\{/g;
  let match;
  while ((match = re.exec(masked))) {
    const open = re.lastIndex - 1;
    const end = balancedEnd(masked, open);
    if (end < 0) continue;
    const body = masked.slice(open + 1, end - 1);
    const restores = /\bThread\s*\.\s*currentThread\s*\(\s*\)\s*\.\s*interrupt\s*\(/.test(body);
    const rethrows = new RegExp(`\\bthrow\\s+${escapeRegex(match[1])}\\s*;`).test(body)
      || /\bthrow\s+new\s+InterruptedException\b/.test(body);
    if (restores || rethrows) continue;
    findings.push(makeFinding({
      category: "structure",
      rule: "java-interrupt-status-not-restored",
      severity: "medium",
      confidence: "high",
      title: "InterruptedException caught without a visible interrupt restore",
      detail: "The catch block neither directly rethrows InterruptedException nor calls Thread.currentThread().interrupt(). A helper may restore it indirectly, so review before changing; otherwise cancellation can be lost.",
      file,
      line: lineAt(text, match.index),
      evidence: [{ file, line: lineAt(text, match.index), snippet: lineText(text, match.index) }],
      fixHint: "restore the interrupt status or propagate the interruption according to the method contract",
    }));
    re.lastIndex = end;
  }
  return findings;
}

export function analyzeSourceCorrectness(sources, { isNonProductPath = () => false } = {}) {
  const findings = [];
  const supportedRuntimeFiles = new Set();
  const concurrencyFiles = new Set();
  const checks = {
    goFixedSlice: { supportedFiles: 0, findings: 0 },
    constructorDiscriminator: { supportedFiles: 0, findings: 0 },
    javaInterrupt: { supportedFiles: 0, findings: 0 },
    retryTermination: { supportedFiles: 0, findings: 0 },
  };
  for (const [file, source] of sources || []) {
    if (isNonProductPath(file)) continue;
    const text = String(source || "");
    const go = /\.go$/i.test(file), java = /\.java$/i.test(file), python = /\.py$/i.test(file);
    const masked = maskNonCode(text, { hashComments: python });
    const retrySupported = /\.(?:[cm]?[jt]sx?|java|go|py)$/i.test(file);
    if (go) {
      supportedRuntimeFiles.add(file);
      checks.goFixedSlice.supportedFiles++;
      checks.constructorDiscriminator.supportedFiles++;
      const slice = goSliceFindings(text, masked, file);
      const discriminator = goConstructorTypeFindings(text, masked, file);
      findings.push(...slice, ...discriminator);
      checks.goFixedSlice.findings += slice.length;
      checks.constructorDiscriminator.findings += discriminator.length;
    }
    if (java) {
      supportedRuntimeFiles.add(file);
      concurrencyFiles.add(file);
      checks.javaInterrupt.supportedFiles++;
      const interruption = javaInterruptFindings(text, masked, file);
      findings.push(...interruption);
      checks.javaInterrupt.findings += interruption.length;
    }
    if (retrySupported) {
      supportedRuntimeFiles.add(file);
      checks.retryTermination.supportedFiles++;
      const retry = retryFindings(text, masked, file, {python});
      findings.push(...retry);
      checks.retryTermination.findings += retry.length;
    }
  }
  return {
    findings,
    coverage: {
      runtimeCorrectnessFiles: supportedRuntimeFiles.size,
      concurrencyFiles: concurrencyFiles.size,
      checks,
      limitations: [
        "bounded source patterns only",
        "no compiler or runtime execution",
        "no race detector; race freedom is not claimed",
      ],
    },
  };
}
