// Stable public facade for target-architecture contracts.
// Owner-specific implementation lives under analysis/architecture so storage,
// normalization and graph verification can evolve independently.
export {
    ARCHITECTURE_CONTRACT_V,
    normalizeArchitectureContract,
} from './architecture/contract-schema.js'
export {
    CONTRACT_PATHS,
    loadArchitectureContract,
    writeCachedArchitectureContract,
} from './architecture/contract-storage.js'
export {
    contractForChange,
    verifyArchitecture,
} from './architecture/contract-verification.js'
