// Executable target architecture for agents: read the active contract before a change, then run the
// same deterministic verifier after it. No tool silently edits policy or accepts debt.
import {contractForChange, loadArchitectureContract, normalizeArchitectureContract, verifyArchitecture} from '../analysis/architecture-contract.js'
import {createPathClassifier, hasPathClass} from '../path-classification.js'
import {detectRepoStack} from '../scan/discover.js'
import {toolResult} from './tool-result.mjs'

const PROVISIONAL_BUDGETS = Object.freeze({
    runtimeCycles: 0,
    maxFileLoc: 300,
    maxFunctionLoc: 120,
    maxCyclomatic: 15,
    maxModuleFiles: 80,
    minModuleCohesion: .5,
    maxModuleBoundaryRatio: .65,
})

const SOURCE_ROOTS = new Set(['src', 'app', 'lib', 'packages', 'services'])
const PRODUCT_CODE_EXTENSIONS = new Set([
    '.cjs', '.cs', '.css', '.go', '.htm', '.html', '.java', '.js', '.jsx', '.less', '.mjs', '.py', '.pyi',
    '.rs', '.scss', '.ts', '.tsx',
])

const remediation = () => ({
    offlinePath: '.weavatrix/architecture.json',
    hostedAction: 'Open Architecture -> choose intended style -> Save target & baseline',
    nextTool: 'verify_architecture',
})

const stackIds = (repoRoot) => {
    try {
        const stack = detectRepoStack(repoRoot)
        return ['languages', 'runtimes', 'tests', 'infra', 'deploy']
            .flatMap((category) => (Array.isArray(stack?.[category]) ? stack[category] : []))
            .map((item) => String(item?.id || '')).filter(Boolean)
    } catch { return [] }
}

function activeContract(ctx) {
    if (!ctx?.repoRoot) return {contract: null, source: null, error: 'no repository root is active'}
    return loadArchitectureContract(ctx.repoRoot, ctx.graphPath)
}

const codeExtension = (file) => {
    const name = String(file || '').split('/').at(-1) || ''
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function starterContract(g, repoRoot) {
    const classifier = createPathClassifier(repoRoot)
    const files = [...new Set((g?.nodes || [])
        .filter((node) => !String(node.id).includes('#'))
        .map((node) => String(node.source_file || node.id || '').replace(/\\/g, '/'))
        .filter((file) => file && PRODUCT_CODE_EXTENSIONS.has(codeExtension(file))))]
        .filter((file) => {
            const explanation = classifier.explain(file)
            return !explanation.excluded && !hasPathClass(
                explanation, 'test', 'e2e', 'generated', 'mock', 'story', 'docs', 'benchmark', 'temp',
            )
        })
    const groups = new Map()
    for (const file of files) {
        const parts = file.split('/').filter(Boolean)
        let key, name, path
        if (parts.length === 1) {
            key = 'root-code'
            name = 'root code'
            path = file
        } else if (SOURCE_ROOTS.has(parts[0]) && parts.length === 2) {
            key = `${parts[0]}-root`
            name = `${parts[0]} (root files)`
            path = file
        } else {
            path = parts.slice(0, SOURCE_ROOTS.has(parts[0]) ? 2 : 1).join('/')
            key = path
            name = path
        }
        const group = groups.get(key) || {name, paths: new Set(), files: 0}
        group.paths.add(path)
        group.files += 1
        groups.set(key, group)
    }
    const components = [...groups].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0])).slice(0, 80)
        .map(([key, group], index) => ({
            id: key.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || `component-${index + 1}`,
            name: group.name,
            paths: [...group.paths].sort((a, b) => a.localeCompare(b)),
        }))
    return normalizeArchitectureContract({
        name: 'Proposed no-regressions baseline', style: 'custom', enforcement: 'ratchet', components,
        dependencyRules: [],
        budgets: PROVISIONAL_BUDGETS,
        technologies: {required: [], forbidden: []}, exceptions: [], ratchet: {baseline: {fingerprints: [], metrics: {}}},
    })
}

function notConfiguredResult(g, action, {includeStarter = false, repoRoot = null} = {}) {
    const starter = includeStarter ? starterContract(g, repoRoot) : null
    const starterText = starter
        ? ` A source-free starter with ${starter.components.length} product-code territories is available in JSON output from this lookup.`
        : ''
    return toolResult([
        `Architecture ${action} is NOT_CONFIGURED — no target contract is active.${starterText}`,
        'Next: save .weavatrix/architecture.json (offline) or approve a target in Hosted, then call verify_architecture.',
    ].join('\n'), {
        state: 'NOT_CONFIGURED',
        remediation: remediation(),
        ...(starter ? {
            starterSummary: {components: starter.components.length, budgets: starter.budgets},
            starterContract: starter,
        } : {}),
    })
}

function classifyChangeFiles(files, repoRoot) {
    const classifier = createPathClassifier(repoRoot)
    const normalized = [...new Set((Array.isArray(files) ? files : [])
        .slice(0, 200)
        .map((file) => String(file || '').replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter((file) => file && !file.startsWith('../') && !file.includes('/../')))]
        .sort((a, b) => a.localeCompare(b))
    const testOnlyFiles = normalized.filter((file) => hasPathClass(classifier.explain(file), 'test', 'e2e'))
    const testOnly = new Set(testOnlyFiles)
    return {files: normalized, productFiles: normalized.filter((file) => !testOnly.has(file)), testOnlyFiles}
}

function provisionalPreflight(g, args, ctx) {
    const surfaces = classifyChangeFiles(args?.files, ctx?.repoRoot)
    const intent = String(args?.intent || '').slice(0, 500)
    const budgetText = [
        `no new runtime cycles (baseline ${PROVISIONAL_BUDGETS.runtimeCycles})`,
        `file <= ${PROVISIONAL_BUDGETS.maxFileLoc} LOC`,
        `function <= ${PROVISIONAL_BUDGETS.maxFunctionLoc} LOC`,
        `cyclomatic <= ${PROVISIONAL_BUDGETS.maxCyclomatic}`,
    ].join('; ')
    return toolResult([
        `Architecture preflight is NOT_CONFIGURED for ${surfaces.files.length} file(s)${intent ? ` — ${intent}` : ''}.`,
        `Provisional no-regression guidance (not enforced policy): ${budgetText}.`,
        `${surfaces.productFiles.length} product file(s); ${surfaces.testOnlyFiles.length} test-only file(s). Save a target contract to make these budgets enforceable.`,
    ].join('\n'), {
        state: 'NOT_CONFIGURED',
        guidance: 'PROVISIONAL_BUDGETS',
        enforceable: false,
        intent,
        ...surfaces,
        provisionalBudgets: PROVISIONAL_BUDGETS,
        remediation: remediation(),
    })
}

export function tGetArchitectureContract(g, args, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) {
        const text = loaded.error
            ? `Architecture contract is invalid (${loaded.source || 'unknown'}): ${loaded.error}`
            : 'No target architecture contract is active.'
        if (!loaded.error) return notConfiguredResult(g, 'lookup', {includeStarter: true, repoRoot: ctx?.repoRoot})
        return toolResult(text, {state: 'ERROR', source: loaded.source, error: loaded.error})
    }
    const contract = loaded.contract
    return toolResult([
        `Target architecture: ${contract.name} (${contract.style}, ${contract.enforcement}).`,
        `Contract ${contract.contractHash.slice(0, 12)} from ${loaded.source}; ${contract.components.length} components, ${contract.dependencyRules.length} dependency rules.`,
        `Quality budgets: ${Object.entries(contract.budgets).map(([key, value]) => `${key}=${value}`).join(', ') || '(none)'}.`,
    ].join('\n'), {state: 'ACTIVE', source: loaded.source, contract})
}

export function tPrepareChange(g, args = {}, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) return provisionalPreflight(g, args, ctx)
    const prepared = contractForChange(loaded.contract, args.files)
    const surfaces = classifyChangeFiles(prepared.files, ctx?.repoRoot)
    const intent = String(args.intent || '').slice(0, 500)
    return toolResult([
        `Architecture preflight for ${prepared.files.length} file(s)${intent ? ` — ${intent}` : ''}.`,
        `Affected target components: ${prepared.components.join(', ') || '(unmapped)'}.`,
        ...(surfaces.testOnlyFiles.length ? [`Test-only surface: ${surfaces.testOnlyFiles.join(', ')}.`] : []),
        `Applicable rules: ${prepared.rules.map((rule) => rule.id).join(', ') || '(none)'}.`,
        'Run verify_architecture after the edit; do not silently add an exception or rewrite the target contract.',
    ].join('\n'), {state: 'READY', intent, contractHash: loaded.contract.contractHash, ...prepared, productFiles: surfaces.productFiles, testOnlyFiles: surfaces.testOnlyFiles})
}

export function tVerifyArchitecture(g, args, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) return notConfiguredResult(g, 'verification')
    const verification = verifyArchitecture({graph: g, contract: loaded.contract, technologies: stackIds(ctx.repoRoot)})
    const groups = [['new', verification.new], ['existing', verification.existing], ['fixed', verification.fixed], ['excepted', verification.excepted]]
    const lines = [
        `Architecture verify: ${verification.status} (${verification.enforcement}; contract ${verification.contractHash.slice(0, 12)}).`,
        `New ${verification.new.length} · existing debt ${verification.existing.length} · fixed ${verification.fixed.length} · excepted ${verification.excepted.length}.`,
        ...groups.filter(([, values]) => values.length).flatMap(([label, values]) => [
            `${label}:`,
            ...values.slice(0, 20).map((item) => typeof item === 'string' ? `  ${item}` : `  ${item.ruleId}: ${item.evidence}${item.current != null ? ` (${item.current} > ${item.target})` : ''}`),
        ]),
    ]
    return toolResult(lines.join('\n'), {state: verification.status, source: loaded.source, verification}, {
        completeness: {violationsReturned: Math.min(20, verification.new.length + verification.existing.length), violationsTotal: verification.new.length + verification.existing.length},
    })
}

export function tExplainArchitectureViolation(g, args, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) return toolResult('No active architecture contract.', {state: 'NOT_CONFIGURED'})
    const verification = verifyArchitecture({graph: g, contract: loaded.contract, technologies: stackIds(ctx.repoRoot)})
    const fingerprint = String(args.fingerprint || '')
    const item = [...verification.new, ...verification.existing, ...verification.excepted]
        .find((entry) => entry.fingerprint === fingerprint)
    if (!item) return toolResult(`Violation ${fingerprint || '(missing)'} is not active in the current verification.`, {state: 'NOT_FOUND', fingerprint})
    const rule = loaded.contract.dependencyRules.find((candidate) => candidate.id === item.ruleId)
    return toolResult([
        `${item.ruleId}: ${item.evidence}.`,
        rule?.reason ? `Reason: ${rule.reason}` : 'The finding violates an explicit dependency or quality rule in the active target contract.',
        'Preferred action: change the dependency/metric. If that is intentionally impossible, propose a time-bounded exception for human review.',
    ].join('\n'), {state: 'ACTIVE', violation: item, rule: rule || null})
}

export function tProposeArchitectureException(g, args, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) return toolResult('No active architecture contract.', {state: 'NOT_CONFIGURED'})
    const verification = verifyArchitecture({graph: g, contract: loaded.contract, technologies: stackIds(ctx.repoRoot)})
    const item = [...verification.new, ...verification.existing].find((entry) => entry.fingerprint === String(args.fingerprint || ''))
    if (!item) return toolResult('Only an active violation can be proposed as an exception.', {state: 'NOT_FOUND'})
    const proposal = {
        fingerprint: item.fingerprint,
        reason: String(args.reason || '').trim().slice(0, 300),
        ...(args.expires ? {expires: String(args.expires)} : {}),
    }
    const checked = normalizeArchitectureContract({...loaded.contract, exceptions: [...loaded.contract.exceptions, proposal]})
    const normalized = checked.exceptions.find((entry) => entry.fingerprint === item.fingerprint)
    if (!normalized || !normalized.reason) return toolResult('A non-empty reason and optional YYYY-MM-DD expiry are required.', {state: 'INVALID'})
    return toolResult('Exception proposal prepared for human review; the contract was not changed.', {state: 'PROPOSED', proposal: normalized, contractHash: loaded.contract.contractHash})
}
