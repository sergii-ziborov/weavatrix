// Release gate: the core is PROVABLY free of any refactoring / edit-plan / source-write
// surface. Refactoring lives entirely in the separate weavatrix-refactor package; the core
// exposes only read-only analysis (see src/analysis-kit.mjs). This scans every shipped core
// source file and fails if any refactoring marker reappears — the machine proof that
// installing the core alone can neither modify code nor even describe a modification, the
// same way the ADR 0001 gate proves the offline artifact has no network path.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Markers that must never appear in core source: the edit-plan schema, the applier tools, and
// the refactoring plan-producer builders that were moved to weavatrix-refactor.
const FORBIDDEN = [
    'weavatrix.edit-plan.v1',
    'apply_edit_plan',
    'rollback_last_apply',
    'buildRenamePlan',
    'buildRelatedRenamePlan',
    'buildGraphRenamePlan',
    'buildSqlRenamePlan',
    'buildMoveFilePlan',
    'buildMoveSymbolDryRun',
    'computeDeleteReadiness',
    'buildSymbolEditPlan',
    'buildChangeSignaturePlan',
    'buildBulkReplacePlan',
    'buildOrganizeImportsPlan',
    'verifyRefactorConservation',
]

function sourceFiles(dir) {
    const out = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
        else if (/\.(?:mjs|js)$/.test(entry)) out.push(full)
    }
    return out
}

test('core source contains no refactoring / edit-plan / source-write marker', () => {
    const offenders = []
    for (const file of sourceFiles(srcDir)) {
        const text = readFileSync(file, 'utf8')
        for (const marker of FORBIDDEN) {
            if (text.includes(marker)) offenders.push(`${file.slice(srcDir.length + 1)}: "${marker}"`)
        }
    }
    assert.deepEqual(offenders, [], `refactoring surface leaked into the read-only core:\n${offenders.join('\n')}`)
})

test('the analysis-kit exposes only read-only primitives (no builder/apply names)', () => {
    const kit = readFileSync(join(srcDir, 'analysis-kit.mjs'), 'utf8')
    for (const marker of FORBIDDEN) assert.equal(kit.includes(marker), false, `analysis-kit must not export ${marker}`)
})
