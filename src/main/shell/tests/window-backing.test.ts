import { describe, expect, it, vi } from 'vitest'
import type { TabRecord } from '../tab-types.js'

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false, on: () => {}, removeListener: () => {} } }))

const { followActiveTabBacking } = await import('../window-backing.js')
const { restingColor } = await import('../sheet-backdrop.js')

const DASHBOARD = 'orivon-shell://renderer/newtab/index.html'

interface Rig { colours: string[], change: (activeTabId: string | null) => void, record: TabRecord }

/** A window whose manager holds one tab, `t1`, whose view `webContents` the test can take away the way Electron
 * does when a page is closed under the shell (a view with no webContents at all). */
function rig (): Rig {
  const wc: { getURL: () => string, isDestroyed: () => boolean } | undefined = { getURL: () => DASHBOARD, isDestroyed: () => false }
  const record = { isDashboardTab: true, internalPage: null, host: { dashboardUrl: DASHBOARD }, view: { webContents: wc } } as unknown as TabRecord
  let listener: (state: { activeTabId: string | null }) => void = () => {}
  const tabs = {
    record: (id: string) => id === 't1' ? record : undefined,
    liveWebContents: (id: string) => {
      const wc = id === 't1' ? (record.view as { webContents?: { isDestroyed: () => boolean } }).webContents : undefined
      return wc === undefined || wc.isDestroyed() ? undefined : wc
    },
    getState: () => ({ activeTabId: 't1' }),
    onStateChange: (cb: typeof listener) => { listener = cb; return () => {} }
  }
  const colours: string[] = []
  const win = { isDestroyed: () => false, setBackgroundColor: (c: string) => { colours.push(c) } }
  followActiveTabBacking(win as never, tabs as never)
  return { colours, record, change: (activeTabId) => { listener({ activeTabId }) } }
}

describe('a window\'s backing follows the active tab', () => {
  it('takes the shown tab\'s resting colour', () => {
    expect(rig().colours).toEqual(['#394244'])
  })

  it('takes the dashboard\'s colour for a new dashboard tab at the moment it is shown, before its load has an address', () => {
    const { colours, record, change } = rig()
    ;(record.view.webContents as unknown as { getURL: () => string }).getURL = () => ''
    change('t1')
    expect(colours).toEqual(['#394244'])
  })

  it('does not throw when the active tab\'s view has no webContents, and keeps the colour it had', () => {
    const { colours, record, change } = rig()
    ;(record.view as unknown as { webContents?: object | undefined }).webContents = undefined
    expect(() => { change('t1') }).not.toThrow()
    expect(colours).toEqual(['#394244'])
  })

  it('does not throw when the webContents is destroyed, and keeps the colour it had', () => {
    const { colours, record, change } = rig()
    ;(record.view.webContents as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true
    expect(() => { change('t1') }).not.toThrow()
    expect(colours).toEqual(['#394244'])
  })
})

describe('restingColor for a view being torn down', () => {
  it('reads no address from a view with no webContents: not the wash, the default', () => {
    const record = { internalPage: null, host: { dashboardUrl: DASHBOARD }, view: {} } as unknown as TabRecord
    expect(restingColor(record)).toBe('#FFFFFF')
  })
})
