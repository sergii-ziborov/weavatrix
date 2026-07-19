export function contractVerdict(analysis, transportAnalysis) {
    const endpointsWithCallers = analysis.endpoints.filter((endpoint) => endpoint.callsites.length > 0)
    const transportWithCallers = (transportAnalysis.contracts || []).filter((contract) => contract.callsites.length > 0)
    const affectedFiles = new Set(), affectedScreens = new Set()
    for (const contract of [...endpointsWithCallers, ...transportWithCallers]) {
        for (const item of contract.affected.files || []) affectedFiles.add(`${item.client}\0${item.file}`)
        for (const item of contract.affected.screens || []) affectedScreens.add(`${item.client}\0${item.file}`)
    }
    const totalContracts = analysis.totals.endpoints + transportAnalysis.totals.contracts
    const totalMatches = analysis.totals.matches + transportAnalysis.totals.matches
    let code = 'NO_ENDPOINTS_MATCHED', risk = 'unknown'
    if (totalContracts > 0 && totalMatches === 0) {
        code = analysis.totals.methodMismatches > 0 ? 'HTTP_METHOD_MISMATCH' : 'NO_STATIC_CLIENT_CALLERS'
        risk = analysis.totals.methodMismatches > 0 ? 'high' : 'unknown'
    } else if (totalMatches > 0 && analysis.totals.methodMismatches > 0) {
        code = 'CLIENTS_AT_RISK_WITH_METHOD_MISMATCHES'; risk = 'high'
    } else if (totalMatches > 0) {
        code = 'CLIENTS_AT_RISK'; risk = 'medium'
    }
    return {
        code, risk,
        endpointsWithCallers: endpointsWithCallers.length + transportWithCallers.length,
        callsites: totalMatches,
        affectedFiles: affectedFiles.size,
        affectedScreens: affectedScreens.size,
        methodMismatches: analysis.totals.methodMismatches,
        uncertainCalls: analysis.totals.uncertainCalls + transportAnalysis.totals.uncertain,
        transportContracts: transportAnalysis.totals.contracts,
        transportMatches: transportAnalysis.totals.matches,
        notDeadExternalUse: analysis.totals.notDeadExternalUse,
        notDeadExternalHandlers: analysis.totals.notDeadExternalHandlers,
        possibleExternalUse: analysis.totals.possibleExternalUse,
        unknownLiveness: analysis.totals.unknownLiveness,
    }
}

export function contractVerdictLine(verdict, contracts) {
    if (verdict.code === 'NO_ENDPOINTS_MATCHED') return 'VERDICT NO_ENDPOINTS_MATCHED — no backend contract satisfied the requested transport/method/path/change filter.'
    if (verdict.code === 'NO_STATIC_CLIENT_CALLERS') return `VERDICT NO_STATIC_CLIENT_CALLERS — ${contracts} backend contract(s) matched, but no bounded static client call was proven; this is unknown, not proof of no consumers.`
    if (verdict.code === 'HTTP_METHOD_MISMATCH') return `VERDICT HTTP_METHOD_MISMATCH — ${verdict.methodMismatches} client call(s) match the route shape with a different method.`
    return `VERDICT ${verdict.code} — ${verdict.callsites} callsite(s) reach ${verdict.endpointsWithCallers} contract(s); ${verdict.affectedScreens} screen(s) and ${verdict.affectedFiles} file(s) are in the bounded blast radius.`
}
