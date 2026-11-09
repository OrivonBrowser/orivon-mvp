import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

type Handler = (details: { url: string, resourceType: string, frame?: { top: { url: string } } }, current: { requestHeaders: Record<string, string> }) => { requestHeaders: Record<string, string> }
const { captured } = vi.hoisted(() => ({ captured: { handler: undefined as Handler | undefined } }))
vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }))
vi.mock('../../sessions/web-request-owner.js', () => ({
  RUN_LAST: 0,
  webRequestOwnerFor: () => ({
    onBeforeSendHeaders: (_order: number, _filter: unknown, _matches: unknown, handler: Handler) => { captured.handler = handler },
    onCompleted: () => {}
  })
}))

const { registerAppOrigin, retireAppOrigin } = await import('../../../loader/electron/app-partitions.js')
const { installPartitionStamp } = await import('../partition-stamp.js')

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
