import { describe, expect, it, vi } from 'vitest'

const onBeforeSendHeaders = vi.fn()
vi.mock('electron', () => ({ session: { defaultSession: {} } }))
vi.mock('../../sessions/web-request-owner.js', () => ({
  webRequestOwnerFor: () => ({ onBeforeSendHeaders })
}))

const { installSignInIdentityHeaders, signInHeaderFilter } = await import('../sign-in-identity-headers.js')
const { firefoxIdentityHeaders, firefoxUserAgent } = await import('../sign-in-identity.js')

describe('firefoxIdentityHeaders', () => {
  it('drops the User-Agent and every Sec-CH-UA header in any casing, and sets the Firefox one', () => {
    const ua = firefoxUserAgent('linux')
    const out = firefoxIdentityHeaders({
      'user-agent': 'Chrome', 'Sec-CH-UA': '"Chromium"', 'sec-ch-ua-mobile': '?0', 'SEC-CH-UA-PLATFORM': '"Linux"', Accept: '*/*'
    }, ua)
    expect(out).toEqual({ Accept: '*/*', 'User-Agent': ua })
  })
})

describe('signInHeaderFilter', () => {
  it('names each host with any scheme, and nothing wider', () => {
    expect(signInHeaderFilter(['accounts.google.com', '127.0.0.1:5000'])).toEqual({
      urls: ['*://accounts.google.com/*', '*://127.0.0.1:5000/*']
    })
  })
})

describe('installSignInIdentityHeaders', () => {
  const hosts = ['accounts.google.com']
  const register = (): { matches: (url: string) => boolean, run: (d: unknown, c: { requestHeaders: Record<string, string> }) => { requestHeaders: Record<string, string> } } => {
    onBeforeSendHeaders.mockClear()
    installSignInIdentityHeaders({} as never, hosts)
    const [, , matches, run] = onBeforeSendHeaders.mock.calls[0] as [number, unknown, (url: string) => boolean, never]
    return { matches, run }
  }

  it('registers one handler through the owner, before the verifier stamp', () => {
    register()
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(onBeforeSendHeaders.mock.calls[0]?.[0]).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('matches a sign-in host exactly, never a suffix or lookalike, and never throws on a bad URL', () => {
    const { matches } = register()
    expect(matches('https://accounts.google.com/signin')).toBe(true)
    expect(matches('https://accounts.google.com.evil.example/')).toBe(false)
    expect(matches('https://google.com/')).toBe(false)
    expect(matches('not a url')).toBe(false)
  })

  it('returns a new header set with the Firefox identity', () => {
    const { run } = register()
    const current = { requestHeaders: { 'User-Agent': 'Chrome', 'sec-ch-ua': 'x', Accept: '*/*' } }
    const result = run({}, current)
    expect(result).not.toBe(current)
    expect(result.requestHeaders['User-Agent']).toMatch(/Firefox\//)
    expect(Object.keys(result.requestHeaders).some((k) => k.toLowerCase().startsWith('sec-ch-ua'))).toBe(false)
    expect(result.requestHeaders['Accept']).toBe('*/*')
  })
})
