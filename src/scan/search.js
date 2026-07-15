// Fast cross-repo search: file NAMES + TEXT inside files, across every open repo at once. Backed by
// ripgrep when one can be resolved (bundled / VS Code / Cursor / PATH), git grep as a fast native
// fallback, and finally a dependency-free Node fs-walk fallback. One reusable searchAcrossRepos() so
// a future MCP server can call the same code.
// Facade: the implementation lives in search.rg.js (ripgrep), search.git.js (git grep),
// search.node.js (pure-Node walker), search.core.js (orchestrator) and search.preview.js.
export { resolveRgInfo, resolveRg } from "./search.rg.js";
export { searchAcrossRepos } from "./search.core.js";
export { readFileForPreview, writeFileForPreview } from "./search.preview.js";
