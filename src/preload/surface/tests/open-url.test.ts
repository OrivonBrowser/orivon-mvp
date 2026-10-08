import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ./open-url.ts keeps its listeners and held links at module scope, one set per document, so each test loads a fresh copy.
const invoke = vi.fn()

vi.mock('electron', () => ({
  ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args), on: vi.fn(), sendSync: vi.fn() }
}))

const ok = (result: unknown): { id: string, ok: true, result: unknown } => ({ id: 'r', ok: true, result })
const fail = (code: string): { id: string, ok: false, code: string, message: string } => ({ id: 'r', ok: false, code, message: 'no' })
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
const never = new Promise<never>(() => {})
const methods = (): string[] => invoke.mock.calls.map((call) => (call[1] as { method: string }).method)

async function load (): Promise<typeof import('../open-url.js')> {
  vi.resetModules()
  return await import('../open-url.js')
}

beforeEach(() => { invoke.mockReset() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('appOnOpenUrl', () => {
  it('starts asking for links when a listener registers, and gives each link to it', async () => {
    const { appOnOpenUrl } = await load()
    invoke.mockResolvedValueOnce(ok(MAGNET)).mockReturnValue(never)
    const heard: string[] = []
    appOnOpenUrl((url) => { heard.push(url) })
    await vi.waitFor(() => { expect(heard).toEqual([MAGNET]) })
    expect(methods()[0]).toBe('app.nextOpenUrl')
  })

  it('asks nothing until a listener registers', async () => {
    await load()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('asks again after a wait that ended with no link', async () => {
    const { appOnOpenUrl } = await load()
    invoke.mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(ok(MAGNET)).mockReturnValue(never)
    const heard: string[] = []
    appOnOpenUrl((url) => { heard.push(url) })
    await vi.waitFor(() => { expect(heard).toEqual([MAGNET]) })
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('gives a link once to every listener that is registered, and not to one that was removed', async () => {
    const { appOnOpenUrl } = await load()
    let release: (value: unknown) => void = () => {}
    invoke.mockReturnValueOnce(new Promise((resolve) => { release = resolve })).mockReturnValue(never)
    const first: string[] = []
    const second: string[] = []
    const removed: string[] = []
    appOnOpenUrl((url) => { first.push(url) })
    appOnOpenUrl((url) => { second.push(url) })
    appOnOpenUrl((url) => { removed.push(url) })()
    release(ok(MAGNET))
    await vi.waitFor(() => { expect(second).toEqual([MAGNET]) })
    expect(first).toEqual([MAGNET])
    expect(removed).toEqual([])
  })

  it('holds a link that arrives while no listener is registered for the next one', async () => {
    const { appOnOpenUrl } = await load()
    let release: (value: unknown) => void = () => {}
    invoke.mockReturnValueOnce(new Promise((resolve) => { release = resolve })).mockReturnValue(never)
    const stop = appOnOpenUrl(() => {})
    stop()
    release(ok(MAGNET))
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledTimes(1) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const heard: string[] = []
    appOnOpenUrl((url) => { heard.push(url) })
    expect(heard).toEqual([MAGNET])
  })

  it('stops asking once the shell refuses: an app with no grant is not sent links', async () => {
    const { appOnOpenUrl } = await load()
    invoke.mockResolvedValue(ok(null))
    invoke.mockResolvedValueOnce(fail('denied'))
    appOnOpenUrl(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering when one listener throws', async () => {
    const { appOnOpenUrl } = await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockResolvedValueOnce(ok(MAGNET)).mockReturnValue(never)
    const heard: string[] = []
    appOnOpenUrl(() => { throw new Error('page bug') })
    appOnOpenUrl((url) => { heard.push(url) })
    await vi.waitFor(() => { expect(heard).toEqual([MAGNET]) })
  })

  it('refuses a listener that is not a function', async () => {
    const { appOnOpenUrl } = await load()
    expect(() => appOnOpenUrl('x' as never)).toThrow()
  })
})

describe('appRequestSchemeHandler', () => {
  it('asks the shell only for a page the person just clicked in', async () => {
    const { appRequestSchemeHandler } = await load()
    vi.stubGlobal('navigator', { userActivation: { isActive: false } })
    expect(await appRequestSchemeHandler('magnet')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()

    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    invoke.mockResolvedValueOnce(ok(true))
    expect(await appRequestSchemeHandler('magnet')).toBe(true)
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ method: 'app.requestSchemeHandler', payload: { scheme: 'magnet' } })
  })
})

describe('appIsSchemeHandler', () => {
  it('asks the shell', async () => {
    const { appIsSchemeHandler } = await load()
    invoke.mockResolvedValueOnce(ok(true))
    expect(await appIsSchemeHandler('magnet')).toBe(true)
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ method: 'app.isSchemeHandler', payload: { scheme: 'magnet' } })
  })
})
