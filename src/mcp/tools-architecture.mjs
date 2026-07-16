// Executable target architecture for agents: read the active contract before a change, then run the
// same deterministic verifier after it. No tool silently edits policy or accepts debt.
import {contractForChange, loadArchitectureContract, normalizeArchitectureContract, verifyArchitecture} from '../analysis/architecture-contract.js'
import {detectRepoStack} from '../scan/discover.js'
import {toolResult} from './tool-result.mjs'

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

function starterContract(g) {
    const files = [...new Set((g?.nodes || [])
        .filter((node) => !String(node.id).includes('#'))
        .map((node) => String(node.source_file || node.id || '').replace(/\\/g, '/'))
        .filter(Boolean))]
    const groups = new Map()
    for (const file of files) {
        const parts = file.split('/').filter(Boolean)
        const depth = ['src', 'app', 'lib', 'packages', 'services'].includes(parts[0]) ? 2 : 1
        const path = parts.slice(0, Math.max(1, Math.min(depth, parts.length - 1))).join('/') || '(root)'
        groups.set(path, (groups.get(path) || 0) + 1)
    }
    const components = [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80)
        .filter(([path]) => path !== '(root)')
        .map(([path], index) => ({
            id: path.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || `component-${index + 1}`,
            name: path,
            paths: [path],
        }))
    return normalizeArchitectureContract({
        name: 'Proposed no-regressions baseline', style: 'custom', enforcement: 'ratchet', components,
        dependencyRules: [],
        budgets: {runtimeCycles: 0, maxFileLoc: 300, maxFunctionLoc: 120, maxCyclomatic: 15, maxModuleFiles: 80, minModuleCohesion: .5, maxModuleBoundaryRatio: .65},
        technologies: {required: [], forbidden: []}, exceptions: [], ratchet: {baseline: {fingerprints: [], metrics: {}}},
    })
}

function notConfiguredResult(g, action) {
    const starter = starterContract(g)
    return toolResult([
        `Architecture ${action} is NOT_CONFIGURED — no target contract is active.`,
        `A source-free starter was inferred from ${starter.components.length} path territories; review it before saving because folders are evidence, not semantic truth.`,
        'Next: save it as .weavatrix/architecture.json (offline) or approve it in the hosted Architecture editor, then call verify_architecture.',
    ].join('\n'), {
        state: 'NOT_CONFIGURED',
        remediation: {
            offlinePath: '.weavatrix/architecture.json',
            hostedAction: 'Open Architecture → choose intended style → Save target & baseline',
            nextTool: 'verify_architecture',
        },
        starterContract: starter,
    })
}

export function tGetArchitectureContract(g, args, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) {
        const text = loaded.error
            ? `Architecture contract is invalid (${loaded.source || 'unknown'}): ${loaded.error}`
            : 'No target architecture contract is active.'
        if (!loaded.error) return notConfiguredResult(g, 'lookup')
        return toolResult(text, {state: 'ERROR', source: loaded.source, error: loaded.error})
    }
    const contract = loaded.contract
    return toolResult([
        `Target architecture: ${contract.name} (${contract.style}, ${contract.enforcement}).`,
        `Contract ${contract.contractHash.slice(0, 12)} from ${loaded.source}; ${contract.components.length} components, ${contract.dependencyRules.length} dependency rules.`,
        `Quality budgets: ${Object.entries(contract.budgets).map(([key, value]) => `${key}=${value}`).join(', ') || '(none)'}.`,
    ].join('\n'), {state: 'ACTIVE', source: loaded.source, contract})
}

export function tPrepareChange(g, args, ctx) {
    const loaded = activeContract(ctx)
    if (!loaded.contract) return notConfiguredResult(g, 'preflight')
    const prepared = contractForChange(loaded.contract, args.files)
    const intent = String(args.intent || '').slice(0, 500)
    return toolResult([
        `Architecture preflight for ${prepared.files.length} file(s)${intent ? ` — ${intent}` : ''}.`,
        `Affected target components: ${prepared.components.join(', ') || '(unmapped)'}.`,
        `Applicable rules: ${prepared.rules.map((rule) => rule.id).join(', ') || '(none)'}.`,
        'Run verify_architecture after the edit; do not silently add an exception or rewrite the target contract.',
    ].join('\n'), {state: 'READY', intent, contractHash: loaded.contract.contractHash, ...prepared})
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
