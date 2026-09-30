// The Worker runtime's three halves, run in-process against a fake parent
// channel: spawn over a real WASI program (JSPI enabled), fork and thread
// over a module the test plays itself.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { hasJspi, jspiWebAssembly } from '../../wasi/tests/support/jspi.js'
import { echoProgram, failingProgram, reportWrittenProgram, trappingProgram } from '../../wasi/tests/support/programs.js'
import { instantiateFrom, tourFixture } from '../../wasi-p2/tests/support/component-fixture.js'
import { type OrivonServer, serveOrivon } from '../orivon-server.js'
import type { ParentChannel } from '../parent.js'
import type { FromWorker, ToWorker } from '../protocol.js'
import { type ForkScope, runFork } from '../runtime-fork.js'
import { runSpawn } from '../runtime-spawn.js'
import { runThread } from '../runtime-thread.js'

let disk: RealDiskFs | undefined
let server: OrivonServer | undefined

afterEach(async () => {
  await server?.dispose()
  await disk?.cleanup()
  disk = undefined
  server = undefined
})

interface FakeParent extends ParentChannel {
  readonly posts: FromWorker[]
  send (message: ToWorker): void
}

/**
 * A parent that acknowledges every chunk of output as it arrives, as an
 * ever-reading page would. Each message is cloned with its transfer list, as
 * postMessage does, so a transferred buffer is detached on the sending side.
 */
function fakeParent (): FakeParent {
  const posts: FromWorker[] = []
  let handler: (message: ToWorker) => void = () => {}
  return {
    posts,
    post: (sent, transfer = []) => {
      const message = structuredClone(sent, { transfer })
      posts.push(message)
      if (message.type === 'output') queueMicrotask(() => { handler({ type: 'ack', stream: message.stream }) })
    },
    onMessage: (next) => { handler = next },
    send: (message) => { handler(message) }
  }
}

function output (parent: FakeParent, stream: 'stdout' | 'stderr'): string {
  return parent.posts.flatMap((post) => post.type === 'output' && post.stream === stream ? [new TextDecoder().decode(post.data)] : []).join('')
}

async function orivonPort (): Promise<MessagePort> {
  disk = await createRealDiskFs()
  const channel = new MessageChannel()
  server = serveOrivon(channel.port1, disk.orivon)
  return channel.port2
}

describe.skipIf(!hasJspi)('runSpawn', () => {
  async function spawnStart (bytes: Uint8Array<ArrayBuffer>): Promise<Parameters<typeof runSpawn>[0]> {
    return { type: 'spawn', program: { kind: 'core', module: new jspiWebAssembly.Module(bytes) }, args: ['prog'], env: {}, preopens: { '/': '/orivon/app' }, orivon: await orivonPort() }
  }

  it('feeds stdin to the program and delivers its stdout, then reports its exit code', async () => {
    const parent = fakeParent()
    const running = runSpawn(await spawnStart(echoProgram()), parent, jspiWebAssembly)
    parent.send({ type: 'stdin', data: new TextEncoder().encode('hello ') })
    parent.send({ type: 'stdin', data: new TextEncoder().encode('world') })
    parent.send({ type: 'stdin-end' })
    await running
    expect(parent.posts[0]).toEqual({ type: 'started' })
    expect(output(parent, 'stdout')).toBe('hello world')
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 0, signal: null })
  })

  it('sends the next chunk of output only once the page has taken the last', async () => {
    const posts: FromWorker[] = []
    let handler: (message: ToWorker) => void = () => {}
    let reading = false
    const parent: ParentChannel = {
      post: (message) => {
        posts.push(message)
        if (reading && message.type === 'output') queueMicrotask(() => { handler({ type: 'ack', stream: message.stream }) })
      },
      onMessage: (next) => { handler = next }
    }
    const running = runSpawn(await spawnStart(echoProgram()), parent, jspiWebAssembly)
    handler({ type: 'stdin', data: new Uint8Array(200).fill(97) })
    handler({ type: 'stdin-end' })
    await vi.waitFor(() => { expect(posts.filter((post) => post.type === 'output')).toHaveLength(1) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posts.filter((post) => post.type === 'output')).toHaveLength(1)
    reading = true
    handler({ type: 'ack', stream: 'stdout' })
    await running
    expect(posts.filter((post) => post.type === 'output')).toHaveLength(4)
    expect(posts.at(-1)).toEqual({ type: 'exit', code: 0, signal: null })
  })

  it('tells the program how many bytes fd_write wrote, which a real libc checks before writing again', async () => {
    const parent = fakeParent()
    await runSpawn(await spawnStart(reportWrittenProgram('hello')), parent, jspiWebAssembly)
    expect(output(parent, 'stdout')).toBe('hello')
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 5, signal: null })
  })

  it('passes a program\'s own exit code and stderr through', async () => {
    const parent = fakeParent()
    await runSpawn(await spawnStart(failingProgram('bad input\n', 3)), parent, jspiWebAssembly)
    expect(output(parent, 'stderr')).toBe('bad input\n')
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 3, signal: null })
  })

  it('reports a trap as a crash, SIGABRT with no exit code, as Node reports a crashed child', async () => {
    const parent = fakeParent()
    await runSpawn(await spawnStart(trappingProgram()), parent, jspiWebAssembly)
    expect(output(parent, 'stderr')).toMatch(/unreachable/)
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: null, signal: 'SIGABRT' })
  })

  it('refuses a module that imports anything but WASI, before reporting it started', async () => {
    const parent = fakeParent()
    const foreign = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 9, 1, 3, 101, 110, 118, 1, 102, 0, 0])
    await runSpawn(await spawnStart(foreign), parent, jspiWebAssembly)
    expect(parent.posts).toEqual([{ type: 'failed', error: expect.objectContaining({ code: 'ENOEXEC' }) }])
  })

  it('runs a component\'s jco output: stdin to stdout, a file through the page\'s orivon.fs, stderr, and its exit', async () => {
    const fixture = tourFixture()
    vi.stubGlobal('fetch', async (url: string) => {
      const core = fixture.cores.get(new URL(url).pathname.replace('/bin/tour.p2/', ''))
      return core === undefined ? new Response(null, { status: 404 }) : new Response(core as Uint8Array<ArrayBuffer>)
    })
    const parent = fakeParent()
    const start: Parameters<typeof runSpawn>[0] = {
      type: 'spawn',
      program: { kind: 'component', glue: 'https://app.test/bin/tour.p2/tour.js', base: 'https://app.test/bin/tour.p2/' },
      args: ['tour'],
      env: {},
      preopens: { '/': '/orivon/app' },
      orivon: await orivonPort()
    }
    const running = runSpawn(start, parent, jspiWebAssembly, async () => instantiateFrom(fixture.glue, jspiWebAssembly))
    parent.send({ type: 'stdin', data: new TextEncoder().encode('through a worker\n') })
    parent.send({ type: 'stdin-end' })
    await running
    vi.unstubAllGlobals()
    expect(output(parent, 'stdout')).toBe('through a worker\n')
    expect(output(parent, 'stderr')).toBe('done\n')
    expect(await disk?.readRealFile('from-component.txt')).toBe('written by a component\n')
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 1, signal: null })
  })
})

/** Shared by `runFork` and `runThread` below: `setupChildProcess` is common to both. */
function fakeScope (): ForkScope & { closed: () => boolean, dispatch: (event: Event) => void } {
  const target = new EventTarget()
  let closed = false
  return Object.assign(target, {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    close: () => { closed = true },
    closed: () => closed,
    dispatch: (event: Event) => target.dispatchEvent(event)
  }) as unknown as ForkScope & { closed: () => boolean, dispatch: (event: Event) => void }
}

describe('runFork', () => {
  function forkStart (port: MessagePort, serialization: 'json' | 'advanced' = 'json'): Parameters<typeof runFork>[0] {
    return { type: 'fork', url: 'https://app.test/child.js', argv: ['node', '/child.js', 'a'], env: { MODE: 'test' }, cwd: '/orivon/app', serialization, orivon: port }
  }

  it('gives the module argv, env, the shim globals and orivon, then answers IPC both ways', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      const proc = scope.process as unknown as { argv: string[], env: Record<string, string>, on: (event: string, listener: (m: unknown) => void) => void, send: (m: unknown) => boolean }
      proc.on('message', (message) => { proc.send({ echo: message, argv: proc.argv, mode: proc.env.MODE }) })
    })
    expect(typeof scope.setImmediate).toBe('function')
    expect(scope.orivon).toBeDefined()
    parent.send({ type: 'ipc', message: { hello: 1 } })
    expect(parent.posts).toContainEqual({ type: 'ipc', message: { echo: { hello: 1 }, argv: ['node', '/child.js', 'a'], mode: 'test' } })
  })

  it('sends console output to the parent as stdout and stderr, and keeps the Worker\'s own console', async () => {
    const scope = fakeScope()
    const own: string[] = []
    const record = (name: string) => (...args: unknown[]) => { own.push(`${name}:${args.join(' ')}`) }
    const console = { log: record('log'), info: record('info'), debug: record('debug'), warn: record('warn'), error: record('error'), trace: record('trace') }
    Object.assign(scope, { console })
    const parent = fakeParent()
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      console.log('listening on %s:%d', '127.0.0.1', 9000)
      console.info({ a: 1 })
      console.warn('careful')
      console.error(new Error('boom').message, 7)
    })
    expect(output(parent, 'stdout')).toBe("listening on 127.0.0.1:9000\n{ a: 1 }\n")
    expect(output(parent, 'stderr')).toBe('careful\nboom 7\n')
    expect(own).toEqual(['log:listening on %s:%d 127.0.0.1 9000', 'info:[object Object]', 'warn:careful', 'error:boom 7'])
  })

  it('installs a global require that esbuild\'s __require finds: a builtin by name, MODULE_NOT_FOUND for any other bare name', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    let seen: { path: unknown, code: unknown } | undefined
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      const require = (scope as unknown as { require: (id: string) => unknown }).require
      let code: unknown
      try { require('bufferutil') } catch (error) { code = (error as { code?: string }).code }
      seen = { path: typeof (require('path') as { join: unknown }).join, code }
    })
    expect(seen).toEqual({ path: 'function', code: 'MODULE_NOT_FOUND' })
  })

  it('holds a message sent while the module loads, and delivers it once the module has run', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    let release: () => void = () => {}
    const running = runFork(forkStart(await orivonPort()), parent, scope, async () => {
      await new Promise<void>((resolve) => { release = resolve })
      const proc = scope.process as unknown as { on: (event: string, listener: (m: unknown) => void) => void, send: (m: unknown) => boolean }
      proc.on('message', (message) => { proc.send({ got: message }) })
    })
    parent.send({ type: 'ipc', message: 'early' })
    release()
    await running
    expect(parent.posts).toContainEqual({ type: 'ipc', message: { got: 'early' } })
  })

  it('delivers a message to a module still loading once it listens, as a top-level await on the first message needs', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    const running = runFork(forkStart(await orivonPort()), parent, scope, async () => {
      const proc = scope.process as unknown as { once: (event: string, listener: (m: unknown) => void) => void, send: (m: unknown) => boolean }
      const first = await new Promise((resolve) => { proc.once('message', resolve) })
      proc.send({ configuredWith: first })
    })
    parent.send({ type: 'ipc', message: 'config' })
    await running
    expect(parent.posts).toContainEqual({ type: 'ipc', message: { configuredWith: 'config' } })
  })

  it('ends on its own with code 0 once the parent disconnects and nothing is pending, after beforeExit', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    const seen: string[] = []
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      const proc = scope.process as unknown as { on: (event: string, listener: (code: unknown) => void) => void }
      proc.on('beforeExit', () => seen.push('beforeExit'))
      proc.on('exit', () => seen.push('exit'))
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(parent.posts.some((post) => post.type === 'exit')).toBe(false)
    parent.send({ type: 'disconnect' })
    await vi.waitFor(() => { expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 0, signal: null }) })
    expect(seen).toEqual(['beforeExit', 'exit'])
    expect(scope.closed()).toBe(true)
  })

  it('stays alive after disconnecting while a timer is pending, and ends when it fires', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    let fired = false
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      const proc = scope.process as unknown as { disconnect: () => void }
      scope.setTimeout?.(() => { fired = true }, 40)
      proc.disconnect()
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(parent.posts.some((post) => post.type === 'exit')).toBe(false)
    await vi.waitFor(() => { expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 0, signal: null }) })
    expect(fired).toBe(true)
  })

  it('serialises messages as JSON by default, dropping what JSON drops', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      (scope.process as unknown as { send: (m: unknown) => boolean }).send({ keep: 1, drop: undefined })
    })
    expect(parent.posts).toContainEqual({ type: 'ipc', message: { keep: 1 } })
  })

  it('reports process.exit as the exit code and ends the Worker, and ignores code after it', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      (scope.process as unknown as { exit: (code: number) => never }).exit(4)
    })
    expect(parent.posts.filter((post) => post.type === 'exit')).toEqual([{ type: 'exit', code: 4, signal: null }])
    expect(scope.closed()).toBe(true)
  })

  it('ends with code 1 and the stack on stderr when the module throws, as a Node child does', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    await runFork(forkStart(await orivonPort()), parent, scope, async () => { throw new Error('module failed') })
    expect(output(parent, 'stderr')).toMatch(/module failed/)
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 1, signal: null })
  })

  it('never posts \'crash\' for a fork (only a worker_threads.Worker listens for it), even for an error structured clone alone could not carry', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    // A non-cloneable `cause`: posting this unconditionally, as 'crash' used to be, threw before
    // the stack ever reached stderr and before 'exit' was posted -- a regression for fork.
    const uncloneable = Object.assign(new Error('fork boom'), { cause: { oops () {} } })
    await runFork(forkStart(await orivonPort()), parent, scope, async () => { throw uncloneable })
    expect(parent.posts.some((post) => post.type === 'crash')).toBe(false)
    expect(output(parent, 'stderr')).toMatch(/fork boom/)
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 1, signal: null })
  })

  it('lets an uncaughtException listener keep the child alive, as in Node', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    const seen: unknown[] = []
    await runFork(forkStart(await orivonPort()), parent, scope, async () => {
      (scope.process as unknown as { on: (event: string, listener: (error: unknown) => void) => void }).on('uncaughtException', (error) => { seen.push(error) })
    })
    scope.dispatch(Object.assign(new Event('error', { cancelable: true }), { error: new Error('later') }))
    expect(seen).toHaveLength(1)
    expect(parent.posts.some((post) => post.type === 'exit')).toBe(false)
  })
})

describe('runThread', () => {
  function threadStart (port: MessagePort): Parameters<typeof runThread>[0] {
    const { port1 } = new MessageChannel()
    return {
      type: 'thread', url: 'https://app.test/thread.js', argv: ['node', '/thread.js'], env: {}, cwd: '/orivon/app',
      threadId: 1, workerData: undefined, name: 'test thread', parentPort: port1, orivon: port,
      stdin: false, stdout: false, stderr: false
    }
  }

  it('posts \'crash\' for an uncaught error, and never writes to stderr -- Node prints nothing for a thread, only the \'error\' event a worker_threads.Worker relays this as', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    await runThread(threadStart(await orivonPort()), parent, scope, async () => { throw new Error('thread boom') })
    expect(parent.posts).toContainEqual({ type: 'crash', error: expect.objectContaining({ message: 'thread boom' }) })
    expect(output(parent, 'stderr')).toBe('')
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 1, signal: null })
  })

  it('falls back to a plain Error when the thrown value cannot survive structured clone, instead of losing the crash path entirely', async () => {
    const scope = fakeScope()
    const parent = fakeParent()
    const uncloneable = { message: 'uncloneable', oops () {} }
    await runThread(threadStart(await orivonPort()), parent, scope, async () => { throw uncloneable })
    const crash = parent.posts.find((post): post is Extract<FromWorker, { type: 'crash' }> => post.type === 'crash')
    expect((crash?.error as { message?: unknown } | undefined)?.message).toBe('uncloneable')
    expect(parent.posts.at(-1)).toEqual({ type: 'exit', code: 1, signal: null })
  })
})
