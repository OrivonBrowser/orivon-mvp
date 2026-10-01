// Describes the chrome.* surface of whichever context loads it: the service
// worker, page.html and the content script share this one file, so the three
// reports are produced the same way. Each namespace is `{ type }` when absent
// or `{ type, members }` where a member is its typeof, or 'event' for
// something with addListener.
(function (root) {
  const NAMESPACES = [
    'action', 'alarms', 'bookmarks', 'browsingData', 'clipboard', 'commands', 'contentSettings', 'contextMenus',
    'cookies', 'debugger', 'declarativeContent', 'declarativeNetRequest', 'desktopCapture', 'devtools', 'dns',
    'dom', 'downloads', 'extension', 'fontSettings', 'history', 'i18n', 'identity', 'idle', 'management',
    'notifications', 'offscreen', 'omnibox', 'pageCapture', 'permissions', 'power', 'privacy', 'proxy',
    'readingList', 'runtime', 'scripting', 'search', 'sessions', 'sidePanel', 'storage', 'system', 'tabCapture',
    'tabGroups', 'tabs', 'topSites', 'tts', 'ttsEngine', 'types', 'userScripts', 'webNavigation', 'webRequest',
    'windows'
  ]

  function kind (value) {
    if (typeof value === 'object' && value !== null && typeof value.addListener === 'function') return 'event'
    return typeof value
  }

  function describe (name) {
    let api
    try { api = root.chrome[name] } catch { return { type: 'throws' } }
    if (api === undefined) return { type: 'undefined' }
    const members = {}
    for (const member of Object.getOwnPropertyNames(api)) {
      try { members[member] = kind(api[member]) } catch { members[member] = 'throws' }
    }
    return { type: typeof api, members }
  }

  root.__sweep = function () {
    const ns = {}
    for (const name of NAMESPACES) ns[name] = describe(name)
    return { href: String(root.location && root.location.href), chromeKeys: Object.getOwnPropertyNames(root.chrome).sort(), ns }
  }
})(globalThis)
