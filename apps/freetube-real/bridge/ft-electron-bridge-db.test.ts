// Unit coverage for the six window.ftElectron.db* members
// ft-electron-bridge-db.js installs -- one action per row in FreeTube's own
// ipcMain.handle(IpcChannels.DB_*) switch (src/main/index.js), read
// directly rather than guessed. Split from ft-electron-bridge.test.ts the
// same way the source itself is (code-guidelines.md Rule 2) -- see
// ft-electron-bridge.test-helpers.ts for the shared vm-sandbox harness.
import { describe, expect, it, vi } from 'vitest'
import { freshBridge, internals } from './ft-electron-bridge.test-helpers.js'

/** A fake `globalThis.__orivonFtDatastore` -- vi.fn() per method, each resolving to a tag naming which method answered, so a test can assert both the wiring (right method, right arguments) and the return value passing straight through. */
function fakeDatastore () {
  const group = (methods: readonly string[]): Record<string, ReturnType<typeof vi.fn>> => {
    const out: Record<string, ReturnType<typeof vi.fn>> = {}
    for (const name of methods) out[name] = vi.fn(async () => `${name}-result`)
    return out
  }
  return {
    settings: group(['find', 'upsert']),
    history: group(['find', 'upsert', 'overwrite', 'updateWatchProgress', 'updateLastViewedPlaylist', 'unsetLastViewedPlaylistForVideos', 'unsetLastViewedPlaylists', 'delete', 'deleteAll']),
    profiles: group(['create', 'find', 'upsert', 'addChannelToProfiles', 'removeChannelFromProfiles', 'delete']),
    playlists: group(['create', 'find', 'upsert', 'upsertVideoByPlaylistId', 'upsertVideosByPlaylistId', 'delete', 'deleteVideoIdByPlaylistId', 'deleteVideoIdsByPlaylistId', 'deleteAllVideosByPlaylistId', 'deleteMultiple', 'deleteAll']),
    searchHistory: group(['find', 'upsert', 'overwrite', 'delete', 'deleteAll']),
    subscriptionCache: group(['find', 'updateVideosByChannelId', 'updateLiveStreamsByChannelId', 'updateShortsByChannelId', 'updateShortsWithChannelPageShortsByChannelId', 'updateCommunityPostsByChannelId', 'deleteMultipleChannels', 'deleteAll'])
  }
}

/**
 * Installs `datastore` where the bridge actually looks for it: the vm
 * SANDBOX's own `globalThis`, set AFTER freshBridge() returns (datastore()
 * in ft-electron-bridge-db.js reads it lazily, at call time, matching the
 * real build where ft-datastore.js's <script> tag runs after the bridge's
 * own top-level code already has -- see ft-datastore-entry.js). Inside a vm
 * context created by `vm.createContext(sandbox)`, `globalThis` IS that
 * sandbox object, not the real outer Node process's -- so this is not the
 * same global every other describe block below implicitly avoids touching,
 * and each test's own freshBridge() call already gets a brand new one.
 */
function withDatastore (datastore: ReturnType<typeof fakeDatastore>) {
  const { bridge, sandbox } = freshBridge({ orivon: {} })
  sandbox.__orivonFtDatastore = datastore
  return { bridge, DBActions: internals(sandbox).DBActions }
}

describe('db* group: no datastore bundle loaded', () => {
  it('every db* member refuses by name, synchronously, rather than throwing a bare TypeError', () => {
    // Synchronous on purpose: datastore() runs before withDbErrors() wraps
    // anything in a promise (see ft-electron-bridge-db.js's own comment on
    // each dbX function), the same convention refusedApi()'s refuse() uses
    // elsewhere in this bridge -- so this is a plain try/catch, not
    // `.rejects`, which expects a promise it would never receive here.
    const { bridge } = freshBridge({ orivon: {} })
    for (const member of ['dbSettings', 'dbHistory', 'dbProfiles', 'dbPlaylists', 'dbSearchHistory', 'dbSubscriptionCache'] as const) {
      let caught: unknown
      try {
        (bridge[member] as (a: number) => unknown)(1)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ name: 'FtBridgeError', reason: 'not-built' })
    }
  })
})

describe('dbSettings', () => {
  it('FIND calls settings.find() and returns its result', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await expect(bridge.dbSettings(DBActions.GENERAL.FIND)).resolves.toBe('find-result')
    expect(datastore.settings.find).toHaveBeenCalledTimes(1)
  })

  it('UPSERT calls settings.upsert(_id, value) and returns null', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await expect(bridge.dbSettings(DBActions.GENERAL.UPSERT, { _id: 'theme', value: 'dark' })).resolves.toBeNull()
    expect(datastore.settings.upsert).toHaveBeenCalledWith('theme', 'dark')
  })

  it('UPSERT of screenshotFolderPath is silently refused, matching CHOOSE_DEFAULT_FOLDER-only real Electron guard', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await expect(bridge.dbSettings(DBActions.GENERAL.UPSERT, { _id: 'screenshotFolderPath', value: '/tmp/evil' })).resolves.toBeNull()
    expect(datastore.settings.upsert).not.toHaveBeenCalled()
  })

  it('an unknown action rejects with the same message upstream throws', async () => {
    const { bridge } = withDatastore(fakeDatastore())
    await expect(bridge.dbSettings(999)).rejects.toBe('Error: invalid settings db action')
  })

  it('a thrown non-string error is stringified before rejecting, matching ipcMain.handle\'s own err.toString()', async () => {
    const datastore = fakeDatastore()
    datastore.settings.find.mockRejectedValueOnce(new Error('disk full'))
    const { bridge, DBActions } = withDatastore(datastore)
    await expect(bridge.dbSettings(DBActions.GENERAL.FIND)).rejects.toBe('Error: disk full')
  })
})

describe('dbHistory', () => {
  it.each([
    ['FIND', [], 'find', []],
    ['UPSERT', [{ videoId: 'a' }], 'upsert', [{ videoId: 'a' }]],
    ['OVERWRITE', [[{ videoId: 'a' }]], 'overwrite', [[{ videoId: 'a' }]]],
    ['UPDATE_WATCH_PROGRESS', [{ videoId: 'a', watchProgress: 5 }], 'updateWatchProgress', ['a', 5]],
    ['UPDATE_PLAYLIST', [{ videoId: 'a', lastViewedPlaylistId: 'p', lastViewedPlaylistType: 'user', lastViewedPlaylistItemId: 'i' }], 'updateLastViewedPlaylist', ['a', 'p', 'user', 'i']],
    ['UNSET_PLAYLIST_FOR_VIDEOS', [{ videoIds: ['a'], lastViewedPlaylistId: 'p' }], 'unsetLastViewedPlaylistForVideos', [['a'], 'p']],
    ['UNSET_PLAYLISTS', [['p']], 'unsetLastViewedPlaylists', [['p']]],
    ['DELETE', ['a'], 'delete', ['a']],
    ['DELETE_ALL', [], 'deleteAll', []]
  ] as const)('%s dispatches to the matching history method', async (actionName, dataArgs, method) => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    const [data] = dataArgs
    await bridge.dbHistory((DBActions.HISTORY as Record<string, number>)[actionName] ?? (DBActions.GENERAL as Record<string, number>)[actionName], data)
    expect(datastore.history[method]).toHaveBeenCalledTimes(1)
  })

  it('an unknown action rejects with the same message upstream throws', async () => {
    const { bridge } = withDatastore(fakeDatastore())
    await expect(bridge.dbHistory(999)).rejects.toBe('Error: invalid history db action')
  })
})

describe('dbProfiles', () => {
  it('CREATE returns the created profile (not null), matching upstream', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await expect(bridge.dbProfiles(DBActions.GENERAL.CREATE, { name: 'x' })).resolves.toBe('create-result')
    expect(datastore.profiles.create).toHaveBeenCalledWith({ name: 'x' })
  })

  it.each([
    ['FIND', undefined, 'find', []],
    ['UPSERT', { _id: 'p1' }, 'upsert', [{ _id: 'p1' }]],
    ['ADD_CHANNEL', { channel: 'c', profileIds: ['p1'] }, 'addChannelToProfiles', ['c', ['p1']]],
    ['REMOVE_CHANNEL', { channelId: 'c', profileIds: ['p1'] }, 'removeChannelFromProfiles', ['c', ['p1']]],
    ['DELETE', 'p1', 'delete', ['p1']]
  ] as const)('%s dispatches to the matching profiles method with the expected arguments', async (actionName, data, method, expectedArgs) => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    const action = (DBActions.PROFILES as Record<string, number>)[actionName] ?? (DBActions.GENERAL as Record<string, number>)[actionName]
    await bridge.dbProfiles(action, data)
    expect(datastore.profiles[method]).toHaveBeenCalledWith(...expectedArgs)
  })

  it('an unknown action rejects with the same message upstream throws', async () => {
    const { bridge } = withDatastore(fakeDatastore())
    await expect(bridge.dbProfiles(999)).rejects.toBe('Error: invalid profile db action')
  })
})

describe('dbPlaylists', () => {
  it.each([
    ['CREATE', [{ _id: 'pl' }], 'create', [{ _id: 'pl' }]],
    ['FIND', [undefined], 'find', []],
    ['UPSERT', [{ _id: 'pl' }], 'upsert', [{ _id: 'pl' }]],
    ['UPSERT_VIDEO', [{ _id: 'pl', lastUpdatedAt: 1, videoData: { videoId: 'v' } }], 'upsertVideoByPlaylistId', ['pl', 1, { videoId: 'v' }]],
    ['UPSERT_VIDEOS', [{ _id: 'pl', lastUpdatedAt: 1, videos: [{ videoId: 'v' }] }], 'upsertVideosByPlaylistId', ['pl', 1, [{ videoId: 'v' }]]],
    ['DELETE', ['pl'], 'delete', ['pl']],
    ['DELETE_VIDEO_ID', [{ _id: 'pl', lastUpdatedAt: 1, videoId: 'v', playlistItemId: 'i' }], 'deleteVideoIdByPlaylistId', ['pl', 1, 'v', 'i']],
    ['DELETE_VIDEO_IDS', [{ _id: 'pl', lastUpdatedAt: 1, playlistItemIds: ['i'] }], 'deleteVideoIdsByPlaylistId', ['pl', 1, ['i']]],
    ['DELETE_ALL_VIDEOS', ['pl'], 'deleteAllVideosByPlaylistId', ['pl']],
    ['DELETE_MULTIPLE', [['pl']], 'deleteMultiple', [['pl']]],
    ['DELETE_ALL', [undefined], 'deleteAll', []]
  ] as const)('%s dispatches to the matching playlists method with the expected arguments', async (actionName, dataArgs, method, expectedArgs) => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    const action = (DBActions.PLAYLISTS as Record<string, number>)[actionName] ?? (DBActions.GENERAL as Record<string, number>)[actionName]
    await bridge.dbPlaylists(action, dataArgs[0])
    expect(datastore.playlists[method]).toHaveBeenCalledWith(...expectedArgs)
  })

  it('an unknown action rejects with the same message upstream throws', async () => {
    const { bridge } = withDatastore(fakeDatastore())
    await expect(bridge.dbPlaylists(999)).rejects.toBe('Error: invalid playlist db action')
  })
})

describe('dbSearchHistory', () => {
  it.each([
    ['FIND', undefined, 'find', []],
    ['UPSERT', { _id: 'q' }, 'upsert', [{ _id: 'q' }]],
    ['OVERWRITE', [{ _id: 'q' }], 'overwrite', [[{ _id: 'q' }]]],
    ['DELETE', 'q', 'delete', ['q']],
    ['DELETE_ALL', undefined, 'deleteAll', []]
  ] as const)('%s dispatches to the matching searchHistory method', async (actionName, data, method, expectedArgs) => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await bridge.dbSearchHistory((DBActions.GENERAL as Record<string, number>)[actionName], data)
    expect(datastore.searchHistory[method]).toHaveBeenCalledWith(...expectedArgs)
  })

  it('an unknown action rejects with the same message upstream throws', async () => {
    const { bridge } = withDatastore(fakeDatastore())
    await expect(bridge.dbSearchHistory(999)).rejects.toBe('Error: invalid search history db action')
  })
})

describe('dbSubscriptionCache', () => {
  it('FIND dispatches to subscriptionCache.find()', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await bridge.dbSubscriptionCache(DBActions.GENERAL.FIND)
    expect(datastore.subscriptionCache.find).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['UPDATE_VIDEOS_BY_CHANNEL', { channelId: 'c', entries: [1], timestamp: 2 }, 'updateVideosByChannelId', ['c', [1], 2]],
    ['UPDATE_LIVE_STREAMS_BY_CHANNEL', { channelId: 'c', entries: [1], timestamp: 2 }, 'updateLiveStreamsByChannelId', ['c', [1], 2]],
    ['UPDATE_SHORTS_BY_CHANNEL', { channelId: 'c', entries: [1], timestamp: 2 }, 'updateShortsByChannelId', ['c', [1], 2]],
    ['UPDATE_SHORTS_WITH_CHANNEL_PAGE_SHORTS_BY_CHANNEL', { channelId: 'c', entries: [1] }, 'updateShortsWithChannelPageShortsByChannelId', ['c', [1]]],
    ['UPDATE_COMMUNITY_POSTS_BY_CHANNEL', { channelId: 'c', entries: [1], timestamp: 2 }, 'updateCommunityPostsByChannelId', ['c', [1], 2]]
  ] as const)('%s dispatches to the matching subscriptionCache method', async (actionName, data, method, expectedArgs) => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await bridge.dbSubscriptionCache((DBActions.SUBSCRIPTION_CACHE as Record<string, number>)[actionName], data)
    expect(datastore.subscriptionCache[method]).toHaveBeenCalledWith(...expectedArgs)
  })

  it('DELETE_MULTIPLE dispatches to subscriptionCache.deleteMultipleChannels', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await bridge.dbSubscriptionCache(DBActions.GENERAL.DELETE_MULTIPLE, ['c1'])
    expect(datastore.subscriptionCache.deleteMultipleChannels).toHaveBeenCalledWith(['c1'])
  })

  it('DELETE_ALL dispatches to subscriptionCache.deleteAll', async () => {
    const datastore = fakeDatastore()
    const { bridge, DBActions } = withDatastore(datastore)
    await bridge.dbSubscriptionCache(DBActions.GENERAL.DELETE_ALL)
    expect(datastore.subscriptionCache.deleteAll).toHaveBeenCalledTimes(1)
  })

  it('an unknown action rejects with the same message upstream throws', async () => {
    const { bridge } = withDatastore(fakeDatastore())
    await expect(bridge.dbSubscriptionCache(999)).rejects.toBe('Error: invalid subscription cache db action')
  })
})
