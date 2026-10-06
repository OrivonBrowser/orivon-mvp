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

function fakeWebContents (initialSession: unknown): { wc: FakeWebContents, commit: (url: string) => void } {
  let didNavigate: ((event: unknown, url: string) => void) | undefined
  const wc: FakeWebContents = {
    session: initialSession,
    on: (name, listener) => { if (name === 'did-navigate') didNavigate = listener }
  }
  return { wc, commit: (url) => didNavigate?.(undefined, url) }
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
