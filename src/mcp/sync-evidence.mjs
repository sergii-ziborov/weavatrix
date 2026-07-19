// Defense-in-depth wire sanitizer for evidence snapshots. Each section owns its
// allowlist; this facade only assembles and hashes the versioned wire envelope.
import {createHash} from 'node:crypto'
import {sanitizeArchitecture} from './sync/evidence-architecture.mjs'
import {stableStringify} from './sync/evidence-common.mjs'
import {sanitizeDuplicates} from './sync/evidence-duplicates.mjs'
import {sanitizeHealth, sanitizeTechnologies} from './sync/evidence-health.mjs'
import {sanitizePackages} from './sync/evidence-packages.mjs'

export function sanitizeEvidenceSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.evidenceSnapshotV !== 1) throw new Error('invalid evidence snapshot')
    const sections = {
        architecture: sanitizeArchitecture(value.sections?.architecture),
        duplicates: sanitizeDuplicates(value.sections?.duplicates),
        health: sanitizeHealth(value.sections?.health),
        technologies: sanitizeTechnologies(value.sections?.technologies),
        packages: sanitizePackages(value.sections?.packages),
    }
    const states = Object.values(sections).map((section) => section.state)
    const snapshotState = states.every((item) => item === 'ERROR') ? 'ERROR' : states.every((item) => item === 'COMPLETE' || item === 'NOT_APPLICABLE') ? 'COMPLETE' : 'PARTIAL'
    const snapshot = {evidenceSnapshotV: 1, state: snapshotState, sections}
    return {...snapshot, snapshotHash: createHash('sha256').update(stableStringify(snapshot)).digest('hex')}
}
