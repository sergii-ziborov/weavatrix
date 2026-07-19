// Tool catalog + hot-reload loader. Every tool declares a capability GROUP; the stdio shell exposes
// only the groups enabled for this registration (argv[4]). loadHotApi() re-imports the tool modules
// with a cache-busting version so edits to src/mcp/tools-*.mjs (or this file) go live without an MCP
// reconnect. graph-context.mjs is imported STATICALLY everywhere — it holds process-lifetime caches
// and does not hot-reload (nor do the ../analysis engines; changing those needs a reconnect).
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveNode, isSymbol, stalenessLine, resetStalenessCache} from './graph-context.mjs'
import {createRgResolver} from '../mcp-rg.mjs'
import {readSource, searchCode} from '../mcp-source-tools.mjs'
import {extensionRuntimeSummary, normalizeWeavatrixExtensions} from './extension-api.mjs'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const resolveRg = createRgResolver(SELF_DIR)
// The core artifact has only local profiles. Online packages compose their own profiles through the
// public extension API; the MIT package never contains a capability alias that can enable HTTP.
export const DEFAULT_CAPS = Object.freeze(['graph', 'search', 'source', 'health', 'build', 'retarget', 'crossrepo'])
const PROFILE_CAPS = Object.freeze({
    offline: DEFAULT_CAPS,
    pinned: ['graph', 'search', 'source', 'health', 'build'],
})
const MOVED_PROFILES = new Set(['online', 'osv', 'hosted', 'full'])

// The files whose mtime the stdio shell watches for hot reload — keep in sync with the imports in
// loadHotApi below (catalog.mjs itself is last: a change here re-derives the whole table).
const HOT_FACADES = [
    'tools-graph.mjs', 'tools-impact.mjs', 'tools-health.mjs', 'tools-source.mjs',
    'tools-context.mjs', 'tools-endpoints.mjs', 'tools-actions.mjs',
    'tools-architecture.mjs', 'tools-history.mjs', 'tools-company.mjs',
    'tools-verified-change.mjs',
]
const HOT_OWNERS = [
    'graph/tools-core.mjs', 'graph/tools-query.mjs', 'tools-graph-hubs.mjs',
    'health/duplicates.mjs', 'health/dead-code.mjs', 'health/audit-format.mjs',
    'health/audit.mjs', 'health/structure.mjs', 'health/endpoints.mjs',
    'actions/graph-lifecycle.mjs',
    'architecture-starter.mjs', 'architecture-bootstrap.mjs',
    'company-contract-verdict.mjs',
]
export const HOT_FILES = [...HOT_FACADES, ...HOT_OWNERS, 'catalog.mjs']

function buildTools({tg, ti, th, ts, tb, te, ta, tar, thi, tc, tv, caps}) {
    const tools = [
        {cap: 'graph', name: 'graph_stats', description: 'Return summary statistics: node count, edge count, communities, versioned edge-provenance/legacy-confidence breakdowns, and graph build time vs repo HEAD (staleness).', inputSchema: {type: 'object', properties: {}}, run: (g, a, ctx) => tg.tGraphStats(g, ctx)},
        {cap: 'graph', name: 'get_node', description: 'Get full details for a specific node by label or ID.', inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'Node label or ID to look up'}}, required: ['label']}, run: (g, a, ctx) => tg.tGetNode(g, a, ctx)},
        {cap: 'graph', name: 'get_neighbors', description: 'Get all direct neighbors of a node with edge details (1 hop, call sites deduped). For transitive impact use get_dependents; for the impact of your current branch changes use change_impact.', inputSchema: {type: 'object', properties: {label: {type: 'string'}, relation_filter: {type: 'string', description: 'Optional: filter by relation type'}}, required: ['label']}, run: (g, a, ctx) => tg.tGetNeighbors(g, a, ctx)},
        {cap: 'graph', name: 'query_graph', description: 'Explore a focused production-first graph around a concept or exact symbols (BFS/DFS). Exact seed files/symbols stay pinned; relation_filter and flow_direction support bounded event/data-flow views without a separate tool. Classified paths and unreferenced constant/field leaves stay suppressed unless explicitly requested.', inputSchema: {type: 'object', properties: {question: {type: 'string', description: 'Optional natural-language question or keyword search when exact seeds are not sufficient'}, mode: {type: 'string', enum: ['bfs', 'dfs'], default: 'bfs'}, depth: {type: 'integer', default: 3}, context_filter: {type: 'array', items: {type: 'string'}}, seed_files: {type: 'array', items: {type: 'string'}, maxItems: 12, description: 'Exact repo-relative file paths. Resolved exact seeds remain pinned unless augment_seeds is true'}, seed_symbols: {type: 'array', items: {type: 'string'}, maxItems: 12, description: 'Exact node IDs or unambiguous symbol labels; enables focused flows without fuzzy query seeds'}, relation_filter: {oneOf: [{type: 'array', items: {type: 'string'}}, {type: 'string'}], description: 'Optional relation allow-list, e.g. calls,references,imports'}, flow_direction: {type: 'string', enum: ['forward', 'backward', 'both'], default: 'both', description: 'Traverse outgoing, incoming, or both directions'}, augment_seeds: {type: 'boolean', default: false, description: 'With exact seeds, also add fuzzy question-derived seeds; false keeps traversal strictly pinned'}, include_classified: {type: 'boolean', default: false, description: 'Allow traversal through tests/e2e/generated/mocks/stories/docs/benchmarks/temp and explicitly excluded paths. An explicit class term in the question enables only that class.'}, include_low_signal: {type: 'boolean', default: false, description: 'Include unreferenced constant/field leaf symbols that do not match a query term'}, token_budget: {type: 'integer', description: 'Higher budget shows more nodes/edges', default: 2000}}, anyOf: [{required: ['question']}, {required: ['seed_files']}, {required: ['seed_symbols']}]}, run: (g, a, ctx) => tg.tQueryGraph(g, a, ctx)},
        {cap: 'graph', name: 'god_nodes', description: 'Rank production-code connectivity hubs by unique call/import/reference neighbors, with class/method ownership reported separately from runtime connectivity. Repeated call sites do not inflate the rank; classified tests, generated/build output and other non-product paths are excluded by default.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', default: 10}, include_classified: {type: 'boolean', default: false, description: 'Include tests/e2e/generated/build output/mocks/stories/docs/benchmarks/temp and paths explicitly excluded by repository classification'}}}, run: (g, a, ctx) => tg.tGodNodes(g, a, ctx)},
        {cap: 'graph', name: 'shortest_path', description: 'Find the shortest path between two concepts in the knowledge graph.', inputSchema: {type: 'object', properties: {source: {type: 'string'}, target: {type: 'string'}, max_hops: {type: 'integer', default: 8}}, required: ['source', 'target']}, run: (g, a) => tg.tShortestPath(g, a)},
        {cap: 'graph', name: 'get_dependents', description: 'Transitive blast-radius of ONE node. JavaScript/TypeScript symbols use a cached on-demand EXACT_LSP point query by default, then traverse exact direct callers through the wider graph; incomplete precision is labelled and never silently presented as exact. Set precision=graph to skip LSP or include_container_importers for a conservative module-wide radius.', inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'Node label or ID'}, depth: {type: 'integer', description: 'Max reverse hops, default 3', default: 3}, max_nodes: {type: 'integer', description: 'Max dependents to list, default 40', default: 40}, precision: {type: 'string', enum: ['auto', 'graph', 'lsp'], default: 'auto', description: 'auto uses exact JS/TS point queries when precision is enabled; graph skips LSP; lsp forces an attempt'}, max_references: {type: 'integer', minimum: 1, maximum: 5000, default: 1000}, timeout_ms: {type: 'integer', minimum: 1000, maximum: 60000, default: 30000}, include_container_importers: {type: 'boolean', description: 'Also seed importers of the symbol containing file (broader, conservative; default false)', default: false}}, required: ['label']}, run: (g, a, ctx) => ti.tGetDependents(g, a, ctx)},
        {cap: 'graph', name: 'change_impact', description: 'Verdict-first, symbol-aware blast radius. Parses a zero-context git diff and uses one bounded EXACT_LSP batch query for direct references to changed JavaScript/TypeScript symbols; transitive hops stay explicitly graph-backed. Additive exports do not inherit legacy file importers. Measured coverage is used when present; otherwise static reachability is labelled, not treated as coverage.', inputSchema: {type: 'object', properties: {base: {type: 'string', description: 'Base ref, e.g. origin/main or HEAD~1 (default: first existing of origin/HEAD, origin/main, origin/master, main, master)'}, diff: {type: 'string', maxLength: 2097152, description: 'Optional unified diff (prefer --unified=0) for a PR/change that is not checked out; enables symbol-level classification'}, files: {type: 'array', items: {type: 'string'}, maxItems: 500, description: 'Optional repo-relative changed-file hints. Without diff evidence these are classified conservatively rather than guessed additive'}, depth: {type: 'integer', description: 'Max reverse hops, default 2'}, max_nodes: {type: 'integer', description: 'Max impacted nodes to list, default 40'}, precision: {type: 'string', enum: ['auto', 'graph', 'lsp'], default: 'auto'}, max_references: {type: 'integer', minimum: 1, maximum: 16384, default: 5000}, timeout_ms: {type: 'integer', minimum: 1000, maximum: 60000, default: 45000}}}, run: (g, a, ctx) => ti.tChangeImpact(g, a, ctx)},
        {cap: 'graph', name: 'git_history', description: 'Behavioral architecture evidence from bounded local git history: churn × connectivity hotspots, hidden co-change coupling, and expected test/source coupling. Reads numstat only — never commit messages, authors, or source bodies.', inputSchema: {type: 'object', properties: {months: {type: 'integer', enum: [3, 6, 12], default: 6}, max_commits: {type: 'integer', minimum: 1, maximum: 5000, default: 1000}, min_pair_count: {type: 'integer', minimum: 2, maximum: 100, default: 3}, max_pairs: {type: 'integer', minimum: 1, maximum: 500, default: 100}, top_n: {type: 'integer', minimum: 1, maximum: 50, default: 10}}}, run: (g, a, ctx) => thi.tGitHistory(g, a, ctx)},
        {
            cap: 'graph', refreshGraph: true, name: 'verified_change',
            description: 'Pre-commit, proof-carrying change safeguard. Given a natural-language task and current diff/files, returns compact edit contexts, bounded call-argument data-flow, blast radius, graph/architecture/duplicate/API ratchets, affected tests, and one PASS/BLOCKED/UNKNOWN verdict. Use this high-level workflow before manually composing lower-level checks. Package tests run only when explicitly requested and WEAVATRIX_ALLOW_TEST_RUNS=1.',
            inputSchema: {type: 'object', additionalProperties: false, properties: {
                task: {type: 'string', minLength: 1, maxLength: 4000}, phase: {type: 'string', enum: ['plan', 'verify'], default: 'plan'},
                base_ref: {type: 'string', maxLength: 200, default: 'HEAD'}, diff: {type: 'string', maxLength: 2097152}, files: {type: 'array', items: {type: 'string'}, maxItems: 500},
                precision: {type: 'string', enum: ['auto', 'graph', 'lsp'], default: 'auto'}, max_symbols: {type: 'integer', minimum: 1, maximum: 5, default: 3},
                impact_depth: {type: 'integer', minimum: 1, maximum: 4, default: 2}, max_impact_nodes: {type: 'integer', minimum: 5, maximum: 120, default: 40},
                data_flow_depth: {type: 'integer', minimum: 1, maximum: 3, default: 2}, max_data_flow_edges: {type: 'integer', minimum: 1, maximum: 60, default: 30},
                duplicate_ratchet: {type: 'boolean', default: true},
                api_contract: {type: 'object', additionalProperties: true, properties: {backend: {type: 'string'}, clients: {type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 20}, method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']}, path: {type: 'string', maxLength: 2048}, changed_files: {type: 'array', items: {type: 'string'}, maxItems: 500}}, required: ['backend', 'clients']},
                tests: {type: 'array', maxItems: 5, items: {type: 'object', additionalProperties: false, properties: {script: {type: 'string', maxLength: 120}, args: {type: 'array', maxItems: 40, items: {type: 'string', maxLength: 300}}}, required: ['script']}},
                run_tests: {type: 'boolean', default: false}, test_timeout_ms: {type: 'integer', minimum: 1000, maximum: 300000, default: 60000},
            }, required: ['task']},
            run: (g, a, ctx) => tv.tVerifiedChange(g, a, ctx, {
                impact: ti.tChangeImpact, context: tb.tContextBundle, inspect: ts.tInspectSymbol,
                prepareChange: tar.tPrepareChange, verifyArchitecture: tar.tVerifyArchitecture, traceApi: tc.tTraceApiContract,
            }, {source: caps.has('source'), health: caps.has('health'), crossrepo: caps.has('crossrepo')}),
        },
        {
            cap: 'crossrepo',
            name: 'trace_api_contract',
            description: 'Cross-repository HTTP, GraphQL, gRPC and event/topic contract, handler-liveness and blast-radius evidence. Joins static models with optional revision-bound runtime/OTLP evidence; unobserved dynamic URLs/topics/reflection remain explicit UNKNOWN. Medium/high-confidence external matches mark a handler/contract NOT_DEAD_EXTERNAL_USE. Repository paths stay local and runtime report paths are repository-contained.',
            inputSchema: {
                type: 'object',
                properties: {
                    backend: {type: 'string', description: 'Backend repository UUID or exact unambiguous registry label'},
                    clients: {type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 20, description: 'Client repository UUIDs or exact unambiguous registry labels'},
                    transport: {type: 'string', enum: ['all', 'http', 'graphql', 'grpc', 'event'], default: 'all', description: 'Contract family to trace; all runs static and revision-bound runtime evidence for every supported transport'},
                    method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']},
                    path: {type: 'string', maxLength: 2048, description: 'Optional full route or segment-aligned route fragment; /query matches /edgeAnalytics/query/... and {id}, :id and concrete parameter values are normalized'},
                    changed_files: {type: 'array', items: {type: 'string'}, maxItems: 500, description: 'Optional backend repo-relative changed files; only endpoints declared in those files are traced'},
                    client_names: {type: 'array', items: {type: 'string', pattern: '^[A-Za-z_$][\\w$]{0,127}$'}, maxItems: 40, uniqueItems: true, description: 'Extra object-style clients whose .get/.post/... methods perform HTTP requests; persistent per-repo configuration belongs in .weavatrix.json httpContracts.clientNames'},
                    client_wrappers: {
                        type: 'array', maxItems: 100,
                        description: 'Fixed-method wrapper calls. Use call+method for get(url), or object+member+method for transport.send(url). url_argument is zero-based.',
                        items: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                call: {type: 'string', pattern: '^[A-Za-z_$][\\w$]{0,127}$'},
                                object: {type: 'string', pattern: '^[A-Za-z_$][\\w$]{0,127}$'},
                                member: {type: 'string', pattern: '^[A-Za-z_$][\\w$]{0,127}$'},
                                method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']},
                                url_argument: {type: 'integer', minimum: 0, maximum: 5, default: 0},
                            },
                            anyOf: [
                                {required: ['call', 'method'], not: {anyOf: [{required: ['object']}, {required: ['member']}]}},
                                {required: ['object', 'member', 'method'], not: {required: ['call']}},
                            ],
                        },
                    },
                    auto_discover_wrappers: {type: 'boolean', default: true, description: 'Discover only simple unambiguous functions that forward a URL parameter directly to a known object-style HTTP client'},
                    runtime_config: {type: 'object', maxProperties: 50, additionalProperties: {type: 'string', maxLength: 2048}, description: 'Optional non-secret static bindings for runtime URL prefixes, e.g. process.env.API_BASE. Values are used locally for this call and are not returned.'},
                    runtime_evidence_files: {type: 'object', maxProperties: 21, additionalProperties: {type: 'string', maxLength: 512}, description: 'Optional repository-label/UUID to repository-relative weavatrix.transport-runtime.v1 JSON path. Defaults to .weavatrix/transport-runtime.json or .weavatrix/reports/transport-runtime.json in each repository.'},
                    runtime_evidence_max_age_hours: {type: 'integer', minimum: 1, maximum: 8760, default: 168, description: 'Maximum accepted age for a revision-matched runtime evidence report'},
                    include_tests: {type: 'boolean', default: false},
                    max_impact_depth: {type: 'integer', minimum: 0, maximum: 5, default: 2},
                    max_endpoints: {type: 'integer', minimum: 1, maximum: 500, default: 250},
                    max_matches: {type: 'integer', minimum: 1, maximum: 5000, default: 1000},
                    max_affected_files: {type: 'integer', minimum: 1, maximum: 500, default: 100},
                    top_n: {type: 'integer', minimum: 1, maximum: 50, default: 10},
                },
                required: ['backend', 'clients'],
            },
            run: (g, a, ctx) => tc.tTraceApiContract(g, a, ctx),
        },
        {cap: 'graph', name: 'get_community', description: 'Get all nodes in a community by community ID (0-indexed by size).', inputSchema: {type: 'object', properties: {community_id: {type: 'integer', description: 'Community ID (0-indexed by size)'}}, required: ['community_id']}, run: (g, a) => tg.tGetCommunity(g, a)},
        {cap: 'search', name: 'search_code', description: 'Full-text or regex search across the repo source (ripgrep-backed, Node fallback). The graph only stores structure — use this to find literal text/patterns, then get_node/get_neighbors for structure.', inputSchema: {type: 'object', properties: {query: {type: 'string', description: 'text or regex to search for'}, is_regex: {type: 'boolean', default: false}, glob: {type: 'string', description: 'optional path glob, e.g. "*.js" or "src/**"'}, max_results: {type: 'integer', default: 40}}, required: ['query']}, run: (g, a, ctx) => searchCode({repoRoot: ctx.repoRoot, resolveRg}, a)},
          {cap: 'source', name: 'read_source', description: "Read the actual source of a node (by label/ID) or a repo-relative file path — the symbol's lines with context. The graph stores only locations, not source text. For a path read, pass start_line to anchor the window anywhere in the file (otherwise it shows the head).", inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'node label or ID'}, path: {type: 'string', description: 'or a repo-relative file path'}, start_line: {type: 'integer', description: 'anchor line: window = start_line-before .. start_line+after'}, before: {type: 'integer', default: 3}, after: {type: 'integer', default: 40}}}, run: (g, a, ctx) => readSource({repoRoot: ctx.repoRoot, resolveNode, isSymbol}, g, a)},
          {cap: 'source', refreshGraph: true, name: 'inspect_symbol', description: 'Inspect one exact symbol with an on-demand TypeScript/JavaScript LSP reference query, grouped occurrence containers, graph blast radius, complexity facts and bounded local source context. Ambiguous labels fail closed; point queries never replace the broad precision overlay.', inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'Exact node ID or unambiguous symbol label'}, precision: {type: 'string', enum: ['auto', 'graph', 'lsp'], default: 'auto'}, max_references: {type: 'integer', minimum: 1, maximum: 5000, default: 1000}, max_containers: {type: 'integer', minimum: 1, maximum: 50, default: 15}, context_lines: {type: 'integer', minimum: 0, maximum: 40, default: 8}, timeout_ms: {type: 'integer', minimum: 1000, maximum: 60000, default: 30000}}, required: ['label']}, run: (g, a, ctx) => ts.tInspectSymbol(g, a, ctx)},
          {cap: 'source', refreshGraph: true, name: 'context_bundle', description: 'Return one compact, bounded source bundle for an exact symbol: definition, production-first inbound/outbound containers, exact re-export sites, on-demand TS/JS reference evidence and diverse excerpts around call sites. Use before an edit when query_graph would be too broad.', inputSchema: {type: 'object', properties: {label: {type: 'string', description: 'Exact node ID or unambiguous symbol label'}, precision: {type: 'string', enum: ['auto', 'graph', 'lsp'], default: 'auto'}, max_references: {type: 'integer', minimum: 1, maximum: 5000, default: 1000}, max_related: {type: 'integer', minimum: 1, maximum: 30, default: 10}, max_reexports: {type: 'integer', minimum: 1, maximum: 100, default: 20}, max_source_files: {type: 'integer', minimum: 1, maximum: 8, default: 4}, context_lines: {type: 'integer', minimum: 0, maximum: 12, default: 4}, include_classified: {type: 'boolean', default: false, description: 'Include test/e2e/generated/mock/story/docs/benchmark/temp callers after production callers'}, timeout_ms: {type: 'integer', minimum: 1000, maximum: 60000, default: 30000}}, required: ['label']}, run: (g, a, ctx) => tb.tContextBundle(g, a, ctx, ts.tInspectSymbol)},
        {cap: 'health', name: 'find_duplicates', description: "Content-based clone detection over production code (MOSS winnowing over method bodies). Supports high-confidence small clones down to 12 tokens when min_tokens is lowered. Tests, classified non-product paths, all-router framework boilerplate and immutable declarative catalogs are excluded by default; opt them in explicitly.", inputSchema: {type: 'object', properties: {min_similarity: {type: 'integer', description: '50-100, default 80 (ignored in semantic mode)'}, min_tokens: {type: 'integer', minimum: 12, maximum: 400, description: 'min fragment size, 12-400; default 50'}, mode: {type: 'string', enum: ['renamed', 'strict', 'semantic'], default: 'renamed'}, include_tests: {type: 'boolean', default: false}, include_classified: {type: 'boolean', default: false, description: 'Include generated/mock/story/docs/benchmark/temp and paths explicitly classified as excluded; tests still require include_tests'}, include_boilerplate: {type: 'boolean', default: false, description: 'Include clone groups made entirely of conventional *.router.js/ts router symbols'}, include_declarative: {type: 'boolean', default: false, description: 'Include repeated immutable array/object catalogs that contain no executable control flow'}, include_strings: {type: 'boolean', description: 'Also clone-check large multi-line string literals', default: false}, top_n: {type: 'integer', default: 15}}}, run: (g, a, ctx) => th.tFindDuplicates(g, a, ctx)},
        {cap: 'health', name: 'find_dead_code', description: 'Conservative review queue for statically unreferenced files, functions, methods and symbols. Returns confidence, reason, bounded evidence and explicit framework/dynamic/reflection/public-API caveats; never an auto-delete verdict. Tests, generated code, mocks, stories, docs, benchmarks and temporary roots are excluded by default.', inputSchema: {type: 'object', properties: {path: {type: 'string', maxLength: 1024, description: 'Optional repo-relative path prefix'}, kinds: {type: 'array', items: {type: 'string', enum: ['file', 'function', 'method', 'symbol']}, maxItems: 4, uniqueItems: true, description: 'Optional candidate kinds; defaults to all'}, min_confidence: {type: 'string', enum: ['high', 'medium', 'low'], default: 'medium', description: 'Minimum confidence to include. low explicitly includes public/framework/dynamic review candidates'}, include_tests: {type: 'boolean', default: false}, include_classified: {type: 'boolean', default: false, description: 'Include generated/mock/story/docs/benchmark/temp and paths explicitly classified as excluded; tests still require include_tests'}, top_n: {type: 'integer', minimum: 1, maximum: 100, default: 30}}}, run: (g, a, ctx) => th.tFindDeadCode(g, a, ctx)},
        {cap: 'health', name: 'run_audit', description: 'Core production-first repository Health review with an explicit capability/completeness matrix for structure, dependencies, bounded runtime-correctness/concurrency patterns, advisories, malware and coverage. Unsupported Maven/Gradle import verification is NOT_SUPPORTED/PARTIAL, never a clean zero. Findings whose evidence is entirely test/e2e/generated/mock/story/docs/benchmark/temp or explicitly excluded are suppressed by default; opt them in with include_classified. category=dependencies is a dedicated dependency-health projection across missing, unused and duplicate declarations while preserving each finding\'s native category. With base_ref, builds and audits an immutable Git checkout and compares stable deterministic finding IDs; debt defaults to genuinely new findings. Supply-chain checks remain explicitly uncomparable across the source-only baseline. changed_files without base_ref is only changed-scope, never a new-debt claim.', inputSchema: {type: 'object', properties: {category: {type: 'string', enum: ['dependencies', 'unused', 'structure', 'vulnerability', 'malware'], description: 'Only findings of this category; dependencies selects dependency manifest/import findings across native categories'}, min_severity: {type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Minimum severity to include'}, max_findings: {type: 'integer', description: 'Max findings to list, default 30'}, include_classified: {type: 'boolean', default: false, description: 'Include findings whose evidence is entirely tests/e2e/generated/mocks/stories/docs/benchmarks/temp or explicitly excluded'}, include_malware_scan: {type: 'boolean', description: 'Also grep installed packages for malware heuristics (slow)', default: false}, base_ref: {type: 'string', maxLength: 200, description: 'Optional immutable Git baseline (for example HEAD~1 or origin/main). Enables honest new/existing/fixed debt comparison'}, changed_files: {type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 500, description: 'Optional explicit repo-relative scope. Without base_ref this is changed-scope only; when omitted with base_ref, files are derived from the Git diff'}, debt: {type: 'string', enum: ['new', 'existing', 'all'], default: 'new', description: 'Baseline comparison view. Defaults to genuinely new deterministic findings when base_ref is present'}}}, run: (g, a, ctx) => th.tRunAudit(g, a, ctx)},
        {cap: 'health', name: 'coverage_map', description: 'Map a real existing coverage report onto the graph. If no report exists, return clearly labelled static test reachability (a test imports/reaches a source file) with actualCoverage=NOT_AVAILABLE; reachability is never presented as measured coverage.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', description: 'Max risk hotspots to list, default 15'}, path: {type: 'string', description: 'Optional repo-relative path prefix filter, e.g. src/query'}}}, run: (g, a, ctx) => th.tCoverageMap(g, a, ctx)},
        {cap: 'health', name: 'hot_path_review', description: 'Rank a focused production-symbol hot-path queue from parser-derived local complexity, inside-loop allocations/copies/scans/sorts/recursion, graph fan-in/fan-out, and measured coverage or clearly labelled static test reachability. The default score gate is 85 with a narrow strong-local fallback; set min_score=0 for the full diagnostic queue. This is not profiler data or interprocedural Big-O.', inputSchema: {type: 'object', properties: {path: {type: 'string', maxLength: 1024, description: 'Optional repository-relative path prefix'}, top_n: {type: 'integer', minimum: 1, maximum: 100, default: 20}, min_score: {type: 'integer', minimum: 0, maximum: 100, default: 85, description: 'Focused default is 85; lower explicitly to broaden, or use 0 for every threshold-matching diagnostic candidate'}, cyclomatic_threshold: {type: 'integer', minimum: 2, maximum: 1000, default: 8}, call_threshold: {type: 'integer', minimum: 1, maximum: 10000, default: 12}, loop_depth_threshold: {type: 'integer', minimum: 1, maximum: 10, default: 2}, time_rank_threshold: {type: 'integer', minimum: 0, maximum: 5, default: 2}, include_tests: {type: 'boolean', default: false}, include_classified: {type: 'boolean', default: false, description: 'Include generated/mock/story/docs/benchmark/temp and explicitly excluded paths; tests still require include_tests'}}}, run: (g, a, ctx) => th.tHotPathReview(g, a, ctx)},
        {cap: 'graph', name: 'list_communities', description: 'List graph communities named by their dominant folder (largest first) with sample files — a readable module overview; feed the list position into get_community.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', description: 'Max communities to list, default 20'}}}, run: (g, a, ctx) => th.tListCommunities(g, a, ctx)},
        {cap: 'graph', name: 'module_map', description: 'First orientation view for understanding an unfamiliar application with little context: a production-first folder architecture map with file/symbol counts and strongest module dependencies, separating runtime, TypeScript type-only and language compile-only coupling.', inputSchema: {type: 'object', properties: {top_n: {type: 'integer', description: 'Max modules to list, default 25'}, include_non_product: {type: 'boolean', default: false, description: 'Include tests, fixtures, benchmarks, generated output, docs and other classified non-product files; false by default'}}}, run: (g, a, ctx) => th.tModuleMap(g, a, ctx)},
        {cap: 'source', refreshGraph: true, name: 'list_endpoints', description: 'Inventory of HTTP endpoints defined in the repo (Express/Fastify/Nest/Flask/FastAPI/Go mux/Rust axum and actix-web/Spring MVC and WebFlux): declared and reachable composed paths, static mount provenance, confidence, handler, file:line, and Spring conditional/default-active state.', inputSchema: {type: 'object', properties: {method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'ALL', 'ANY']}, path: {type: 'string', maxLength: 2048, description: 'Optional exact composed path or segment-aligned suffix'}, max_results: {type: 'integer', description: 'Max endpoints to list, default 100'}}}, run: (g, a, ctx) => th.tListEndpoints(g, a, ctx)},
        {cap: 'source', refreshGraph: true, name: 'trace_endpoint', description: 'Resolve one exact reachable HTTP endpoint, prove its router mount chain, bind its handler symbol, and return a bounded production-only multi-hop call graph with call-site excerpts. This is a focused projection of the repository graph, not text-search inference.', inputSchema: {type: 'object', properties: {path: {type: 'string', minLength: 1, maxLength: 2048, description: 'Exact composed path; a suffix is accepted only when unambiguous'}, method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'ALL', 'ANY']}, max_depth: {type: 'integer', minimum: 1, maximum: 4, default: 3}, max_nodes: {type: 'integer', minimum: 2, maximum: 40, default: 20}, max_excerpts: {type: 'integer', minimum: 0, maximum: 12, default: 6}, context_lines: {type: 'integer', minimum: 0, maximum: 6, default: 2}, include_classified: {type: 'boolean', default: false, description: 'Include test/e2e/generated/mock/story/docs/benchmark/temp and explicitly excluded targets'}}, required: ['path']}, run: (g, a, ctx) => te.tTraceEndpoint(g, a, ctx)},
        {cap: 'build', name: 'rebuild_graph', description: "Rebuild the active full-repository graph and report a structural delta. Omitted mode/precision preserve the active graph; a first build uses full and the startup precision setting (lsp unless WEAVATRIX_PRECISION=off). The local TypeScript/JavaScript LSP overlay validates bounded ambiguous edges; precision:off is an explicit fallback. With scope, build an isolated diagnostic graph without replacing or diffing the full graph.", inputSchema: {type: 'object', properties: {mode: {type: 'string', enum: ['full', 'no-tests', 'tests-only'], description: 'Build mode; omit to preserve the active mode (or use full for a first build)'}, precision: {type: 'string', enum: ['lsp', 'off'], description: 'Semantic precision; omit to preserve the active mode (or use the startup setting for a first build)'}, scope: {type: 'string', description: 'Optional isolated diagnostic path prefix; never replaces the active full graph'}}}, run: (g, a, ctx) => ta.tRebuildGraph(g, a, ctx)},
        {cap: 'graph', name: 'graph_diff', description: 'Structural graph diff: compare the current graph with an immutable Git-ref baseline (base_ref such as HEAD~1 or main), or with graph.prev.json from the last rebuild when base_ref is omitted. Reports architecture drift, cycle changes and symbols that lost their last caller.', inputSchema: {type: 'object', properties: {base_ref: {type: 'string', maxLength: 256, description: 'Optional immutable Git baseline to build in isolation, e.g. HEAD~1, main or origin/main; never checks out or mutates the working tree'}, path: {type: 'string', description: 'Optional node-id/path prefix to scope the diff, e.g. src/query'}}}, run: (g, a, ctx) => ti.tGraphDiff(g, a, ctx)},
        {cap: 'graph', name: 'get_architecture_contract', description: 'Read the owner-approved architecture target or safely bootstrap one. With action=preview, returns an adaptive candidate, observed-but-not-enforced dependency directions, verification, exact file content/hash and a short-lived confirmation token. action=approve creates the local contract only after explicit token confirmation and never overwrites an active target.', inputSchema: {type: 'object', properties: {action: {type: 'string', enum: ['preview', 'approve'], description: 'Omit to read; preview is dry-run only; approve requires the preview token'}, candidate_contract: {type: 'object', description: 'Optional reviewed candidate to normalize and verify during preview'}, baseline_mode: {type: 'string', enum: ['none', 'accept-current'], default: 'none', description: 'Whether preview should materialize current violations as an explicit ratchet baseline'}, confirm_token: {type: 'string', description: 'One-time token returned by preview; required for approve'}}}, run: (g, a, ctx) => tar.tGetArchitectureContract(g, a, ctx)},
        {cap: 'graph', name: 'prepare_change', description: 'Select active target-architecture rules for an intended set of changed files. Run before a non-trivial edit.', inputSchema: {type: 'object', properties: {intent: {type: 'string'}, files: {type: 'array', items: {type: 'string'}, maxItems: 200}}, required: ['files']}, run: (g, a, ctx) => tar.tPrepareChange(g, a, ctx)},
        {cap: 'health', name: 'verify_architecture', description: 'Verify the fresh graph against the active target contract and ratchet; separates new, existing, fixed and excepted debt.', inputSchema: {type: 'object', properties: {}}, run: (g, a, ctx) => tar.tVerifyArchitecture(g, a, ctx)},
        {cap: 'health', name: 'explain_architecture_violation', description: 'Explain one active architecture violation and the governing rule.', inputSchema: {type: 'object', properties: {fingerprint: {type: 'string'}}, required: ['fingerprint']}, run: (g, a, ctx) => tar.tExplainArchitectureViolation(g, a, ctx)},
        {cap: 'health', name: 'propose_architecture_exception', description: 'Prepare, but never apply, a bounded exception proposal for human review.', inputSchema: {type: 'object', properties: {fingerprint: {type: 'string'}, reason: {type: 'string'}, expires: {type: 'string', description: 'Optional YYYY-MM-DD'}}, required: ['fingerprint', 'reason']}, run: (g, a, ctx) => tar.tProposeArchitectureException(g, a, ctx)},
        {cap: 'retarget', name: 'open_repo', description: 'OFFLINE RETARGET: switch this server to another local Git repository, building its graph when missing. This explicit tool call changes the active repository boundary; pass build:false to probe without building. Omitted mode/precision preserve an existing graph; a new graph uses full and the startup precision setting (lsp unless WEAVATRIX_PRECISION=off). Omit the retarget capability at registration to pin one repository.', inputSchema: {type: 'object', properties: {path: {type: 'string', description: 'Absolute path to a Git working tree'}, build: {type: 'boolean', description: 'Build the graph when missing (default true)', default: true}, mode: {type: 'string', enum: ['full', 'no-tests', 'tests-only'], description: 'Optional build mode override; omit to preserve an existing graph'}, precision: {type: 'string', enum: ['lsp', 'off'], description: 'Optional semantic precision override; omit to preserve an existing graph or use the startup setting for a new graph'}} , required: ['path']}, run: (g, a, ctx) => ta.tOpenRepo(g, a, ctx)},
        {cap: 'retarget', name: 'list_known_repos', description: 'OFFLINE RETARGET: list every registered local repository graph from the global per-user registry, regardless of parent folder.', inputSchema: {type: 'object', properties: {}}, run: (g, a, ctx) => ta.tListKnownRepos(g, a, ctx)},
    ]
    // Every tool supports the same machine-output switch. Text mode is TextContent-only so large
    // analysis payloads are not duplicated into an agent's context; JSON opts into structuredContent
    // and mirrors that envelope into TextContent for older workflow runners. Since MCP output schemas
    // apply to every invocation, tools do not advertise one conditionally here.
    return tools.map((tool) => ({
        ...tool,
        inputSchema: {
            ...(tool.inputSchema || {type: 'object'}),
            properties: {
                ...(tool.inputSchema?.properties || {}),
                output_format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    default: 'text',
                    description: 'text returns only the concise TextContent summary; json also returns and mirrors the stable structuredContent envelope',
                },
            },
        },
    }))
}

// Import the tool modules (cache-busted when version > 0), build the catalog, apply the caps filter.
// capsArg semantics: undefined/null = offline defaults; a
// present string (even '') is an explicit selection, so "select nothing" really exposes nothing.
export async function loadHotApi(version, capsArg, {extensions: extensionDefinitions = []} = {}) {
    const v = version ? `?v=${version}` : ''
    const [tg, ti, th, ts, tb, te, ta, tar, thi, tc, tv] = await Promise.all([
        import(new URL(`./tools-graph.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-impact.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-health.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-source.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-context.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-endpoints.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-actions.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-architecture.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-history.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-company.mjs${v}`, import.meta.url).href),
        import(new URL(`./tools-verified-change.mjs${v}`, import.meta.url).href),
    ])
    const extensions = normalizeWeavatrixExtensions(extensionDefinitions)
    const extensionProfiles = Object.assign({}, ...extensions.map((extension) => extension.profiles))
    for (const name of Object.keys(extensionProfiles)) {
        if (Object.hasOwn(PROFILE_CAPS, name)) throw new TypeError(`extension profile collides with core profile: ${name}`)
    }
    const profiles = {...PROFILE_CAPS, ...extensionProfiles}
    const raw = capsArg == null ? 'offline' : String(capsArg).trim()
    if (MOVED_PROFILES.has(raw) && !Object.hasOwn(extensionProfiles, raw)) {
        throw new Error(`MCP profile "${raw}" moved to weavatrix-online; the MIT core exposes only offline network-free profiles`)
    }
    const profile = Object.hasOwn(profiles, raw) ? raw : 'custom'
    const selected = profiles[raw] || raw.split(',').map((s) => s.trim()).filter(Boolean)
    const caps = new Set(selected)
    const coreTools = buildTools({tg, ti, th, ts, tb, te, ta, tar, thi, tc, tv, caps})
    const extensionTools = extensions.flatMap((extension) => extension.tools.map((tool) => ({...tool, extension: extension.name})))
    const all = [...coreTools, ...extensionTools.map((tool) => ({
        ...tool,
        inputSchema: {
            ...(tool.inputSchema || {type: 'object'}),
            properties: {
                ...(tool.inputSchema?.properties || {}),
                output_format: {
                    type: 'string', enum: ['text', 'json'], default: 'text',
                    description: 'text returns concise TextContent; json also returns the stable structuredContent envelope',
                },
            },
        },
    }))]
    const toolNames = new Set()
    for (const tool of all) {
        if (toolNames.has(tool.name)) throw new TypeError(`extension tool collides with an existing tool: ${tool.name}`)
        toolNames.add(tool.name)
    }
    const tools = all.filter((t) => caps.has(t.cap))
    return {
        tools,
        byName: new Map(tools.map((t) => [t.name, t])),
        caps,
        profile,
        extensions: {
            items: extensionRuntimeSummary(extensions),
            auditProviders: extensions.flatMap((extension) => extension.auditProviders.map((provider) => ({...provider, extension: extension.name}))),
            skills: extensions.flatMap((extension) => extension.skills.map((skill) => ({...skill, extension: extension.name}))),
        },
        stalenessLine,
        resetStalenessCache,
    }
}
