export function frame(value, extraHeaders = '') {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    return Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n${extraHeaders}\r\n`, 'ascii'),
        body,
    ])
}

export const FAKE_SERVER = String.raw`
const inside = process.argv[2]
const outside = process.argv[3]
const range = {start: {line: 0, character: 0}, end: {line: 0, character: 6}}
let buffer = Buffer.alloc(0)
let expected = null

function send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const framed = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body])
    const split = Math.max(1, Math.floor(framed.length / 2))
    process.stdout.write(framed.subarray(0, split))
    setImmediate(() => process.stdout.write(framed.subarray(split)))
}

function handle(message) {
    if (message.method === 'initialize') {
        send({jsonrpc: '2.0', id: message.id, result: {
            capabilities: {definitionProvider: true, referencesProvider: true},
            clientInfo: message.params.clientInfo,
            inside,
        }})
    } else if (message.method === 'textDocument/definition') {
        send({jsonrpc: '2.0', id: message.id, result: [
            {targetUri: inside, targetRange: range, targetSelectionRange: range},
            {uri: outside, range},
        ]})
    } else if (message.method === 'textDocument/references') {
        send({jsonrpc: '2.0', id: message.id, result: [{uri: inside, range}, {uri: outside, range}]})
    } else if (message.method === 'shutdown') {
        send({jsonrpc: '2.0', id: message.id, result: null})
    } else if (message.method === 'exit') {
        process.exit(0)
    }
}

process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length) {
        if (expected == null) {
            const marker = buffer.indexOf('\r\n\r\n')
            if (marker < 0) return
            const header = buffer.subarray(0, marker).toString('ascii')
            expected = Number(/Content-Length: ([0-9]+)/i.exec(header)[1])
            buffer = buffer.subarray(marker + 4)
        }
        if (buffer.length < expected) return
        const body = buffer.subarray(0, expected)
        buffer = buffer.subarray(expected)
        expected = null
        handle(JSON.parse(body.toString('utf8')))
    }
})
`
