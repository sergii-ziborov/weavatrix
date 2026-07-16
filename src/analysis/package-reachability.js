// Package-level reachability: correlate a dependency finding with the graph's external imports.
// This is intentionally not function-level exploitability analysis. It only states whether product
// code imports the package and preserves unknown as unknown.
export const PACKAGE_REACHABILITY_V = 1

export function packageReachability(externalImports, packageName, {isNonProductPath = () => false} = {}) {
    const imports = (Array.isArray(externalImports) ? externalImports : [])
        .filter((item) => item?.pkg === packageName && item.builtin !== true)
        .map((item) => ({
            file: String(item.file || '').replace(/\\/g, '/'),
            line: Number.isInteger(item.line) ? item.line : 0,
            kind: String(item.kind || 'import'),
            typeOnly: item.typeOnly === true,
            dynamic: item.dynamic === true,
        }))
        .filter((item) => item.file)
    const product = imports.filter((item) => !isNonProductPath(item.file))
    const runtime = product.filter((item) => !item.typeOnly)
    const state = runtime.length
        ? 'DIRECT_RUNTIME_IMPORT'
        : product.length
            ? 'TYPE_ONLY_IMPORT'
            : imports.length
                ? 'NON_PRODUCT_IMPORT_ONLY'
                : 'NOT_OBSERVED_IN_GRAPH'
    return {
        packageReachabilityV: PACKAGE_REACHABILITY_V,
        level: 'package-import',
        state,
        directRuntimeImports: runtime.length,
        directProductImports: product.length,
        observedImports: imports.length,
        files: [...new Set((runtime.length ? runtime : product.length ? product : imports).map((item) => item.file))].sort().slice(0, 20),
        evidence: (runtime.length ? runtime : product.length ? product : imports).slice(0, 10),
        note: state === 'NOT_OBSERVED_IN_GRAPH'
            ? 'No static import was observed; implicit, dynamic, plugin and transitive runtime use remain unknown.'
            : 'Package-level static import evidence; this does not prove vulnerable-function reachability.',
    }
}
