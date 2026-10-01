import { describe, expect, it, vi } from 'vitest'
import type { AuthInfo, AuthenticationResponseDetails, WebContents } from 'electron'
import type { SlotAsk } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { AuthChallenges } from '../auth-queue.js'
import { handleLogin, isPageOfServer } from '../login-handler.js'

const WINDOW = {} as ShellWindow
const TAB = {} as WebContents
const PAGE = 'https://site.example/page'

function setup (over: { tab?: boolean, pageUrl?: string } = {}): {
  deps: Parameters<typeof handleLogin>[0]
  challenges: AuthChallenges
  asks: SlotAsk[]
  cancel: ReturnType<typeof vi.fn>
  contents: WebContents
} {
  let n = 0
  const challenges = new AuthChallenges({ schedule: () => () => undefined, newId: () => `c${String(++n)}` })
  const asks: SlotAsk[] = []
  const cancel = vi.fn()
  const contents = { getURL: () => over.pageUrl ?? PAGE } as unknown as WebContents
  return {
    deps: {
      challenges,
      findTab: (candidate) => candidate === contents && over.tab !== false ? { window: WINDOW, tabId: 't1' } : null,
      loadOf: () => 1,
      ask: (ask) => { asks.push(ask); return { cancel } }
    },
    challenges, asks, cancel, contents
  }
}

const details = (patch: Partial<AuthenticationResponseDetails & { isMainFrame: boolean }> = {}): AuthenticationResponseDetails =>
  ({ url: 'http://127.0.0.1:8080/secret', pid: 1, isRequestForNavigation: true, firstAuthAttempt: true, isMainFrame: true, ...patch })
const info = (patch: Partial<AuthInfo> = {}): AuthInfo => ({ isProxy: false, scheme: 'basic', host: '127.0.0.1', port: 8080, realm: 'Staging', ...patch })

function run (s: ReturnType<typeof setup>, d = details(), i = info(), contents: WebContents | null = s.contents): { prevented: boolean, callback: ReturnType<typeof vi.fn> } {
  const callback = vi.fn()
  let prevented = false
  handleLogin(s.deps, { preventDefault: () => { prevented = true } }, contents, d, i, callback)
  return { prevented, callback }
}

describe('handleLogin', () => {
  it('raises a sheet for a tab, holds the default answer and asks for the centre slot', () => {
    const s = setup()
    const { prevented, callback } = run(s)
    expect(prevented).toBe(true)
    expect(callback).not.toHaveBeenCalled()
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toMatchObject({ window: WINDOW, tabId: 't1', slot: 'center', overlay: 'auth-sheet', payload: { id: 'c1' } })
    expect(s.challenges.get('c1')).toMatchObject({ first: true, insecure: true, mismatch: false, server: { scheme: 'http', host: '127.0.0.1', port: 8080, realm: 'Staging' } })
  })

  it('leaves anything that is not a tab to Electron, which cancels it', () => {
    const notATab = setup({ tab: false })
    const none = setup()
    for (const [s, contents] of [[notATab, notATab.contents], [none, null]] as const) {
      const { prevented, callback } = run(s, details(), info(), contents)
      expect(prevented).toBe(false)
      expect(callback).not.toHaveBeenCalled()
      expect(s.asks).toHaveLength(0)
    }
  })

  it('passes the answer on: credentials to the callback, a cancel as no arguments', () => {
    const s = setup()
    const a = run(s)
    s.challenges.answer('c1', { username: 'u', password: 'p' })
    expect(a.callback).toHaveBeenCalledWith('u', 'p')
    const b = run(s, details(), info({ realm: 'B' }))
    s.asks[1]?.closed('escape')
    expect(b.callback).toHaveBeenCalledWith()
  })

  it('cancels the challenge whenever its sheet ends without an answer', () => {
    const s = setup()
    const { callback } = run(s)
    s.asks[0]?.closed('tab-closed')
    expect(callback).toHaveBeenCalledWith()
  })

  it('takes the sheet away when the challenge waited too long', () => {
    const s = setup()
    const timers: Array<() => void> = []
    const deps = { ...s.deps, challenges: new AuthChallenges({ schedule: (fn) => { timers.push(fn); return () => undefined }, newId: () => 'x1' }) }
    handleLogin(deps, { preventDefault: () => undefined }, s.contents, details(), info(), () => undefined)
    timers[0]?.()
    expect(s.cancel).toHaveBeenCalledOnce()
  })

  it('flags a proxy, never calls it insecure, and never compares it with the page', () => {
    const s = setup()
    run(s, details({ url: 'http://example.com/', isMainFrame: false }), info({ isProxy: true, host: 'proxy.lan', port: 3128 }))
    expect(s.challenges.get('c1')).toMatchObject({ insecure: false, mismatch: false, server: { isProxy: true } })
  })

  it('does not call an https request insecure', () => {
    const s = setup()
    run(s, details({ url: 'https://127.0.0.1:8080/x' }))
    expect(s.challenges.get('c1')?.insecure).toBe(false)
  })

  it('flags a subresource from another server, and accepts one from the page\'s own', () => {
    const s = setup({ pageUrl: 'http://127.0.0.1:8080/page' })
    run(s, details({ url: 'http://127.0.0.1:9090/img.png', isMainFrame: false, isRequestForNavigation: false }), info({ port: 9090 }))
    expect(s.challenges.get('c1')?.mismatch).toBe(true)
    run(s, details({ url: 'http://127.0.0.1:8080/img.png', isMainFrame: false, isRequestForNavigation: false }), info({ realm: 'other' }))
    expect(s.challenges.get('c2')?.mismatch).toBe(false)
  })

  it('treats an iframe navigation as a subresource, and judges a request that does not say by the page the tab is on', () => {
    const s = setup({ pageUrl: 'http://127.0.0.1:9090/page' })
    run(s, details({ isMainFrame: false }))
    expect(s.challenges.get('c1')?.mismatch).toBe(true)
    // A navigation request that does not say whether it is a frame's is never taken for the page's own.
    const { isMainFrame: _unused, ...untyped } = details({ isRequestForNavigation: true }) as AuthenticationResponseDetails & { isMainFrame?: boolean }
    run(s, untyped, info({ realm: 'n' }))
    expect(s.challenges.get('c2')?.mismatch).toBe(true)
    const own = setup({ pageUrl: 'http://127.0.0.1:8080/page' })
    run(own, untyped, info({ realm: 'n' }))
    expect(own.challenges.get('c1')?.mismatch).toBe(false)
  })

  it('cancels an address it cannot read', () => {
    const s = setup()
    const { prevented, callback } = run(s, details({ url: 'not a url' }))
    expect(prevented).toBe(true)
    expect(callback).toHaveBeenCalledWith()
    expect(s.asks).toHaveLength(0)
  })

  it('answers a repeat of a cancelled server at once, without a sheet', () => {
    const s = setup()
    run(s)
    s.asks[0]?.closed('escape')
    const again = run(s)
    expect(again.prevented).toBe(true)
    expect(again.callback).toHaveBeenCalledWith()
    expect(s.asks).toHaveLength(1)
  })

  it('marks a second ask after a wrong answer as a retry', () => {
    const s = setup()
    run(s)
    s.challenges.answer('c1', { username: 'alice', password: 'no' })
    run(s, details({ firstAuthAttempt: false }))
    expect(s.challenges.get('c2')).toMatchObject({ first: false, username: 'alice' })
  })
})

describe('isPageOfServer', () => {
  const server = { scheme: 'https', host: 'Site.Example', port: 443, isProxy: false, realm: '' }
  it('compares host and port, with the scheme\'s own port filled in', () => {
    expect(isPageOfServer('https://site.example/a', server)).toBe(true)
    expect(isPageOfServer('https://site.example:444/a', server)).toBe(false)
    expect(isPageOfServer('https://other.example/a', server)).toBe(false)
    expect(isPageOfServer('http://[::1]:80/', { ...server, host: '::1', port: 80 })).toBe(true)
  })
  it('matches no page that is not on the web', () => {
    for (const url of ['orivon://settings', 'about:blank', 'file:///x', '', 'nonsense']) expect(isPageOfServer(url, server), url).toBe(false)
  })
})
