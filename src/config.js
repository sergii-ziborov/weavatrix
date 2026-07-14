// weavatrix config (Node/Electron). Data (repo-runs.json + editable prompt overrides) lives under
// the Electron userData dir, passed in via WEAVATRIX_DATA; falls back to ./data beside main/.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_DIR = fileURLToPath(new URL(".", import.meta.url));
export const DATA_DIR = process.env.WEAVATRIX_DATA || join(MAIN_DIR, "..", "data");
export const ROOT_DIR = MAIN_DIR; // engine.js codex `-C` fallback cwd when a call passes none

// Engine (Claude Code / Codex CLI)
export const CLAUDE_TIMEOUT_MS = Number(process.env.WEAVATRIX_CLAUDE_TIMEOUT_MS || 240000);
export const CLAUDE_MODEL = (process.env.WEAVATRIX_CLAUDE_MODEL || "sonnet").trim();
export const CLAUDE_MODELS = ["sonnet", "opus", "haiku", "fable"];
export const CODEX_MODELS = ["gpt-5.5", "gpt-5-codex", "gpt-5", "o3"];
export const CODEX_TIMEOUT_MS = Number(process.env.WEAVATRIX_CODEX_TIMEOUT_MS || 180000);
export const DEEP_SCAN_TIMEOUT_MS = Number(process.env.WEAVATRIX_DEEP_SCAN_TIMEOUT_MS || 600000);

// Tooling
export const KNIP_TIMEOUT_MS = Number(process.env.WEAVATRIX_KNIP_TIMEOUT_MS || 180000);
export const DEPCRUISE_TIMEOUT_MS = Number(process.env.WEAVATRIX_DEPCRUISE_TIMEOUT_MS || 180000);
export const JS_TOOL_CMD = { depcheck: ["depcheck"] };

// Editable "Analyze with <engine>" prompts (defaults; overrides saved under DATA_DIR/prompt-*.md)
export const DEFAULT_ANALYZE_REPO =
  "You are reviewing this repository. Give a concise, prioritized markdown bullet list (6-10 bullets) of concrete improvements: dead code to remove, structural/architecture issues, risky or unused dependencies, missing tests, and quick wins. Cite specific files/paths. Bullets only, no preamble.";
export const DEFAULT_ANALYZE_KNIP =
  "You are analyzing a knip dead-code / unused-dependency report. Produce a concise prioritized markdown bullet list: which unused files/exports/deps are safe to delete now, which need a manual check first (dynamic imports, reflection, build-only/CI usage), and the recommended cleanup order. Bullets only, no preamble.";
export const DEFAULT_ANALYZE_DEPCHECK =
  "You are analyzing a depcheck report (unused + missing dependencies). Produce a concise prioritized markdown bullet list: which unused dependencies are safe to remove, which are false positives (used in config/build/CI, dynamically, or via binaries), and any missing dependencies to add. Bullets only, no preamble.";
export const DEFAULT_ANALYZE_GRAPH =
  "You are analyzing a code-dependency graph report. Produce a concise markdown bullet list of architecture insights: hub/central modules, highly-coupled areas, orphan or likely-dead clusters, and concrete refactor candidates worth a closer look. Bullets only, no preamble.";
export const DEFAULT_ANALYZE_DEPCRUISE =
  "You are analyzing a dependency-cruiser report (module dependency violations: circular dependencies, orphan modules, and any custom architectural-boundary rules the repo defines). Produce a concise prioritized markdown bullet list: which circular dependencies to break first and how, which orphans are genuinely dead vs entry points / dynamically-loaded, and any boundary violations worth fixing. Cite specific files. Bullets only, no preamble.";
// One shared prompt for the combined Dependencies tab (knip + depcheck + dependency-cruiser reports).
export const DEFAULT_ANALYZE_DEPS =
  "You are analyzing a JS/TS project's dependency & dead-code health, given one or more of: a knip report (unused files/exports/dependencies), a depcheck report (unused + missing dependencies), and a dependency-cruiser report (circular dependencies, orphan modules, boundary violations). Produce ONE concise, prioritized markdown bullet list across all of them: what is safe to delete now, what needs a manual check first (dynamic imports, reflection, build/CI-only usage, entry points), which circular dependencies to break first and how, and missing dependencies to add. Cite specific files. Bullets only, no preamble.";
// About tab: a plain-language summary of what the repo is, grounded in the dependency graph.
export const DEFAULT_ANALYZE_ABOUT =
  "You are summarizing what this repository is about. Below is its REAL architecture, extracted from the dependency graph (folders, their sizes, and how folders import/call each other). In 4–8 sentences explain the project's purpose, its main modules, and how the parts fit together. Then a short 'Key modules:' bullet list naming the top folders and what each does. Cite real files where useful.";

// "Deep" variants — used by the 🔬 Deep button, which also opens the repo's files (read-only).
export const DEFAULT_ANALYZE_DEPS_DEEP =
  "You are validating a JS/TS project's dependency & dead-code findings WITH the repository open (read-only). For each candidate in the knip / depcheck / dependency-cruiser reports below, open the real files to confirm before acting. Produce ONE prioritized markdown bullet list: what is confirmed safe to delete (cite the file and why it's unused), what looked dead but is actually used (dynamic import, reflection, build/CI, entry point — cite where), which circular dependencies to break first and how, and missing dependencies to add. Bullets only, no preamble.";
export const DEFAULT_ANALYZE_GRAPH_DEEP =
  "You are analyzing this code-dependency graph WITH the repository open (read-only). Using the report below AND the real files, produce a concise markdown bullet list of architecture insights: hub/central modules, highly-coupled areas, orphan or likely-dead clusters (confirm by opening the files), and concrete refactor candidates with the files to start from. Bullets only, no preamble.";
export const DEFAULT_ANALYZE_ABOUT_DEEP =
  "You are summarizing what this repository is about, WITH the repo open (read-only). Below is its architecture from the dependency graph; open the key files to confirm. In 4–8 sentences explain the project's purpose, its main modules, and how the parts fit together. Then a short 'Key modules:' bullet list naming the top folders and what each does. Cite real files.";

export const PROMPT_PATHS = {
  "analyze-repo": join(DATA_DIR, "prompt-analyze-repo.md"),
  "analyze-knip": join(DATA_DIR, "prompt-analyze-knip.md"),
  "analyze-depcheck": join(DATA_DIR, "prompt-analyze-depcheck.md"),
  "analyze-graph": join(DATA_DIR, "prompt-analyze-graph.md"),
  "analyze-depcruise": join(DATA_DIR, "prompt-analyze-depcruise.md"),
  "analyze-deps": join(DATA_DIR, "prompt-analyze-deps.md"),
  "analyze-deps-deep": join(DATA_DIR, "prompt-analyze-deps-deep.md"),
  "analyze-about": join(DATA_DIR, "prompt-analyze-about.md"),
  "analyze-about-deep": join(DATA_DIR, "prompt-analyze-about-deep.md"),
  "analyze-graph-deep": join(DATA_DIR, "prompt-analyze-graph-deep.md")
};

export const PROMPT_DEFAULTS = {
  "analyze-repo": () => DEFAULT_ANALYZE_REPO,
  "analyze-knip": () => DEFAULT_ANALYZE_KNIP,
  "analyze-depcheck": () => DEFAULT_ANALYZE_DEPCHECK,
  "analyze-graph": () => DEFAULT_ANALYZE_GRAPH,
  "analyze-depcruise": () => DEFAULT_ANALYZE_DEPCRUISE,
  "analyze-deps": () => DEFAULT_ANALYZE_DEPS,
  "analyze-deps-deep": () => DEFAULT_ANALYZE_DEPS_DEEP,
  "analyze-about": () => DEFAULT_ANALYZE_ABOUT,
  "analyze-about-deep": () => DEFAULT_ANALYZE_ABOUT_DEEP,
  "analyze-graph-deep": () => DEFAULT_ANALYZE_GRAPH_DEEP
};
