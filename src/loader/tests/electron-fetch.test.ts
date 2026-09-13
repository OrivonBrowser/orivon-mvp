import { afterEach, describe, expect, it, vi } from 'vitest'

// electronFetch and netFetch both dynamically import 'electron' (see
// electron-fetch.ts's own header for why) -- mocked here so this file can
// assert what they hand `net.fetch`/`net.resolveHost` without a real
// network call or a real Electron process. Same pattern as
// ../../main/tests/favicon.test.ts, which mocks the same module for the
// same reason.
//
// A155 (docs/open-questions.md): before this file existed, nothing verified
// that electronFetch's address guard, once it PASSES, still delegates to a
// call carrying `redirect: 'error'` -- the e2e suite
// (test/e2e-loader-adapter.test.ts) only ever exercises electronFetch's
// guard REFUSING a real loopback server, which returns before net.fetch is
// ever reached, and separately exercises netFetch directly, bypassing
// electronFetch's guard entirely. A future edit that wrapped, inlined, or
// re-implemented electronFetch's delegation could pass every test that
// existed before this one, including the e2e test whose stated purpose is
// to prove `redirect: 'error'` holds.
vi.mock('electron', () => ({
  net: { fetch: vi.fn(), resolveHost: vi.fn() }
}))

const { net } = await import('electron')
const { electronFetch, netFetch } = await import('../electron-fetch.js')

const fetchMock = vi.mocked(net.fetch)
const resolveHostMock = vi.mocked(net.resolveHost)

afterEach(() => {
  fetchMock.mockReset()
  resolveHostMock.mockReset()
})

describe('netFetch', () => {
  it('calls net.fetch with credentials omitted and redirect set to error', async () => {
    const fakeResponse = { ok: true, status: 200 } as unknown as Response
    fetchMock.mockResolvedValue(fakeResponse)
    const controller = new AbortController()

    const result = await netFetch('https://x.example/a.js', controller.signal)

    expect(result).toBe(fakeResponse)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://x.example/a.js', {
      credentials: 'omit',
      signal: controller.signal,
      redirect: 'error'
    })
  })
})

describe('electronFetch', () => {
  it('delegates to net.fetch with redirect: error once a public address literal clears the guard', async () => {
    const fakeResponse = { ok: true, status: 200 } as unknown as Response
    fetchMock.mockResolvedValue(fakeResponse)
    const controller = new AbortController()

    const result = await electronFetch('https://8.8.8.8/a.js', ['8.8.8.8'], controller.signal)

    expect(result).toBe(fakeResponse)
    expect(resolveHostMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://8.8.8.8/a.js', {
      credentials: 'omit',
      signal: controller.signal,
      redirect: 'error'
    })
  })

  it('delegates to net.fetch with redirect: error once a hostname resolves to only public addresses', async () => {
    const fakeResponse = { ok: true, status: 200 } as unknown as Response
    resolveHostMock.mockResolvedValue({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
    fetchMock.mockResolvedValue(fakeResponse)
    const controller = new AbortController()

    const result = await electronFetch('https://cdn.example/a.js', ['93.184.216.34'], controller.signal)

    expect(result).toBe(fakeResponse)
    expect(resolveHostMock).toHaveBeenCalledExactlyOnceWith('cdn.example')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://cdn.example/a.js', {
      credentials: 'omit',
      signal: controller.signal,
      redirect: 'error'
    })
  })

  it('never calls net.fetch when a literal address fails the guard', async () => {
    const controller = new AbortController()

    await expect(electronFetch('https://127.0.0.1/a.js', [], controller.signal)).rejects.toThrow(
      /not a public address literal/
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never calls net.fetch when a hostname resolves to a private address', async () => {
    resolveHostMock.mockResolvedValue({ endpoints: [{ address: '10.0.0.5', family: 'ipv4' }] })
    const controller = new AbortController()

    await expect(electronFetch('https://rebind.example/a.js', ['93.184.216.34'], controller.signal)).rejects.toThrow(
      /no longer resolves to a public address/
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never calls net.fetch when a hostname resolves to no addresses at all', async () => {
    resolveHostMock.mockResolvedValue({ endpoints: [] })
    const controller = new AbortController()

    await expect(electronFetch('https://nowhere.example/a.js', [], controller.signal)).rejects.toThrow(
      /resolved to no addresses/
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
