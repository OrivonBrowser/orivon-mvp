// The six window.ftElectron.db* members -- split out of ft-electron-bridge.js
// by code-guidelines.md Rule 2 (500-line source limit), NOT a second classic
// script: splice-bridge-source.mjs concatenates this file into the shell's
// single IIFE at its own `// #include` marker, so `FtBridgeError`,
// `REFUSAL_REASONS` and everything else the shell already declares stay
// reachable here exactly as if this were still inline.
//
// Every action name and value below is FreeTube's own DBActions
// (src/constants.js), copied rather than computed: this bridge has nothing
// to import it from (a classic script has no module graph), and it is a
// stable, versioned wire contract between FreeTube's renderer and its own
// main process -- the same reason DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$
// itself is a frozen upstream name, not ours to rename.
const DBActions = {
  GENERAL: { CREATE: 0, FIND: 1, UPSERT: 2, DELETE: 3, DELETE_MULTIPLE: 4, DELETE_ALL: 5, OVERWRITE: 6 },
  HISTORY: { UPDATE_WATCH_PROGRESS: 20, UPDATE_PLAYLIST: 21, UNSET_PLAYLIST_FOR_VIDEOS: 22, UNSET_PLAYLISTS: 23 },
  PROFILES: { ADD_CHANNEL: 20, REMOVE_CHANNEL: 21 },
  PLAYLISTS: { UPSERT_VIDEO: 20, UPSERT_VIDEOS: 21, DELETE_VIDEO_ID: 22, DELETE_VIDEO_IDS: 23, DELETE_ALL_VIDEOS: 24 },
  SUBSCRIPTION_CACHE: {
    UPDATE_VIDEOS_BY_CHANNEL: 20,
    UPDATE_LIVE_STREAMS_BY_CHANNEL: 21,
    UPDATE_SHORTS_BY_CHANNEL: 22,
    UPDATE_SHORTS_WITH_CHANNEL_PAGE_SHORTS_BY_CHANNEL: 23,
    UPDATE_COMMUNITY_POSTS_BY_CHANNEL: 24
  }
}

/**
 * The datastore bundle (webpack.orivon-datastore.config.cjs) exposes its
 * handlers on this global, loaded by its own <script> tag AFTER this
 * bridge's but BEFORE FreeTube's own (prepare.mjs) -- so this has to read
 * `globalThis.__orivonFtDatastore` freshly on every call, never capture it
 * once at bridge-install time, which runs before that script has.
 */
function datastore () {
  const found = globalThis.__orivonFtDatastore
  if (found === undefined) {
    throw new FtBridgeError(
      'db', 'not-built',
      'the FreeTube datastore bundle (/orivon/ft-datastore.js) has not loaded -- either this ' +
      'build was prepared without --build, or its own <script> tag has not run yet'
    )
  }
  return found
}

/**
 * ipcMain.handle(IpcChannels.DB_*) wraps its WHOLE switch in exactly this
 * try/catch, converting anything that is not already a string via
 * `err.toString()` before rethrowing -- an IPC-serialisation habit (a raw
 * Error does not survive the renderer/main boundary intact), reproduced
 * here for parity even though nothing here crosses that boundary, since a
 * FreeTube catch block downstream may already expect a string.
 */
async function withDbErrors (run) {
  try {
    return await run()
  } catch (error) {
    throw typeof error === 'string' ? error : error.toString()
  }
}

/**
 * dbSettings -- mirrors ipcMain.handle(IpcChannels.DB_SETTINGS). The
 * screenshotFolderPath guard is copied verbatim: real Electron reserves
 * that write for the CHOOSE_DEFAULT_FOLDER flow alone, so a page-supplied
 * upsert of it is silently refused (returns null, writes nothing) rather
 * than erroring, exactly matching upstream's own behaviour. The setting's
 * own menu/tray/theme side effects (setMenu(), tray visibility, native
 * theme) are Electron-shell state this bridge has no shell to update --
 * dropped the same way refusedApi() drops shell-owned members, not
 * reproduced as a no-op.
 */
function dbSettings (action, data) {
  const { settings } = datastore()
  return withDbErrors(async () => {
    switch (action) {
      case DBActions.GENERAL.FIND:
        return await settings.find()
      case DBActions.GENERAL.UPSERT:
        if (data._id === 'screenshotFolderPath') return null
        await settings.upsert(data._id, data.value)
        return null
      default:
        throw new Error('invalid settings db action')
    }
  })
}

/** dbHistory -- mirrors ipcMain.handle(IpcChannels.DB_HISTORY), minus the syncOtherWindows() calls after each write: those exist to keep a second open window's renderer in sync, and this bridge only ever has the one window FreeTube's chrome already assumes here. */
function dbHistory (action, data) {
  const { history } = datastore()
  return withDbErrors(async () => {
    switch (action) {
      case DBActions.GENERAL.FIND:
        return await history.find()
      case DBActions.GENERAL.UPSERT:
        await history.upsert(data)
        return null
      case DBActions.GENERAL.OVERWRITE:
        await history.overwrite(data)
        return null
      case DBActions.HISTORY.UPDATE_WATCH_PROGRESS:
        await history.updateWatchProgress(data.videoId, data.watchProgress)
        return null
      case DBActions.HISTORY.UPDATE_PLAYLIST:
        await history.updateLastViewedPlaylist(data.videoId, data.lastViewedPlaylistId, data.lastViewedPlaylistType, data.lastViewedPlaylistItemId)
        return null
      case DBActions.HISTORY.UNSET_PLAYLIST_FOR_VIDEOS:
        await history.unsetLastViewedPlaylistForVideos(data.videoIds, data.lastViewedPlaylistId)
        return null
      case DBActions.HISTORY.UNSET_PLAYLISTS:
        await history.unsetLastViewedPlaylists(data)
        return null
      case DBActions.GENERAL.DELETE:
        await history.delete(data)
        return null
      case DBActions.GENERAL.DELETE_ALL:
        await history.deleteAll()
        return null
      default:
        throw new Error('invalid history db action')
    }
  })
}

/** dbProfiles -- mirrors ipcMain.handle(IpcChannels.DB_PROFILES), same syncOtherWindows() drop as dbHistory. CREATE returns the created profile, matching upstream (the renderer uses the returned _id). */
function dbProfiles (action, data) {
  const { profiles } = datastore()
  return withDbErrors(async () => {
    switch (action) {
      case DBActions.GENERAL.CREATE:
        return await profiles.create(data)
      case DBActions.GENERAL.FIND:
        return await profiles.find()
      case DBActions.GENERAL.UPSERT:
        await profiles.upsert(data)
        return null
      case DBActions.PROFILES.ADD_CHANNEL:
        await profiles.addChannelToProfiles(data.channel, data.profileIds)
        return null
      case DBActions.PROFILES.REMOVE_CHANNEL:
        await profiles.removeChannelFromProfiles(data.channelId, data.profileIds)
        return null
      case DBActions.GENERAL.DELETE:
        await profiles.delete(data)
        return null
      default:
        throw new Error('invalid profile db action')
    }
  })
}

/** dbPlaylists -- mirrors ipcMain.handle(IpcChannels.DB_PLAYLISTS), same syncOtherWindows() drop. Upstream's own comment stands: most of these actions have no real caller yet, only FIND/CREATE/UPSERT do. */
function dbPlaylists (action, data) {
  const { playlists } = datastore()
  return withDbErrors(async () => {
    switch (action) {
      case DBActions.GENERAL.CREATE:
        await playlists.create(data)
        return null
      case DBActions.GENERAL.FIND:
        return await playlists.find()
      case DBActions.GENERAL.UPSERT:
        await playlists.upsert(data)
        return null
      case DBActions.PLAYLISTS.UPSERT_VIDEO:
        await playlists.upsertVideoByPlaylistId(data._id, data.lastUpdatedAt, data.videoData)
        return null
      case DBActions.PLAYLISTS.UPSERT_VIDEOS:
        await playlists.upsertVideosByPlaylistId(data._id, data.lastUpdatedAt, data.videos)
        return null
      case DBActions.GENERAL.DELETE:
        await playlists.delete(data)
        return null
      case DBActions.PLAYLISTS.DELETE_VIDEO_ID:
        await playlists.deleteVideoIdByPlaylistId(data._id, data.lastUpdatedAt, data.videoId, data.playlistItemId)
        return null
      case DBActions.PLAYLISTS.DELETE_VIDEO_IDS:
        await playlists.deleteVideoIdsByPlaylistId(data._id, data.lastUpdatedAt, data.playlistItemIds)
        return null
      case DBActions.PLAYLISTS.DELETE_ALL_VIDEOS:
        await playlists.deleteAllVideosByPlaylistId(data)
        return null
      case DBActions.GENERAL.DELETE_MULTIPLE:
        await playlists.deleteMultiple(data)
        return null
      case DBActions.GENERAL.DELETE_ALL:
        await playlists.deleteAll()
        return null
      default:
        throw new Error('invalid playlist db action')
    }
  })
}

/** dbSearchHistory -- mirrors ipcMain.handle(IpcChannels.DB_SEARCH_HISTORY), same syncOtherWindows() drop. */
function dbSearchHistory (action, data) {
  const { searchHistory } = datastore()
  return withDbErrors(async () => {
    switch (action) {
      case DBActions.GENERAL.FIND:
        return await searchHistory.find()
      case DBActions.GENERAL.UPSERT:
        await searchHistory.upsert(data)
        return null
      case DBActions.GENERAL.OVERWRITE:
        await searchHistory.overwrite(data)
        return null
      case DBActions.GENERAL.DELETE:
        await searchHistory.delete(data)
        return null
      case DBActions.GENERAL.DELETE_ALL:
        await searchHistory.deleteAll()
        return null
      default:
        throw new Error('invalid search history db action')
    }
  })
}

/** dbSubscriptionCache -- mirrors ipcMain.handle(IpcChannels.DB_SUBSCRIPTION_CACHE), same syncOtherWindows() drop. */
function dbSubscriptionCache (action, data) {
  const { subscriptionCache } = datastore()
  return withDbErrors(async () => {
    switch (action) {
      case DBActions.GENERAL.FIND:
        return await subscriptionCache.find()
      case DBActions.SUBSCRIPTION_CACHE.UPDATE_VIDEOS_BY_CHANNEL:
        await subscriptionCache.updateVideosByChannelId(data.channelId, data.entries, data.timestamp)
        return null
      case DBActions.SUBSCRIPTION_CACHE.UPDATE_LIVE_STREAMS_BY_CHANNEL:
        await subscriptionCache.updateLiveStreamsByChannelId(data.channelId, data.entries, data.timestamp)
        return null
      case DBActions.SUBSCRIPTION_CACHE.UPDATE_SHORTS_BY_CHANNEL:
        await subscriptionCache.updateShortsByChannelId(data.channelId, data.entries, data.timestamp)
        return null
      case DBActions.SUBSCRIPTION_CACHE.UPDATE_SHORTS_WITH_CHANNEL_PAGE_SHORTS_BY_CHANNEL:
        await subscriptionCache.updateShortsWithChannelPageShortsByChannelId(data.channelId, data.entries)
        return null
      case DBActions.SUBSCRIPTION_CACHE.UPDATE_COMMUNITY_POSTS_BY_CHANNEL:
        await subscriptionCache.updateCommunityPostsByChannelId(data.channelId, data.entries, data.timestamp)
        return null
      case DBActions.GENERAL.DELETE_MULTIPLE:
        await subscriptionCache.deleteMultipleChannels(data)
        return null
      case DBActions.GENERAL.DELETE_ALL:
        await subscriptionCache.deleteAll()
        return null
      default:
        throw new Error('invalid subscription cache db action')
    }
  })
}

function dbApi () {
  return { dbSettings, dbHistory, dbProfiles, dbPlaylists, dbSearchHistory, dbSubscriptionCache }
}
