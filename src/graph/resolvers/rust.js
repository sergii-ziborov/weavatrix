import {join} from 'node:path'

const cleanRustRel = (path) => String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '').replace(/^\.$/, '')
const rustDir = (path) => {
  const clean = cleanRustRel(path)
  const index = clean.lastIndexOf('/')
  return index < 0 ? '' : clean.slice(0, index)
}
const rustBase = (path) => {
  const clean = cleanRustRel(path)
  const index = clean.lastIndexOf('/')
  return index < 0 ? clean : clean.slice(index + 1)
}
const rustJoin = (...parts) => cleanRustRel(join(...parts.filter((part) => part != null && part !== '')))

export function createRustResolvers(fileSet) {
  const rustFiles = new Set([...fileSet].filter((file) => file.endsWith('.rs')))
  const rustRoots = new Map()
  for (const file of rustFiles) {
    const base = rustBase(file)
    if (base !== 'lib.rs' && base !== 'main.rs') continue
    const dir = rustDir(file)
    let root = rustRoots.get(dir)
    if (!root) rustRoots.set(dir, (root = {base: dir, lib: null, main: null}))
    root[base === 'lib.rs' ? 'lib' : 'main'] = file
  }
  const rustRootList = [...rustRoots.values()].sort((a, b) => b.base.length - a.base.length)

  const rustContext = (fromRel) => {
    const clean = cleanRustRel(fromRel)
    const base = rustBase(clean)
    const dir = rustDir(clean)
    if (base === 'lib.rs' || base === 'main.rs') return {base: dir, rootFile: clean}
    if (/^(?:bin|examples|tests|benches)$/.test(rustBase(dir))) return {base: dir, rootFile: clean}
    for (const root of rustRootList) {
      if (!root.base || clean.startsWith(root.base + '/')) return {base: root.base, rootFile: root.lib || root.main}
    }
    return {base: dir, rootFile: clean}
  }
  const rustModuleBase = (fromRel) => {
    const context = rustContext(fromRel)
    if (context.rootFile === cleanRustRel(fromRel)) return rustDir(fromRel)
    const name = rustBase(fromRel)
    if (name === 'lib.rs' || name === 'main.rs' || name === 'mod.rs') return rustDir(fromRel)
    return rustJoin(rustDir(fromRel), name.replace(/\.rs$/, ''))
  }
  const rustInlineBase = (fromRel, inlineModules = []) => {
    let base = rustModuleBase(fromRel)
    for (let index = 0; index < inlineModules.length; index++) {
      const module = inlineModules[index] || {}
      if (module.path) {
        const parent = index === 0 ? rustDir(fromRel) : base
        base = rustJoin(parent, module.path)
      } else base = rustJoin(base, module.name)
    }
    return base
  }
  const rustModuleFile = (moduleBase, context) => {
    const clean = cleanRustRel(moduleBase)
    if (clean === cleanRustRel(context.base) && context.rootFile && rustFiles.has(context.rootFile)) return context.rootFile
    const flat = clean + '.rs'
    if (rustFiles.has(flat)) return flat
    const legacy = rustJoin(clean, 'mod.rs')
    return rustFiles.has(legacy) ? legacy : null
  }

  const resolveRustMod = (fromRel, name, {inlineModules = [], explicitPath = ''} = {}) => {
    const clean = cleanRustRel(fromRel)
    if (explicitPath) {
      const parent = inlineModules.length ? rustInlineBase(clean, inlineModules) : rustDir(clean)
      const target = rustJoin(parent, explicitPath)
      return rustFiles.has(target) ? target : null
    }
    const targetBase = rustJoin(rustInlineBase(clean, inlineModules), String(name || '').replace(/^r#/, ''))
    return rustModuleFile(targetBase, rustContext(clean))
  }

  const resolveRustPath = (fromRel, rawSegments, {inlineModules = [], unqualified = true} = {}) => {
    const clean = cleanRustRel(fromRel)
    const segments = (Array.isArray(rawSegments) ? rawSegments : String(rawSegments || '').split('::'))
      .map((segment) => String(segment).trim().replace(/^r#/, '')).filter(Boolean)
    if (!segments.length) return null
    const context = rustContext(clean)
    const current = rustInlineBase(clean, inlineModules)
    const rest = [...segments]
    const starts = []
    let anchored = false
    if (rest[0] === 'crate') { anchored = true; rest.shift(); starts.push(context.base) }
    else if (rest[0] === 'self') { anchored = true; rest.shift(); starts.push(current) }
    else if (rest[0] === 'super') {
      anchored = true
      let base = current
      while (rest[0] === 'super') { rest.shift(); base = rustDir(base) }
      if (context.base && base !== context.base && !base.startsWith(context.base + '/')) return null
      starts.push(base)
    } else if (unqualified) {
      starts.push(context.base)
      if (current !== context.base) starts.push(current)
    } else return null

    for (const start of starts) {
      const minimum = anchored ? 0 : 1
      for (let used = rest.length; used >= minimum; used--) {
        const target = rustModuleFile(rustJoin(start, ...rest.slice(0, used)), context)
        if (target) return {
          targetFile: target,
          consumed: segments.length - rest.length + used,
          remaining: rest.slice(used),
          anchored,
        }
      }
    }
    return null
  }

  return {resolveRustMod, resolveRustPath}
}
