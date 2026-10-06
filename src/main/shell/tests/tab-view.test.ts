import { describe, expect, it, vi } from 'vitest'
import { originFromUrl } from '../../../broker/policy/origin.js'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import { LOCAL_FILES_PARTITION } from '../../local-files/partition.js'

// tab-view.ts imports WebContentsView from 'electron' at module scope, so
// even these pure functions cannot be imported without mocking it first --
// same reasoning tabs.test.ts states for itself. makeTabView() below needs
// a webContents with a working `.on` -- watchAppTab()'s own reportAppFailures
// wiring calls it at construction, whatever additionalArguments it got.
vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: { webContents: unknown, setBackgroundColor: unknown }) {
    this.webContents = { on: vi.fn() }
    this.setBackgroundColor = vi.fn()
  })
}))

// The serve registry is a real module-level Set in the loader; mocking it
// here keeps these tests about the RULE rather than about registration.
const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { appTabArgsFor, appTabFlagChanged, captureTabPage, leftDashboard, makeTabView, partitionChanged, partitionForTarget, popupTargetIsApp } = await import('../tab-view.js')

const APP = 'https://app.example'
const SITE = 'https://news.example'
const OTHER_SITE = 'https://search.example'

/** A minimal Broker stub for appTabArgsFor/appTabFlagChanged/popupTargetIsApp. */
function brokerWith (opts: { registered?: string[], granted?: string[] }): Broker {
  return {
    app: {
      isRegisteredSync: (origin: string) => (opts.registered ?? []).includes(origin),
      hasGrantsSync: (origin: string) => (opts.granted ?? []).includes(origin)
    }
  } as unknown as Broker
}

const appPartition = partitionFor(originFromUrl(APP) as string)

describe('partitionForTarget -- ONLY a cache-served origin gets its own partition', () => {
  it('leaves an ordinary, ungranted website on the shared default session', () => {
    expect(partitionForTarget(SITE)).toBeUndefined()
  })

  it('does NOT isolate an origin merely because it is installed/registered', () => {
    // isRegisteredSync plays no part in partitionForTarget at all: it takes
    // no broker, so there is nothing here that could read a grant or a
    // registration either way.
    expect(partitionForTarget(APP)).toBeUndefined()
  })

  it('isolates an origin served from the pinned cache -- ADR-0007\'s protocol.handle is partition-scoped, so a served origin sitting on the default session could not load at all', () => {
    served.add(APP)
    try {
      expect(partitionForTarget(APP)).toBe(appPartition)
    } finally {
      served.delete(APP)
    }
  })

  it('has no partition for a target with no derivable origin', () => {
    expect(partitionForTarget('about:blank')).toBeUndefined()
  })

  it('leaves a chrome-extension: target on the default session, same as any other target with no derivable origin', () => {
    // The trusted path an extension-opened tab takes (tabs.ts's
    // openTrusted() relies on this: originFromUrl only derives http(s)
    // origins, so a chrome-extension: target never matches cache coverage
    // and always stays on session.defaultSession, where extensions load.
    expect(partitionForTarget('chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html')).toBeUndefined()
  })
})

// Unlike partitionForTarget above, a held grant DOES count here -- popups.ts's
// README.md Design notes has the reasoning (ADR-0044's own gap).
describe('popupTargetIsApp -- routePopup\'s own isApp: a held grant counts, unlike partitionForTarget', () => {
  it('is true for a granted origin, even with no partition of its own', () => {
    expect(popupTargetIsApp(APP, brokerWith({ granted: [APP] }))).toBe(true)
  })

  it('is true for a cache-served origin, granted or not', () => {
    served.add(APP)
    try {
      expect(popupTargetIsApp(APP, brokerWith({}))).toBe(true)
    } finally {
      served.delete(APP)
    }
  })

  it('is false for an ordinary, ungranted, non-cache-served origin', () => {
    expect(popupTargetIsApp(SITE, brokerWith({ granted: [APP] }))).toBe(false)
  })

  it('is false with no broker to ask, and for a target with no derivable origin', () => {
    expect(popupTargetIsApp(APP, undefined)).toBe(false)
    expect(popupTargetIsApp('about:blank', brokerWith({ granted: [APP] }))).toBe(false)
  })

  it('does NOT read isRegisteredSync -- a merely-registered, ungranted, non-cache-served app is not "an app" for this purpose', () => {
    expect(popupTargetIsApp(APP, brokerWith({ registered: [APP] }))).toBe(false)
  })
})

describe('partitionChanged -- when a navigation must swap the view', () => {
  it('does not swap between two ordinary, ungranted websites, which is what keeps back/forward alive (A109)', () => {
    expect(partitionChanged(OTHER_SITE, undefined)).toBeUndefined()
  })

  it('does not swap for a same-origin navigation inside a cache-served app', () => {
    served.add(APP)
    try {
      expect(partitionChanged(`${APP}/other`, appPartition)).toBeUndefined()
    } finally {
      served.delete(APP)
    }
  })

  it('swaps an ordinary tab into a cache-served origin\'s own partition when it reaches one', () => {
    served.add(APP)
    try {
      expect(partitionChanged(APP, undefined)).toEqual({ to: appPartition })
    } finally {
      served.delete(APP)
    }
  })

  it('swaps a tab back OUT to the default session when it leaves a cache-served origin for an ordinary website', () => {
    // Without this the ordinary site would keep running inside the app's
    // isolated session -- its cookies, its storage, and whatever the cache
    // partition holds.
    expect(partitionChanged(SITE, appPartition)).toEqual({ to: undefined })
  })

  it('swaps straight from one cache-served partition to another', () => {
    const second = 'https://other-app.example'
    served.add(second)
    try {
      expect(partitionChanged(second, appPartition)).toEqual({ to: partitionFor(originFromUrl(second) as string) })
    } finally {
      served.delete(second)
    }
  })

  it('never swaps two GRANTED, network-served origins -- they now share the default session, and a grant alone is never a reason to move', () => {
    // The rule this file exists to prove: a held grant alone no longer gives
    // an origin its own partition. Chrome extensions load into
    // session.defaultSession and must run as one instance on every page,
    // granted or not, so a granted app shares that session too --
    // partitionChanged has no broker to even ask, and two granted origins
    // produce no swap between them.
    expect(partitionChanged(APP, undefined)).toBeUndefined()
    expect(partitionChanged(SITE, undefined)).toBeUndefined()
  })

  it('never swaps for a target with no derivable origin, whatever the tab is in', () => {
    expect(partitionChanged('about:blank', appPartition)).toBeUndefined()
    expect(partitionChanged('about:blank', undefined)).toBeUndefined()
  })
})

// isRegisteredSync (the app-tab flag) is a REGISTRATION question, entirely
// unaffected by this rule: a registered-but-not-cache-served app still
// shares the default session with every ordinary site, and the flag can
// change independently of any partition swap (there being none to make).
describe('appTabFlagChanged -- a registered app and an ordinary site can share a session while disagreeing on the flag', () => {
  const registeredApp = brokerWith({ registered: [APP] })

  it('needs a rebuild leaving such an app for an ordinary site', () => {
    const view = makeTabView('preload.js', undefined, appTabArgsFor(APP, registeredApp))
    expect(appTabFlagChanged(SITE, view, registeredApp)).toBe(true)
  })

  it('needs a rebuild entering such an app from an ordinary site', () => {
    const view = makeTabView('preload.js', undefined, appTabArgsFor(SITE, registeredApp))
    expect(appTabFlagChanged(APP, view, registeredApp)).toBe(true)
  })

  it('does not need one between two ordinary sites', () => {
    const view = makeTabView('preload.js', undefined, appTabArgsFor(SITE, registeredApp))
    expect(appTabFlagChanged(OTHER_SITE, view, registeredApp)).toBe(false)
  })

  it('never reads as a flag change for a target with no derivable origin', () => {
    const view = makeTabView('preload.js', undefined, appTabArgsFor(APP, registeredApp))
    expect(appTabFlagChanged('about:blank', view, registeredApp)).toBe(false)
  })
})

// createTab() (tabs.ts) attaches a tab's view to screen BEFORE loadURL, so
// whatever this view's background defaults to (Electron: opaque white) is
// what actually paints first. Only the shell's own pages get a background
// here -- see makeTabView's own doc.
describe('makeTabView: an explicit backgroundColor is set on the view before it is ever shown', () => {
  it('sets it when the caller passes one (the dashboard / an internal page)', () => {
    const view = makeTabView('preload.js', undefined, undefined, { backgroundColor: '#0d0e14' })
    expect((view as unknown as { setBackgroundColor: (c: string) => void }).setBackgroundColor).toHaveBeenCalledWith('#0d0e14')
  })

  it('leaves an ordinary tab (no colour passed) at Electron\'s own default', () => {
    const view = makeTabView('preload.js', undefined, undefined)
    expect((view as unknown as { setBackgroundColor: (c: string) => void }).setBackgroundColor).not.toHaveBeenCalled()
  })
})

describe('captureTabPage', () => {
  it('captures a page without making it visible, so a page behind the one in front stays hidden', async () => {
    const image = { isEmpty: () => true }
    const capturePage = vi.fn().mockResolvedValue(image)
    expect(await captureTabPage({ capturePage } as never)).toBe(image)
    expect(capturePage).toHaveBeenCalledExactlyOnceWith(undefined, { stayHidden: true })
  })

  it('is null for no page, and for a capture that throws', async () => {
    expect(await captureTabPage(undefined)).toBeNull()
    expect(await captureTabPage({ capturePage: vi.fn().mockRejectedValue(new Error('gone')) } as never)).toBeNull()
  })
})

describe('a local file runs in the local-files session', () => {
  const FILE = 'file:///home/u/app/index.html'

  it('partitionForTarget puts any local file there, query and fragment included', () => {
    expect(partitionForTarget(FILE)).toBe(LOCAL_FILES_PARTITION)
    expect(partitionForTarget(`${FILE}?q=1#top`)).toBe(LOCAL_FILES_PARTITION)
  })

  it('partitionForTarget leaves a file with a host to the default session, where the guard serves it nothing', () => {
    expect(partitionForTarget('file://server/share/a.html')).toBeUndefined()
  })

  it('partitionChanged moves a default-session tab onto a file and back out onto a website', () => {
    expect(partitionChanged(FILE, undefined)).toEqual({ to: LOCAL_FILES_PARTITION })
    expect(partitionChanged(SITE, LOCAL_FILES_PARTITION)).toEqual({ to: undefined })
  })

  it('partitionChanged keeps a tab that goes from one local file to another', () => {
    expect(partitionChanged('file:///home/u/app/other.html', LOCAL_FILES_PARTITION)).toBeUndefined()
  })

  it('partitionChanged moves a tab from an app\'s partition onto a file', () => {
    expect(partitionChanged(FILE, appPartition)).toEqual({ to: LOCAL_FILES_PARTITION })
  })

  it('a local file is never an app tab', () => {
    expect(appTabArgsFor(FILE, brokerWith({ registered: [FILE] }))).toBeUndefined()
  })
})

describe('leftDashboard -- which committed document still counts as the new-tab page', () => {
  const BUILT = 'file:///opt/orivon/out/renderer/newtab/index.html'
  const DEV = 'http://localhost:5173/newtab/'

  it('keeps the flag on the dashboard itself, whatever query or fragment it carries', () => {
    expect(leftDashboard(BUILT, BUILT)).toBe(false)
    expect(leftDashboard(`${BUILT}#top`, BUILT)).toBe(false)
    expect(leftDashboard(DEV, DEV)).toBe(false)
  })

  it('clears it for any other local file, which a built dashboard and every file share a web origin of null with', () => {
    expect(leftDashboard('file:///home/u/app/index.html', BUILT)).toBe(true)
    expect(leftDashboard('file:///opt/orivon/out/renderer/index.html', BUILT)).toBe(true)
  })

  it('clears it for a website and for a blank page', () => {
    expect(leftDashboard(SITE, BUILT)).toBe(true)
    expect(leftDashboard(SITE, DEV)).toBe(true)
    expect(leftDashboard('about:blank', BUILT)).toBe(true)
  })
})
