import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { TabRecord } from '../tab-types.js'

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false, on: () => {}, removeListener: () => {} } }))

const { watchBacking } = await import('../tab-backing.js')
const { isDashboardUrl, restingColor } = await import('../sheet-backdrop.js')

const DASHBOARD = 'file:///app/out/renderer/newtab/index.html'

function rig (record: Partial<TabRecord> = {}, shown = true): { wc: EventEmitter & { url: string }, colours: string[] } {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, id: 1, url: '', getURL (): string { return this.url } })
  const colours: string[] = []
  const view = { webContents: wc, setBackgroundColor: (c: string) => { colours.push(c) } }
  const full = { isDashboardTab: false, internalPage: null, host: { dashboardUrl: DASHBOARD }, ...record } as unknown as TabRecord
  watchBacking(view as never, full, () => shown)
  return { wc, colours }
}

const start = (wc: EventEmitter, url: string, extra: { isMainFrame?: boolean, isSameDocument?: boolean } = {}): void => {
  wc.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false, ...extra })
}

describe('isDashboardUrl', () => {
  it('matches the new-tab page whatever its query or hash, and nothing else', () => {
    expect(isDashboardUrl(`${DASHBOARD}?x=1#top`, DASHBOARD)).toBe(true)
    expect(isDashboardUrl('https://example.com/', DASHBOARD)).toBe(false)
    expect(isDashboardUrl('about:blank', DASHBOARD)).toBe(false)
  })
})

describe('a tab view\'s backing while a navigation starts', () => {
  it('goes white when a dashboard tab starts for a site, and back to the wash for the dashboard', () => {
    const { wc, colours } = rig({ isDashboardTab: true })
    start(wc, 'https://example.com/')
    start(wc, DASHBOARD)
    expect(colours).toEqual(['#FFFFFF', '#0d0e14'])
  })

  it('ignores a subframe, a same-document change, a view that is not the tab\'s, and an internal page', () => {
    const { wc, colours } = rig({ isDashboardTab: true })
    start(wc, 'https://example.com/', { isMainFrame: false })
    start(wc, 'https://example.com/#a', { isSameDocument: true })
    const parked = rig({}, false)
    start(parked.wc, 'https://example.com/')
    const internal = rig({ internalPage: 'settings' as never })
    start(internal.wc, 'https://example.com/')
    expect([colours, parked.colours, internal.colours]).toEqual([[], [], []])
  })

  it('puts the wash back when a navigation never commits and the view still shows the dashboard, whichever way the tab got there', () => {
    const dashboard = rig()
    dashboard.wc.url = DASHBOARD
    start(dashboard.wc, 'https://example.com/file.zip')
    dashboard.wc.emit('did-stop-loading')
    expect(dashboard.colours).toEqual(['#FFFFFF', '#0d0e14'])
    const site = rig({ isDashboardTab: true })
    site.wc.url = 'https://example.com/'
    site.wc.emit('did-stop-loading')
    expect(site.colours).toEqual([])
  })
})

describe('restingColor', () => {
  const record = (url: string, extra: Partial<TabRecord> = {}): TabRecord =>
    ({ isDashboardTab: false, internalPage: null, host: { dashboardUrl: DASHBOARD }, view: { webContents: { getURL: () => url } }, ...extra }) as unknown as TabRecord

  it('is the wash for a tab showing the dashboard, even one that left it and came back', () => {
    expect(restingColor(record(DASHBOARD))).toBe('#0d0e14')
  })

  it('is the default for a site, even on a tab created as the dashboard', () => {
    expect(restingColor(record('https://example.com/', { isDashboardTab: true }))).toBe('#FFFFFF')
  })
})
