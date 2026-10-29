import { beforeEach, describe, expect, it, vi } from 'vitest'

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))
let own = true
const asked: Array<[string, unknown]> = []
vi.mock('../tab-partition.js', () => ({ partitionForTab: (url: string, choice: unknown) => { asked.push([url, choice]); return own ? 'persist:site-x' : undefined } }))

const { installSiteSessions } = await import('../install-site-sessions.js')

interface Fakes {
  changeHub: (origin: string) => void
  changeSetting: (key: string) => void
  settle: () => void
  install: () => void
}

const stop = vi.fn()

function fakes (unreadable = false, settledFails = false, committed = 'https://news.example/a'): Fakes & { records: Map<string, unknown> } {
  let onHub: ((origin: string) => void) | undefined
  let onSetting: ((change: { key: string }) => void) | undefined
  let release: () => void = () => {}
  const settled = new Promise<void>((resolve, reject) => { release = settledFails ? () => { reject(new Error('the sessions could not follow')) } : resolve })
  const records = new Map<string, unknown>([['t1', { partition: undefined, isDashboardTab: false, internalPage: null, sleeping: null }]])
  const window = {
    tabs: {
      ids: () => ['t1'],
      record: (id: string) => records.get(id),
      liveWebContents: () => ({ getURL: () => committed, stop })
    }
  }
  const ctx = {
    routes: {
      hub: { onChange: (listener: (origin: string) => void) => { onHub = listener; return () => {} }, unreadable: () => unreadable },
      controller: { settled: async () => { await settled } }
    }
  }
  const services = {
    windows: { all: () => [window], liveTabOrigins: () => ['https://news.example'] },
    settings: { onChange: (listener: (change: { key: string }) => void) => { onSetting = listener; return () => {} } }
  }
  return {
    records,
    changeHub: (origin) => { onHub?.(origin) },
    changeSetting: (key) => { onSetting?.({ key }) },
    settle: () => { release() },
    install: () => { installSiteSessions.install({} as never, services as never, ctx as never, {} as never) }
  }
}

beforeEach(() => { repartitionView.mockReset(); stop.mockClear(); own = true; asked.length = 0 })

describe('moving tabs when a website\'s tunnel changes', () => {
  it('waits for the sessions to follow the switch, then moves the tabs on that website into the session its state calls for', async () => {
    const world = fakes()
    world.install()
    world.changeHub('https://news.example')
    await Promise.resolve()
    expect(repartitionView).not.toHaveBeenCalled()
    world.settle()
    await vi.waitFor(() => { expect(repartitionView).toHaveBeenCalledWith('t1', world.records.get('t1'), 'https://news.example/a', 'persist:site-x') })
  })

  it('asks for the session of the tab\'s own tunnel choice, so the change moves a tab only to where its choice allows', async () => {
    const world = fakes()
    ;(world.records.get('t1') as { tunnelChoice?: string }).tunnelChoice = 'nym'
    world.install()
    world.settle()
    world.changeHub('https://news.example')
    await vi.waitFor(() => { expect(asked).toEqual([['https://news.example/a', 'nym']]) })
  })

  it('moves nothing for a website none of whose tabs is open', async () => {
    const world = fakes()
    world.install()
    world.settle()
    world.changeHub('https://other.example')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('moves the open websites when the tunnel is set while the list of settings cannot be read, and not otherwise', async () => {
    const readable = fakes(false)
    readable.install()
    readable.settle()
    readable.changeSetting('network.route.proxy')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()

    const broken = fakes(true)
    broken.install()
    broken.settle()
    broken.changeSetting('privacy.cookies')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()
    broken.changeSetting('network.route.proxy')
    await vi.waitFor(() => { expect(repartitionView).toHaveBeenCalledTimes(1) })
  })

  it('does nothing when routes are not running', () => {
    expect(() => { installSiteSessions.install({} as never, {} as never, {} as never, {} as never) }).not.toThrow()
  })
})

describe('a tab that cannot be moved to the session its tunnel calls for', () => {
  it('has its loads stopped, never left running in the session it was in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    repartitionView.mockImplementation(() => { throw new Error('the view could not be made') })
    const world = fakes()
    world.install()
    world.settle()
    world.changeHub('https://news.example')
    await vi.waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
  })

  it('has the loads of the website\'s open tabs stopped when the sessions could not follow the switch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const world = fakes(false, true)
    world.install()
    world.changeHub('https://news.example')
    world.settle()
    await vi.waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
    expect(repartitionView).not.toHaveBeenCalled()
  })
})

describe('a tab whose first page has not committed', () => {
  const opening = (): ReturnType<typeof fakes> => {
    const world = fakes(false, false, '')
    Object.assign(world.records.get('t1') as object, { inflightUrl: 'https://t.example/x', inflightTarget: 'https://news.example/a' })
    return world
  }

  it('moves into the session of the website it is opening when that website\'s tunnel changes, loading the address it was opening there', async () => {
    const world = opening()
    world.install()
    world.settle()
    world.changeHub('https://news.example')
    await vi.waitFor(() => { expect(repartitionView).toHaveBeenCalledWith('t1', world.records.get('t1'), 'https://news.example/a', 'persist:site-x') })
    expect(asked).toEqual([['https://news.example/a', undefined]])
  })

  it('leaves the tab alone when another website\'s tunnel changes', async () => {
    const world = opening()
    world.install()
    world.settle()
    world.changeHub('https://t.example')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('has its load stopped when the sessions could not follow the switch, as the loads of a tab showing the website are', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const world = fakes(false, true, '')
    Object.assign(world.records.get('t1') as object, { inflightTarget: 'https://news.example/a' })
    world.install()
    world.changeHub('https://news.example')
    world.settle()
    await vi.waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
  })
})
