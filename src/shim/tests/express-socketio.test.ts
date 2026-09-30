// The shim's http.createServer under the two libraries a Node web app runs on:
// real express (routing, JSON bodies, express.static over the shim's fs) and a
// real socket.io server (polling and websocket transports), each driven by a
// real client. The server is bundled against the shim, as a port bundles its
// own, and runs in a child process with orivon.fs on a temporary directory
// and orivon.net.listen on a real loopback socket.

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { orivonShimPlugin } from '../bundler/esbuild-plugin.js'
import { fetchFrom } from './support/http-server-harness.js'

const APP = fileURLToPath(new URL('./support/apps/express-socketio-app.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The two support files that stand in for the broker keep Node's own builtins; the shim's plugin would otherwise map them into the shim. */
const realNodeImporters: esbuild.Plugin = {
  name: 'real-node-for-the-host-side',
  setup (build) {
    build.onResolve({ filter: /^(node:)?(fs|fs\/promises|os|path|net|stream|events|buffer|util)$/ }, (args) => {
      if (!/(express-socketio-host\.mjs|real-disk-fs\.ts|real-tcp-listen\.ts)$/.test(args.importer)) return undefined
      return { path: args.path.startsWith('node:') ? args.path : `node:${args.path}`, external: true }
    })
  }
}

let dir = ''
let child: ChildProcess | undefined
let port = 0
const clients: Socket[] = []

async function startServer (): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'orivon-express-'))
  const built = await esbuild.build({
    entryPoints: [APP], bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false,
    absWorkingDir: REPO_ROOT, plugins: [realNodeImporters, orivonShimPlugin()], logLevel: 'silent'
  })
  const bundle = join(dir, 'server.mjs')
  writeFileSync(bundle, built.outputFiles[0]?.text ?? '')
  child = spawn(process.execPath, ['--no-warnings', bundle], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start: ${stderr}`)), 20_000)
    child?.stdout?.on('data', (chunk: Buffer) => {
      const match = /PORT (\d+)/.exec(chunk.toString())
      if (match !== null) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child?.on('exit', () => { clearTimeout(timer); reject(new Error(`the server exited: ${stderr}`)) })
  })
}

function client (transports: string[]): Socket {
  const socket = connect(`http://127.0.0.1:${port}`, { transports, forceNew: true, reconnection: false })
  clients.push(socket)
  return socket
}

const once = async <T>(socket: Socket, event: string): Promise<T> => await new Promise<T>((resolve) => { socket.once(event, resolve) })

beforeAll(startServer, 60_000)
afterAll(() => {
  for (const socket of clients) socket.close()
  child?.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe('express on the shim\'s http.createServer', () => {
  it('routes a JSON request and parses its query', async () => {
    const reply = await fetchFrom(port, '/api/hello?x=1')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toContain('application/json')
    expect(JSON.parse(reply.text)).toEqual({ hello: 'world', query: { x: '1' } })
    expect(reply.headers.etag).toMatch(/^W\//)
  })

  it('parses a JSON body', async () => {
    const reply = await fetchFrom(port, '/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: [1, 2] }) })
    expect(reply.status).toBe(201)
    expect(JSON.parse(reply.text)).toEqual({ received: { a: [1, 2] } })
  })

  it('serves a static file from the app\'s files with its validators, and answers a conditional request 304', async () => {
    const first = await fetchFrom(port, '/hello.txt')
    expect(first.status).toBe(200)
    expect(first.text).toBe('hello from the app files, served by express.static')
    expect(first.headers['content-type']).toContain('text/plain')
    const { etag } = first.headers
    expect(etag).toBeDefined()
    expect(first.headers['last-modified']).toBeDefined()
    expect(first.headers['accept-ranges']).toBe('bytes')
    const second = await fetchFrom(port, '/hello.txt', { headers: { 'if-none-match': etag as string } })
    expect(second.status).toBe(304)
    expect(second.body.length).toBe(0)
  })

  it('serves a byte range as 206', async () => {
    const reply = await fetchFrom(port, '/hello.txt', { headers: { range: 'bytes=6-9' } })
    expect(reply.status).toBe(206)
    expect(reply.text).toBe('from')
    expect(reply.headers['content-range']).toBe('bytes 6-9/50')
  })

  it('serves an index document for a directory, and answers 404 for a missing file', async () => {
    expect((await fetchFrom(port, '/')).text).toContain('<title>lounge</title>')
    expect((await fetchFrom(port, '/nope.txt')).status).toBe(404)
  })
})

describe('socket.io on the shim\'s http.createServer', () => {
  it('connects over polling, exchanges an acknowledged event, and receives a broadcast', async () => {
    const socket = client(['polling'])
    const welcome = await once<{ transport: string }>(socket, 'welcome')
    expect(welcome.transport).toBe('polling')
    expect(await socket.emitWithAck('add', 2, 3)).toBe(5)
    const shouted = once<string>(socket, 'shouted')
    socket.emit('shout', 'quiet')
    expect(await shouted).toBe('QUIET')
  })

  it('connects over websocket, and carries binary data', async () => {
    const socket = client(['websocket'])
    const welcome = await once<{ transport: string }>(socket, 'welcome')
    expect(welcome.transport).toBe('websocket')
    expect(await socket.emitWithAck('add', 20, 22)).toBe(42)
    expect(await socket.emitWithAck('blob', new Uint8Array(70_000))).toBe(70_000)
  })

  it('starts on polling and upgrades to websocket', async () => {
    const socket = client(['polling', 'websocket'])
    await once(socket, 'welcome')
    await expect.poll(() => socket.io.engine.transport.name, { timeout: 5000 }).toBe('websocket')
    expect(await socket.emitWithAck('add', 1, 1)).toBe(2)
  })

  it('a second client sees a broadcast made by the first', async () => {
    const one = client(['websocket'])
    const two = client(['polling'])
    await Promise.all([once(one, 'welcome'), once(two, 'welcome')])
    const heard = once<string>(two, 'shouted')
    one.emit('shout', 'hi')
    expect(await heard).toBe('HI')
  })
})
