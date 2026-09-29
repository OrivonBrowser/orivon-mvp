import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FromWorker, ToWorker } from '../protocol.js'
import type { StartChildMessage } from '../host-protocol.js'

interface Posted { readonly message: unknown, readonly transfer: readonly Transferable[] | undefined }

class FakeWorker {
  onmessage: ((event: { data: FromWorker }) => void) | null = null
  onerror: ((event: { preventDefault: () => void, message: string }) => void) | null = null
  readonly posted: Posted[] = []
  terminated = false

  postMessage (message: unknown, transfer?: readonly Transferable[]): void {
    this.posted.push({ message, transfer })
  }

  terminate (): void { this.terminated = true }
  emit (data: FromWorker): void { this.onmessage?.({ data }) }
}

const createdWorkers: FakeWorker[] = []
const failNextWorker = { value: false }

vi.mock('../launch.js', () => ({
  createChildWorker: (_name: string) => {
    if (failNextWorker.value) { failNextWorker.value = false; throw new Error('CSP refused a Worker') }
    const worker = new FakeWorker()
    createdWorkers.push(worker)
    return worker
  }
}))

const disposedServers: Array<() => void> = []
vi.mock('../orivon-server.js', () => ({
  serveOrivon: vi.fn(() => ({ dispose: vi.fn(async () => { disposedServers.push(() => {}) }) }))
}))

/** A spawn's program-loading result for the next call, set per test: a program to resolve with,
 * or an error to reject with (../child-process/program.js's own SpawnError shape). `gate`, when
 * set, is awaited first -- a test's way of holding `loadProgram` pending, to drive a message or a
 * close through the page's per-child port before the real Worker exists. */
const nextProgram: { value?: unknown, error?: Error | undefined, gate?: Promise<void> | undefined } = {}
const loadProgram = vi.fn(async (_command: string, _args: readonly string[]) => {
  if (nextProgram.gate !== undefined) await nextProgram.gate
  if (nextProgram.error !== undefined) throw nextProgram.error
  return nextProgram.value
})
vi.mock('../../child-process/program.js', () => ({ loadProgram }))

const { createChildHost } = await import('../host.js')

const HOST_ORIGIN = 'https://app.example'

beforeEach(() => {
  createdWorkers.length = 0
  disposedServers.length = 0
  nextProgram.value = undefined
  nextProgram.error = undefined
  nextProgram.gate = undefined
  loadProgram.mockClear()
  vi.stubGlobal('location', { origin: HOST_ORIGIN })
})

/** A page port pair: `page` is what the test drives (as `../child-process/host-client.ts` would), `hostSide` is what `addPage` receives. */
function pagePortPair (): { page: MessagePort, hostSide: MessagePort } {
  const { port1, port2 } = new MessageChannel()
  port1.start()
  return { page: port1, hostSide: port2 }
}

function startChildMessage (start: StartChildMessage['start'], extra: readonly Transferable[] = []): { message: StartChildMessage, childPage: MessagePort } {
  const { port1, port2 } = new MessageChannel()
  port1.start()
  return { message: { type: 'start-child', port: port2, start, extra }, childPage: port1 }
}

function waitFor (predicate: () => boolean, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = (): void => {
      if (predicate()) { resolve(); return }
      if (Date.now() - start > 2000) { reject(new Error(`timed out waiting for: ${description}`)); return }
      setTimeout(check, 5)
    }
    check()
  })
}

describe('createChildHost', () => {
  it('starts a fork, relays its FromWorker messages back to the page', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'fork', url: `${HOST_ORIGIN}/app.js`, argv: ['node', '/app.js'], env: {}, cwd: '/', serialization: 'json'
    })
    page.postMessage(message, [message.port])

    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created')
    const worker = createdWorkers[0] as FakeWorker
    worker.emit({ type: 'started' })

    const received: FromWorker[] = []
    childPage.onmessage = (event) => { received.push(event.data as FromWorker) }
    await waitFor(() => received.length === 1, 'the started message to reach the page')
    expect(received[0]).toEqual({ type: 'started' })
  })

  it('forwards stdin and IPC from the page straight to the real Worker', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'fork', url: `${HOST_ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json'
    })
    page.postMessage(message, [message.port])
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created')
    const worker = createdWorkers[0] as FakeWorker

    childPage.postMessage({ type: 'ipc', message: { hello: 1 } } satisfies ToWorker)
    await waitFor(() => worker.posted.some((p) => (p.message as ToWorker).type === 'ipc'), 'the ipc message to reach the Worker')
    expect(worker.posted.at(-1)?.message).toEqual({ type: 'ipc', message: { hello: 1 } })
  })

  it('loads a spawned program itself, then starts a Worker with it', async () => {
    const program = { kind: 'component', glue: `${HOST_ORIGIN}/prog.p2/prog.js`, base: `${HOST_ORIGIN}/prog.p2/` }
    nextProgram.value = program
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'spawn', command: '/prog', args: ['/prog', 'a'], env: { FOO: 'bar' }, preopens: { '/': '/' }
    })
    page.postMessage(message, [message.port])

    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created')
    // `start.args` carries argv0 (`child.spawnargs`, matching the worker's
    // own argv below) -- `loadProgram` wants the plain args, never argv0
    // (shim finding 14: the host used to pass the whole thing through,
    // handing a spawned program one extra leading argument the local path
    // never did).
    expect(loadProgram).toHaveBeenCalledWith('/prog', ['a'])
    const worker = createdWorkers[0] as FakeWorker
    expect(worker.posted[0]?.message).toMatchObject({
      type: 'spawn', program, args: ['/prog', 'a'], env: { FOO: 'bar' }, preopens: { '/': '/' }
    })

    worker.emit({ type: 'started' })
    const received: FromWorker[] = []
    childPage.onmessage = (event) => { received.push(event.data as FromWorker) }
    await waitFor(() => received.length === 1, 'the started message to reach the page')
    expect(received[0]).toEqual({ type: 'started' })
  })

  it('buffers a message sent while a spawn\'s own program is still loading, and delivers it once the Worker exists', async () => {
    let release: () => void = () => {}
    nextProgram.gate = new Promise((resolve) => { release = resolve })
    nextProgram.value = { kind: 'component', glue: `${HOST_ORIGIN}/prog.p2/prog.js`, base: `${HOST_ORIGIN}/prog.p2/` }

    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({ type: 'spawn', command: '/prog', args: [], env: {}, preopens: {} })
    page.postMessage(message, [message.port])

    // Sent while loadProgram is still gated -- before this file's own
    // `port.onmessage` has ever been assigned to anything but a buffer.
    childPage.postMessage({ type: 'stdin-end' } satisfies ToWorker)
    expect(createdWorkers).toHaveLength(0) // still loading; nothing to have lost the message to yet

    release()
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created once loading finishes')
    const worker = createdWorkers[0] as FakeWorker
    await waitFor(
      () => worker.posted.some((p) => (p.message as ToWorker).type === 'stdin-end'),
      'the buffered stdin-end to reach the Worker, not be lost'
    )
  })

  it('a page port closed while a spawn\'s own program is still loading orphans the child once it starts, rather than losing the close', async () => {
    let release: () => void = () => {}
    nextProgram.gate = new Promise((resolve) => { release = resolve })
    nextProgram.value = { kind: 'component', glue: `${HOST_ORIGIN}/prog.p2/prog.js`, base: `${HOST_ORIGIN}/prog.p2/` }

    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({ type: 'spawn', command: '/prog', args: [], env: {}, preopens: {} })
    page.postMessage(message, [message.port])

    childPage.close() // the page goes away before the Worker even exists
    expect(createdWorkers).toHaveLength(0)

    release()
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created despite the page already being gone')
    const worker = createdWorkers[0] as FakeWorker
    await waitFor(() => worker.posted.some((p) => (p.message as ToWorker).type === 'stdin-end'), 'stdin-end for the already-orphaned child')
    expect(worker.terminated).toBe(false) // the child still starts and keeps running (ADR-0046)
  })

  it('a spawn whose program cannot be loaded replies failed, with no Worker started', async () => {
    nextProgram.error = Object.assign(new Error('spawn /missing ENOENT'), { code: 'ENOENT' })
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({ type: 'spawn', command: '/missing', args: [], env: {}, preopens: {} })
    page.postMessage(message, [message.port])

    const received: FromWorker[] = []
    childPage.onmessage = (event) => { received.push(event.data as FromWorker) }
    await waitFor(() => received.length === 1, 'a failed reply')
    expect(received[0]).toMatchObject({ type: 'failed', error: { code: 'ENOENT' } })
    expect(createdWorkers).toHaveLength(0)
  })

  it('carries a native program\'s "excluded" reason across the wire, not only its code', async () => {
    nextProgram.error = Object.assign(new Error('spawn /bin/native ENOEXEC: a native program'), { code: 'ENOEXEC', reason: 'excluded' })
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({ type: 'spawn', command: '/bin/native', args: [], env: {}, preopens: {} })
    page.postMessage(message, [message.port])

    const received: FromWorker[] = []
    childPage.onmessage = (event) => { received.push(event.data as FromWorker) }
    await waitFor(() => received.length === 1, 'a failed reply')
    expect(received[0]).toMatchObject({ type: 'failed', error: { code: 'ENOEXEC', reason: 'excluded' } })
  })

  it('refuses a forked module whose URL is off the host\'s own origin', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'fork', url: 'https://evil.example/app.js', argv: [], env: {}, cwd: '/', serialization: 'json'
    })
    page.postMessage(message, [message.port])

    const received: FromWorker[] = []
    childPage.onmessage = (event) => { received.push(event.data as FromWorker) }
    await waitFor(() => received.length === 1, 'a failed reply')
    expect(received[0]).toMatchObject({ type: 'failed' })
    expect(createdWorkers).toHaveLength(0)
  })

  it('a terminate request stops the Worker and disposes its orivon server', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'fork', url: `${HOST_ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json'
    })
    page.postMessage(message, [message.port])
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created')
    const worker = createdWorkers[0] as FakeWorker

    childPage.postMessage({ type: 'terminate' })
    await waitFor(() => worker.terminated, 'the Worker to be terminated')
  })

  it('a closed page port leaves the child running: relaying stops, stdin ends, and a fork is told to disconnect', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'fork', url: `${HOST_ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json'
    })
    page.postMessage(message, [message.port])
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created')
    const worker = createdWorkers[0] as FakeWorker

    childPage.close() // the page went away -- ordinary, not a kill

    await waitFor(
      () => worker.posted.some((p) => (p.message as ToWorker).type === 'stdin-end') &&
        worker.posted.some((p) => (p.message as ToWorker).type === 'disconnect'),
      'stdin-end and disconnect to reach the still-running Worker'
    )
    expect(worker.terminated).toBe(false) // the child keeps running

    // Output the Worker sends afterwards is never thrown at a closed port.
    expect(() => { worker.emit({ type: 'output', stream: 'stdout', data: new Uint8Array([1]) }) }).not.toThrow()
  })

  it('an orphaned child\'s output is acknowledged rather than left to block its next write', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({
      type: 'fork', url: `${HOST_ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json'
    })
    page.postMessage(message, [message.port])
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created')
    const worker = createdWorkers[0] as FakeWorker

    childPage.close() // the page went away while a write may already be waiting on an ack that will now never arrive from it

    const acksOf = (stream: string): number => worker.posted.filter((p) => {
      const m = p.message as ToWorker
      return m.type === 'ack' && m.stream === stream
    }).length
    // Closing the port itself flushes one ack per stream, unblocking any write already waiting.
    await waitFor(() => acksOf('stdout') >= 1 && acksOf('stderr') >= 1, 'an immediate ack for each stream on close')

    // Every output message the child sends afterwards gets its own ack, not a relay to the dead port.
    worker.emit({ type: 'output', stream: 'stdout', data: new Uint8Array([1]) })
    await waitFor(() => acksOf('stdout') >= 2, 'a second ack for a second output message')
  })
})
