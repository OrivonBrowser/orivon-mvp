import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

type Handler = (details: { url: string, resourceType: string, frame?: { top: { url: string } } }, current: { requestHeaders: Record<string, string> }) => { requestHeaders: Record<string, string> }
interface Started { resourceType: string, url: string, webContents?: object, fromCache?: boolean, responseHeaders?: Record<string, string[]> }
const { captured } = vi.hoisted(() => ({ captured: { handler: undefined as Handler | undefined, started: undefined as ((details: Started) => void) | undefined } }))
vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('../../sessions/web-request-owner.js', () => ({
  RUN_LAST: 0,
  webRequestOwnerFor: () => ({
    onBeforeSendHeaders: (_order: number, _filter: unknown, _matches: unknown, handler: Handler) => { captured.handler = handler },
    onCompleted: () => {},
    onResponseStarted: (_filter: unknown, _matches: unknown, handler: (details: Started) => void) => { captured.started = handler }
  })
}))

const { registerAppOrigin, retireAppOrigin } = await import('../../../loader/electron/app-partitions.js')
const { installPartitionStamp, installShellAnswerWatch } = await import('../partition-stamp.js')
const { takeShellAnswered, forgetShellAnswered } = await import('../../sessions/shell-answered.js')
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
  const watch = (): ((details: Started) => void) => {
    installShellAnswerWatch({} as Session)
    if (captured.started === undefined) throw new Error('nothing was registered for responses')
    return captured.started
  }
  const main = (url: string, headers: Record<string, string[]> | undefined, more: Partial<Started> = {}): Started => ({ resourceType: 'mainFrame', url, webContents: contents, fromCache: false, ...(headers === undefined ? {} : { responseHeaders: headers }), ...more })
  afterEach(() => { forgetShellAnswered(contents) })

  it('records a main-frame response that carries the mark, for the commit of that address to take once', () => {
    watch()(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'], 'content-type': ['text/html'] }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(true)
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(false)
  })

  it('reads the mark whatever case the header name comes in', () => {
    watch()(main(`${HOST_ORIGIN}/`, { 'X-Orivon-Shell-Answered': ['1'] }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(true)
  })

  it('records nothing for a response without the mark, and it replaces an earlier mark: the last response is the document', () => {
    const on = watch()
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }))
    on(main(`${HOST_ORIGIN}/`, { 'content-type': ['text/html'] }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(false)
    on(main(`${HOST_ORIGIN}/`, undefined))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(false)
  })

  it('does not count a mark on any value but 1, or on a response read from the HTTP cache', () => {
    const on = watch()
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['yes'] }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(false)
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }, { fromCache: true }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/`)).toBe(false)
  })

  it('ignores a response that is not a main frame\'s, and a commit of another address', () => {
    const on = watch()
    on(main(`${HOST_ORIGIN}/app.js`, { [SHELL_ANSWERED_HEADER]: ['1'] }, { resourceType: 'script' }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/app.js`)).toBe(false)
    on(main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] }))
    expect(takeShellAnswered(contents, `${HOST_ORIGIN}/other.html`)).toBe(false)
  })

  it('ignores a response with no page behind it', () => {
    const { webContents: _none, ...bare } = main(`${HOST_ORIGIN}/`, { [SHELL_ANSWERED_HEADER]: ['1'] })
    expect(() => { watch()(bare) }).not.toThrow()
  })
})
