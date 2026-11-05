import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  executeInMainWorld: vi.fn(),
  invoke: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: bridge.executeInMainWorld, exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: bridge.invoke, send: vi.fn(), sendSync: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

const { installWebGpuAsk } = await import('../webgpu-ask.js')
const { WEBGPU_ASK_CHANNEL } = await import('../../main/channels.js')

type Ask = (adapter: boolean) => Promise<unknown>
interface Install { func: (askMain: Ask) => void, args: [Ask] }
const installed = (): Install => bridge.executeInMainWorld.mock.calls[0]?.[0] as Install

/** What the page's `navigator.gpu` is: the platform's own `requestAdapter` lives on the prototype. */
class FakeGpu {
  calls: unknown[] = []
  constructor (public reply: (options: unknown) => Promise<unknown> = async () => await Promise.resolve(ADAPTER)) {}
  requestAdapter (options?: unknown): Promise<unknown> {
    this.calls.push(options)
    return this.reply(options)
  }
}
const ADAPTER = { info: { vendor: 'test' } }

const originalFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
const setFrame = (main: boolean | undefined): void => { Reflect.defineProperty(process, 'isMainFrame', { value: main, configurable: true }) }

beforeEach(() => {
  bridge.executeInMainWorld.mockReset()
  bridge.invoke.mockReset()
  vi.stubGlobal('GPU', FakeGpu)
  setFrame(true)
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalFrame === undefined) Reflect.deleteProperty(process, 'isMainFrame')
  else Reflect.defineProperty(process, 'isMainFrame', originalFrame)
})

function wrapped (answer: Ask): FakeGpu['requestAdapter'] {
  const original = Object.getOwnPropertyDescriptor(FakeGpu.prototype, 'requestAdapter') as PropertyDescriptor
  installWebGpuAsk()
  installed().func(answer)
  const request = FakeGpu.prototype.requestAdapter
  Reflect.defineProperty(FakeGpu.prototype, 'requestAdapter', original)
  return request
}

describe('installation', () => {
  it('goes into the page\'s own world, and a refusal to install is logged, not thrown', () => {
    installWebGpuAsk()
    expect(bridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    bridge.executeInMainWorld.mockImplementation(() => { throw new Error('unavailable') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { installWebGpuAsk() }).not.toThrow()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it.each([['a frame inside the page', false], ['a frame that cannot say which it is', undefined]])('installs nothing in %s', (_label, main) => {
    setFrame(main)
    installWebGpuAsk()
    expect(bridge.executeInMainWorld).not.toHaveBeenCalled()
  })

  it('hands the page\'s world one function that tells main only whether an adapter was given, and reads nothing but a plain true back', async () => {
    installWebGpuAsk()
    const [ask] = installed().args
    bridge.invoke.mockResolvedValueOnce(true)
    expect(await ask(true)).toBe(true)
    expect(bridge.invoke).toHaveBeenLastCalledWith(WEBGPU_ASK_CHANNEL, { adapter: true })
    bridge.invoke.mockResolvedValueOnce(true)
    await ask(false)
    expect(bridge.invoke).toHaveBeenLastCalledWith(WEBGPU_ASK_CHANNEL, { adapter: false })
    for (const reply of ['true', 1, { allowed: true }, null, undefined, false]) {
      bridge.invoke.mockResolvedValueOnce(reply)
      expect(await ask(true)).toBe(false)
    }
    bridge.invoke.mockRejectedValueOnce(new Error('gone'))
    expect(await ask(true)).toBe(false)
    bridge.invoke.mockImplementationOnce(() => { throw new Error('sync') })
    expect(await ask(true)).toBe(false)
  })

  it('is self-contained: rebuilt from its source text alone, it still installs', () => {
    installWebGpuAsk()
    const source = installed().func.toString()
    const rebuilt = new Function(`return (${source})`)() as (askMain: Ask) => void
    const original = Object.getOwnPropertyDescriptor(FakeGpu.prototype, 'requestAdapter') as PropertyDescriptor
    try {
      rebuilt(async () => await Promise.resolve(true))
      expect(FakeGpu.prototype.requestAdapter).not.toBe(original.value)
    } finally {
      Reflect.defineProperty(FakeGpu.prototype, 'requestAdapter', original)
    }
  })

  it('leaves a page with no GPU interface, as an insecure one has, untouched', () => {
    installWebGpuAsk()
    vi.stubGlobal('GPU', undefined)
    expect(() => { installed().func(async () => await Promise.resolve(true)) }).not.toThrow()
    vi.stubGlobal('GPU', class {})
    expect(() => { installed().func(async () => await Promise.resolve(true)) }).not.toThrow()
  })
})

describe('a call to requestAdapter', () => {
  it('gives the page the platform\'s own adapter when main says yes, and asks with whether one was given', async () => {
    const ask = vi.fn(async () => await Promise.resolve(true))
    const request = wrapped(ask)
    expect(await request.call(new FakeGpu())).toBe(ADAPTER)
    expect(ask).toHaveBeenCalledWith(true)
  })

  it.each([false, null, undefined, 'true', 1, { allowed: true }])('gives the page null when main answers %j', async (answer) => {
    const request = wrapped(async () => await Promise.resolve(answer))
    expect(await request.call(new FakeGpu())).toBeNull()
  })

  it('gives the page null when main cannot be asked, and never the adapter', async () => {
    const rejecting = wrapped(async () => await Promise.reject(new Error('gone')))
    expect(await rejecting.call(new FakeGpu())).toBeNull()
    const throwing = wrapped(() => { throw new Error('sync') })
    expect(await throwing.call(new FakeGpu())).toBeNull()
    const notAPromise = wrapped((() => true) as unknown as Ask)
    expect(await notAPromise.call(new FakeGpu())).toBeNull()
  })

  it('tells main that no adapter was given and still gives the page null, whatever main answers', async () => {
    const ask = vi.fn(async () => await Promise.resolve(true))
    const request = wrapped(ask)
    expect(await request.call(new FakeGpu(async () => await Promise.resolve(null)))).toBeNull()
    expect(ask).toHaveBeenCalledWith(false)
  })

  it('treats anything the platform returns that is not an object as no adapter', async () => {
    const ask = vi.fn(async () => await Promise.resolve(true))
    const request = wrapped(ask)
    expect(await request.call(new FakeGpu(async () => await Promise.resolve(undefined)))).toBeNull()
    expect(await request.call(new FakeGpu(async () => await Promise.resolve('adapter')))).toBeNull()
    expect(ask).toHaveBeenNthCalledWith(1, false)
    expect(ask).toHaveBeenNthCalledWith(2, false)
  })

  it('does not ask while the platform\'s own call is still open, and waits for main before it resolves', async () => {
    let answer: (value: unknown) => void = () => {}
    const ask = vi.fn(async () => await new Promise<unknown>((resolve) => { answer = resolve }))
    const request = wrapped(ask)
    let resolved = false
    const result = request.call(new FakeGpu()).then((adapter) => { resolved = true; return adapter })
    await Promise.resolve()
    await Promise.resolve()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(false)
    answer(true)
    expect(await result).toBe(ADAPTER)
  })

  it('passes the page\'s options to the platform untouched, and the platform\'s rejection back untouched, asking nobody', async () => {
    const ask = vi.fn(async () => await Promise.resolve(true))
    const request = wrapped(ask)
    const options = { powerPreference: 'high-performance' }
    const gpu = new FakeGpu(async () => await Promise.reject(new TypeError('bad option')))
    await expect(request.call(gpu, options)).rejects.toThrow('bad option')
    expect(gpu.calls[0]).toBe(options)
    expect(ask).not.toHaveBeenCalled()
  })

  it('throws what the platform throws for a receiver that is not a GPU, as the platform does', () => {
    const request = wrapped(async () => await Promise.resolve(true))
    const thrower = new FakeGpu(() => { throw new TypeError('Illegal invocation') })
    expect(() => request.call(thrower)).toThrow('Illegal invocation')
  })

  it('looks like the platform\'s function: same name and length, and the page cannot tell the descriptor changed', () => {
    const original = Object.getOwnPropertyDescriptor(FakeGpu.prototype, 'requestAdapter') as PropertyDescriptor
    installWebGpuAsk()
    installed().func(async () => await Promise.resolve(true))
    try {
      const now = Object.getOwnPropertyDescriptor(FakeGpu.prototype, 'requestAdapter') as PropertyDescriptor
      expect(now.writable).toBe(original.writable)
      expect(now.enumerable).toBe(original.enumerable)
      expect(now.configurable).toBe(original.configurable)
      expect((now.value as { name: string }).name).toBe('requestAdapter')
      expect((now.value as { length: number }).length).toBe((original.value as { length: number }).length)
    } finally {
      Reflect.defineProperty(FakeGpu.prototype, 'requestAdapter', original)
    }
  })

  it('touches no global while a call runs: a page that scuttles its globals (LavaMoat) cannot break it', async () => {
    const request = wrapped(async () => await Promise.resolve(true))
    const gpu = new FakeGpu()
    const names = ['Reflect', 'Object', 'Symbol', 'JSON', 'Array', 'String', 'Error', 'TypeError', 'Function', 'Proxy', 'GPU']
    // The test's own helpers are taken before the globals go, as the wrapper's natives are at install.
    const define = Reflect.defineProperty.bind(Reflect)
    const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
    const Fail = Error
    const settled = Promise.resolve()
    let result: Promise<unknown> | undefined
    try {
      for (const name of names) define(globalThis, name, { configurable: true, get: () => { throw new Fail(`${name} read at call time`) } })
      result = request.call(gpu) as Promise<unknown>
      // Microtasks only: every continuation of the call runs in them, and no timer or message of the test runner can run while its own globals are gone.
      for (let tick = 0; tick < 50; tick++) await settled
    } finally {
      for (const [name, descriptor] of saved) if (descriptor !== undefined) define(globalThis, name, descriptor)
    }
    expect(await result).toBe(ADAPTER)
  })
})
