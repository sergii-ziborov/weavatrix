// Explicit two-step local architecture bootstrap. Preview is pure; approval writes only the exact
// previewed contract with a short-lived one-time token and never overwrites an active policy.
import {createHash, randomBytes} from 'node:crypto'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {
    loadArchitectureContract, normalizeArchitectureContract, verifyArchitecture,
} from '../analysis/architecture-contract.js'
import {createRepoBoundary} from '../repo-path.js'
import {detectRepoStack} from '../scan/discover.js'
import {toolResult} from './tool-result.mjs'

const version = new URL(import.meta.url).search
const starter = await import(new URL(`./architecture-starter.mjs${version}`, import.meta.url).href)
const {createArchitectureStarter, proposeObservedDependencyDirections} = starter

const PREVIEW_TTL_MS = 5 * 60_000
const previews = new Map()

const stackIds = (repoRoot) => {
    try {
        const stack = detectRepoStack(repoRoot)
        return ['languages', 'runtimes', 'tests', 'infra', 'deploy']
            .flatMap((category) => Array.isArray(stack?.[category]) ? stack[category] : [])
            .map((item) => String(item?.id || '')).filter(Boolean)
    } catch { return [] }
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function currentFingerprints(verification) {
    return [...verification.new, ...verification.existing]
        .map((item) => item.fingerprint).sort((a, b) => a.localeCompare(b))
}

function baselineMetrics(verification) {
    return Object.fromEntries(['runtimeCycles', 'violations', 'componentDependencies', 'mappedComponents']
        .map((key) => [key, verification.metrics?.[key]])
        .filter(([, value]) => Number.isFinite(value)))
}

function materializeCandidate(candidate, verification, baselineMode) {
    if (baselineMode !== 'accept-current') return normalizeArchitectureContract(candidate)
    return normalizeArchitectureContract({
        ...candidate,
        ratchet: {baseline: {
            fingerprints: currentFingerprints(verification),
            metrics: baselineMetrics(verification),
        }},
    })
}

export function activeArchitectureContract(ctx) {
    if (!ctx?.repoRoot) return {contract: null, source: null, error: 'no repository root is active'}
    return loadArchitectureContract(ctx.repoRoot, ctx.graphPath)
}

function preview(g, args, ctx) {
    const active = activeArchitectureContract(ctx)
    if (active.contract) return toolResult(
        `Architecture bootstrap refused: an active contract already exists at ${active.source}.`,
        {state: 'ALREADY_CONFIGURED', source: active.source, contractHash: active.contract.contractHash},
    )
    if (active.error) return toolResult(
        `Architecture bootstrap refused: ${active.source || 'contract'} is invalid (${active.error}).`,
        {state: 'ERROR', source: active.source, error: active.error},
    )
    const baselineMode = args?.baseline_mode === 'accept-current' ? 'accept-current' : 'none'
    let candidate, starterProposal = null
    try {
        starterProposal = args?.candidate_contract ? null : createArchitectureStarter(g, ctx?.repoRoot)
        candidate = args?.candidate_contract
            ? normalizeArchitectureContract(args.candidate_contract)
            : starterProposal.contract
    } catch (error) {
        return toolResult(`Candidate architecture contract is invalid: ${error.message}`, {state: 'INVALID', error: error.message})
    }
    const technologies = stackIds(ctx?.repoRoot)
    const candidateVerification = verifyArchitecture({graph: g, contract: candidate, technologies})
    const materializedContract = materializeCandidate(candidate, candidateVerification, baselineMode)
    const materializedVerification = verifyArchitecture({graph: g, contract: materializedContract, technologies})
    const contents = `${JSON.stringify(materializedContract, null, 2)}\n`
    const contentHash = sha256(contents)
    const token = randomBytes(12).toString('hex')
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString()
    previews.set(token, {
        repoRoot: String(ctx?.repoRoot || ''), graphPath: String(ctx?.graphPath || ''),
        contract: materializedContract, contents, contentHash,
        verificationHash: materializedVerification.verificationHash,
        expiresAt: Date.parse(expiresAt),
    })
    return toolResult([
        `Architecture bootstrap PREVIEW only; no file was written. Candidate verification: ${candidateVerification.status}.`,
        baselineMode === 'accept-current'
            ? `Explicit accept-current baseline would record ${currentFingerprints(candidateVerification).length} current finding fingerprint(s).`
            : 'No current findings were added to the baseline.',
        `Review the materialized contract and then approve with confirm_token "${token}" before ${expiresAt}.`,
    ].join('\n'), {
        state: 'PREVIEW', wrote: false, baselineMode,
        candidateVerification, materializedVerification, materializedContract,
        observedDependencyProposals: proposeObservedDependencyDirections(g, materializedContract.components),
        budgetProposals: starterProposal?.budgetProposals || [],
        starterMethodology: starterProposal?.methodology,
        patch: {operation: 'create', path: '.weavatrix/architecture.json', contentHash, contents},
        confirmToken: token, expiresAt,
    })
}

function approve(g, args, ctx) {
    const token = String(args?.confirm_token || '')
    const pending = previews.get(token)
    if (!pending) return toolResult(
        'Architecture approval refused: run a fresh preview and provide its exact confirm_token.',
        {state: 'CONFIRMATION_REQUIRED', wrote: false},
    )
    previews.delete(token)
    if (pending.expiresAt < Date.now()) return toolResult(
        'Architecture approval refused: the preview expired; run preview again.',
        {state: 'PREVIEW_EXPIRED', wrote: false},
    )
    if (pending.repoRoot !== String(ctx?.repoRoot || '') || pending.graphPath !== String(ctx?.graphPath || '')) {
        return toolResult('Architecture approval refused: the active repository changed after preview.', {
            state: 'REPOSITORY_CHANGED', wrote: false,
        })
    }
    const active = activeArchitectureContract(ctx)
    if (active.contract || active.error) return toolResult(
        `Architecture approval refused: ${active.source || 'a contract'} appeared or changed after preview.`,
        {state: active.error ? 'ERROR' : 'ALREADY_CONFIGURED', wrote: false, source: active.source, error: active.error || undefined},
    )
    const verification = verifyArchitecture({
        graph: g, contract: pending.contract, technologies: stackIds(ctx?.repoRoot),
    })
    if (verification.verificationHash !== pending.verificationHash) return toolResult(
        'Architecture approval refused: graph evidence changed after preview; review a fresh preview.',
        {state: 'GRAPH_CHANGED', wrote: false, previewVerificationHash: pending.verificationHash, currentVerificationHash: verification.verificationHash},
    )
    const boundary = createRepoBoundary(ctx?.repoRoot)
    if (!boundary.root) return toolResult('Architecture approval refused: the repository boundary is unavailable.', {
        state: 'PATH_REFUSED', wrote: false,
    })
    try { mkdirSync(join(boundary.root, '.weavatrix'), {recursive: true}) }
    catch (error) { return toolResult(`Architecture approval could not create its policy directory: ${error.message}`, {
        state: 'WRITE_FAILED', wrote: false, error: error.message,
    }) }
    const policyDirectory = boundary.resolve('.weavatrix')
    if (!policyDirectory.ok) return toolResult('Architecture approval refused: the policy directory resolves outside the active repository.', {
        state: 'PATH_REFUSED', wrote: false,
    })
    const targetPath = join(policyDirectory.path, 'architecture.json')
    if (existsSync(targetPath)) return toolResult('Architecture approval refused: the target contract already exists.', {
        state: 'ALREADY_CONFIGURED', wrote: false, source: '.weavatrix/architecture.json',
    })
    try {
        writeFileSync(targetPath, pending.contents, {encoding: 'utf8', flag: 'wx'})
    } catch (error) {
        return toolResult(`Architecture approval failed without overwriting policy: ${error.message}`, {
            state: 'WRITE_FAILED', wrote: false, error: error.message,
        })
    }
    return toolResult(
        `Architecture contract approved and created at .weavatrix/architecture.json (${pending.contentHash.slice(0, 12)}).`,
        {state: 'APPROVED', wrote: true, source: '.weavatrix/architecture.json', contentHash: pending.contentHash, contract: pending.contract, verification},
    )
}

export function tBootstrapArchitecture(g, args = {}, ctx) {
    return args.action === 'approve' ? approve(g, args, ctx) : preview(g, args, ctx)
}
