// Built-in, dependency-free code-graph builder: parses a repo with web-tree-sitter (WASM grammars,
// no Python/native tooling) and emits graph.json ({nodes: files+symbols, links:
// contains/imports/calls/inherits}) for the analysis pipeline.
//
// ARCHITECTURE: this file is a slim FACADE so external import paths stay unchanged. The orchestrator
// (file walk dispatch, the two-pass loop, community, graph.json writer) lives in ./internal-builder.build.js;
// the language registry, web-tree-sitter parser lifecycle, and the cycle-safe file walk live in
// ./internal-builder.langs.js; the per-repo resolvers (JS/TS aliases, go.mod, java index, href, CSS
// selector index) live in ./internal-builder.resolvers.js. Each language lives in its OWN module under
// ./builder/lang-*.js and declares its grammars, file extensions, tree-sitter queries, and a pass1(ctx)
// extractor. To add/fix a language, edit only its module (or add one to LANG_MODULES).
export { buildInternalGraph, writeInternalGraph, INTERNAL_BUILDER_LANGS } from "./internal-builder.build.js";
