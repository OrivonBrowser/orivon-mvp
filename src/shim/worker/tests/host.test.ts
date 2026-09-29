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

const loadProgram = vi.fn(async (command: string, _args: readonly string[]) => {
  if (command === 'missing') throw Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' })
  return { kind: 'core', module: {} } as const
})
vi.mock('../../child-process/program.js', () => ({ loadProgram }))

const { createChildHost } = await import('../host.js')

const HOST_ORIGIN = 'https://app.example'

beforeEach(() => {
  createdWorkers.length = 0
  disposedServers.length = 0
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

  it('a spawn loads its program itself, from the command the page sent (never a precompiled module)', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message } = startChildMessage({ type: 'spawn', command: '/prog', args: [], env: {}, preopens: {} })
    page.postMessage(message, [message.port])

    await waitFor(() => loadProgram.mock.calls.length === 1, 'loadProgram to be called')
    expect(loadProgram).toHaveBeenCalledWith('/prog', [])
    await waitFor(() => createdWorkers.length === 1, 'the Worker to be created after the program loads')
    const worker = createdWorkers[0] as FakeWorker
    const started = worker.posted[0]?.message as ToWorker & { type: 'spawn' }
    expect(started.type).toBe('spawn')
    expect(started.program).toEqual({ kind: 'core', module: {} })
  })

  it('a spawn whose command does not resolve fails the child, never creating a Worker', async () => {
    const host = createChildHost({} as never)
    const { page, hostSide } = pagePortPair()
    host.addPage(hostSide)

    const { message, childPage } = startChildMessage({ type: 'spawn', command: 'missing', args: [], env: {}, preopens: {} })
    page.postMessage(message, [message.port])

    const received: FromWorker[] = []
    childPage.onmessage = (event) => { received.push(event.data as FromWorker) }
    await waitFor(() => received.length === 1, 'a failed reply')
    expect(received[0]).toMatchObject({ type: 'failed', error: { code: 'ENOENT' } })
    expect(createdWorkers).toHaveLength(0)
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

  it('a closed page port leaves the child running: output is dropped, stdin ends, and a fork is told to disconnect', async () => {
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

    // Output the Worker sends afterwards is dropped, never thrown at a closed port.
    expect(() => { worker.emit({ type: 'output', stream: 'stdout', data: new Uint8Array([1]) }) }).not.toThrow()
  })
})
