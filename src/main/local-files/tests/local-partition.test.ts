import { describe, expect, it, vi } from 'vitest'
import { prepareLocalSession, type LocalSessionDeps } from '../local-partition.js'
import { LOCAL_FILES_PARTITION } from '../partition.js'

function fakeSession (handled: boolean): {
  target: Parameters<typeof prepareLocalSession>[0]
  protocol: { isProtocolHandled: () => boolean, handle: ReturnType<typeof vi.fn>, unhandle: ReturnType<typeof vi.fn> }
  fetch: ReturnType<typeof vi.fn>
} {
  const protocol = { isProtocolHandled: () => handled, handle: vi.fn(), unhandle: vi.fn() }
  const fetch = vi.fn(async () => new Response('bytes', { status: 200 }))
  return { target: { protocol, fetch } as unknown as Parameters<typeof prepareLocalSession>[0], protocol, fetch }
}

function deps (): LocalSessionDeps & { onBeforeRequest: ReturnType<typeof vi.fn> } {
  const onBeforeRequest = vi.fn()
  return { owner: () => ({ onBeforeRequest }), fuse: async () => 'off', extraPolicy: async () => undefined, onBeforeRequest }
}

describe('prepareLocalSession', () => {
  it('installs the file handler and the fence on a session of its own', () => {
    const { target, protocol } = fakeSession(false)
    const d = deps()

    prepareLocalSession(target, LOCAL_FILES_PARTITION, d)

    expect(protocol.handle).toHaveBeenCalledWith('file', expect.any(Function))
    expect(d.onBeforeRequest).toHaveBeenCalledOnce()
  })

  it('takes the 404 a session was given at creation off first, since handling a scheme twice throws', () => {
    const { target, protocol } = fakeSession(true)

    prepareLocalSession(target, LOCAL_FILES_PARTITION, deps())

    expect(protocol.unhandle).toHaveBeenCalledWith('file')
    expect(protocol.unhandle.mock.invocationCallOrder[0]).toBeLessThan(protocol.handle.mock.invocationCallOrder[0] as number)
  })

  it('is done once per session: a second call changes nothing', () => {
    const { target, protocol } = fakeSession(false)
    const d = deps()

    prepareLocalSession(target, LOCAL_FILES_PARTITION, d)
    prepareLocalSession(target, LOCAL_FILES_PARTITION, d)

    expect(protocol.handle).toHaveBeenCalledOnce()
    expect(d.onBeforeRequest).toHaveBeenCalledOnce()
  })

  it('reads files through the session\'s own loader, bypassing its custom handlers', async () => {
    const { target, protocol, fetch } = fakeSession(false)
    prepareLocalSession(target, LOCAL_FILES_PARTITION, deps())
    const handler = protocol.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>

    const response = await handler(new Request('file:///home/u/a.html'))

    expect(await response.text()).toBe('bytes')
    expect(fetch.mock.calls[0]?.[1]).toEqual({ bypassCustomProtocolHandlers: true })
  })
})
