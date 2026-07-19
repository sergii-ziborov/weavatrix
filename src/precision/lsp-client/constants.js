export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_HEADER_BYTES = 16 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
export const JSON_RPC_VERSION = '2.0'

export function positiveInteger(value, fallback, label) {
    const candidate = value == null ? fallback : Number(value)
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new TypeError(`${label} must be a positive integer`)
    }
    return candidate
}
