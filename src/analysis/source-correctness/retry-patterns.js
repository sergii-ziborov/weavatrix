import {makeFinding} from '../findings.js'

const RETRY_SIGNAL = /\b(?:retry|retries|retrying|reconnect|backoff|attempts?)\b/i
const WAIT_SIGNAL = /\b(?:sleep|delay)\s*\(/i
const FAILURE_SIGNAL = /\b(?:catch|isError|error|exception|failed?|healthCheck)\b/i
const TERMINATION_POLICY = /\b(?:max(?:imum)?(?:Retries|Attempts)|retryLimit|attemptLimit|deadline|timeout|isInterrupted)\b|\bcontext\s*\.\s*Done\b|\bsignal\s*\.\s*aborted\b|\battempts?\s*(?:>=|>)\s*\w+|\bbreak\s*;/i

const lineAt = (text, index) => {
    let line = 1
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
    return line
}

const lineText = (text, index) => {
    const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1
    const end = text.indexOf('\n', index)
    return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 300)
}

function balancedEnd(text, openAt) {
    if (text[openAt] !== '{') return -1
    let depth = 0
    for (let i = openAt; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) return i + 1
    }
    return -1
}

function retryFinding(text, file, index) {
    return makeFinding({
        category: 'structure',
        rule: 'unbounded-retry-loop',
        severity: 'low',
        confidence: 'medium',
        title: 'Retry/poll loop has no visible attempt, deadline, or cancellation bound',
        detail: 'A repeating loop contains retry/failure plus wait behavior but no local maximum-attempt, deadline, cancellation, interrupt, or explicit break policy was recognized. This is a review signal, not proof of an infinite loop; success or a called helper may terminate it.',
        file,
        line: lineAt(text, index),
        evidence: [{file, line: lineAt(text, index), snippet: lineText(text, index)}],
        fixHint: 'confirm and document the retry termination/cancellation policy',
    })
}

function retryBehavior(source) {
    return RETRY_SIGNAL.test(source) || (WAIT_SIGNAL.test(source) && FAILURE_SIGNAL.test(source))
}

function bracedRetryFindings(text, masked, file) {
    const findings = []
    const re = /\bwhile\s*\(([^)]*)\)\s*\{|\bfor\s*\(\s*;\s*;\s*\)\s*\{|\bfor\s*\{|\bdo\s*\{/g
    let match
    while ((match = re.exec(masked))) {
        const open = re.lastIndex - 1
        const end = balancedEnd(masked, open)
        if (end < 0) continue
        const body = masked.slice(open + 1, end - 1)
        const context = masked.slice(Math.max(0, match.index - 250), match.index)
        let condition = match[1] || '', tailLength = 0
        if (/^do\b/.test(match[0])) {
            const tail = /^\s*while\s*\(([^)]*)\)\s*;/.exec(masked.slice(end))
            condition = tail?.[1] || ''
            tailLength = tail?.[0]?.length || 0
        }
        const evidence = `${context}\n${condition}\n${body}`
        if (retryBehavior(evidence) && !TERMINATION_POLICY.test(`${condition}\n${body}`)) {
            findings.push(retryFinding(text, file, match.index))
        }
        re.lastIndex = end + tailLength
    }
    return findings
}

function pythonRetryFindings(text, masked, file) {
    const findings = [], lines = masked.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const match = /^(\s*)while\s+True\s*:/.exec(lines[i])
        if (!match) continue
        const indent = match[1].length
        let end = i + 1
        while (end < lines.length && (!lines[end].trim() || /^\s*/.exec(lines[end])[0].length > indent)) end++
        const body = lines.slice(i + 1, end).join('\n')
        const context = lines.slice(Math.max(0, i - 8), i).join('\n')
        if (retryBehavior(`${context}\n${body}`) && !TERMINATION_POLICY.test(body)) {
            findings.push(retryFinding(text, file, text.split(/\r?\n/).slice(0, i).join('\n').length + (i ? 1 : 0)))
        }
    }
    return findings
}

export function retryFindings(text, masked, file, {python = false} = {}) {
    return python ? pythonRetryFindings(text, masked, file) : bracedRetryFindings(text, masked, file)
}
