// Health tools: clone detection, the internal audit, community/module overviews, coverage mapping
// and the HTTP endpoint inventory. Hot-reloadable (re-imported by catalog.mjs on change).
import {degreeOf, rawGraph} from './graph-context.mjs'
import {computeDuplicates} from '../analysis/duplicates.js'
import {runInternalAudit} from '../analysis/internal-audit.js'
import {summarizeCommunities, aggregateGraph} from '../analysis/graph-analysis.js'
import {detectEndpoints} from '../analysis/endpoints.js'

// Group clone pairs into union-find families.
function groupClones(data, {simMin, tokMin, mode, skipTests}) {
    const frags = data.frags || []
    const elig = (i) => frags[i].n >= tokMin && (!skipTests || !frags[i].test)
    const pairs = (data.modes?.[mode] || []).filter(([i, j, s]) => s >= simMin && elig(i) && elig(j))
    const parent = new Map()
    const find = (x) => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); return r }
    for (const [i, j] of pairs) { if (!parent.has(i)) parent.set(i, i); if (!parent.has(j)) parent.set(j, j); parent.set(find(i), find(j)) }
    const groups = new Map()
    for (const [i, j, s] of pairs) {
        const r = find(i)
        if (!groups.has(r)) groups.set(r, {members: new Set(), maxSim: 0})
        const g = groups.get(r); g.members.add(i); g.members.add(j); g.maxSim = Math.max(g.maxSim, s)
    }
    return [...groups.values()].map((g) => {
        const members = [...g.members].sort((a, b) => frags[b].n - frags[a].n)
        return {members: members.map((i) => frags[i]), maxSim: g.maxSim, tokens: members.reduce((n, i) => n + frags[i].n, 0)}
    }).sort((a, b) => b.tokens - a.tokens)
}

export function tFindDuplicates(g, args, ctx) {
    if (!ctx.repoRoot) return 'Duplicate scan needs the repo root (not provided to this server).'
    const simMin = Math.min(100, Math.max(50, Number(args.min_similarity) || 80))
    const tokMin = Math.min(400, Math.max(30, Number(args.min_tokens) || 50))
    const mode = args.mode === 'strict' ? 'strict' : 'renamed'
    const skipTests = args.include_tests ? false : true
    const includeStrings = !!args.include_strings
    // semantic mode: same-name symbols across files, ranked by size — LOW similarity is the signal
    // (same name, drifted behavior). Token-clone pairing is skipped entirely.
    if (args.mode === 'semantic') {
        const data = computeDuplicates(ctx.repoRoot, ctx.graphPath, {nameTwins: true})
        const frags = data.frags
        const candidates = []
        for (const twin of data.nameTwins || []) {
            const allowed = new Set(twin.members.filter((i) => (!skipTests || !frags[i].test) && frags[i].n >= tokMin))
            const pairs = (twin.pairs || []).filter((p) => allowed.has(p.a) && allowed.has(p.b))
            if (!pairs.length) continue
            const closest = pairs.slice().sort((a, b) => b.similarity - a.similarity)[0]
            const farthest = pairs.slice().sort((a, b) => a.similarity - b.similarity)[0]
            if (closest.similarity >= 85) candidates.push({kind: 'clone', label: twin.label, pair: closest})
            if (farthest.similarity <= 45) candidates.push({kind: 'collision', label: twin.label, pair: farthest})
        }
        for (const item of candidates) item.tokens = frags[item.pair.a].n + frags[item.pair.b].n
        candidates.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'clone' ? -1 : 1
            return a.kind === 'clone'
                ? b.pair.similarity - a.pair.similarity || b.tokens - a.tokens
                : b.tokens - a.tokens || a.pair.similarity - b.pair.similarity
        })
        if (!candidates.length) return 'No actionable same-name pairs across files (semantic mode; ambiguous middle-similarity pairs are suppressed).'
        const top = candidates.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
        const lines = top.map((item, k) => {
            const a = frags[item.pair.a]
            const b = frags[item.pair.b]
            const verdict = item.kind === 'clone'
                ? 'near-identical duplicate candidate — review, then extract shared logic if the contract is truly shared'
                : 'name collision, not a duplicate — inspect only if these definitions should share a contract'
            return [
                `${k + 1}. "${item.label}" — ${item.pair.similarity}% similar; ${verdict}`,
                `     ${a.file}:${a.start}-${a.end}  (${a.n} tok)`,
                `     ${b.file}:${b.start}-${b.end}  (${b.n} tok)`,
            ].join('\n')
        })
        return `Found ${candidates.length} actionable same-name pair(s) across files (semantic mode; one closest clone and/or farthest collision per name). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nThese are review candidates, not automatic refactors. Use read_source on both sites before changing code.`
    }
    const data = computeDuplicates(ctx.repoRoot, ctx.graphPath, {includeStrings})
    const groups = groupClones(data, {simMin, tokMin, mode, skipTests})
    if (!groups.length) return `No clones at ≥${simMin}% similarity / ≥${tokMin} tokens (${mode} mode). Try lowering the thresholds.`
    const top = groups.slice(0, Math.min(30, Math.max(1, Number(args.top_n) || 15)))
    const lines = top.map((grp, k) => {
        const isStr = grp.members.some((f) => f.kind === 'string')
        const head = `${k + 1}. ${grp.members.length}× "${grp.members[0].label}"${isStr ? ' [string literal]' : ''} — ≤${grp.maxSim}% similar, ${grp.tokens} duplicated tokens`
        const sites = grp.members.slice(0, 8).map((f) => `     ${f.file}:${f.start}-${f.end}`)
        return [head, ...sites].join('\n')
    })
    return `Found ${groups.length} clone group(s) (${mode} mode, ≥${simMin}%, ≥${tokMin} tok${includeStrings ? ', incl. large string literals' : ''}). Top ${top.length}:\n\n${lines.join('\n\n')}\n\nUse read_source on any two sites to compare, then extract shared logic.`
}

const SEVERITY_RANK = {critical: 0, high: 1, medium: 2, low: 3, info: 4}

export function formatAuditFinding(f) {
    const where = f.file ? `  (${f.file}${f.symbol ? ` ${f.symbol}` : ''})` : f.package ? `  (pkg ${f.package}${f.version ? `@${f.version}` : ''}${f.manifest ? `; ${f.manifest}` : ''})` : ''
    return `  [${f.severity}/${f.confidence || '?'}] ${f.rule}: ${f.title}${where}${f.reason ? `\n      reason: ${f.reason}` : ''}${f.cycleRoute ? `\n      route: ${f.cycleRoute}` : ''}${f.fixHint ? `\n      fix: ${f.fixHint}` : ''}`
}

// Full internal health audit: dead code + unused exports, dependency findings (npm/go/py missing &
// unused deps), structure (import cycles / orphans / boundary rules), supply-chain (offline OSV
// advisories, typosquat, lockfile drift), optional malware heuristics.
export async function tRunAudit(g, args, ctx) {
    if (!ctx.repoRoot) return 'Audit needs the repo root (not provided to this server).'
    const audit = await runInternalAudit(ctx.repoRoot, {
        graph: rawGraph(ctx),
        skipMalwareScan: !args.include_malware_scan, // greps installed packages — slow, so opt-in
    })
    if (!audit.ok) return `Audit failed: ${audit.error}`
    const minSev = SEVERITY_RANK[args.min_severity] ?? 4
    const cat = args.category ? String(args.category) : null
    const max = Math.max(1, Math.min(100, Number(args.max_findings) || 30))
    const filtered = audit.findings
        .filter((f) => (SEVERITY_RANK[f.severity] ?? 4) <= minSev)
        .filter((f) => !cat || f.category === cat)
    const shown = filtered.slice(0, max)
    const sev = audit.summary.bySeverity
    const bycat = audit.summary.byCategory
    const check = (name, state) => `${name} ${state?.status || 'ERROR'}${state?.detail ? ` — ${state.detail}` : ''}`
    return [
        `Internal audit of ${audit.repo} (${audit.scanned.files} files, ${audit.scanned.symbols} symbols, ${audit.scanned.externalImports} external imports; malware scan: ${audit.scanned.malwareScanMode}).`,
        `Severity: critical ${sev.critical}, high ${sev.high}, medium ${sev.medium}, low ${sev.low}, info ${sev.info}. Categories: unused ${bycat.unused}, structure ${bycat.structure}, vulnerability ${bycat.vulnerability}, malware ${bycat.malware}.`,
        `Structure: ${audit.structureReport?.runtimeCycles ?? audit.structureReport?.cycles ?? 0} runtime cycle(s), ${audit.structureReport?.compileTimeCouplings ?? audit.structureReport?.typeCouplings ?? 0} compile-time coupling group(s), ${audit.structureReport?.orphans ?? 0} orphan(s); import edges: ${audit.structureReport?.runtimeImportEdges ?? audit.structureReport?.importEdges ?? 0} runtime + ${audit.structureReport?.typeOnlyImportEdges ?? 0} type-only + ${audit.structureReport?.compileOnlyImportEdges ?? 0} compile-only. Dead: ${audit.deadReport.deadFiles} file(s), ${audit.deadReport.unusedExports} unused export(s).`,
        `Checks: ${check('OSV', audit.checks?.osv)}; ${check('malware', audit.checks?.malware)}. A NOT_CHECKED/PARTIAL/ERROR check is incomplete or unknown, never a clean zero.`,
        ``,
        `Showing ${shown.length} of ${filtered.length} finding(s)${cat ? ` in category "${cat}"` : ''}${args.min_severity ? ` at ≥${args.min_severity}` : ''}:`,
        ...shown.map(formatAuditFinding),
        filtered.length > shown.length ? `  … +${filtered.length - shown.length} more (raise max_findings or filter by category/min_severity)` : null,
    ].filter((x) => x != null).join('\n')
}

// Named module clusters: graph communities labeled by their dominant folder instead of bare numbers.
export function tListCommunities(g, args, ctx) {
    const max = Math.max(1, Math.min(100, Number(args.top_n) || 20))
    const list = summarizeCommunities(ctx.graphPath, max)
    if (!list.length) return 'No communities found in the graph.'
    return [
        `Communities, largest first (list position = community_id for get_community):`,
        ...list.map((c, i) => `${String(i).padStart(3)}. ${c.name} — ${c.size} nodes (raw id ${c.id}; e.g. ${[...new Set(c.files)].join(', ')})`),
    ].join('\n')
}

// Folder-level architecture map: modules (top-two path segments) with file/symbol counts and the
// strongest module→module dependencies. Pure graph aggregation — no filesystem reads.
export function tModuleMap(g, args, ctx) {
    const agg = aggregateGraph(rawGraph(ctx), null)
    const topN = Math.max(1, Math.min(60, Number(args.top_n) || 25))
    const mods = agg.modules.slice(0, topN)
    const edges = agg.moduleEdges.slice(0, Math.min(50, topN * 2))
    const compileEdges = new Map()
    const collectCompileEdges = (list, kind) => {
        for (const edge of list || []) {
            const key = `${edge.from}\0${edge.to}`
            const current = compileEdges.get(key) || {from: edge.from, to: edge.to, count: 0, typeOnly: 0, compileOnly: 0}
            current.count += edge.count
            current[kind] += edge.count
            compileEdges.set(key, current)
        }
    }
    collectCompileEdges(agg.typeOnlyModuleEdges, 'typeOnly')
    collectCompileEdges(agg.compileOnlyModuleEdges, 'compileOnly')
    const compiled = [...compileEdges.values()].sort((a, b) => b.count - a.count).slice(0, Math.min(50, topN * 2))
    return [
        `Module map: ${agg.totals.files} files in ${agg.modules.length} folder-modules, ${agg.totals.moduleEdges} runtime module dependencies and ${agg.totals.compileTimeModuleEdges || 0} compile-time dependencies (${agg.totals.typeOnlyModuleEdges || 0} type-only, ${agg.totals.compileOnlyModuleEdges || 0} compile-only). Top ${mods.length}:`,
        ...mods.map((m) => `  ${m.name} — ${m.fileCount} files, ${m.symbolCount} symbols`),
        ``,
        `Strongest runtime module dependencies:`,
        ...edges.map((e) => `  ${e.from} → ${e.to}  (${e.count})`),
        compiled.length ? `` : null,
        compiled.length ? `Compile-time module dependencies (not runtime coupling):` : null,
        ...compiled.map((e) => `  ${e.from} → ${e.to}  (${e.count}; ${e.typeOnly} type-only, ${e.compileOnly} compile-only)`),
    ].filter((line) => line != null).join('\n')
}

// Coverage × graph: map an EXISTING coverage report (istanbul/lcov/coverage.py/Go — read offline,
// tests are never executed here) onto files and symbols, then rank refactor risk as
// connectivity × uncovered share. Pairs with get_dependents: many dependents + low coverage ⇒ write
// tests before changing. Coverage pcts in this layer are fractions (0..1).
export function tCoverageMap(g, args, ctx) {
    if (!ctx.repoRoot) return 'Coverage mapping needs the repo root (not provided to this server).'
    const agg = aggregateGraph(rawGraph(ctx), ctx.repoRoot)
    const pathFilter = args.path ? String(args.path).replace(/\\/g, '/').replace(/\/+$/, '') : null
    const inScope = (p) => !pathFilter || p === pathFilter || String(p).startsWith(`${pathFilter}/`)
    const allFiles = agg.modules.flatMap((m) => m.files.filter((f) => inScope(f.path)))
    const measured = allFiles.filter((f) => f.coverage != null)
    if (!measured.length) {
        return [
            `No coverage report found${pathFilter ? ` for ${pathFilter}` : ''} — this tool reads existing reports, it does not run tests.`,
            'Generate one with the repo\'s own test runner, then call coverage_map again:',
            '  JS/TS:  npx vitest run --coverage   (or jest --coverage)',
            '  Python: pytest --cov --cov-report=json',
            '  Go:     go test ./... -coverprofile=coverage.out',
            'Read locations: coverage/coverage-summary.json, coverage/coverage-final.json, (coverage/)lcov.info, coverage.json, coverage.out.',
        ].join('\n')
    }
    const pctStr = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)
    const sources = [...new Set(measured.map((f) => f.coverageSource).filter(Boolean))]
    const avg = measured.reduce((s, f) => s + f.coverage, 0) / measured.length
    const rollup = agg.modules
        .map((m) => {
            const withCov = m.files.filter((f) => f.coverage != null && inScope(f.path))
            if (!withCov.length) return null
            return {
                name: m.name,
                measured: withCov.length,
                total: m.files.filter((f) => inScope(f.path)).length,
                avg: withCov.reduce((s, f) => s + f.coverage, 0) / withCov.length,
            }
        })
        .filter(Boolean)
        .sort((a, b) => a.avg - b.avg)
    const topN = Math.max(1, Math.min(50, Number(args.top_n) || 15))
    // risk = graph degree × uncovered share; only symbols below 80% matter
    const risky = agg.symbols
        .filter((s) => s.coverage != null && s.coverage < 0.8 && inScope(s.file))
        .map((s) => ({...s, degree: degreeOf(g, s.id)}))
        .filter((s) => s.degree > 0)
        .sort((a, b) => b.degree * (1 - b.coverage) - a.degree * (1 - a.coverage))
        .slice(0, topN)
    return [
        `Coverage map (${measured.length}/${allFiles.length} files measured, avg ${pctStr(avg)}; report: ${sources.join(', ') || 'unknown'}${pathFilter ? `; filter ${pathFilter}` : ''}).`,
        ``,
        `Modules by average coverage (worst first):`,
        ...rollup.slice(0, 20).map((m) => `  ${pctStr(m.avg).padStart(5)}  ${m.name}  (${m.measured}/${m.total} files measured)`),
        ``,
        `Refactor-risk hotspots — connected symbols with low coverage (ranked by degree × uncovered):`,
        ...(risky.length
            ? risky.map((s) => `  ${pctStr(s.coverage).padStart(5)}  deg ${String(s.degree).padStart(3)}  ${s.label}  (${s.file}${s.line ? `:${s.line}` : ''})`)
            : ['  (none — every connected symbol is ≥80% covered or unmeasured)']),
        ``,
        `Tip: before refactoring a hotspot, run get_dependents on it — low coverage × many dependents means write tests first.`,
    ].join('\n')
}

// HTTP endpoint inventory: Express/Fastify/Nest/Flask/FastAPI/Go-mux style route definitions.
export function tListEndpoints(g, args, ctx) {
    if (!ctx.repoRoot) return 'Endpoint detection needs the repo root (not provided to this server).'
    const graph = rawGraph(ctx)
    const codeFiles = [...new Set(
        (graph.nodes || [])
            .filter((n) => !String(n.id).includes('#') && n.source_file && n.file_type === 'code')
            .map((n) => n.source_file)
    )]
    const eps = detectEndpoints(ctx.repoRoot, codeFiles)
    if (!eps.length) return 'No HTTP endpoints detected in the indexed code files.'
    const max = Math.max(1, Math.min(300, Number(args.max_results) || 100))
    const shown = eps.slice(0, max)
    return [
        `${eps.length} endpoint(s) detected${eps.length > shown.length ? `, showing ${shown.length}` : ''}:`,
        ...shown.map((e) => `  ${e.method.toUpperCase().padEnd(6)} ${e.path}${e.handler ? `  → ${e.handler}` : ''}  (${e.file}${e.line ? `:${e.line}` : ''})`),
    ].join('\n')
}
