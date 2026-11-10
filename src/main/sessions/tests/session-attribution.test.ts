import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originFromUrl } from '../../../broker/policy/origin.js'
import { originHash, partitionFor } from '../../../broker/grants/origin-hash.js'
import { LocalFileApps, installLocalFileApps } from '../../local-files/local-file-apps.js'
import { LOCAL_FILES_PARTITION } from '../../local-files/partition.js'
import { createSubsystemContext } from '../../registry.js'

// session-attribution.ts's own subsystem reaches into electron (app, session)
// at module scope and imports ../shell/tab-view.js, which itself imports
// WebContentsView from electron -- same shape tab-view.test.ts already mocks,
// reused here for the same reason: these tests are about the ATTRIBUTION
// RULE, not about wiring a real Electron session.
const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { webContentsCreatedListeners, sessionsByPartition, DEFAULT_SESSION } = vi.hoisted(() => ({
  webContentsCreatedListeners: [] as Array<(event: unknown, wc: unknown) => void>,
  sessionsByPartition: new Map<string, { name: string }>(),
  DEFAULT_SESSION: { name: 'default' }
}))

vi.mock('electron', () => ({
  WebContentsView: vi.fn(),
  ipcMain: { on: vi.fn() },
  app: {
    on: (name: string, listener: (event: unknown, wc: unknown) => void) => {
      if (name === 'web-contents-created') webContentsCreatedListeners.push(listener)
    }
  },
  session: {
    defaultSession: DEFAULT_SESSION,
    fromPartition: (partition: string) => {
      let s = sessionsByPartition.get(partition)
      if (s === undefined) {
        s = { name: partition }
        sessionsByPartition.set(partition, s)
      }
      return s
    }
  }
}))

const { sessionAttributionSubsystem } = await import('../session-attribution.js')
const { session } = await import('electron')
const { setTabTunnelSource } = await import('../../route/tab-tunnel.js')
const { setSiteRoutes } = await import('../../route/site-routes.js')
const { profilePartitionFor } = await import('../../route/site-partition.js')
const { noteMainFrameResponse } = await import('../shell-answered.js')
const { noteWorkerControl } = await import('../worker-control.js')
const { appTabContents } = await import('../../shell/tab-partition.js')

const APP = 'https://app.example'
const OTHER = 'https://other.example'
// Built through the SAME mocked session.fromPartition every production call
// goes through, never a separately-constructed literal -- attribution
// compares by reference, and a look-alike object would never be `===` to
// what the real predicate resolves.
const appPartitionSession = session.fromPartition(partitionFor(originFromUrl(APP) as string))

interface FakeWebContents {
  session: unknown
  on: (name: string, listener: (event: unknown, url: string) => void) => void
}

function fakeWebContents (initialSession: unknown): { wc: FakeWebContents, commit: (url: string) => void, start: () => void } {
  const listeners = new Map<string, (event: unknown, url: string) => void>()
  const wc: FakeWebContents = {
    session: initialSession,
    on: (name, listener) => { listeners.set(name, listener) }
  }
  return {
    wc,
    commit: (url) => { listeners.get('did-navigate')?.(undefined, url) },
    start: () => { listeners.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: false }, '') }
  }
}

/** One subsystem instance, publishing its own `senderAttributed` onto a fresh context (registry.ts refuses a second, disagreeing one on the same context). */
function attributionRig (): {
  attributed: (sender: unknown, origin: string) => boolean
  register: (wc: FakeWebContents) => void
} {
  const ctx = createSubsystemContext({} as never)
  const before = webContentsCreatedListeners.length
  sessionAttributionSubsystem.afterReady?.(ctx)
  const listener = webContentsCreatedListeners[before]
  const attributed = ctx.senderAttributed
  if (attributed === undefined || listener === undefined) throw new Error('senderAttributed was not published')
  return { attributed, register: (wc) => { listener(undefined, wc) } }
}

describe('senderAttributed -- cache-served origins are checked live and strictly', () => {
  it('denies a sender outside the pinned partition even with no commit record at all', () => {
    served.add(APP)
    const { attributed } = attributionRig()
    const { wc } = fakeWebContents(DEFAULT_SESSION)

    expect(attributed(wc, APP)).toBe(false)
    served.delete(APP)
  })

  it('allows a sender already inside the pinned partition', () => {
    served.add(APP)
    const { attributed } = attributionRig()
    const { wc } = fakeWebContents(appPartitionSession)

    expect(attributed(wc, APP)).toBe(true)
    served.delete(APP)
  })

  it('never trusts a stale record for a cache-served origin', () => {
    served.add(APP)
    const { attributed, register } = attributionRig()
    const { wc, commit } = fakeWebContents(appPartitionSession)
    register(wc)
    commit(APP) // records attributed: true, in the right partition
    wc.session = DEFAULT_SESSION // then moves out of it without navigating

    expect(attributed(wc, APP)).toBe(false)
    served.delete(APP)
  })
})

describe('senderAttributed -- a network-served origin belongs in the default session, granted or not (ADR-0044)', () => {
  it('attributes a document committed in the default session, whatever the origin holds', () => {
    const { attributed, register } = attributionRig()
    const { wc, commit } = fakeWebContents(DEFAULT_SESSION)
    register(wc)
    commit(APP)

    expect(attributed(wc, APP)).toBe(true)
  })

  it('stays attributed after its origin leaves the pinned cache, until it next navigates', () => {
    served.add(APP)
    const { attributed, register } = attributionRig()
    const { wc, commit } = fakeWebContents(appPartitionSession)
    register(wc)
    commit(APP) // cache-served at commit time: the app partition was expected, and matched

    served.delete(APP) // the pinned copy goes away; the document never navigates
    expect(attributed(wc, APP)).toBe(true)
  })

  it('falls back to the live check for a different origin the same WebContents never committed', () => {
    const { attributed, register } = attributionRig()
    const { wc, commit } = fakeWebContents(DEFAULT_SESSION)
    register(wc)
    commit(APP)

    // OTHER has no record on this WebContents, so the live check runs: OTHER
    // is not cache-served, so DEFAULT_SESSION is expected, and matches.
    expect(attributed(wc, OTHER)).toBe(true)
  })

  it('a commit in some other session stays denied, even after a fresh WebContents in the right one takes over the tab', () => {
    // A web context's or an embed's own partition: the page it shows is
    // never the origin's own document for the broker's purposes.
    const { attributed, register } = attributionRig()
    const stale = fakeWebContents(session.fromPartition('isolated-context'))
    register(stale.wc)
    stale.commit(APP)
    expect(attributed(stale.wc, APP)).toBe(false)

    const fresh = fakeWebContents(DEFAULT_SESSION)
    register(fresh.wc)
    fresh.commit(APP)
    expect(attributed(fresh.wc, APP)).toBe(true)
    expect(attributed(stale.wc, APP)).toBe(false)
  })

  it('denies, by the live check, a sender in the app partition for an origin that is not cache-served', () => {
    const { attributed } = attributionRig()
    const { wc } = fakeWebContents(appPartitionSession)

    expect(attributed(wc, APP)).toBe(false)
  })

  it('falls back to the live check when no did-navigate has ever landed for this WebContents', () => {
    const { attributed } = attributionRig()
    const { wc } = fakeWebContents(DEFAULT_SESSION)

    expect(attributed(wc, APP)).toBe(true)
  })
})

describe('senderAttributed -- an app the verifier hands to the shell runs in the default session, as a website does', () => {
  // A host a protocol serves: the shared session reaches the app's handler through the verifier, so no partition of its own.
  const KEPT = 'https://kept.eth'
  const keptOldPartition = session.fromPartition(partitionFor(originFromUrl(KEPT) as string))
  afterEach(() => { served.delete(KEPT); setSiteRoutes(undefined) })

  /** A tab view of the app: it carries the app-tab flag, registers with the subsystem, and commits `url`, answered by the shell or by the network. */
  function appTab (attributed: (sender: unknown, origin: string) => boolean, register: (wc: FakeWebContents) => void, inSession: unknown, options: { answered?: boolean, flagged?: boolean, url?: string } = {}): { wc: FakeWebContents, commit: (answered?: boolean) => void } {
    const made = fakeWebContents(inSession)
    register(made.wc)
    if (options.flagged !== false) appTabContents.add(made.wc as never)
    const url = options.url ?? `${KEPT}/`
    const commit = (answered = options.answered ?? true): void => {
      made.start()
      noteMainFrameResponse(made.wc, url, answered)
      made.commit(url)
    }
    void attributed
    return { wc: made.wc, commit }
  }

  it('attributes a document the shell answered, in an app-tab view in the default session', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const tab = appTab(attributed, register, DEFAULT_SESSION)
    tab.commit()

    expect(attributed(tab.wc, KEPT)).toBe(true)
  })

  it('denies a document the shell did not answer even though the shell served the app when it committed: it came from the network', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const tab = appTab(attributed, register, DEFAULT_SESSION)
    tab.commit(false)

    expect(attributed(tab.wc, KEPT)).toBe(false)
  })

  it('denies a document no response was seen for and no worker controls, and a sender with no commit record at all', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const made = fakeWebContents(DEFAULT_SESSION)
    register(made.wc)
    appTabContents.add(made.wc as never)
    made.start()
    made.commit(`${KEPT}/`)
    expect(attributed(made.wc, KEPT)).toBe(false)

    expect(attributed(fakeWebContents(DEFAULT_SESSION).wc, KEPT)).toBe(false)
  })

  describe('a document the app\'s own service worker answers', () => {
    /** A tab whose navigation to `url` is answered by no response the session sees, as a worker's answer is, with the preload's report of a controller. */
    function workerAnswered (attributed: (sender: unknown, origin: string) => boolean, register: (wc: FakeWebContents) => void, options: { report?: 'before' | 'after' | 'none', reportUrl?: string, flagged?: boolean, inSession?: unknown } = {}): { wc: FakeWebContents, commit: () => void } {
      const made = fakeWebContents(options.inSession ?? DEFAULT_SESSION)
      register(made.wc)
      if (options.flagged !== false) appTabContents.add(made.wc as never)
      void attributed
      const url = `${KEPT}/`
      const report = (): void => { noteWorkerControl(made.wc, options.reportUrl ?? url) }
      return {
        wc: made.wc,
        commit: () => {
          made.start()
          if (options.report === 'before') report()
          made.commit(url)
          if (options.report === undefined || options.report === 'after') report()
        }
      }
    }

    it('attributes it: the preload says a worker controls the document, and no response was seen for it', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const tab = workerAnswered(attributed, register)
      tab.commit()

      expect(attributed(tab.wc, KEPT)).toBe(true)
    })

    it('attributes it whichever of the commit and the preload\'s report arrives first', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const reportFirst = workerAnswered(attributed, register, { report: 'before' })
      reportFirst.commit()

      expect(attributed(reportFirst.wc, KEPT)).toBe(true)
    })

    it('denies a document the preload reported nothing for: no controller, so nothing is known of how it came', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const tab = workerAnswered(attributed, register, { report: 'none' })
      tab.commit()

      expect(attributed(tab.wc, KEPT)).toBe(false)
    })

    it('denies a report made for another address than the document that committed', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const tab = workerAnswered(attributed, register, { reportUrl: `${KEPT}/other.html` })
      tab.commit()

      expect(attributed(tab.wc, KEPT)).toBe(false)
    })

    it('denies a controlled document the network or the HTTP cache answered: only a commit no response came for is a worker\'s', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const tab = appTab(attributed, register, DEFAULT_SESSION, { answered: false })
      tab.commit()
      noteWorkerControl(tab.wc, `${KEPT}/`)

      expect(attributed(tab.wc, KEPT)).toBe(false)
    })

    it('forgets the report when a navigation starts: a later commit nothing answered is not the earlier document\'s', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const tab = workerAnswered(attributed, register)
      tab.commit()
      expect(attributed(tab.wc, KEPT)).toBe(true)

      const made = fakeWebContents(DEFAULT_SESSION)
      register(made.wc)
      appTabContents.add(made.wc as never)
      made.start()
      noteWorkerControl(made.wc, `${KEPT}/`)
      made.start() // a second navigation begins: the report was of the document before it
      made.commit(`${KEPT}/`)
      expect(attributed(made.wc, KEPT)).toBe(false)
    })

    it('still needs the app\'s tab view and the session a website at the origin runs in', () => {
      served.add(KEPT)
      const { attributed, register } = attributionRig()
      const popup = workerAnswered(attributed, register, { flagged: false })
      popup.commit()
      const oldPartition = workerAnswered(attributed, register, { inSession: keptOldPartition })
      oldPartition.commit()

      expect(attributed(popup.wc, KEPT)).toBe(false)
      expect(attributed(oldPartition.wc, KEPT)).toBe(false)
    })

    it('does not make a document of an origin the shell does not serve the app\'s', () => {
      const { attributed, register } = attributionRig()
      const tab = workerAnswered(attributed, register)
      tab.commit()

      expect(attributed(tab.wc, KEPT)).toBe(true) // a website at that origin, attributed as any website is: the report changed nothing
      served.add(KEPT)
      expect(attributed(tab.wc, KEPT)).toBe(false)
    })
  })

  it('denies a document the shell answered in a view that was not built as an app tab: a popup of a website page, say', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const tab = appTab(attributed, register, DEFAULT_SESSION, { flagged: false })
    tab.commit()

    expect(attributed(tab.wc, KEPT)).toBe(false)
  })

  it('never attributes a document in the app\'s old partition, with a record or without', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    expect(attributed(fakeWebContents(keptOldPartition).wc, KEPT)).toBe(false)

    const tab = appTab(attributed, register, keptOldPartition)
    tab.commit()
    expect(attributed(tab.wc, KEPT)).toBe(false)
  })

  it('never trusts a stale record: a document that leaves the default session without navigating is denied', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const tab = appTab(attributed, register, DEFAULT_SESSION)
    tab.commit()
    tab.wc.session = session.fromPartition('isolated-context')

    expect(attributed(tab.wc, KEPT)).toBe(false)
  })

  it('denies a document that committed before the shell served the app, until one the shell answered commits', () => {
    const { attributed, register } = attributionRig()
    const tab = appTab(attributed, register, DEFAULT_SESSION)
    tab.commit(false) // the first visit: an ordinary website, answered by the verifier
    served.add(KEPT) // Allow

    expect(attributed(tab.wc, KEPT)).toBe(false)

    tab.commit(true) // the reload the allowed app is entered with
    expect(attributed(tab.wc, KEPT)).toBe(true)
  })

  it('takes the answer once: a later commit that no response came for is not the shell\'s', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const made = fakeWebContents(DEFAULT_SESSION)
    register(made.wc)
    appTabContents.add(made.wc as never)
    made.start()
    noteMainFrameResponse(made.wc, `${KEPT}/`, true)
    made.commit(`${KEPT}/`)
    expect(attributed(made.wc, KEPT)).toBe(true)

    made.start() // a navigation answered from a cache: no response is seen
    made.commit(`${KEPT}/`)
    expect(attributed(made.wc, KEPT)).toBe(false)
  })

  it('stays attributed after the shell stops serving the app, until it next navigates', () => {
    served.add(KEPT)
    const { attributed, register } = attributionRig()
    const tab = appTab(attributed, register, DEFAULT_SESSION)
    tab.commit()

    served.delete(KEPT)
    expect(attributed(tab.wc, KEPT)).toBe(true)
  })

  it('attributes in the profile session of the app\'s tunnel entry, and not in the default session, as for a website', () => {
    served.add(KEPT)
    setSiteRoutes({ profileFor: (origin) => origin === KEPT ? 'nym' : undefined })
    const { attributed, register } = attributionRig()

    const inProfile = appTab(attributed, register, session.fromPartition(profilePartitionFor('nym', KEPT)))
    inProfile.commit()
    const inDefault = appTab(attributed, register, DEFAULT_SESSION)
    inDefault.commit()
    const inOld = appTab(attributed, register, keptOldPartition)
    inOld.commit()
    expect(attributed(inProfile.wc, KEPT)).toBe(true)
    expect(attributed(inDefault.wc, KEPT)).toBe(false)
    expect(attributed(inOld.wc, KEPT)).toBe(false)
  })

  it('follows the tunnel choice of the tab the document is in, as a website does', () => {
    served.add(KEPT)
    setSiteRoutes({ profileFor: () => undefined })
    setTabTunnelSource({ choiceOfContents: () => 'nym', kindShowing: () => undefined })
    const { attributed, register } = attributionRig()
    const inDefault = appTab(attributed, register, DEFAULT_SESSION)
    Object.assign(inDefault.wc, { id: 7 })
    inDefault.commit()
    const inProfile = appTab(attributed, register, session.fromPartition('persist:tunnel-profile'))
    Object.assign(inProfile.wc, { id: 7 })
    inProfile.commit()
    expect(attributed(inDefault.wc, KEPT)).toBe(false)
    expect(attributed(inProfile.wc, KEPT)).toBe(true)
    setTabTunnelSource(undefined)
  })
})

describe('senderAttributed -- a local file belongs in the session localPartitionFor names, checked live', () => {
  const FILE = 'file:///home/u/app/index.html'
  const SIBLING = 'file:///home/u/app/other.html'
  const sharedSession = session.fromPartition(LOCAL_FILES_PARTITION)
  const ownSession = session.fromPartition(`persist:local-${originHash(FILE)}`)
  let dir: string | undefined

  afterEach(() => {
    installLocalFileApps(undefined)
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  function record (...keys: string[]): void {
    dir = mkdtempSync(join(tmpdir(), 'orivon-attr-'))
    const apps = new LocalFileApps(join(dir, 'a.json'))
    for (const key of keys) apps.add(key)
    installLocalFileApps(apps)
  }

  it('attributes a file in the shared local session while it is not recorded, with or without a commit record', () => {
    const { attributed, register } = attributionRig()
    const { wc, commit } = fakeWebContents(sharedSession)

    expect(attributed(wc, FILE)).toBe(true)
    register(wc)
    commit(`${FILE}?q=1#top`)
    expect(attributed(wc, FILE)).toBe(true)
  })

  it('attributes a recorded file only in its own session: the shared one and the default are denied', () => {
    record(FILE)
    const { attributed } = attributionRig()

    expect(attributed(fakeWebContents(ownSession).wc, FILE)).toBe(true)
    expect(attributed(fakeWebContents(sharedSession).wc, FILE)).toBe(false)
    expect(attributed(fakeWebContents(DEFAULT_SESSION).wc, FILE)).toBe(false)
  })

  it('denies a file in the default session or in an app partition', () => {
    const { attributed } = attributionRig()

    for (const home of [DEFAULT_SESSION, appPartitionSession]) {
      expect(attributed(fakeWebContents(home).wc, FILE)).toBe(false)
    }
  })

  it('denies a recorded file\'s session for its sibling, which belongs in the shared one', () => {
    record(FILE)
    const { attributed } = attributionRig()

    expect(attributed(fakeWebContents(ownSession).wc, SIBLING)).toBe(false)
    expect(attributed(fakeWebContents(sharedSession).wc, SIBLING)).toBe(true)
  })

  it('follows the record live: a file whose record is gone is denied in the session it had', () => {
    record(FILE)
    const { attributed } = attributionRig()
    const { wc } = fakeWebContents(ownSession)
    expect(attributed(wc, FILE)).toBe(true)

    installLocalFileApps(undefined)

    expect(attributed(wc, FILE)).toBe(false)
  })
})

describe('senderAttributed -- a tab with a tunnel choice puts every website in the choice\'s profile', () => {
  const NYM = session.fromPartition('persist:tunnel-profile')

  function tunnelTab (initialSession: unknown, id = 7): { wc: FakeWebContents & { id: number }, commit: (url: string) => void } {
    const made = fakeWebContents(initialSession)
    return { wc: Object.assign(made.wc, { id }), commit: made.commit }
  }

  afterEach(() => { setSiteRoutes(undefined); setTabTunnelSource(undefined) })

  it('attributes a document in the profile the tab\'s choice calls for, and not one in the default session', () => {
    setSiteRoutes({ profileFor: () => undefined })
    setTabTunnelSource({ choiceOfContents: (id) => id === 7 ? 'nym' : undefined, kindShowing: () => undefined })
    const { attributed } = attributionRig()
    expect(attributed(tunnelTab(NYM).wc, OTHER)).toBe(true)
    expect(attributed(tunnelTab(DEFAULT_SESSION).wc, OTHER)).toBe(false)
  })

  it('attributes a document of a tab with no choice in the default session as it always did', () => {
    setSiteRoutes({ profileFor: () => undefined })
    setTabTunnelSource({ choiceOfContents: () => undefined, kindShowing: () => undefined })
    const { attributed } = attributionRig()
    expect(attributed(tunnelTab(DEFAULT_SESSION).wc, OTHER)).toBe(true)
    expect(attributed(tunnelTab(NYM).wc, OTHER)).toBe(false)
  })

  it('records the verdict at the commit with the choice the tab had then', () => {
    setSiteRoutes({ profileFor: () => undefined })
    setTabTunnelSource({ choiceOfContents: () => 'nym', kindShowing: () => undefined })
    const { attributed, register } = attributionRig()
    const { wc, commit } = tunnelTab(NYM)
    register(wc)
    commit(OTHER)
    expect(attributed(wc, OTHER)).toBe(true)
  })
})
