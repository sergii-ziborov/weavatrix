const compareText = (left, right) => String(left).localeCompare(String(right), 'en')

// Snapshot construction and source-free payload validation must use the same stable
// member order or equivalent evidence can hash differently across the boundary.
export function compareDuplicateMember(left, right) {
    return compareText(left.file, right.file) || left.startLine - right.startLine ||
        left.endLine - right.endLine || compareText(left.graphNodeId || '', right.graphNodeId || '')
}
