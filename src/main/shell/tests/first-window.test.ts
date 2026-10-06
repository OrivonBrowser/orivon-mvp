import { describe, expect, it, vi } from 'vitest'
import { firstWindowOptions } from '../first-window.js'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import { fakeTabs } from '../../session-restore/tests/tabs-fake.js'
import type { SavedSession, SavedWindow } from '../../session-restore/session-types.js'
import type { ShellServices } from '../shell-services.js'

const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
const saved = { bounds: { x: 100, y: 80, width: 900, height: 620 }, maximized: false }

const savedWindow = (urls: string[], bounds = { x: 10, y: 20, width: 800, height: 600 }, maximized = false, active = 0): SavedWindow =>
  ({ bounds, maximized, active, tabs: urls.map((url) => ({ url, title: '', pinned: false })) })
const sessionOf = (windows: SavedWindow[]): SavedSession => ({ version: 1, clean: true, windows })

function services (extra: { kiosk?: boolean, saved?: unknown, home?: string, mode?: string, pages?: string, previous?: SavedSession, closed?: ClosedStack } = {}): ShellServices {
  const values: Record<string, unknown> = { 'home.url': extra.home ?? '', 'startup.mode': extra.mode ?? 'newTab', 'startup.pages': extra.pages ?? '' }
  return {
    kiosk: extra.kiosk ?? false,
    windowState: { get: () => extra.saved ?? null },
    session: { previous: () => extra.previous ?? null },
    closedTabs: extra.closed ?? new ClosedStack(),
    settings: { get: (key: string) => values[key] }
  } as unknown as ShellServices
}

function opened (first: ((tabs: never) => void) | undefined): Array<[string, boolean]> {
  const calls: Array<[string, boolean]> = []
  const record = (url: string, active: boolean): void => { calls.push([url, active]) }
  first?.({ createTab: record, openLocalFile: (url: string, active: boolean) => { record(url, active); return Promise.resolve('t') } } as never)
  return calls
}

describe('firstWindowOptions', () => {
  it('opens as it always does when nothing was saved and nothing was asked', () => {
    expect(firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon'], displays: [display] })).toEqual({})
  })

  it('restores the saved place and the maximised state', () => {
    expect(firstWindowOptions({ services: services({ saved }), isPrivate: false, argv: [], displays: [display] }))
      .toEqual({ place: { x: 100, y: 80, width: 900, height: 620 } })
    expect(firstWindowOptions({ services: services({ saved: { ...saved, maximized: true } }), isPrivate: false, argv: [], displays: [display] }))
      .toEqual({ place: { x: 100, y: 80, width: 900, height: 620 }, maximized: true })
  })

  it('does not restore a place in a private session or a kiosk', () => {
    expect(firstWindowOptions({ services: services({ saved }), isPrivate: true, argv: [], displays: [display] })).toEqual({})
    expect(firstWindowOptions({ services: services({ saved, kiosk: true }), isPrivate: false, argv: [], displays: [display] })).toEqual({})
  })

  it('opens the addresses on the command line as tabs, the first in front', () => {
    const plan = firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon', '--x', 'https://a.example/', 'file://server/share/x', 'http://b.example/'] })
    expect(opened(plan.first)).toEqual([['https://a.example/', true], ['http://b.example/', false]])
  })

  it('opens a local file on the command line the way it opens a web address, in order', () => {
    const disk = { cwd: '/work', platform: 'linux' as const, kindOf: (path: string) => path === '/work/a.html' ? 'file' as const : undefined }
    const plan = firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon', 'a.html', 'https://b.example/', 'file:///tmp/c.html', 'missing.html'], disk })
    expect(opened(plan.first)).toEqual([['file:///work/a.html', true], ['https://b.example/', false], ['file:///tmp/c.html', false]])
  })

  it('says a start that opens a local file does, so the launch reads the fuse before the window exists', () => {
    const disk = { cwd: '/work', platform: 'linux' as const, kindOf: () => undefined }
    expect(firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon', 'file:///tmp/c.html'], disk }).localFiles).toBe(true)
    expect(firstWindowOptions({ services: services(), isPrivate: false, argv: ['orivon', 'https://a.example/'], disk }).localFiles).toBeUndefined()
    expect(firstWindowOptions({ services: services({ kiosk: true }), isPrivate: false, argv: ['orivon', 'file:///tmp/c.html'], disk }).localFiles).toBe(true)
  })

  it('opens at most eight, and only web addresses and local files', () => {
    const argv = Array.from({ length: 12 }, (_, n) => `https://${String(n)}.example/`)
    expect(opened(firstWindowOptions({ services: services(), isPrivate: false, argv }).first)).toHaveLength(8)
    expect(firstWindowOptions({ services: services(), isPrivate: false, argv: ['javascript:alert(1)', 'data:text/html,x', 'orivon://settings', 'notaurl'] }).first).toBeUndefined()
  })

  it('opens an address given to a private session too', () => {
    const plan = firstWindowOptions({ services: services(), isPrivate: true, argv: ['--orivon-private', 'https://a.example/'] })
    expect(opened(plan.first)).toEqual([['https://a.example/', true]])
  })

  it('shows a kiosk the address it was given, else its home page, else the new tab page', () => {
    const kiosk = { kiosk: true, home: 'example.com' }
    expect(opened(firstWindowOptions({ services: services(kiosk), isPrivate: false, argv: ['orivon', 'https://a.example/'] }).first)).toEqual([['https://a.example/', true]])
    expect(opened(firstWindowOptions({ services: services(kiosk), isPrivate: false, argv: [] }).first)).toEqual([['https://example.com/', true]])
    expect(firstWindowOptions({ services: services({ kiosk: true }), isPrivate: false, argv: [] }).first).toBeUndefined()
  })

  it('does not open the home page for an ordinary start', () => {
    expect(firstWindowOptions({ services: services({ home: 'example.com' }), isPrivate: false, argv: [] }).first).toBeUndefined()
  })

  describe('the start-up choice', () => {
    const previous = sessionOf([
      savedWindow(['https://a.example/', 'https://b.example/'], { x: 100, y: 80, width: 900, height: 620 }, true, 1),
      savedWindow(['https://c.example/'], { x: 300, y: 200, width: 700, height: 500 })
    ])

    it('opens the listed pages as the first window\'s tabs, none of the session', () => {
      const plan = firstWindowOptions({ services: services({ mode: 'pages', pages: 'https://p.example/\nnot a url at all\njavascript:alert(1)\nhttps://q.example/', previous }), isPrivate: false, argv: [], displays: [display] })
      const fake = fakeTabs()
      plan.first?.(fake.tabs)
      expect(fake.calls).toEqual(['create https://p.example/ back', 'create https://q.example/ back', 'activate t1'])
      expect(plan.after).toBeUndefined()
    })

    it('continues with the first saved window here, its place over the last-used window\'s, and the rest after', () => {
      const closed = new ClosedStack()
      const open = vi.fn()
      const plan = firstWindowOptions({ services: services({ mode: 'continue', previous, saved, closed }), isPrivate: false, argv: [], displays: [display], openWindow: open })
      expect(plan.place).toEqual({ x: 100, y: 80, width: 900, height: 620 })
      expect(plan.maximized).toBe(true)
      expect(plan.first).toBeDefined()
      expect(open).not.toHaveBeenCalled()
      const first = { isDestroyed: () => false, focus: vi.fn() }
      plan.after?.(first as never)
      expect(open).toHaveBeenCalledTimes(1)
      expect(open.mock.calls[0]?.[0]).toMatchObject({ place: { x: 300, y: 200, width: 700, height: 500 }, maximized: false })
    })

    it('opens the later windows without focus and gives the first window the focus once they are shown', () => {
      const open = vi.fn()
      const plan = firstWindowOptions({ services: services({ mode: 'continue', previous, saved, closed: new ClosedStack() }), isPrivate: false, argv: [], displays: [display], openWindow: open })
      const first = { isDestroyed: () => false, focus: vi.fn() }
      plan.after?.(first as never)
      const options = open.mock.calls[0]?.[0] as { inactive?: boolean, shown?: () => void }
      expect(options.inactive).toBe(true)
      expect(first.focus).not.toHaveBeenCalled()
      options.shown?.()
      expect(first.focus).toHaveBeenCalledTimes(1)
    })

    it('has no `after` when there is no other window, or nowhere to open it', () => {
      const one = sessionOf([savedWindow(['https://a.example/'])])
      expect(firstWindowOptions({ services: services({ mode: 'continue', previous: one }), isPrivate: false, argv: [], displays: [display], openWindow: vi.fn() }).after).toBeUndefined()
      expect(firstWindowOptions({ services: services({ mode: 'continue', previous }), isPrivate: false, argv: [], displays: [display] }).after).toBeUndefined()
    })

    it('sends a window whose place no screen shows to the default place, still maximised as it was', () => {
      const gone = sessionOf([savedWindow(['https://a.example/'], { x: 5000, y: 5000, width: 800, height: 600 }, true)])
      const plan = firstWindowOptions({ services: services({ mode: 'continue', previous: gone }), isPrivate: false, argv: [], displays: [display] })
      expect(plan.place).toBeUndefined()
      expect(plan.maximized).toBe(true)
    })

    it('takes the windows it reopens off the closed stack so Reopen does not offer them twice', () => {
      const closed = new ClosedStack()
      for (const window of previous.windows) closed.push({ kind: 'window', window })
      const other = savedWindow(['https://z.example/'])
      closed.push({ kind: 'window', window: other })
      firstWindowOptions({ services: services({ mode: 'continue', previous, closed }), isPrivate: false, argv: [], displays: [display], openWindow: vi.fn() })
      expect(closed.list().map((entry) => entry.kind === 'window' && entry.window)).toEqual([other])
    })

    it('leaves the stack alone when the choice is not continue, and opens the new tab page with no session', () => {
      const closed = new ClosedStack()
      for (const window of previous.windows) closed.push({ kind: 'window', window })
      expect(firstWindowOptions({ services: services({ mode: 'newTab', previous, closed }), isPrivate: false, argv: [] }).first).toBeUndefined()
      expect(closed.size).toBe(2)
      expect(firstWindowOptions({ services: services({ mode: 'continue' }), isPrivate: false, argv: [] }).first).toBeUndefined()
    })

    it('adds the launch address to the restored tabs, in front, and ignores the choice in a private session', () => {
      const plan = firstWindowOptions({ services: services({ mode: 'continue', previous }), isPrivate: false, argv: ['orivon', 'https://link.example/'], displays: [display] })
      const fake = fakeTabs()
      plan.first?.(fake.tabs)
      expect(fake.calls).toEqual(['create https://a.example/ back', 'create https://b.example/ back', 'create https://link.example/ front'])
      const private_ = firstWindowOptions({ services: services({ mode: 'continue', previous }), isPrivate: true, argv: [], displays: [display] })
      expect(private_).toEqual({})
    })
  })
})
