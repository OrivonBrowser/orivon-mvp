import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { darkTokens, isShellSurface, rootTokens, shellCss } from '../shell-style.js'
import type { ShellStylePart, SurfaceEnv } from '../shell-style.js'

const SETTINGS = { get: () => 'x' } as never

const part = (name: string, css: string): ShellStylePart => ({ name, keys: [], css: () => css })

describe('shellCss', () => {
  it('is empty with no parts, which is what the shell has until a feature adds one', () => {
    expect(shellCss(SETTINGS)).toBe('')
  })

  it('joins the parts that are on, in order, and skips one that is off', () => {
    expect(shellCss(SETTINGS, [part('a', '.a{}'), part('off', ''), part('b', '.b{}')])).toBe('.a{}\n.b{}')
  })

  it('hands each part the settings', () => {
    const seen = vi.fn(() => '')
    shellCss(SETTINGS, [{ name: 'reads', keys: [], css: seen }])
    expect(seen).toHaveBeenCalledWith(SETTINGS)
  })

  it('leaves out a part that throws and logs it by name', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const broken: ShellStylePart = { name: 'broken', keys: [], css: () => { throw new Error('boom') } }

      expect(shellCss(SETTINGS, [broken, part('fine', '.f{}')])).toBe('.f{}')
      expect(error.mock.calls[0]?.[0]).toContain('broken')
    } finally {
      error.mockRestore()
    }
  })
})

describe('rootTokens and darkTokens', () => {
  it('write a rule that outweighs a page\'s own :root', () => {
    expect(rootTokens({ '--waccent': '#ff0000', '--waccent-text': '#ff8888' })).toBe(':root:root{--waccent:#ff0000;--waccent-text:#ff8888}')
  })

  it('scope the same rule to a dark theme', () => {
    expect(darkTokens({ '--waccent-text': '#ff8888' })).toBe('@media (prefers-color-scheme: dark){:root:root{--waccent-text:#ff8888}}')
  })

  it('refuse a name or a value that could close the rule and start another', () => {
    expect(() => rootTokens({ 'color': 'red' })).toThrow()
    expect(() => rootTokens({ '--x': 'red;}body{display:none' })).toThrow()
    expect(() => rootTokens({ '--x': '' })).toThrow()
    expect(() => darkTokens({ '--x y': 'red' })).toThrow()
  })
})

describe('isShellSurface', () => {
  const shell = { id: 'shell' } as unknown as Session
  const internal = { id: 'internal' } as unknown as Session
  const site = { id: 'site' } as unknown as Session
  const env = (internalNow: Session | undefined): SurfaceEnv => ({ shellSession: shell, internalSession: () => internalNow, dashboardUrl: 'file:///app/out/renderer/newtab/index.html' })
  const contents = (session: Session, url: string): Parameters<typeof isShellSurface>[0] => ({ session, getURL: () => url })

  it.each([
    ['the chrome or a popup, in the shell session', shell, 'file:///app/out/renderer/index.html', internal, true],
    ['an internal page, in the internal session', internal, 'orivon://settings/appearance', internal, true],
    ['the new-tab page, by its address', site, 'file:///app/out/renderer/newtab/index.html', internal, true],
    ['the new-tab page with a query and a hash', site, 'file:///app/out/renderer/newtab/index.html?x=1#top', undefined, true],
    ['a site in the default session', site, 'https://example.com/', internal, false],
    ['a site that only looks like the new-tab page', site, 'https://example.com/file:///app/out/renderer/newtab/index.html', internal, false],
    ['an extension page', site, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', internal, false],
    ['a page when no internal session exists yet', site, 'orivon://settings/', undefined, false]
  ])('%s', (_name, session, url, internalNow, expected) => {
    expect(isShellSurface(contents(session, url), env(internalNow))).toBe(expected)
  })
})
