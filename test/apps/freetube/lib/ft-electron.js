// FreeTube's renderer never imports Node or Electron. Everything privileged
// reaches it through one bridge its preload exposes as `window.ftElectron`.
// This file is that bridge, rebuilt over `orivon.*` -- the porting artifact,
// and the reason this app is shaped the way it is: a real FreeTube renderer
// dropped in later talks to this object and needs no edit of its own.
//
// A handler this platform cannot honour REFUSES BY NAME with a reason,
// never by being absent. An absent method reaches the caller as
// `undefined is not a function`, which says nothing about whether the gap is
// unbuilt, excluded by decision, or simply never considered.

import { COLLECTION_NAMES, openCollections } from './store.js'

/** Why a bridge member does not work, kept a closed set so a caller can branch on it. */
const REFUSAL_REASONS = {
  excluded: 'excluded from Orivon by decision',
  'shell-owned': 'the browser owns this, not the app',
  'not-built': 'not built in this port'
}

export class FtBridgeError extends Error {
  constructor (member, reason, detail) {
    super(`ftElectron.${member} is unavailable: ${REFUSAL_REASONS[reason]}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'FtBridgeError'
    this.member = member
    this.reason = reason
  }
}

function refuse (member, reason, detail) {
  return () => { throw new FtBridgeError(member, reason, detail) }
}

/**
 * Storage. FreeTube's seven `DB_*` channels are one shape repeated per
 * collection, so they are generated rather than written out seven times.
 */
function databaseApi (collections) {
  const api = {}
  for (const name of COLLECTION_NAMES) {
    api[name] = {
      find: (query) => collections[name].find(query),
      findOne: (query) => collections[name].findOne(query),
      create: (document) => collections[name].insert(document),
      upsert: (document) => collections[name].upsert(document),
      delete: (query) => collections[name].remove(query),
      deleteAll: () => collections[name].clear(),
      persistent: () => collections[name].persistent
    }
  }
  return api
}

/**
 * The player cache FreeTube keeps between a search result and the watch
 * page. Memory-only on purpose: it holds stream URLs that expire in hours,
 * so persisting it would spend the app's disk quota on entries that are
 * already stale by the next launch.
 */
function playerCacheApi () {
  const cache = new Map()
  return {
    get: (key) => cache.get(key),
    set: (key, value) => { cache.set(key, value) },
    clear: () => { cache.clear() }
  }
}

/**
 * The group the reconnaissance found needs no capability at all: every one
 * of these is a web platform API that already works inside an app tab.
 */
function windowApi () {
  let wakeLock
  return {
    async requestFullscreen (element) {
      await (element ?? document.documentElement).requestFullscreen()
    },
    async exitFullscreen () {
      if (document.fullscreenElement !== null) await document.exitFullscreen()
    },
    async requestPictureInPicture (video) {
      return await video.requestPictureInPicture()
    },
    async setPreventSleep (prevent) {
      if (!('wakeLock' in navigator)) return false
      if (!prevent) {
        await wakeLock?.release()
        wakeLock = undefined
        return false
      }
      wakeLock = await navigator.wakeLock.request('screen')
      return true
    },
    getSystemLocale: () => navigator.language,
    getZoomFactor: () => Number(document.documentElement.style.zoom || '1'),
    setZoomFactor: (factor) => { document.documentElement.style.zoom = String(factor) }
  }
}

/**
 * Downloads, over the one route out of the app's own directory. A picked
 * folder is the consent; there is no separate grant to request.
 */
function downloadApi (fs) {
  return {
    async chooseDefaultFolder () {
      if (fs === undefined) return null
      return await fs.userSelected({ directory: true })
    },
    async writeToFolder (folder, name, bytes) {
      if (folder === null || folder === undefined) throw new FtBridgeError('writeToFolder', 'not-built', 'no folder has been chosen')
      await folder.writeFile(name, bytes)
    }
  }
}

/**
 * Members this port does not answer, each with the reason that applies to
 * it. `generatePoToken` is the one that decides whether most videos play at
 * all: YouTube's bot-guard wants a token produced by running its own script,
 * and this app has nowhere to run it. See README.md's Design notes.
 */
function refusedApi () {
  return {
    openInExternalPlayer: refuse('openInExternalPlayer', 'excluded', 'subprocess is cut from v0'),
    enableProxy: refuse('enableProxy', 'shell-owned', 'proxy configuration is browser-level'),
    disableProxy: refuse('disableProxy', 'shell-owned', 'proxy configuration is browser-level'),
    relaunch: refuse('relaunch', 'shell-owned'),
    openNewWindow: refuse('openNewWindow', 'shell-owned'),
    setWindowTitle: refuse('setWindowTitle', 'shell-owned'),
    setHardwareAcceleration: refuse('setHardwareAcceleration', 'shell-owned'),
    generatePoToken: refuse('generatePoToken', 'not-built', 'needs a sandbox to run YouTube\'s bot-guard script')
  }
}

/**
 * Builds the bridge and installs it as `window.ftElectron`. `fs` is the
 * app's own `orivon.fs`, or undefined when the filesystem grant was
 * refused -- in which case every collection runs in memory and says so
 * through `persistent()`, rather than throwing at the first write.
 */
export function installFtElectron (orivon, platform) {
  const fs = platform.canPersist ? orivon?.fs : undefined
  const collections = openCollections(fs)
  const bridge = {
    platform: {
      runtime: platform.runtime,
      routedFetch: platform.routedFetch,
      persistent: fs !== undefined,
      manifest: () => orivon?.app.manifest(),
      grants: () => orivon?.app.grants()
    },
    db: databaseApi(collections),
    playerCache: playerCacheApi(),
    window: windowApi(),
    download: downloadApi(fs),
    ...refusedApi()
  }
  if (typeof globalThis === 'object') globalThis.ftElectron = bridge
  return { bridge, collections }
}
