import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

type Handler = (details: { url: string, resourceType: string, frame?: { top: { url: string } } }, current: { requestHeaders: Record<string, string> }) => { requestHeaders: Record<string, string> }
interface Started { id?: number, resourceType: string, url: string, webContents?: object, fromCache?: boolean, responseHeaders?: Record<string, string[]>, initiatorOrigin?: string }
type Received = (details: Started, current: { responseHeaders: Record<string, string[]>, cancel?: boolean }) => { responseHeaders: Record<string, string[]>, cancel?: boolean }
const { captured } = vi.hoisted(() => ({ captured: { handler: undefined as Handler | undefined, started: undefined as ((details: Started) => void) | undefined, received: undefined as Received | undefined } }))
vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('../../sessions/web-request-owner.js', () => ({
  RUN_LAST: 0,
  webRequestOwnerFor: () => ({
    onBeforeSendHeaders: (_order: number, _filter: unknown, _matches: unknown, handler: Handler) => { captured.handler = handler },
    onHeadersReceived: (_order: number, _filter: unknown, _matches: unknown, handler: Received) => { captured.received = handler },
    onCompleted: () => {},
    onResponseStarted: (_filter: unknown, _matches: unknown, handler: (details: Started) => void) => { captured.started = handler }
  })
}))

const { registerAppOrigin, retireAppOrigin } = await import('../../../loader/electron/app-partitions.js')
const { installPartitionStamp, installShellAnswerWatch, installWorkerScriptGuard } = await import('../partition-stamp.js')
const { guardWorkerScripts, releaseWorkerScripts } = await import('../../sessions/app-workers.js')
const { beginSettling, forgetSettling, settleServedOrigin } = await import('../../sessions/worker-settle.js')
const { takeMainFrameAnswer, forgetShellAnswered } = await import('../../sessions/shell-answered.js')
const { SHELL_ANSWERED_HEADER } = await import('../../../loader/fetch/content-root.js')

const HOST_ORIGIN = 'https://stamped.eth'

function fakeSession (): Session {
  const handled = new Set<string>()
  return { protocol: { isProtocolHandled: (scheme: string) => handled.has(scheme), unhandle: (scheme: string) => { handled.delete(scheme) }, handle: (scheme: string) => { handled.add(scheme) } } } as unknown as Session
}

function send (url: string, top: string | undefined, headers: Record<string, string>): Record<string, string> {
  installPartitionStamp({} as Session, undefined)
  const answered = captured.handler?.({ url, resourceType: top === undefined ? 'mainFrame' : 'script', ...(top === undefined ? {} : { frame: { top: { url: top } } }) }, { requestHeaders: headers })
  return answered?.requestHeaders ?? {}
}

afterEach(() => { retireAppOrigin(fakeSession(), HOST_ORIGIN) })

describe('the HTTP cache a request of a served app is kept out of', () => {
  it('is decided on the headers as stamped: a cross-site looking request the stamp names the host for is kept out, as the host hands it over', () => {
    registerAppOrigin(fakeSession(), HOST_ORIGIN, async () => new Response('kept'))
    const sandboxedFrame = send(`${HOST_ORIGIN}/app.js`, `${HOST_ORIGIN}/`, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' })
    expect(sandboxedFrame['If-Match']).toBe('*')
  })

  it('leaves a request another page makes in the cache, since the host does not hand it over', () => {
    registerAppOrigin(fakeSession(), HOST_ORIGIN, async () => new Response('kept'))
    const embedder = send(`${HOST_ORIGIN}/app.js`, 'https://evil.example/', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' })
    expect(embedder['If-Match']).toBeUndefined()
  })

  it('keeps a navigation to the app out of the cache whoever made it', () => {
    registerAppOrigin(fakeSession(), HOST_ORIGIN, async () => new Response('kept'))
    const navigation = send(`${HOST_ORIGIN}/`, undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    expect(navigation['If-Match']).toBe('*')
  })

  it('leaves everything in the cache for an origin the shell does not serve', () => {
    const request = send(`${HOST_ORIGIN}/`, undefined, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    expect(request['If-Match']).toBeUndefined()
  })
})

describe('which document the shell answered', () => {
  const contents = {}
  let requestId = 0
  /** A response as the session sees it: its headers reach the hooks as the network gave them (`received`), then as the listeners left them (`started`). */
  const watch = (): ((details: Started, received?: Record<string, string[]>) => void) => {
    installShellAnswerWatch({} as Session)
    const started = captured.started
    const received = captured.received
    if (started === undefined || received === undefined) throw new Error('nothing was registered for responses')
    return (details, original) => {
      requestId += 1
      const headers = original ?? details.responseHeaders ?? {}
      received({ ...details, id: requestId, responseHeaders: headers } as Started, { responseHeaders: headers })
      started({ ...details, id: requestId })
    }
  }
  const main = (url: string, headers: Record<string, string[]> | undefined, more: Partial<Started> = {}): Started => ({ resourceType: 'mainFrame', url, webContents: contents, fromCache: false, ...(headers === undefined ? {} : { responseHeaders: headers }), ...more })
  afterEach(() => { forgetShellAnswered(contents) })

  it('records a main-frame response that carries the mark, for the commit of that address to take once', () => {
    watch()(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'], 'content-type': ['text/html'] }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('shell')
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('none')
  })

  it('reads the mark whatever case the header name comes in', () => {
    watch()(main(`${HOST_ORIGIN}/`, { 'X-Orivon-Shell-Answered': ['1'] }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('shell')
  })

  it('records nothing for a response without the mark, and it replaces an earlier mark: the last response is the document', () => {
    const on = watch()
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }))
    on(main(`${HOST_ORIGIN}/`, { 'content-type': ['text/html'] }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('other')
    on(main(`${HOST_ORIGIN}/`, undefined))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('other')
  })

  it('does not count a mark on any value but 1, or on a response read from the HTTP cache', () => {
    const on = watch()
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['yes'] }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('other')
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }, { fromCache: true }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('other')
  })

  it('ignores a response that is not a main frame\'s, and a commit of another address', () => {
    const on = watch()
    on(main(`${HOST_ORIGIN}/app.js`, { [SHELL_ANSWERED_HEADER]: ['1'] }, { resourceType: 'script' }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/app.js`)).toBe('none')
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }))
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/other.html`)).toBe('other')
  })

  it('ignores a response with no page behind it', () => {
    const { webContents: _none, ...bare } = main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] })
    expect(() => { watch()(bare) }).not.toThrow()
  })

  it('does not count a mark a listener added after the network answered: an extension cannot make a page the shell\'s', () => {
    watch()(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }), { 'content-type': ['text/html'] })
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('other')
  })

  it('counts the mark the network gave even when a listener took it away, since the host answered', () => {
    watch()(main(`${HOST_ORIGIN}/`, { 'content-type': ['text/html'] }), { [SHELL_ANSWERED_HEADER]: ['1'] })
    expect(takeMainFrameAnswer(contents, `${HOST_ORIGIN}/`)).toBe('shell')
  })
})

describe('the service worker scripts of a served origin', () => {
  const answer = async (over: Partial<Started> = {}, headers: Record<string, string[]> = {}): Promise<{ responseHeaders: Record<string, string[]>, cancel?: boolean }> => {
    installWorkerScriptGuard({} as Session, 150)
    if (captured.received === undefined) throw new Error('nothing was registered for response headers')
    const current = { responseHeaders: headers }
    return await captured.received({ resourceType: 'script', url: `${HOST_ORIGIN}/sw.js`, responseHeaders: headers, ...over }, current)
  }
  const settle = async (hostKnows: () => Promise<void> = async () => {}): Promise<boolean> => await settleServedOrigin(HOST_ORIGIN, { hostKnows, pagesOf: () => [], isOwnDocument: () => true, isEntering: () => false, reload: async () => {}, becameOwn: async () => {}, clear: async () => {}, limits: { hostMs: 300, pageMs: 300, enteringMs: 300, clearMs: 300 }, log: () => {} })
  const pending = async (promise: Promise<unknown>): Promise<boolean> => await Promise.race([promise.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => { resolve(true) }, 20))])
  afterEach(() => { releaseWorkerScripts(HOST_ORIGIN); forgetSettling(HOST_ORIGIN) })

  it('are refused when the shell did not serve them, so a worker the check never saw is never registered', async () => {
    guardWorkerScripts(HOST_ORIGIN)
    beginSettling(HOST_ORIGIN)
    await settle()
    expect((await answer()).cancel).toBe(true)
    expect((await answer({}, { [SHELL_ANSWERED_HEADER]: ['yes'] })).cancel).toBe(true)
  })

  it('are let through when the shell served them and the origin has settled, with the headers as the others left them', async () => {
    guardWorkerScripts(HOST_ORIGIN)
    beginSettling(HOST_ORIGIN)
    await settle()
    const headers = { [SHELL_ANSWERED_HEADER]: ['1'], 'content-type': ['text/javascript'] }
    const result = await answer({}, headers)
    expect(result.cancel).toBeUndefined()
    expect(result.responseHeaders).toBe(headers)
  })

  it('wait for the origin to settle when the shell served them, so the registration they start follows the removal of what a website left', async () => {
    guardWorkerScripts(HOST_ORIGIN)
    beginSettling(HOST_ORIGIN)
    let told = (): void => {}
    const attempt = settle(async () => { await new Promise<void>((resolve) => { told = resolve }) })
    const waiting = answer({}, { [SHELL_ANSWERED_HEADER]: ['1'] })
    expect(await pending(waiting)).toBe(true)
    told()
    await attempt
    expect((await waiting).cancel).toBeUndefined()
  })

  it('are cancelled when the origin could not settle, so no registration comes of a script the removal did not precede', async () => {
    guardWorkerScripts(HOST_ORIGIN)
    beginSettling(HOST_ORIGIN)
    expect(await settle(async () => { await new Promise<void>(() => {}) })).toBe(false)
    expect((await answer({}, { [SHELL_ANSWERED_HEADER]: ['1'] })).cancel).toBe(true)
  })

  it('are left alone for a website, a page\'s own script and every other kind of request', async () => {
    expect((await answer()).cancel).toBeUndefined()
    guardWorkerScripts(HOST_ORIGIN)
    expect((await answer({ webContents: {} })).cancel).toBeUndefined()
    expect((await answer({ resourceType: 'xhr' })).cancel).toBeUndefined()
  })
})
