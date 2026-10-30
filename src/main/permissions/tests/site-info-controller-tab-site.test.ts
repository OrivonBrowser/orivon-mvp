import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps } from '../../../broker/tests/index.test-helpers.js'
import type { SubsystemContext } from '../../registry.js'
import { entryFor } from '../../route/route-state.js'
import type { TunnelEntry } from '../../route/route-state.js'
import { profileOf } from '../../route/site-partition.js'
import type { TabTunnelChoice } from '../../route/tab-tunnel.js'
import { createSiteInfoController } from '../site-info-controller.js'
import type { SiteTrustSources } from '../site-info-controller.js'

// The tunnel popup of a tab showing a website: the rows set the tab, "Always use for this site" keeps what they show as the website's
// own entry, and the popup of a tab that has moved on never changes an entry it did not show.

vi.mock('../../extensions/site-reach-runner.js', () => ({ extensionNamesForOrigin: async () => ['Ad Blocker'] }))

const SITE = 'https://news.example'
const OTHER = 'https://other.example'
const APP = 'https://app.example'

const trust = (): SiteTrustSources => ({
  isOriginServedFromCacheSync: (origin) => origin === APP,
  pinCoverageFor: () => undefined,
  nameEvidenceFor: async () => undefined,
  levelOverrideFor: () => undefined,
  deliveryOverrideFor: () => undefined,
  localDdocHashFor: async () => undefined,
  providerVerdictFor: async () => ({ status: 'off' })
})

interface Options {
  everywhere?: boolean
  unreadable?: boolean
  privateTunnel?: 'nym' | null
  noProxy?: boolean
  /** The tab's address: the page it shows. */
  address?: string | undefined
  choice?: TabTunnelChoice
  entries?: Record<string, TunnelEntry>
  /** `routeSwitch.choose` / `forget` throw: the entry cannot be saved. */
  entryFails?: boolean
  /** `routeSwitch.choose` / `forget` save the entry and then fail (the sessions did not follow). */
  entryFailsAfterSaving?: boolean
  /** The tab could not move to the session its new choice calls for: it keeps what it had. */
  tabStuck?: boolean
}

/** A tab 't1', the website entries and the routes around them, kept in memory; every call that changes one is recorded in `calls` in order. */
function world (options: Options = {}) {
  const calls: string[] = []
  const entries = new Map<string, TunnelEntry>(Object.entries(options.entries ?? {}))
  const tab: { choice: TabTunnelChoice | undefined, address: string | undefined } = { choice: options.choice, address: 'address' in options ? options.address : SITE }
  const everywhere = options.everywhere === true
  const kindOf = (origin: string): 'nym' | 'socks5' | undefined => {
    const state = entries.get(origin) ?? (everywhere ? 'nym' : 'off')
    return state === 'off' ? undefined : state
  }
  const forget = vi.fn(async (origin: string, _tabStays?: boolean) => {
    calls.push(`forget:${origin}`)
    if (options.entryFails === true) throw new Error('could not be saved')
    entries.delete(origin)
    if (options.entryFailsAfterSaving === true) throw new Error('the sessions did not follow')
  })
  const routes = {
    hub: {
      state: () => 'ok',
      unreadable: () => options.unreadable === true,
      profileFor: (origin: string) => options.unreadable === true ? 'nym' : profileOf(entries.get(origin)),
      isEverywhere: () => everywhere,
      kindOf
    },
    store: { entries: () => [...entries], stateOf: (origin: string) => entries.get(origin) },
    routeSwitch: {
      blockedFor: (_origin: string, kind: 'nym' | 'socks5') => kind === 'socks5' && options.noProxy === true ? 'no-proxy' : undefined,
      noticeFor: (origin: string, kind: 'nym' | 'socks5' | null) => {
        const profile = profileOf(entryFor(kind ?? 'off', everywhere))
        return origin === SITE && profile !== undefined && profile !== profileOf(entries.get(origin)) ? profile : undefined
      },
      choose: vi.fn(async (origin: string, kind: 'nym' | 'socks5' | null) => {
        calls.push(`choose:${origin}:${String(kind)}`)
        if (options.entryFails === true) throw new Error('could not be saved')
        const entry = entryFor(kind ?? 'off', everywhere)
        if (entry === undefined) entries.delete(origin)
        else entries.set(origin, entry)
        if (options.entryFailsAfterSaving === true) throw new Error('the sessions did not follow')
      }),
      forget
    },
    defaultKind: () => 'nym',
    targetOf: (kind: 'nym' | 'socks5') => kind === 'socks5' && options.noProxy === true ? undefined : { host: '127.0.0.1', port: 9050 },
    nym: { state: () => ({ state: 'ready' }) }
  } as unknown as SubsystemContext['routes']
  const set = vi.fn((_id: string, next: TabTunnelChoice | null) => {
    calls.push(`tab:${String(next)}`)
    if (options.tabStuck !== true) tab.choice = next ?? undefined
  })
  const tabTunnels = { choiceOf: (id: string) => id === 't1' ? { choice: tab.choice, ...(tab.address === undefined ? {} : { address: tab.address }) } : undefined, set }
  const controller = createSiteInfoController({ broker: createBroker(baseDeps()), routes, privateTunnel: options.privateTunnel ?? null, extensions: { list: () => [] } } as unknown as SubsystemContext, trust(), undefined, undefined, undefined, tabTunnels)
  const info = async () => await controller.tabInfoFor('t1')
  return { controller, calls, entries, tab, info, routes, forget }
}

describe('what the popup says of a tab showing a website', () => {
  it('is about the tab and names the website only for the commands: nothing chosen means a switch with nothing to keep', async () => {
    const w = world()
    const info = await w.info()
    expect(info).toMatchObject({ origin: SITE, displayOrigin: expect.stringContaining('news.example'), tunnel: { subject: 'tab', via: null, following: true, always: { on: false, available: false } } })
    expect(w.controller.tabShownOrigin('t1')).toBe(SITE)
  })

  it('keeps everything the website\'s own panel told: the storage notices, the extensions on it, why a tunnel cannot be chosen', async () => {
    const w = world({ noProxy: true })
    const info = await w.info()
    expect(info?.extensionsOnSite).toEqual(['Ad Blocker'])
    expect(info?.tunnel).toMatchObject({ blocked: { socks5: 'no-proxy' }, notices: {} })
    const site = world()
    expect((await site.info())?.tunnel?.notices, 'moving into the tunnel profile is told first, as for the website').toEqual({ nym: 'nym', socks5: 'socks5' })
  })

  it('names the notices of the tunnel the page really goes through, not the website\'s own: the lit row is not offered again', async () => {
    const w = world({ choice: 'nym' })
    const notices = (await w.info())?.tunnel?.notices
    expect(notices).toEqual({ socks5: 'socks5' })
  })

  it('shows what the page really does: the tab\'s tunnel over the website\'s entry, the entry when the tab has no choice, the browser\'s otherwise', async () => {
    expect((await world({ choice: 'nym', entries: { [SITE]: 'socks5' } }).info())?.tunnel).toMatchObject({ via: 'nym', following: false, tabChoice: 'nym', profile: 'nym', always: { on: true, available: true } })
    expect((await world({ entries: { [SITE]: 'socks5' } }).info())?.tunnel).toMatchObject({ via: 'socks5', following: false, profile: 'socks5', always: { on: true } })
    expect((await world({ everywhere: true }).info())?.tunnel).toMatchObject({ via: 'nym', following: true, always: { on: false, available: false } })
    expect((await world({ everywhere: true, choice: 'direct' }).info())?.tunnel).toMatchObject({ via: null, following: false, profile: 'direct', always: { on: false, available: true } })
  })

  it('is the tab\'s own list for a new tab, an installed app, this computer and a page it cannot read', async () => {
    for (const address of [undefined, '', APP + '/', 'http://localhost:3000/', 'file:///a.html']) {
      const info = await world(address === undefined ? { address: undefined } : { address }).info()
      expect(info, String(address)).toMatchObject({ origin: '', tunnel: { subject: 'tab' } })
      expect(info?.tunnel?.always, String(address)).toBeUndefined()
    }
  })
})

describe('moving a row', () => {
  it('sets the tab alone while the website has no entry of its own', async () => {
    const w = world()
    expect(await w.controller.setTabTunnel('t1', 'nym', SITE)).toBe(true)
    expect(w.calls).toEqual(['tab:nym'])
    expect(w.entries.size).toBe(0)
  })

  it('moves the tab and the entry together while Always is on, so the row really moves', async () => {
    const w = world({ choice: 'nym', entries: { [SITE]: 'nym' } })
    expect(await w.controller.setTabTunnel('t1', 'socks5', SITE)).toBe(true)
    expect(w.calls).toEqual(['tab:socks5', `choose:${SITE}:socks5`])
    expect((await w.info())?.tunnel).toMatchObject({ via: 'socks5', always: { on: true } })
  })

  it('turns the lit row off for both: the page really leaves the tunnel, and the website has no entry while the browser is on no tunnel', async () => {
    const w = world({ choice: 'nym', entries: { [SITE]: 'nym' } })
    expect(await w.controller.setTabTunnel('t1', null, SITE)).toBe(true)
    expect(w.entries.size).toBe(0)
    expect(w.tab.choice).toBeUndefined()
    expect((await w.info())?.tunnel).toMatchObject({ via: null, always: { on: false } })
  })

  it('makes both direct while the browser is on a tunnel: a direct tab alone would leave the website\'s own tunnel lit', async () => {
    const w = world({ everywhere: true, entries: { [SITE]: 'nym' } })
    expect(await w.controller.setTabTunnel('t1', null, SITE)).toBe(true)
    expect(w.entries.get(SITE)).toBe('off')
    expect(w.tab.choice).toBe('direct')
    expect((await w.info())?.tunnel).toMatchObject({ via: null, always: { on: true } })
  })

  it('fails closed when the tab shows another website than the rows were drawn for and the website it shows has an entry', async () => {
    const w = world({ entries: { [SITE]: 'nym' } })
    expect(await w.controller.setTabTunnel('t1', 'socks5', OTHER)).toBe(false)
    expect(await w.controller.setTabTunnel('t1', 'socks5', '')).toBe(false)
    expect(await w.controller.setTabTunnel('t1', 'socks5')).toBe(false)
    expect(w.calls).toEqual([])
    expect(w.entries.get(SITE)).toBe('nym')
  })

  it('still sets the tab\'s choice for a website with no entry whatever the rows were drawn for: no promise is changed', async () => {
    const w = world()
    expect(await w.controller.setTabTunnel('t1', 'nym', OTHER)).toBe(true)
    expect(w.tab.choice).toBe('nym')
  })

  it('gives the tab its choice back when the entry cannot be changed, and says it did not move', async () => {
    const w = world({ choice: 'nym', entries: { [SITE]: 'nym' }, entryFails: true })
    expect(await w.controller.setTabTunnel('t1', 'socks5', SITE)).toBe(false)
    expect(w.tab.choice).toBe('nym')
    expect(w.entries.get(SITE)).toBe('nym')
    expect((await w.info())?.tunnel).toMatchObject({ via: 'nym', always: { on: true } })
  })

  it('changes nothing when the tab could not move to the session the choice calls for', async () => {
    const w = world({ entries: { [SITE]: 'nym' }, tabStuck: true })
    expect(await w.controller.setTabTunnel('t1', 'socks5', SITE)).toBe(false)
    expect(w.calls).toEqual(['tab:socks5'])
    expect(w.entries.get(SITE)).toBe('nym')
  })
})

describe('Always use for this site', () => {
  it('saves the tab\'s tunnel as the website\'s entry and does not touch the tab', async () => {
    const w = world({ choice: 'nym' })
    expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(true)
    expect(w.calls).toEqual([`choose:${SITE}:nym`])
    expect(w.entries.get(SITE)).toBe('nym')
    expect(w.tab.choice).toBe('nym')
  })

  it('saves a direct tab as an off entry while the browser is on a tunnel', async () => {
    const w = world({ choice: 'direct', everywhere: true })
    expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(true)
    expect(w.calls).toEqual([`choose:${SITE}:null`])
    expect(w.entries.get(SITE)).toBe('off')
  })

  it('has nothing to save when nothing is chosen, and says so', async () => {
    const w = world()
    expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(false)
    expect(w.calls).toEqual([])
  })

  it('hands a tab with no choice the entry\'s tunnel before the entry goes, so nothing visibly moves', async () => {
    const w = world({ entries: { [SITE]: 'socks5' } })
    expect(await w.controller.setSiteAlways('t1', false, SITE)).toBe(true)
    expect(w.calls).toEqual(['tab:socks5', `forget:${SITE}`])
    expect(w.entries.size).toBe(0)
    expect((await w.info())?.tunnel).toMatchObject({ via: 'socks5', tabChoice: 'socks5', always: { on: false, available: true } })
  })

  it('turns an off entry into a direct tab', async () => {
    const w = world({ everywhere: true, entries: { [SITE]: 'off' } })
    expect(await w.controller.setSiteAlways('t1', false, SITE)).toBe(true)
    expect(w.tab.choice).toBe('direct')
    expect(w.entries.size).toBe(0)
  })

  it('is already as asked when pressed twice: true, and nothing is done again', async () => {
    const w = world({ choice: 'nym', entries: { [SITE]: 'nym' } })
    expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(true)
    expect(await world().controller.setSiteAlways('t1', false, SITE)).toBe(true)
    expect(w.calls).toEqual([])
  })

  describe('never changes where the page leaves by', () => {
    const CHOICES: readonly (TabTunnelChoice | undefined)[] = [undefined, 'nym', 'socks5', 'direct']
    const ENTRIES: readonly (TunnelEntry | undefined)[] = [undefined, 'nym', 'socks5', 'off']
    for (const everywhere of [false, true]) for (const choice of CHOICES) for (const entry of ENTRIES) {
      const name = `tab ${String(choice)}, entry ${String(entry)}, browser ${everywhere ? 'on a tunnel' : 'direct'}`
      it(name, async () => {
        const w = world({ everywhere, ...(choice === undefined ? {} : { choice }), ...(entry === undefined ? {} : { entries: { [SITE]: entry } }) })
        const before = (await w.info())?.tunnel
        const done = await w.controller.setSiteAlways('t1', entry === undefined, SITE)
        const after = (await w.info())?.tunnel
        if (!done) {
          expect(after, 'a refusal changes nothing').toEqual(before)
          return
        }
        expect(after?.via, 'the page leaves by the tunnel it left by').toBe(before?.via)
        expect(after?.always?.on, 'and the switch is where it was pressed to').toBe(entry === undefined)
        expect(w.entries.has(SITE)).toBe(entry === undefined)
      })
    }
  })

  describe('the workers of the page', () => {
    it('stay in the session a tab still runs it in once the entry is gone', async () => {
      const follows = world({ entries: { [SITE]: 'socks5' } })
      await follows.controller.setSiteAlways('t1', false, SITE)
      expect(follows.forget).toHaveBeenLastCalledWith(SITE, true)
      const offEntry = world({ everywhere: true, choice: 'direct', entries: { [SITE]: 'off' } })
      await offEntry.controller.setSiteAlways('t1', false, SITE)
      expect(offEntry.forget).toHaveBeenLastCalledWith(SITE, true)
    })

    it('go from the session the entry put the page in when the tab runs it in another one', async () => {
      const w = world({ choice: 'nym', entries: { [SITE]: 'socks5' } })
      await w.controller.setSiteAlways('t1', false, SITE)
      expect(w.forget).toHaveBeenLastCalledWith(SITE, false)
    })
  })

  describe('when the entry cannot be saved', () => {
    it('turning it on leaves the tab with its choice and the switch off', async () => {
      const w = world({ choice: 'nym', entryFails: true })
      expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(false)
      expect(w.tab.choice).toBe('nym')
      expect((await w.info())?.tunnel).toMatchObject({ via: 'nym', always: { on: false, available: true } })
    })

    it('turning it off gives the tab what it had, because the entry stays and so the switch stays on', async () => {
      const w = world({ entries: { [SITE]: 'socks5' }, entryFails: true })
      expect(await w.controller.setSiteAlways('t1', false, SITE)).toBe(false)
      expect(w.calls).toEqual(['tab:socks5', `forget:${SITE}`, 'tab:null'])
      expect(w.tab.choice).toBeUndefined()
      expect((await w.info())?.tunnel).toMatchObject({ via: 'socks5', following: false, always: { on: true } })
    })

    it('turning it off keeps the tab where the plan put it when the entry was already gone, so the page and the entry agree', async () => {
      const w = world({ entries: { [SITE]: 'socks5' }, entryFailsAfterSaving: true })
      expect(await w.controller.setSiteAlways('t1', false, SITE)).toBe(false)
      expect(w.calls).toEqual(['tab:socks5', `forget:${SITE}`])
      expect(w.tab.choice).toBe('socks5')
      expect((await w.info())?.tunnel).toMatchObject({ via: 'socks5', tabChoice: 'socks5', always: { on: false } })
    })

    it('a move keeps the tab where it went when the entry was saved before the failure', async () => {
      const w = world({ choice: 'nym', entries: { [SITE]: 'nym' }, entryFailsAfterSaving: true })
      expect(await w.controller.setTabTunnel('t1', 'socks5', SITE)).toBe(false)
      expect(w.tab.choice).toBe('socks5')
      expect(w.entries.get(SITE)).toBe('socks5')
    })

    it('turning it off with the tab unable to take the choice leaves the entry alone', async () => {
      const w = world({ entries: { [SITE]: 'socks5' }, tabStuck: true })
      expect(await w.controller.setSiteAlways('t1', false, SITE)).toBe(false)
      expect(w.calls).toEqual(['tab:socks5'])
      expect(w.entries.get(SITE)).toBe('socks5')
    })
  })

  describe('is refused', () => {
    it('for a website the popup was not drawn for, as a stale change fails closed', async () => {
      const w = world({ choice: 'nym' })
      expect(await w.controller.setSiteAlways('t1', true, OTHER)).toBe(false)
      expect(await w.controller.setSiteAlways('t1', true, '')).toBe(false)
      expect(w.calls).toEqual([])
    })

    it('in a window held to Nym, whatever the tab carries', async () => {
      const w = world({ choice: 'nym', privateTunnel: 'nym' })
      expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(false)
      const entry = world({ entries: { [SITE]: 'nym' }, privateTunnel: 'nym' })
      expect(await entry.controller.setSiteAlways('t1', false, SITE)).toBe(false)
      expect(w.calls).toEqual([])
      expect(entry.calls).toEqual([])
    })

    it('while the tunnel settings cannot be read', async () => {
      const w = world({ choice: 'nym', unreadable: true })
      expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(false)
      expect(w.calls).toEqual([])
    })

    it('for a tab that shows no website: a new tab, an installed app, this computer, a tab that is gone, and while routes are not running', async () => {
      for (const address of [undefined, '', `${APP}/`, 'http://localhost:3000/']) {
        const w = world({ choice: 'nym', address })
        expect(await w.controller.setSiteAlways('t1', true, address ?? ''), String(address)).toBe(false)
        expect(w.calls).toEqual([])
      }
      const gone = world({ choice: 'nym' })
      expect(await gone.controller.setSiteAlways('gone', true, SITE)).toBe(false)
      expect(await gone.controller.tabInfoFor('gone')).toBeUndefined()
    })

    it('when the tunnel has no address: the entry cannot be made, and the tab keeps its choice', async () => {
      const w = world({ choice: 'socks5', noProxy: true })
      expect(await w.controller.setSiteAlways('t1', true, SITE)).toBe(false)
      expect(w.entries.size).toBe(0)
      expect(w.tab.choice).toBe('socks5')
    })
  })
})
