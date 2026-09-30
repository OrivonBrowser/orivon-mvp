import { describe, expect, it } from 'vitest'
import { SIGN_IN_HOSTS, firefoxUserAgent, isSignInHost } from '../sign-in-identity.js'

describe('isSignInHost -- exact hosts only, no suffix match', () => {
  it('matches the real sign-in hosts', () => {
    expect(isSignInHost('accounts.google.com')).toBe(true)
    expect(isSignInHost('accounts.youtube.com')).toBe(true)
  })

  it('never matches google.com or youtube.com at large, or an unrelated subdomain', () => {
    expect(isSignInHost('google.com')).toBe(false)
    expect(isSignInHost('www.google.com')).toBe(false)
    expect(isSignInHost('youtube.com')).toBe(false)
    expect(isSignInHost('mail.google.com')).toBe(false)
    expect(isSignInHost('evilaccounts.google.com.attacker.example')).toBe(false)
  })

  it('accepts an injected host list, for a test fixture standing in for a real one', () => {
    expect(isSignInHost('127.0.0.1:54321', ['127.0.0.1:54321'])).toBe(true)
    expect(isSignInHost('accounts.google.com', ['127.0.0.1:54321'])).toBe(false)
  })

  it('the default list is exactly the two real hosts, nothing else', () => {
    expect(SIGN_IN_HOSTS).toEqual(['accounts.google.com', 'accounts.youtube.com'])
  })
})

describe('firefoxUserAgent -- what these hosts see instead of Chrome', () => {
  it('carries no Chrome, Chromium, Electron or orivon token, on any platform', () => {
    for (const platform of ['linux', 'win32', 'darwin', 'freebsd'] as const) {
      const ua = firefoxUserAgent(platform)
      expect(ua).toMatch(/^Mozilla\/5\.0 \(.+\) Gecko\/20100101 Firefox\/\d+\.\d+$/)
      expect(ua).not.toMatch(/chrome/i)
      expect(ua).not.toMatch(/electron/i)
      expect(ua).not.toMatch(/orivon/i)
    }
  })

  it('uses Firefox\'s own frozen platform tokens on Windows and macOS, not Chrome\'s', () => {
    expect(firefoxUserAgent('win32')).toContain('Windows NT 10.0; Win64; x64')
    expect(firefoxUserAgent('darwin')).toContain('Macintosh; Intel Mac OS X 10.15')
    expect(firefoxUserAgent('linux')).toContain('X11; Linux x86_64')
  })
})
