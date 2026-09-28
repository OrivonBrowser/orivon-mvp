// The Worker runtime's two halves, run in-process against a fake parent
// channel: spawn over a real WASI program (JSPI enabled), fork over a module
// the test plays itself.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { hasJspi, jspiWebAssembly } from '../../wasi/tests/support/jspi.js'
import { echoProgram, failingProgram, trappingProgram } from '../../wasi/tests/support/programs.js'
import { type OrivonServer, serveOrivon } from '../orivon-server.js'
import type { ParentChannel } from '../parent.js'
import type { FromWorker, ToWorker } from '../protocol.js'
import { type ForkScope, runFork } from '../runtime-fork.js'
import { runSpawn } from '../runtime-spawn.js'

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

/** A parent that acknowledges every chunk of output as it arrives, as an ever-reading page would. */
function fakeParent (): FakeParent {
  const posts: FromWorker[] = []
  let handler: (message: ToWorker) => void = () => {}
  return {
    posts,
    post: (message) => {
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
    return { type: 'spawn', module: new jspiWebAssembly.Module(bytes), args: ['prog'], env: {}, preopens: { '/': '/orivon/app' }, orivon: await orivonPort() }
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
})

describe('runFork', () => {
  function fakeScope (): ForkScope & { closed: () => boolean, dispatch: (event: Event) => void } {
    const target = new EventTarget()
    let closed = false
    return Object.assign(target, {
      close: () => { closed = true },
      closed: () => closed,
      dispatch: (event: Event) => target.dispatchEvent(event)
    }) as unknown as ForkScope & { closed: () => boolean, dispatch: (event: Event) => void }
  }

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
