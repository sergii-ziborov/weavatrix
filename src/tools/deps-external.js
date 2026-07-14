// External-engine adapter: run knip + depcheck + dependency-cruiser (the pre-internal tools, via npx)
// and normalize their TEXT reports into the unified Finding shape, so the Dependencies UI renders one
// contract regardless of engine. Parsers are deliberately tolerant — on a shape we don't recognize the
// raw text is preserved as a single info finding instead of being dropped. DEPS_SECURITY_PLAN §P3.
import { runKnipOnRepo, runJsTool } from "./jstools.js";
import { runDepCruiseOnRepo } from "./depcruise.js";
import { makeFinding, summarizeFindings, sortFindings } from "../analysis/findings.js";

// knip text sections → rule mapping. Section lines look like "Unused files (3)".
const KNIP_SECTIONS = {
  "Unused files": { rule: "unused-file", category: "unused", severity: "low" },
  "Unused dependencies": { rule: "unused-dep", category: "unused", severity: "low" },
  "Unused devDependencies": { rule: "unused-dep", category: "unused", severity: "info" },
  "Unlisted dependencies": { rule: "missing-dep", category: "unused", severity: "medium" },
  "Unlisted binaries": { rule: "missing-dep", category: "unused", severity: "low" },
  "Unresolved imports": { rule: "unresolved-import", category: "structure", severity: "low" },
  "Unused exports": { rule: "unused-export", category: "unused", severity: "info" },
  "Unused exported types": { rule: "unused-export", category: "unused", severity: "info" },
  "Unused exported enum members": { rule: "unused-export", category: "unused", severity: "info" },
  "Duplicate exports": { rule: "duplicate-dep", category: "unused", severity: "info" },
};

export function parseKnip(output) {
  const findings = [];
  let section = null;
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = line.match(/^([A-Z][A-Za-z ]+?)\s*\((\d+)\)\s*$/);
    if (head && KNIP_SECTIONS[head[1]]) { section = KNIP_SECTIONS[head[1]]; continue; }
    if (head) { section = null; continue; }
    if (!section || !line.trim() || /^[-=]+$/.test(line.trim())) continue;
    const entry = line.trim().split(/\s{2,}/)[0]; // "name  package.json" → name; "src/a.ts:3:7  foo" → path
    if (!entry) continue;
    const isDepRule = section.rule === "unused-dep" || section.rule === "missing-dep" || section.rule === "duplicate-dep";
    findings.push(makeFinding({
      category: section.category, rule: section.rule, severity: section.severity, confidence: "medium",
      title: `${section.rule === "unused-file" ? "Unused file" : section.rule === "unused-export" ? "Unused export" : section.rule === "missing-dep" ? "Unlisted" : section.rule === "unresolved-import" ? "Unresolved import" : "Unused"}: ${entry}`,
      detail: `Reported by knip. Verify config/dynamic usage before removing.`,
      ...(isDepRule ? { package: entry } : { file: entry.split(":")[0], graphNodeId: entry.split(":")[0] }),
      source: "knip",
    }));
  }
  return findings;
}

// depcheck text: "Unused dependencies\n* pkg\nMissing dependencies\n* pkg: ./using/file"
export function parseDepcheck(output) {
  const findings = [];
  let mode = null;
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Unused dependencies/i.test(line)) { mode = { rule: "unused-dep", severity: "low" }; continue; }
    if (/^Unused devDependencies/i.test(line)) { mode = { rule: "unused-dep", severity: "info" }; continue; }
    if (/^Missing dependencies/i.test(line)) { mode = { rule: "missing-dep", severity: "medium" }; continue; }
    const m = line.match(/^\*\s+(\S+?)(?::\s*(.+))?$/);
    if (!m || !mode) continue;
    findings.push(makeFinding({
      category: "unused", rule: mode.rule, severity: mode.severity, confidence: "medium",
      title: `${mode.rule === "missing-dep" ? "Missing dependency" : "Unused dependency"}: ${m[1]}`,
      detail: `Reported by depcheck.${m[2] ? ` Used in ${m[2]}.` : ""} Verify config/dynamic usage before acting.`,
      package: m[1],
      ...(m[2] ? { file: m[2].split(",")[0].trim().replace(/^\.\//, "") } : {}),
      source: "depcheck",
    }));
  }
  return findings;
}

// depcruise err-long text: "  warn no-circular: a.js → \n      b.js →\n      a.js\n    <comment>"
export function parseDepcruise(output) {
  const findings = [];
  const lines = String(output || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,4}(error|warn|info)\s+([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, level, ruleName] = m;
    const chain = [m[3].replace(/\s*→\s*$/, "").trim()].filter(Boolean);
    while (i + 1 < lines.length && /^\s{5,}\S/.test(lines[i + 1]) && !/^\s{0,4}(error|warn|info)\s/.test(lines[i + 1])) {
      const cont = lines[++i].trim().replace(/\s*→\s*$/, "");
      if (/^[A-Z]/.test(cont)) break; // the rule's prose comment line — stop collecting the path
      chain.push(cont);
    }
    const rule = ruleName === "no-circular" ? "circular-dep" : ruleName === "no-orphans" ? "orphan-file" : "boundary-violation";
    findings.push(makeFinding({
      category: "structure", rule,
      severity: level === "error" ? "high" : level === "warn" ? "medium" : "info",
      confidence: "medium",
      title: rule === "circular-dep" ? `Circular dependency: ${chain[0] || ruleName}` : rule === "orphan-file" ? `Orphan module: ${chain[0] || ""}` : `Boundary violation (${ruleName}): ${chain[0] || ""}`,
      detail: `${chain.join(" → ")} — reported by dependency-cruiser (${ruleName}).`,
      file: (chain[0] || "").split(" ")[0],
      graphNodeId: (chain[0] || "").split(" ")[0],
      evidence: chain.map((c) => ({ file: c, line: 0, snippet: "" })),
      source: "depcruise",
    }));
  }
  return findings;
}

const CLEAN_RE = /found no issues|No depcheck issue|no dependency violations/i;

export async function runExternalDeps(repoPath) {
  const findings = [];
  const toolLogs = {};
  const wrap = (name, parse) => async (runResult) => {
    toolLogs[name] = runResult.ok ? `exit ${runResult.exitCode}` : `error: ${runResult.error || "failed"}`;
    if (!runResult.ok || !runResult.output || CLEAN_RE.test(runResult.output)) return;
    try {
      const parsed = parse(runResult.output);
      if (parsed.length) findings.push(...parsed);
      else findings.push(makeFinding({ category: "unused", rule: "unused-dep", severity: "info", confidence: "low", title: `${name}: unparsed report`, detail: String(runResult.output).slice(0, 4000), source: name }));
    } catch (error) {
      findings.push(makeFinding({ category: "unused", rule: "unused-dep", severity: "info", confidence: "low", title: `${name}: report parse failed (${error.message})`, detail: String(runResult.output).slice(0, 4000), source: name }));
    }
  };
  await wrap("knip", parseKnip)(await runKnipOnRepo(repoPath, false));
  await wrap("depcheck", parseDepcheck)(await runJsTool(repoPath, "depcheck"));
  await wrap("depcruise", parseDepcruise)(await runDepCruiseOnRepo(repoPath, {}));

  // failed tools must be VISIBLE — all three down (no npx / offline) is an error, not a clean report
  const failed = Object.entries(toolLogs).filter(([, v]) => String(v).startsWith("error:"));
  if (failed.length === 3) return { ok: false, error: `No external tool could run — ${failed.map(([n, v]) => `${n}: ${v.slice(7)}`).join("; ")}. Check npx/network or switch to the built-in engine.` };
  for (const [name, v] of failed) {
    findings.push(makeFinding({ category: "unused", rule: "tool-failed", severity: "info", confidence: "high", title: `${name} did not run`, detail: `${v.slice(7)} — findings below come from the remaining tools only.`, source: name }));
  }

  const sorted = sortFindings(findings);
  return {
    ok: true,
    engine: "external",
    savedAt: new Date().toISOString(),
    scanned: { toolLogs },
    summary: summarizeFindings(sorted),
    findings: sorted,
  };
}
