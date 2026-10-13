import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

// A page of a routed app that starts a navigation outside the app's sessions is stopped and asked about; what the
// answer does to the tab is checked here against fakes of the question and of the tab's moves.

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))
const loadInTab = vi.fn()
vi.mock('../load-in-tab.js', () => ({ loadInTab }))
const askToLeaveRoute = vi.fn<(...args: unknown[]) => Promise<'proxy' | 'direct' | 'cancel'>>()
vi.mock('../leaving-route-prompt.js', () => ({ askToLeaveRoute: (...args: unknown[]) => askToLeaveRoute(...args) }))
const isNavigationHeld = vi.fn(() => false)
const holdNavigation = vi.fn(() => () => {})
vi.mock('../navigation-hold.js', () => ({ isNavigationHeld, holdNavigation: () => holdNavigation() }))
const leaveFor = vi.fn()
const isRoutedPage = vi.fn((_url: string) => true)
const openTemporaryRoute = vi.fn(async () => 'orivon-route-tab-1')
const routeAppToo = vi.fn(async (_origin?: string) => true)
vi.mock('../../route/leaving-routes.js', () => ({ isRoutedPage: (url: string) => isRoutedPage(url), leaveFor: (...args: unknown[]) => leaveFor(...args), openTemporaryRoute: () => openTemporaryRoute(), routeAppToo: (origin: string) => routeAppToo(origin) }))

const { askBeforeLeavingRoute, chooseLeave, leaveForOpen } = await import('../leaving-route.js')

const APP_URL = 'https://routed.example/app'
const WEBSITE = { kind: 'website', origin: 'https://news.example', app: 'https://routed.example' } as const

function rig (record: Record<string, unknown> = {}) {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => APP_URL }) as unknown as WebContents & EventEmitter
  const view = {}
  const tab: Record<string, unknown> = { view, partition: 'persist:app-1', isDashboardTab: false, internalPage: null, host: { services: undefined }, ...record }
  let on = true
  askBeforeLeavingRoute(wc, 'tab-1', tab as never, () => on)
  const fire = (name: 'will-navigate' | 'will-redirect', extra: Record<string, unknown> = {}) => {
    const event = { url: 'https://news.example/a', isMainFrame: true, defaultPrevented: false, preventDefault: vi.fn(), ...extra }
    wc.emit(name, event)
    return event
  }
  return { fire, tab, hide: () => { on = false } }
}

const turn = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }

beforeEach(() => {
  isRoutedPage.mockReset().mockReturnValue(true)
  repartitionView.mockReset(); loadInTab.mockReset(); askToLeaveRoute.mockReset(); leaveFor.mockReset().mockReturnValue(WEBSITE)
  isNavigationHeld.mockReset().mockReturnValue(false); holdNavigation.mockReset().mockReturnValue(() => {})
  openTemporaryRoute.mockReset().mockResolvedValue('orivon-route-tab-1'); routeAppToo.mockReset().mockResolvedValue(true)
})

describe('askBeforeLeavingRoute', () => {
  it.each(['will-navigate', 'will-redirect'] as const)('stops a main-frame %s the decision asks about, and asks', async (name) => {
    askToLeaveRoute.mockResolvedValue('cancel')
    const { fire } = rig()
    const event = fire(name)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(leaveFor).toHaveBeenCalledWith(APP_URL, 'https://news.example/a', 'persist:app-1')
    await turn()
    expect(askToLeaveRoute).toHaveBeenCalledOnce()
  })

  it('leaves a navigation the decision does not ask about', async () => {
    leaveFor.mockReturnValue(undefined)
    const event = rig().fire('will-navigate')
    expect(event.preventDefault).not.toHaveBeenCalled()
    await turn()
    expect(askToLeaveRoute).not.toHaveBeenCalled()
  })

  it('opens the website in a temporary routed session in the same tab on "through my proxy"', async () => {
    askToLeaveRoute.mockResolvedValue('proxy')
    const { fire, tab } = rig()
    fire('will-navigate')
    await turn()
    expect(openTemporaryRoute).toHaveBeenCalledOnce()
    expect(repartitionView).toHaveBeenCalledWith('tab-1', tab, 'https://news.example/a', 'orivon-route-tab-1')
    expect(tab.routedAway).toBe('orivon-route-tab-1')
    expect(loadInTab).not.toHaveBeenCalled()
  })

  it('loads it as the tab would with no route on "directly"', async () => {
    askToLeaveRoute.mockResolvedValue('direct')
    const { fire, tab } = rig()
    fire('will-navigate')
    await turn()
    expect(loadInTab).toHaveBeenCalledWith('tab-1', tab, 'https://news.example/a')
    expect(openTemporaryRoute).not.toHaveBeenCalled()
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('turns the other app\'s route on, then loads it, on "use my proxy for it too"', async () => {
    leaveFor.mockReturnValue({ kind: 'app', origin: 'https://other.example', app: 'https://routed.example' })
    askToLeaveRoute.mockResolvedValue('proxy')
    const { fire, tab } = rig()
    fire('will-navigate', { url: 'https://other.example/x' })
    await turn()
    expect(routeAppToo).toHaveBeenCalledWith('https://other.example')
    expect(loadInTab).toHaveBeenCalledWith('tab-1', tab, 'https://other.example/x')
    expect(openTemporaryRoute).not.toHaveBeenCalled()
  })

  it('does nothing on Cancel: the tab stays on the app', async () => {
    askToLeaveRoute.mockResolvedValue('cancel')
    const { fire } = rig()
    fire('will-navigate')
    await turn()
    expect(loadInTab).not.toHaveBeenCalled()
    expect(repartitionView).not.toHaveBeenCalled()
    expect(openTemporaryRoute).not.toHaveBeenCalled()
  })

  it('does not load the address when the tab\'s view was replaced while the question was open', async () => {
    askToLeaveRoute.mockResolvedValue('direct')
    const { fire, tab } = rig()
    fire('will-navigate')
    tab.view = {}
    await turn()
    expect(loadInTab).not.toHaveBeenCalled()
  })

  it('ignores a subframe, an already prevented navigation, a held one and a tab that is not showing', async () => {
    const r = rig()
    expect(r.fire('will-navigate', { isMainFrame: false }).preventDefault).not.toHaveBeenCalled()
    expect(r.fire('will-navigate', { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled()
    isNavigationHeld.mockReturnValue(true)
    expect(r.fire('will-navigate').preventDefault).not.toHaveBeenCalled()
    isNavigationHeld.mockReturnValue(false)
    r.hide()
    expect(r.fire('will-navigate').preventDefault).not.toHaveBeenCalled()
    await turn()
    expect(askToLeaveRoute).not.toHaveBeenCalled()
  })

  it('leaves the dashboard and an internal page alone', () => {
    expect(rig({ isDashboardTab: true }).fire('will-navigate').preventDefault).not.toHaveBeenCalled()
    expect(rig({ internalPage: 'settings' }).fire('will-navigate').preventDefault).not.toHaveBeenCalled()
  })
})

describe('chooseLeave', () => {
  const wc = {} as WebContents

  it('holds the page where it is while the question is open, and lets it go after', async () => {
    const release = vi.fn()
    holdNavigation.mockReturnValue(release)
    askToLeaveRoute.mockImplementation(async () => { expect(release).not.toHaveBeenCalled(); return 'direct' })
    expect(await chooseLeave(wc, WEBSITE)).toEqual({ kind: 'direct' })
    expect(holdNavigation).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('cancels, and never goes direct, when the temporary session cannot be made', async () => {
    askToLeaveRoute.mockResolvedValue('proxy')
    openTemporaryRoute.mockRejectedValue(new Error('no front'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await chooseLeave(wc, WEBSITE)).toEqual({ kind: 'cancel' })
    log.mockRestore()
  })

  it('offers a page Orivon loads itself only directly: "directly" opens it, anything else cancels, and no session is made', async () => {
    const served = { kind: 'served', origin: 'ipfs://bafyexample', app: 'https://routed.example' } as const
    askToLeaveRoute.mockResolvedValue('direct')
    expect(await chooseLeave(wc, served)).toEqual({ kind: 'direct' })
    askToLeaveRoute.mockResolvedValue('proxy')
    expect(await chooseLeave(wc, served)).toEqual({ kind: 'cancel' })
    expect(openTemporaryRoute).not.toHaveBeenCalled()
    expect(routeAppToo).not.toHaveBeenCalled()
  })

  it('asks one question at a time for an app and cancels its other requests unasked, remembering nothing', async () => {
    let answer: (value: 'cancel' | 'direct') => void = () => {}
    askToLeaveRoute.mockImplementationOnce(async () => await new Promise((resolve) => { answer = resolve }))
    const first = chooseLeave(wc, WEBSITE)
    expect(await chooseLeave({} as WebContents, { ...WEBSITE, origin: 'https://other-news.example' })).toEqual({ kind: 'cancel' })
    expect(askToLeaveRoute).toHaveBeenCalledOnce()
    expect(holdNavigation).toHaveBeenCalledOnce()
    // Another routed app is not held up by it.
    askToLeaveRoute.mockResolvedValueOnce('direct')
    expect(await chooseLeave(wc, { ...WEBSITE, app: 'https://second-routed.example' })).toEqual({ kind: 'direct' })
    answer('cancel')
    expect(await first).toEqual({ kind: 'cancel' })
    // Once it is answered the app is asked again, as often as it opens something.
    askToLeaveRoute.mockResolvedValueOnce('direct')
    expect(await chooseLeave(wc, WEBSITE)).toEqual({ kind: 'direct' })
    expect(askToLeaveRoute).toHaveBeenCalledTimes(3)
  })

  it('lets the app ask again after a question that failed', async () => {
    askToLeaveRoute.mockRejectedValueOnce(new Error('panel gone'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await chooseLeave(wc, WEBSITE)).toEqual({ kind: 'cancel' })
    log.mockRestore()
    askToLeaveRoute.mockResolvedValueOnce('direct')
    expect(await chooseLeave(wc, WEBSITE)).toEqual({ kind: 'direct' })
  })

  it('cancels when the other app cannot be routed', async () => {
    askToLeaveRoute.mockResolvedValue('proxy')
    routeAppToo.mockResolvedValue(false)
    expect(await chooseLeave(wc, { kind: 'app', origin: 'https://other.example', app: 'https://routed.example' })).toEqual({ kind: 'cancel' })
  })
})

describe('leaveForOpen', () => {
  const record = { host: { services: undefined } } as never

  it('maps no address and asks nothing for a page that is not a routed app\'s', () => {
    isRoutedPage.mockReturnValue(false)
    expect(leaveForOpen(record, 'https://news.example/', 'ipfs://some-name.eth/', undefined)).toBeUndefined()
    expect(leaveFor).not.toHaveBeenCalled()
  })

  it('asks about an address as written', () => {
    expect(leaveForOpen(record, APP_URL, 'https://news.example/a', 'persist:app-1')).toEqual(WEBSITE)
    expect(leaveFor).toHaveBeenCalledWith(APP_URL, 'https://news.example/a', 'persist:app-1')
  })

  it('judges a protocol address by the address it is served at, and asks about it when Orivon loads it itself', () => {
    const served = { kind: 'served', origin: 'ipfs://some-name.eth', app: 'https://routed.example' } as const
    leaveFor.mockReturnValue(served)
    expect(leaveForOpen(record, APP_URL, 'ipfs://some-name.eth/', 'persist:app-1')).toEqual(served)
    expect(leaveFor).toHaveBeenCalledWith(APP_URL, 'https://some-name.eth/', 'persist:app-1')
  })

  it('still asks when a protocol address is an installed app whose route is off', () => {
    leaveFor.mockReturnValue({ kind: 'app', origin: 'https://other.example', app: 'https://routed.example' })
    expect(leaveForOpen(record, APP_URL, 'ipfs://other.example/', 'persist:app-1')).toEqual({ kind: 'app', origin: 'https://other.example', app: 'https://routed.example' })
  })
})
