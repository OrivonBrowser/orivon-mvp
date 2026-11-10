import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OWN_READ_HEADER, SHELL_ANSWERED_HEADER } from '../../../../loader/fetch/content-root.js'
import type { FromHost, RelayRequest, RelayToHost } from '../../protocol.js'
import { RELAY_IDLE_MS, ShellRelay } from '../shell-relay.js'

// The host's half of a request for a host the shell serves: what crosses to the shell, what is written back, and what
// happens when either side goes. The server is a real one on loopback, so the socket's own behaviour is the one tested.

const PUBLIC = 'treat-as-public-address'
const TOKEN = 'a-secret-chosen-at-random'

interface Reply { status: number, headers: IncomingHttpHeaders, rawHeaders: string[], body: Buffer, error?: string }

let server: Server | undefined
afterEach(async () => {
  const closing = server
  server = undefined
  if (closing === undefined) return
  closing.closeAllConnections()
  await new Promise<void>((resolve) => { closing.close(() => { resolve() }) })
})

async function start (relay: ShellRelay, network = 'network'): Promise<number> {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase()
    if (relay.wants(host, req.headers)) relay.relay(req, res, new URL(req.url ?? '/', `https://${host}`), PUBLIC)
    else res.writeHead(200, { 'x-answered-by': 'the network' }).end(network)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function get (port: number, path: string, options: { host?: string, method?: string, headers?: Record<string, string>, abortAfterMs?: number } = {}): { done: Promise<Reply>, abort: () => void } {
  let abort = (): void => {}
  const done = new Promise<Reply>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: options.host ?? 'kept.example', 'sec-fetch-site': 'same-origin', ...options.headers } }, (res) => {
      const chunks: Buffer[] = []
      const finish = (error?: string): void => { resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), ...(error === undefined ? {} : { error }) }) }
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { finish() })
      res.on('error', (error) => { finish(error.message) })
      res.on('aborted', () => { finish('aborted') })
    })
    abort = () => { req.destroy() }
    req.on('error', (error) => { resolve({ status: 0, headers: {}, rawHeaders: [], body: Buffer.alloc(0), error: error.message }) })
    req.end()
  })
  return { done, abort: () => { abort() } }
}

function harness (options: { token?: string | undefined, idleMs?: number, limit?: number } = {}): { relay: ShellRelay, posted: FromHost[], requests: () => RelayRequest[], lastRequest: () => RelayRequest, answer: (message: RelayToHost) => void } {
  const posted: FromHost[] = []
  const relay = new ShellRelay({ post: (message) => posted.push(message), ownReadToken: 'token' in options ? options.token : TOKEN, ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }), ...(options.limit === undefined ? {} : { limit: options.limit }) })
  relay.setServed(['https://kept.example'])
  const requests = (): RelayRequest[] => posted.filter((message): message is RelayRequest => message.type === 'relay-request')
  const lastRequest = (): RelayRequest => {
    const found = requests().at(-1)
    if (found === undefined) throw new Error('nothing was relayed')
    return found
  }
  return { relay, posted, requests, lastRequest, answer: (message) => { relay.receive(message) } }
}

/** Waits until `check` holds, polling on the event loop. */
async function until (check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000; tries += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`never: ${what}`)
}

describe('which requests are handed to the shell', () => {
  it('hands over only what the browser made for the site, whichever route its session takes', () => {
    const { relay } = harness()
    const mark = (site: string, mode?: string, dest?: string): IncomingHttpHeaders => ({ 'sec-fetch-site': site, ...(mode === undefined ? {} : { 'sec-fetch-mode': mode }), ...(dest === undefined ? {} : { 'sec-fetch-dest': dest }) })
    expect(relay.wants('kept.example', mark('same-origin'))).toBe(true)
    expect(relay.wants('kept.example', mark('none'))).toBe(true)
    expect(relay.wants('kept.example', mark('cross-site', 'navigate', 'document'))).toBe(true)
    expect(relay.wants('kept.example', mark('cross-site', 'navigate', 'iframe'))).toBe(false)
    expect(relay.wants('kept.example', mark('cross-site', 'no-cors', 'image'))).toBe(false)
    expect(relay.wants('kept.example', mark('same-site', 'cors', 'empty'))).toBe(false)
    expect(relay.wants('kept.example', {})).toBe(false)
    // The page that started the request decides when the shell stamped one: the site's own, even sandboxed, or another's.
    const stamped = (page: string, site: string): IncomingHttpHeaders => ({ 'x-orivon-partition': page, 'sec-fetch-site': site })
    expect(relay.wants('kept.example', stamped('https://kept.example', 'cross-site'))).toBe(true)
    expect(relay.wants('kept.example', stamped('https://evil.example', 'same-origin'))).toBe(false)
    expect(relay.wants('kept.example', { ...stamped('https://evil.example', 'cross-site'), 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).toBe(true)
    // A tunnel profile's request is the shell's too, whether the app is served from its pin or live: the shell's live reads leave by that profile's tunnel.
    expect(relay.wants('kept.example', { ...mark('same-origin'), 'x-orivon-route': 'socks5' })).toBe(true)
    expect(relay.wants('other.example', mark('same-origin'))).toBe(false)
  })

  it('hands over a request for a host the shell serves, and answers any other from the network', async () => {
    const { relay, requests } = harness()
    const port = await start(relay)
    const other = await get(port, '/app.js', { host: 'elsewhere.example' }).done
    expect(other.body.toString()).toBe('network')
    expect(requests()).toHaveLength(0)
    void get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
  })

  it('hands over nothing while the server has no secret to tell the shell\'s own reads by', async () => {
    const { relay, requests } = harness({ token: undefined })
    const port = await start(relay)
    expect((await get(port, '/app.js').done).body.toString()).toBe('network')
    expect(requests()).toHaveLength(0)
  })

  it('keeps a read that carries the shell\'s secret for the network, so a handler that reads this server is not sent back to itself', async () => {
    const { relay, requests } = harness()
    const port = await start(relay)
    const own = await get(port, '/app.js', { headers: { [OWN_READ_HEADER]: TOKEN } }).done
    expect(own.body.toString()).toBe('network')
    expect(requests()).toHaveLength(0)
  })

  it('hands over a request that claims to be the shell\'s own without the secret, and does not pass the claim on', async () => {
    const { relay, lastRequest, requests } = harness()
    const port = await start(relay)
    void get(port, '/app.js', { headers: { [OWN_READ_HEADER]: 'a-guess' } })
    await until(() => requests().length === 1, 'the forged read reached the shell')
    void get(port, '/app.js', { headers: { [OWN_READ_HEADER]: `${TOKEN}x` } })
    await until(() => requests().length === 2, 'the near miss reached the shell')
    expect(lastRequest().headers.some(([name]) => name === OWN_READ_HEADER)).toBe(false)
  })

  it('follows the set it was last given, and takes only default-port https origins from it', async () => {
    const { relay, requests } = harness()
    const port = await start(relay)
    relay.setServed(['https://other.example', 'http://kept.example', 'https://kept.example:8443', 'kept.example', 'https://kept.example/with/path', 'https://third.example'])
    expect((await get(port, '/app.js').done).body.toString()).toBe('network')
    void get(port, '/app.js', { host: 'other.example' })
    await until(() => requests().length === 1, 'the request for the host now served reached the shell')
    expect(requests().map((request) => new URL(request.url).host)).toEqual(['other.example'])
    relay.setServed([])
    expect((await get(port, '/app.js', { host: 'other.example' }).done).body.toString()).toBe('network')
  })
})

describe('what crosses to the shell', () => {
  it('carries the method, the address and the headers the client sent, lower-cased, without the ones that belong to the connection', async () => {
    const { relay, lastRequest, requests } = harness()
    const port = await start(relay)
    void get(port, '/dir/app.js?x=1', { method: 'HEAD', headers: { Range: 'bytes=0-3', 'Sec-Fetch-Mode': 'navigate', Connection: 'keep-alive', 'X-Orivon-Partition': 'https://kept.example' } })
    await until(() => requests().length === 1, 'the request reached the shell')
    const sent = lastRequest()
    expect(sent.method).toBe('HEAD')
    expect(sent.url).toBe('https://kept.example/dir/app.js?x=1')
    const names = sent.headers.map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining(['range', 'sec-fetch-mode', 'x-orivon-partition']))
    expect(names).not.toContain('host')
    expect(names).not.toContain('connection')
    expect(sent.headers.find(([name]) => name === 'range')?.[1]).toBe('bytes=0-3')
  })

  it('numbers each request of its own', async () => {
    const { relay, requests } = harness()
    const port = await start(relay)
    void get(port, '/a.js')
    void get(port, '/b.js')
    await until(() => requests().length === 2, 'both reached the shell')
    expect(new Set(requests().map((request) => request.id)).size).toBe(2)
  })
})

describe('what is written back', () => {
  it('writes the status, the headers and the body as the shell gave them, with the public-address policy added beside the shell\'s own', async () => {
    const { relay, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 206, headers: [['content-type', 'text/javascript'], ['content-security-policy', "default-src 'self'"], ['content-range', 'bytes 0-3/9'], ['x-twice', 'a'], ['x-twice', 'b']] })
    answer({ type: 'relay-body', id, chunk: new TextEncoder().encode('run(') })
    answer({ type: 'relay-end', id })
    const done = await reply.done
    expect(done.status).toBe(206)
    expect(done.body.toString()).toBe('run(')
    expect(done.headers['content-type']).toBe('text/javascript')
    expect(done.headers['content-range']).toBe('bytes 0-3/9')
    expect(done.headers['x-twice']).toBe('a, b')
    const policies = done.rawHeaders.flatMap((value, at) => at % 2 === 0 && value.toLowerCase() === 'content-security-policy' ? [done.rawHeaders[at + 1]] : [])
    expect(policies).toEqual(["default-src 'self'", PUBLIC])
  })

  it('marks what the shell answered, once, and takes a mark the shell\'s own answer carried: only this server says it was relayed', async () => {
    const { relay, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [['content-type', 'text/html'], [SHELL_ANSWERED_HEADER, 'a-claim'], [SHELL_ANSWERED_HEADER.toUpperCase(), 'another']] })
    answer({ type: 'relay-end', id })
    const done = await reply.done
    expect(done.headers[SHELL_ANSWERED_HEADER]).toBe('1')
    const marks = done.rawHeaders.filter((value, at) => at % 2 === 0 && value.toLowerCase() === SHELL_ANSWERED_HEADER)
    expect(marks).toHaveLength(1)
  })

  it('marks nothing it answers itself: the network\'s answer, and a request kept for the network, carry no mark', async () => {
    const { relay, requests } = harness()
    const port = await start(relay)
    const elsewhere = await get(port, '/app.js', { host: 'elsewhere.example' }).done
    expect(elsewhere.headers[SHELL_ANSWERED_HEADER]).toBeUndefined()
    const own = await get(port, '/app.js', { headers: { [OWN_READ_HEADER]: TOKEN } }).done
    expect(own.headers[SHELL_ANSWERED_HEADER]).toBeUndefined()
    expect(requests()).toHaveLength(0)
  })

  it('leaves out the headers that belong to the connection the answer was made on', async () => {
    const { relay, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [['connection', 'close'], ['keep-alive', 'timeout=1'], ['content-length', '2']] })
    answer({ type: 'relay-body', id, chunk: new TextEncoder().encode('ok') })
    answer({ type: 'relay-end', id })
    const done = await reply.done
    expect(done.body.toString()).toBe('ok')
    // The server keeps its own connection's terms; the shell's were for a connection that was not this one.
    expect(done.headers['keep-alive']).not.toBe('timeout=1')
    expect(done.headers['content-length']).toBe('2')
  })

  it('answers a HEAD with the shell\'s headers and no body', async () => {
    const { relay, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js', { method: 'HEAD' })
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [['content-length', '9']] })
    answer({ type: 'relay-end', id })
    const done = await reply.done
    expect(done.status).toBe(200)
    expect(done.headers['content-length']).toBe('9')
    expect(done.body).toHaveLength(0)
  })

  it('says the shell wrote a chunk once the socket took it, with its length, and never before the chunk came', async () => {
    const { relay, posted, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/big.bin')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    const wrote = (): number[] => posted.filter((message) => message.type === 'relay-wrote').map((message) => (message as { bytes: number }).bytes)
    answer({ type: 'relay-head', id, status: 200, headers: [] })
    expect(wrote()).toEqual([])
    answer({ type: 'relay-body', id, chunk: new Uint8Array(1000) })
    answer({ type: 'relay-body', id, chunk: new Uint8Array(24) })
    await until(() => wrote().length === 2, 'both chunks were written')
    expect(wrote()).toEqual([1000, 24])
    expect(posted.filter((message) => message.type === 'relay-wrote').every((message) => (message as { id: number }).id === id)).toBe(true)
    answer({ type: 'relay-end', id })
    expect((await reply.done).body).toHaveLength(1024)
  })
})

describe('when the client leaves', () => {
  it('tells the shell to stop, and drops what the shell still sends for that request', async () => {
    const { relay, posted, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/stream.bin')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [] })
    answer({ type: 'relay-body', id, chunk: new Uint8Array(10) })
    reply.abort()
    await until(() => posted.some((message) => message.type === 'relay-abort'), 'the shell was told to stop')
    expect(posted.filter((message) => message.type === 'relay-abort')).toEqual([{ type: 'relay-abort', id }])
    expect(() => { answer({ type: 'relay-body', id, chunk: new Uint8Array(10) }); answer({ type: 'relay-end', id }) }).not.toThrow()
    const before = posted.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(posted.length).toBe(before)
  })

  it('does not tell the shell to stop an answer that finished', async () => {
    const { relay, posted, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [] })
    answer({ type: 'relay-end', id })
    await reply.done
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(posted.some((message) => message.type === 'relay-abort')).toBe(false)
  })
})

describe('when the shell cannot answer', () => {
  it('fails the load of a request the shell reports an error for, before it began an answer', async () => {
    const { relay, lastRequest, requests, answer, posted } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    answer({ type: 'relay-error', id: lastRequest().id, message: 'the handler failed' })
    const done = await reply.done
    expect(done.status).toBe(0)
    expect(done.error).toBeDefined()
    expect(posted.some((message) => message.type === 'relay-abort')).toBe(false)
  })

  it('cuts the connection of a request the shell reports an error for after the head, so the client sees an answer that is incomplete', async () => {
    const { relay, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [['content-length', '100']] })
    answer({ type: 'relay-body', id, chunk: new Uint8Array(10) })
    answer({ type: 'relay-error', id, message: 'the file ended early' })
    const done = await reply.done
    expect(done.error).toBeDefined()
    expect(done.body.length).toBeLessThan(100)
  })

  it.each([
    ['a status that is no answer', { type: 'relay-head', status: 100, headers: [] }],
    ['a status that is not a number', { type: 'relay-head', status: '200', headers: [] }],
    ['headers that are not pairs', { type: 'relay-head', status: 200, headers: ['content-type'] }],
    ['a header the socket refuses', { type: 'relay-head', status: 200, headers: [['bad name', 'x']] }],
    ['an end before any head', { type: 'relay-end' }],
    ['a body before any head', { type: 'relay-body', chunk: new Uint8Array(1) }]
  ])('refuses %s: the shell is told to stop and the connection is cut', async (_name, partial) => {
    const { relay, posted, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ ...partial, id } as unknown as RelayToHost)
    const done = await reply.done
    expect(done.status).toBe(0)
    expect(posted.filter((message) => message.type === 'relay-abort')).toEqual([{ type: 'relay-abort', id }])
  })

  it('refuses a body that is not bytes', async () => {
    const { relay, posted, lastRequest, requests, answer } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [] })
    answer({ type: 'relay-body', id, chunk: 'text' } as unknown as RelayToHost)
    await reply.done
    expect(posted.some((message) => message.type === 'relay-abort')).toBe(true)
  })

  it('cuts a request nobody has answered for the idle time, and tells the shell to stop', async () => {
    const { relay, posted, requests } = harness({ idleMs: 40 })
    const port = await start(relay)
    const reply = await get(port, '/app.js').done
    expect(requests()).toHaveLength(1)
    expect(reply.status).toBe(0)
    expect(posted.some((message) => message.type === 'relay-abort')).toBe(true)
  })

  it('waits the idle time out of the shell\'s last word, not of the first request', async () => {
    const { relay, posted, lastRequest, requests, answer } = harness({ idleMs: 120 })
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    const { id } = lastRequest()
    answer({ type: 'relay-head', id, status: 200, headers: [] })
    for (let sent = 0; sent < 4; sent += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      answer({ type: 'relay-body', id, chunk: new Uint8Array(4) })
    }
    answer({ type: 'relay-end', id })
    const done = await reply.done
    expect(done.status).toBe(200)
    expect(done.body).toHaveLength(16)
    expect(posted.some((message) => message.type === 'relay-abort')).toBe(false)
  })

  it('answers 503 when it already holds as many requests as it may', async () => {
    const { relay, requests } = harness({ limit: 2 })
    const port = await start(relay)
    void get(port, '/a.js')
    void get(port, '/b.js')
    await until(() => requests().length === 2, 'two requests are held')
    const third = await get(port, '/c.js').done
    expect(third.status).toBe(503)
    expect(requests()).toHaveLength(2)
  })

  it('cuts every request still waiting when it is disposed of', async () => {
    const { relay, requests } = harness()
    const port = await start(relay)
    const reply = get(port, '/app.js')
    await until(() => requests().length === 1, 'the request reached the shell')
    relay.dispose()
    expect((await reply.done).status).toBe(0)
  })
})

it('gives an unanswered request five minutes by default', () => {
  expect(RELAY_IDLE_MS).toBe(5 * 60_000)
})
