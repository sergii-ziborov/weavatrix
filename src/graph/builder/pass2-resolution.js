export function createPass2Resolution({symIdsByFileName, nodeById, importedLocals, symByFileName}) {
    const dirSymbols = new Map(), dirMethods = new Map(), dirMethodsByName = new Map(), dirTypes = new Map()
    const sharesDirScope = (file) => file.endsWith('.go') || file.endsWith('.cs') || file.endsWith('.rs')
    for (const [file, names] of symIdsByFileName) {
        if (!sharesDirScope(file)) continue
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
        let symbols = dirSymbols.get(dir)
        if (!symbols) dirSymbols.set(dir, (symbols = new Map()))
        for (const [name, ids] of names) for (const id of ids) {
            const node = nodeById.get(id)
            if (file.endsWith('.go') && node?.member_of && node?.symbol_kind === 'method') {
                let receivers = dirMethods.get(dir)
                if (!receivers) dirMethods.set(dir, (receivers = new Map()))
                let methods = receivers.get(node.member_of)
                if (!methods) receivers.set(node.member_of, (methods = new Map()))
                const exact = methods.get(name) || []
                exact.push(id); methods.set(name, exact)
                let byName = dirMethodsByName.get(dir)
                if (!byName) dirMethodsByName.set(dir, (byName = new Map()))
                const candidates = byName.get(name) || []
                candidates.push(id); byName.set(name, candidates)
                continue
            }
            if (!symbols.has(name)) symbols.set(name, id)
            if (file.endsWith('.go') && node?.symbol_space === 'type') {
                let types = dirTypes.get(dir)
                if (!types) dirTypes.set(dir, (types = new Map()))
                if (!types.has(name)) types.set(name, id)
            }
        }
    }
    const symbolSpace = (node) => {
        const explicit = String(node?.symbol_space || '')
        if (['value', 'type', 'both'].includes(explicit)) return explicit
        const kind = String(node?.symbol_kind || '').toLowerCase()
        if (['interface', 'type'].includes(kind)) return 'type'
        return ['class', 'enum'].includes(kind) ? 'both' : 'value'
    }
    const resolveNamedSymbol = (file, name, space = 'value') => {
        const ids = symIdsByFileName.get(file)?.get(name) || []
        const exact = ids.find((id) => symbolSpace(nodeById.get(id)) === space)
        return exact || ids.find((id) => ['both', space].includes(symbolSpace(nodeById.get(id)))) || null
    }
    const resolveCall = (name, file) => {
        const local = resolveNamedSymbol(file, name, 'value')
        if (local) return local
        if (sharesDirScope(file)) {
            const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
            const symbols = dirSymbols.get(dir)
            if (symbols?.has(name)) return symbols.get(name)
        }
        const imported = importedLocals.get(file)?.get(name)
        if (!imported?.targetFile) return null
        return resolveNamedSymbol(imported.originFile || imported.targetFile, imported.originName || imported.imported, 'value')
    }
    const javaTypeKinds = new Set(['class', 'interface', 'enum', 'record', 'annotation'])
    const resolveJavaType = (name, file) => {
        const imported = importedLocals.get(file)?.get(name)
        if (imported?.targetFile) {
            const symbols = symByFileName.get(imported.targetFile)
            const target = symbols?.get(imported.imported) || symbols?.get(name)
            if (target && javaTypeKinds.has(nodeById.get(target)?.symbol_kind)) return target
        }
        const target = symByFileName.get(file)?.get(name)
        return target && javaTypeKinds.has(nodeById.get(target)?.symbol_kind) ? target : null
    }
    return {dirSymbols, dirMethods, dirMethodsByName, dirTypes, resolveNamedSymbol, resolveCall, resolveJavaType}
}
