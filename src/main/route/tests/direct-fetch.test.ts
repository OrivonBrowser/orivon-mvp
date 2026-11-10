// The fetch of Orivon's own requests that leave on the system's proxy is made in the session that follows the system, and is
// refused first for a name the verifier serves that this session's proxy would carry.

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { Net, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDirectFetch } from '../direct-fetch.js'
import { forgetSystemSettings, systemSettingsAre } from './mirror-status.test-helpers.js'
import { PROXY_WOULD_SEE_NAME } from '../verifier-name-guard.js'

beforeEach(() => { systemSettingsAre() })
afterEach(() => { vi.restoreAllMocks(); forgetSystemSettings() })

interface FakeRequest extends EventEmitter { end: () => void, abort: () => void, setHeader: (name: string, value: string) => void, write: (chunk: Buffer) => void }

/** A `net` whose requests answer 200, and the options they were made with. */
function fakeNet () {
  const made: Array<Record<string, unknown>> = []
  const net = {
    request: (options: Record<string, unknown>) => {
      made.push(options)
      const request = new EventEmitter() as FakeRequest
      request.setHeader = () => {}
      request.write = () => {}
      request.abort = () => {}
      request.end = () => {
        queueMicrotask(() => {
          const stream = Readable.from([Buffer.from('ok')]) as Readable & { statusCode: number, headers: Record<string, string> }
          stream.statusCode = 200
          stream.headers = {}
          request.emit('response', stream)
        })
      }
      return request
    }
  } as unknown as Pick<Net, 'request'>
  return { net, made }
}

const systemSession = (answer: string): Session & { resolveProxy: ReturnType<typeof vi.fn<(url: string) => Promise<string>>> } => ({ resolveProxy: vi.fn(async () => answer) }) as unknown as Session & { resolveProxy: ReturnType<typeof vi.fn<(url: string) => Promise<string>>> }

describe('the fetch that leaves on the system\'s proxy', () => {
  it('asks the session it sends in about a name the verifier serves, and sends nothing when that session\'s proxy would carry it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { net, made } = fakeNet()
    const session = systemSession('PROXY 127.0.0.1:3128')
    await expect(createDirectFetch(net, session)('https://site.eth/index.html')).rejects.toThrow(PROXY_WOULD_SEE_NAME)
    expect(session.resolveProxy).toHaveBeenCalledExactlyOnceWith('https://site.eth/')
    expect(made).toEqual([])
  })

  it('sends it in that session when the session sends the name to the verifier', async () => {
    const { net, made } = fakeNet()
    const session = systemSession('DIRECT')
    const response = await createDirectFetch(net, session)('https://site.eth/index.html')
    expect(await response.text()).toBe('ok')
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ url: 'https://site.eth/index.html', session, credentials: 'omit' })
  })

  it('asks nothing about any other host, and sends it in the session', async () => {
    const { net, made } = fakeNet()
    const session = systemSession('PROXY 127.0.0.1:3128')
    await createDirectFetch(net, session)('https://example.com/a')
    expect(session.resolveProxy).not.toHaveBeenCalled()
    expect(made[0]).toMatchObject({ url: 'https://example.com/a', session })
  })

  it('cancels a proxy\'s challenge, since the system\'s proxy is not one Orivon signs in to', async () => {
    const { net } = fakeNet()
    const original = net.request
    const given = vi.fn()
    ;(net as { request: unknown }).request = (options: Record<string, unknown>) => {
      const request = original(options as never) as unknown as FakeRequest
      const end = request.end
      request.end = () => { request.emit('login', { isProxy: true, host: '10.0.0.1', port: 3128 }, given); end() }
      return request as never
    }
    await createDirectFetch(net, systemSession('DIRECT'))('https://example.com/a')
    expect(given.mock.calls).toEqual([[]])
  })
})
