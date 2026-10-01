import { describe, expect, it } from 'vitest'
import { hostAndPort, lineOf, MAX_REALM, mismatchText, originOf, realmText, titleOf } from '../auth-text.js'
import type { AuthServer } from '../auth-queue.js'

const site = (patch: Partial<AuthServer> = {}): AuthServer => ({ scheme: 'https', host: 'intranet.example', port: 443, isProxy: false, realm: '', ...patch })

describe('the sign-in sheet text', () => {
  it('names the server from what Electron reported, leaving out the scheme\'s own port', () => {
    expect(originOf(site())).toBe('https://intranet.example')
    expect(originOf(site({ scheme: 'http', port: 8080, host: '127.0.0.1' }))).toBe('http://127.0.0.1:8080')
    expect(originOf(site({ scheme: 'http', port: 443 }))).toBe('http://intranet.example:443')
    expect(hostAndPort(site({ host: '::1', port: 9 }))).toBe('[::1]:9')
  })

  it('names a proxy by its address and says so in the title and the line', () => {
    const proxy = site({ isProxy: true, host: 'proxy.lan', port: 3128 })
    expect(originOf(proxy)).toBe('proxy.lan:3128')
    expect(titleOf(proxy)).toBe('Sign in to the proxy')
    expect(lineOf(proxy)).toBe('This proxy needs a username and password.')
    expect(titleOf(site())).toBe('Sign in')
    expect(lineOf(site())).toBe('This site is asking for a username and password.')
  })

  it('says where a request that is not the page\'s own comes from', () => {
    expect(mismatchText(site({ scheme: 'http', host: 'img.example', port: 81 }))).toBe('This request comes from img.example:81, not from the page you are on.')
  })

  it('shows a realm as one plain line, and none that is empty or too long to be a name', () => {
    expect(realmText('Staging')).toBe('Staging')
    expect(realmText('  ')).toBeNull()
    expect(realmText('x'.repeat(MAX_REALM))).toBe('x'.repeat(MAX_REALM))
    expect(realmText('x'.repeat(MAX_REALM + 1))).toBeNull()
    expect(realmText('Bank\nEnter your PIN‮')).toBe('Bank Enter your PIN')
  })
})
