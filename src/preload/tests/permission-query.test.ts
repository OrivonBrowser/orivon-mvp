import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  executeInMainWorld: vi.fn(),
  invoke: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: bridge.executeInMainWorld, exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: bridge.invoke, send: vi.fn(), sendSync: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

const { installPermissionQuery, installPermissionQueryInExtensionPage } = await import('../permission-query.js')
const { PERMISSION_QUERY_CHANNEL } = await import('../../main/channels.js')

type Ask = (name: string) => Promise<unknown>
interface Install { func: (askMain: Ask) => void, args: [Ask] }
const installed = (): Install => bridge.executeInMainWorld.mock.calls[0]?.[0] as Install

/** The engine's status object: `state` is a getter on the prototype, as the platform's is. */
class FakeStatus extends EventTarget {
  onchange: unknown = null
  constructor (public native: string) { super() }
  get state (): string { return this.native }
}

class FakePermissions {
  calls: unknown[] = []
  constructor (public reply: (descriptor: unknown) => Promise<unknown> = async () => await Promise.resolve(new FakeStatus('denied'))) {}
  query (descriptor: unknown): Promise<unknown> {
    this.calls.push(descriptor)
    return this.reply(descriptor)
  }
}

/** What the page sees after the wrapper is in: the page's own `navigator.permissions` object. */
function pageWith (reply?: FakePermissions['reply']): FakePermissions {
  const permissions = new FakePermissions(reply)
  Object.setPrototypeOf(permissions, FakePermissions.prototype)
  return permissions
}

beforeEach(() => {
  bridge.executeInMainWorld.mockReset()
  bridge.invoke.mockReset()
  vi.stubGlobal('Permissions', FakePermissions)
  vi.stubGlobal('PermissionStatus', FakeStatus)
})
afterEach(() => {
  vi.unstubAllGlobals()
  // The wrapper replaced a property of the fake's prototype: give the next test a fresh one.
  delete (FakePermissions.prototype as unknown as Record<string, unknown>)['__wrapped']
})

function wrapped (answer: Ask): FakePermissions['query'] {
  const original = Object.getOwnPropertyDescriptor(FakePermissions.prototype, 'query') as PropertyDescriptor
  installPermissionQuery()
  installed().func(answer)
  const query = FakePermissions.prototype.query
  Reflect.defineProperty(FakePermissions.prototype, 'query', original)
  return query
}

describe('installation', () => {
  it('goes into the page\'s own world, and a refusal to install is logged, not thrown', () => {
    installPermissionQuery()
    expect(bridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    bridge.executeInMainWorld.mockImplementation(() => { throw new Error('unavailable') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { installPermissionQuery() }).not.toThrow()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('hands the page\'s world one function that asks main by name and reads nothing but a string back', async () => {
    installPermissionQuery()
    const [ask] = installed().args
    bridge.invoke.mockResolvedValueOnce('prompt')
    expect(await ask('camera')).toBe('prompt')
    expect(bridge.invoke).toHaveBeenLastCalledWith(PERMISSION_QUERY_CHANNEL, { name: 'camera' })
    bridge.invoke.mockResolvedValueOnce({ state: 'prompt' })
    expect(await ask('camera')).toBeNull()
    bridge.invoke.mockRejectedValueOnce(new Error('gone'))
    expect(await ask('camera')).toBeNull()
    bridge.invoke.mockImplementationOnce(() => { throw new Error('sync') })
    expect(await ask('camera')).toBeNull()
  })

  it('is self-contained: rebuilt from its source text alone, it still installs', () => {
    installPermissionQuery()
    const source = installed().func.toString()
    const rebuilt = new Function(`return (${source})`)() as (askMain: Ask) => void
    const original = Object.getOwnPropertyDescriptor(FakePermissions.prototype, 'query') as PropertyDescriptor
    try {
      rebuilt(async () => await Promise.resolve('prompt'))
      expect(FakePermissions.prototype.query).not.toBe(original.value)
    } finally {
      Reflect.defineProperty(FakePermissions.prototype, 'query', original)
    }
  })

  it('leaves the page untouched where the platform has no Permissions or PermissionStatus', () => {
    installPermissionQuery()
    vi.stubGlobal('Permissions', undefined)
    expect(() => { installed().func(async () => await Promise.resolve('prompt')) }).not.toThrow()
    vi.stubGlobal('Permissions', FakePermissions)
    vi.stubGlobal('PermissionStatus', undefined)
    const original = FakePermissions.prototype.query
    installed().func(async () => await Promise.resolve('prompt'))
    expect(FakePermissions.prototype.query).toBe(original)
  })
})

describe('a query', () => {
  it('reads prompt on the engine\'s own status object when the engine says denied and main says prompt', async () => {
    const ask = vi.fn(async () => await Promise.resolve('prompt'))
    const query = wrapped(ask)
    const engine = new FakeStatus('denied')
    const status = await query.call(pageWith(async () => await Promise.resolve(engine)), { name: 'camera' }) as FakeStatus
    expect(status).toBe(engine)
    expect(status).toBeInstanceOf(FakeStatus)
    expect(status.state).toBe('prompt')
    expect(ask).toHaveBeenCalledWith('camera')
    // The rest of the object is the engine's: events still reach a listener, onchange is still the page's to set.
    const heard = vi.fn()
    status.addEventListener('change', heard)
    status.dispatchEvent(new Event('change'))
    expect(heard).toHaveBeenCalledTimes(1)
    expect(status.onchange).toBeNull()
  })

  it('follows the engine afterwards: a state that is no longer denied reads as it is', async () => {
    const query = wrapped(async () => await Promise.resolve('prompt'))
    const engine = new FakeStatus('denied')
    const status = await query.call(pageWith(async () => await Promise.resolve(engine)), { name: 'camera' }) as FakeStatus
    expect(status.state).toBe('prompt')
    engine.native = 'granted'
    expect(status.state).toBe('granted')
    engine.native = 'denied'
    expect(status.state).toBe('prompt')
  })

  it.each(['denied', 'granted', null, undefined, '', 'Prompt', 7, { state: 'prompt' }])('keeps the engine\'s denied when main answers %j', async (answer) => {
    const query = wrapped(async () => await Promise.resolve(answer))
    const status = await query.call(pageWith(), { name: 'camera' }) as FakeStatus
    expect(status.state).toBe('denied')
    expect(Object.getOwnPropertyNames(status)).not.toContain('state')
  })

  it('keeps the engine\'s denied when main cannot be asked', async () => {
    const rejecting = wrapped(async () => await Promise.reject(new Error('gone')))
    expect(((await rejecting.call(pageWith(), { name: 'camera' })) as FakeStatus).state).toBe('denied')
    const throwing = wrapped(() => { throw new Error('sync') })
    expect(((await throwing.call(pageWith(), { name: 'camera' })) as FakeStatus).state).toBe('denied')
  })

  it.each(['granted', 'prompt'])('does not ask main when the engine already says %s', async (native) => {
    const ask = vi.fn(async () => await Promise.resolve('prompt'))
    const query = wrapped(ask)
    const status = await query.call(pageWith(async () => await Promise.resolve(new FakeStatus(native))), { name: 'camera' }) as FakeStatus
    expect(status.state).toBe(native)
    expect(ask).not.toHaveBeenCalled()
  })

  it('passes the page\'s descriptor to the engine untouched, and the engine\'s rejection back untouched', async () => {
    const ask = vi.fn(async () => await Promise.resolve('prompt'))
    const query = wrapped(ask)
    const descriptor = { name: 'midi', sysex: true }
    const permissions = pageWith(async () => await Promise.reject(new TypeError('bad name')))
    await expect(query.call(permissions, descriptor)).rejects.toThrow('bad name')
    expect(permissions.calls).toEqual([descriptor])
    expect(permissions.calls[0]).toBe(descriptor)
    expect(ask).not.toHaveBeenCalled()
  })

  it('does not ask for a descriptor that has no usable name, and lets the engine answer it', async () => {
    const ask = vi.fn(async () => await Promise.resolve('prompt'))
    const query = wrapped(ask)
    for (const descriptor of [undefined, null, 'camera', {}, { name: 7 }, { name: ['camera'] }, { get name (): string { throw new Error('page code') } }]) {
      const status = await query.call(pageWith(), descriptor) as FakeStatus
      expect(status.state).toBe('denied')
    }
    expect(ask).not.toHaveBeenCalled()
  })

  it('answers the engine\'s result when the engine returns something that is not a status', async () => {
    const ask = vi.fn(async () => await Promise.resolve('prompt'))
    const query = wrapped(ask)
    const odd = { state: 'denied' }
    expect(await query.call(pageWith(async () => await Promise.resolve(odd)), { name: 'camera' })).toBe(odd)
    expect(await query.call(pageWith(async () => await Promise.resolve(undefined)), { name: 'camera' })).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
  })

  it('looks like the platform\'s function: same name and length, and the page cannot tell the descriptor changed', () => {
    const original = Object.getOwnPropertyDescriptor(FakePermissions.prototype, 'query') as PropertyDescriptor
    installPermissionQuery()
    installed().func(async () => await Promise.resolve('prompt'))
    try {
      const now = Object.getOwnPropertyDescriptor(FakePermissions.prototype, 'query') as PropertyDescriptor
      expect(now.writable).toBe(original.writable)
      expect(now.enumerable).toBe(original.enumerable)
      expect(now.configurable).toBe(original.configurable)
      expect((now.value as { name: string }).name).toBe('query')
      expect((now.value as { length: number }).length).toBe(1)
    } finally {
      Reflect.defineProperty(FakePermissions.prototype, 'query', original)
    }
  })

  it('touches no global while a query runs: a page that scuttles its globals (LavaMoat) cannot break it', async () => {
    const query = wrapped(async () => await Promise.resolve('prompt'))
    const permissions = pageWith()
    const names = ['Reflect', 'Object', 'Symbol', 'JSON', 'Array', 'String', 'Error', 'TypeError', 'Function', 'Proxy', 'Permissions', 'PermissionStatus']
    // The test's own helpers are taken before the globals go, as the wrapper's natives are at install.
    const define = Reflect.defineProperty.bind(Reflect)
    const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
    const Fail = Error
    const settled = Promise.resolve()
    let result: Promise<unknown> | undefined
    try {
      for (const name of names) define(globalThis, name, { configurable: true, get: () => { throw new Fail(`${name} read at call time`) } })
      result = query.call(permissions, { name: 'camera' }) as Promise<unknown>
      // Microtasks only: every continuation of the query runs in them, and no timer or message of the test runner can run while its own globals are gone.
      for (let tick = 0; tick < 50; tick++) await settled
    } finally {
      for (const [name, descriptor] of saved) if (descriptor !== undefined) define(globalThis, name, descriptor)
    }
    expect(((await result) as FakeStatus).state).toBe('prompt')
  })
})

describe('an extension page', () => {
  const originalFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
  const setFrame = (main: boolean | undefined): void => { Reflect.defineProperty(process, 'isMainFrame', { value: main, configurable: true }) }
  afterEach(() => {
    if (originalFrame === undefined) Reflect.deleteProperty(process, 'isMainFrame')
    else Reflect.defineProperty(process, 'isMainFrame', originalFrame)
  })

  it('is wrapped in its top frame', () => {
    vi.stubGlobal('location', { protocol: 'chrome-extension:' })
    setFrame(true)
    installPermissionQueryInExtensionPage()
    expect(bridge.executeInMainWorld).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a frame inside it', 'chrome-extension:', false],
    ['a frame that cannot say which it is', 'chrome-extension:', undefined],
    ['a website', 'https:', true],
    ['a shell page', 'orivon:', true]
  ])('is not wrapped for %s', (_label, protocol, main) => {
    vi.stubGlobal('location', { protocol })
    setFrame(main)
    installPermissionQueryInExtensionPage()
    expect(bridge.executeInMainWorld).not.toHaveBeenCalled()
  })

  it('is not wrapped where the preload has no location, as in a service worker', () => {
    vi.stubGlobal('location', undefined)
    setFrame(true)
    installPermissionQueryInExtensionPage()
    expect(bridge.executeInMainWorld).not.toHaveBeenCalled()
  })
})
