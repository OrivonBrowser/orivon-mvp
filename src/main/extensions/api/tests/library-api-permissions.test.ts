import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// Drives the REAL ExtensionRouter with the REAL bookmarks, history, topSites and search modules, the way
// notifications-permission.test.ts does for the library's own API: a handler runs only for an extension
// whose permission is held, and the namespace's events are gated by the same permission.
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn() }, session: { defaultSession: { extensions: { getExtension: () => null } } } }))

const { ExtensionRouter, setPermissionCheck } = await import('../../../../../vendor/electron-chrome-extensions/src/browser/router.js')
const { installExtensionApis } = await import('../api-context.js')
const { createExtensionPrefsStore } = await import('../../extension-prefs-runner.js')
const { bookmarksApi } = await import('../bookmarks-api.js')
const { historyApi, topSitesApi } = await import('../history-api.js')
const { searchApi } = await import('../search-api.js')
const { eventListenerFilter } = await import('../../extension-event-filter.js')
const { installPermissionCheck } = await import('../../extension-permission-check.js')

const HOLDER = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

const CASES: Array<[string, string, unknown[]]> = [
  ['bookmarks', 'bookmarks.getTree', []],
  ['bookmarks', 'bookmarks.create', [{ title: 'x', url: 'https://x.test/' }]],
  ['history', 'history.search', [{ text: '' }]],
  ['history', 'history.deleteAll', []],
  ['topSites', 'topSites.get', []],
  ['search', 'search.query', [{ text: 'x', disposition: 'NEW_TAB' }]]
]

function setup () {
  const held = new Set([`${HOLDER}:bookmarks`, `${HOLDER}:history`, `${HOLDER}:topSites`, `${HOLDER}:search`])
  const extensions = new Map([[HOLDER, { id: HOLDER, manifest: {} }], [OTHER, { id: OTHER, manifest: {} }]])
  const session = {
    extensions: { on: vi.fn(), getExtension: (id: string) => extensions.get(id) ?? null },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
  const router = new ExtensionRouter(session)
  setPermissionCheck((id: string, permission: string) => held.has(`${id}:${permission}`))
  const store = {
    load: async () => {}, onChange: () => () => {}, children: () => [], node: () => undefined, path: () => [],
    addUrl: () => null, addFolder: () => null, update: () => false, move: () => false, remove: () => 0, count: () => 0
  }
  const shell = {
    bookmarks: store,
    history: { list: () => [], listOrdered: () => [], visit: () => {}, remove: () => {}, removeMany: () => {}, removeRange: () => {}, clear: () => {}, onChange: () => () => {} },
    settings: { get: () => '' },
    windows: { focused: () => ({ tabs: { createTab: vi.fn(), navigate: vi.fn() } }) },
    commands: { openWindow: vi.fn() },
    internalPages: { pageOf: () => undefined }
  }
  installExtensionApis({
    host: { getRouter: () => router } as never,
    session,
    userDataPath: '/data',
    shell: () => shell as never,
    extensions: () => undefined,
    prefs: createExtensionPrefsStore(null),
    held: () => true,
    isAppOrigin: () => false,
    webContentsFromId: () => undefined
  }, [bookmarksApi, historyApi, topSitesApi, searchApi])
  const frame = (id: string) => ({ type: 'frame', sender: { session }, senderFrame: { url: `chrome-extension://${id}/p.html`, origin: `chrome-extension://${id}` } })
  return { router, frame }
}

describe('library namespaces: the permission', () => {
  for (const [permission, handler, args] of CASES) {
    it(`${handler} requires an extension with ${permission} permissions`, async () => {
      const { router, frame } = setup()
      await expect(router.onExtensionMessage(frame(OTHER) as never, OTHER, handler, ...args)).rejects.toThrow(`requires an extension with ${permission} permissions`)
    })

    it(`${handler} runs for an extension holding ${permission}`, async () => {
      const { router, frame } = setup()
      let reached = true
      try { await router.onExtensionMessage(frame(HOLDER) as never, HOLDER, handler, ...args) } catch (error) {
        reached = !/requires an extension with/.test(String((error as Error).message))
      }
      expect(reached).toBe(true)
    })
  }
})

describe('library namespaces: the events', () => {
  it('reach only an extension that holds the permission', () => {
    installPermissionCheck({
      stripped: () => [],
      manifestPermissions: (id) => (id === HOLDER ? ['bookmarks', 'history'] : []),
      prefs: createExtensionPrefsStore(null)
    }, () => {})
    for (const name of ['bookmarks.onCreated', 'history.onVisited']) {
      expect(eventListenerFilter(HOLDER, name, [1])).toEqual([1])
      expect(eventListenerFilter(OTHER, name, [1])).toBeUndefined()
    }
  })

  it('are gated once a module registers its namespace', () => {
    setup()
    expect(eventListenerFilter(OTHER, 'history.onVisitRemoved', [{}])).toBeUndefined()
  })
})
