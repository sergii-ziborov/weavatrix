const EXTENSION_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,127}$/

const asArray = (value, field) => {
    if (value == null) return []
    if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
    return value
}

const validateProfiles = (profiles = {}) => {
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new TypeError('extension profiles must be an object')
    const normalized = {}
    for (const [name, capabilities] of Object.entries(profiles)) {
        if (!EXTENSION_NAME.test(name)) throw new TypeError(`invalid extension profile name: ${name}`)
        normalized[name] = asArray(capabilities, `profile ${name}`).map(String)
    }
    return Object.freeze(normalized)
}

const validateTools = (tools = []) => Object.freeze(asArray(tools, 'extension tools').map((tool) => {
    if (!tool || typeof tool !== 'object') throw new TypeError('each extension tool must be an object')
    if (!TOOL_NAME.test(String(tool.name || ''))) throw new TypeError(`invalid extension tool name: ${tool.name || '(missing)'}`)
    if (!EXTENSION_NAME.test(String(tool.cap || ''))) throw new TypeError(`invalid extension tool capability: ${tool.cap || '(missing)'}`)
    if (typeof tool.run !== 'function') throw new TypeError(`extension tool ${tool.name} must provide run()`)
    return Object.freeze({...tool})
}))

const validateAuditProviders = (providers = []) => Object.freeze(asArray(providers, 'auditProviders').map((provider) => {
    if (!provider || typeof provider !== 'object') throw new TypeError('each audit provider must be an object')
    if (!EXTENSION_NAME.test(String(provider.id || ''))) throw new TypeError(`invalid audit provider id: ${provider.id || '(missing)'}`)
    if (typeof provider.run !== 'function') throw new TypeError(`audit provider ${provider.id} must provide run()`)
    if (provider.network !== undefined && provider.network !== 'none') throw new TypeError(`audit provider ${provider.id} must be local (network: "none")`)
    return Object.freeze({...provider, network: 'none'})
}))

const validateSkills = (skills = []) => Object.freeze(asArray(skills, 'skills').map((skill) => {
    if (!skill || typeof skill !== 'object') throw new TypeError('each extension skill must be an object')
    if (!EXTENSION_NAME.test(String(skill.name || ''))) throw new TypeError(`invalid extension skill name: ${skill.name || '(missing)'}`)
    if (!String(skill.path || '').trim()) throw new TypeError(`extension skill ${skill.name} must provide a package-relative path`)
    return Object.freeze({...skill, name: String(skill.name), path: String(skill.path)})
}))

// Public composition contract for packages layered on top of the MIT core. Extensions may add
// tools, local audit providers and packaged skills, but cannot replace core tools or profiles.
export function defineWeavatrixExtension(spec) {
    if (!spec || typeof spec !== 'object') throw new TypeError('extension definition must be an object')
    const name = String(spec.name || '')
    const version = String(spec.version || '')
    if (!EXTENSION_NAME.test(name)) throw new TypeError(`invalid extension name: ${name || '(missing)'}`)
    if (!version.trim()) throw new TypeError(`extension ${name} must provide a version`)
    return Object.freeze({
        name,
        version,
        tools: validateTools(spec.tools),
        profiles: validateProfiles(spec.profiles),
        auditProviders: validateAuditProviders(spec.auditProviders),
        skills: validateSkills(spec.skills),
    })
}

export function normalizeWeavatrixExtensions(extensions = []) {
    const normalized = asArray(extensions, 'extensions').map((extension) => defineWeavatrixExtension(extension))
    const names = new Set()
    for (const extension of normalized) {
        if (names.has(extension.name)) throw new TypeError(`duplicate extension name: ${extension.name}`)
        names.add(extension.name)
    }
    return Object.freeze(normalized)
}

export const extensionRuntimeSummary = (extensions = []) => extensions.map((extension) => ({
    name: extension.name,
    version: extension.version,
    tools: extension.tools.length,
    auditProviders: extension.auditProviders.length,
    skills: extension.skills.map((skill) => skill.name),
}))
