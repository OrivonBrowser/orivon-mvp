// Session-wide 'service-worker' preload. Runs for EVERY service worker that
// starts in the session it's registered on: our own tiny probe extensions,
// each real extension under test, and (for the scope test) an ordinary
// website's own service worker. Reports back over the per-worker `w.ipc`
// channel (NOT the global ipcMain -- that never receives SW-preload sends).
const { contextBridge, ipcRenderer } = require('electron')

const NAMESPACES = ['storage', 'alarms', 'offscreen', 'sidePanel', 'contextMenus', 'notifications',
  'commands', 'permissions', 'webNavigation', 'cookies', 'userScripts', 'declarativeNetRequest',
  'action', 'tabs', 'windows', 'webRequest', 'runtime', 'scripting', 'management', 'i18n', 'extension', 'dom']

function send (payload) { try { ipcRenderer.send('probe:sw', payload) } catch (e) {} }

// Item 6: try to polyfill chrome.* before the extension's own bg.js runs.
// Harmless (a no-op) against a website SW, where `chrome` does not exist.
try {
  const patchResult = contextBridge.executeInMainWorld({
    func: () => {
      const out = { ran: true, dnrPatched: false, sidePanelPatched: false, hadChrome: typeof chrome !== 'undefined' }
      try {
        if (typeof chrome !== 'undefined') {
          if (chrome.declarativeNetRequest) { chrome.declarativeNetRequest.__probe = 1; out.dnrPatched = true }
          if (!chrome.sidePanel) { chrome.sidePanel = { __polyfilled: true }; out.sidePanelPatched = true }
        }
      } catch (e) { out.error = String(e && e.message || e) }
      return out
    }
  })
  send({ kind: 'patch', patchResult })
} catch (e) { send({ kind: 'patch-threw', error: String(e && e.message || e) }) }

// Items 1, 5, 8: namespace + harmless-call introspection.
async function introspect () {
  let result
  try {
    result = await contextBridge.executeInMainWorld({
      func: async (namespaces) => {
        const c = typeof chrome !== 'undefined' ? chrome : null
        const present = {}
        const calls = {}
        for (const n of namespaces) present[n] = c ? (n in c ? typeof c[n] : 'absent') : 'no-chrome'
        async function tryCall (name, fn) {
          try { const r = await fn(); calls[name] = { ok: true, result: JSON.stringify(r).slice(0, 200) } } catch (e) { calls[name] = { ok: false, error: String(e && e.message || e).slice(0, 200) } }
        }
        if (c) {
          if (c.storage && c.storage.local) await tryCall('storage.local.get', () => c.storage.local.get(null)); else calls['storage.local.get'] = { ok: false, error: 'absent' }
          if (c.storage && c.storage.sync) await tryCall('storage.sync.get', () => c.storage.sync.get(null)); else calls['storage.sync.get'] = { ok: false, error: 'absent' }
          if (c.storage && c.storage.session) await tryCall('storage.session.get', () => c.storage.session.get(null)); else calls['storage.session.get'] = { ok: false, error: 'absent' }
          if (c.alarms) await tryCall('alarms.getAll', () => c.alarms.getAll()); else calls['alarms.getAll'] = { ok: false, error: 'absent' }
          if (c.offscreen) await tryCall('offscreen.hasDocument', () => c.offscreen.hasDocument()); else calls['offscreen.hasDocument'] = { ok: false, error: 'absent' }
          if (c.sidePanel) await tryCall('sidePanel.getOptions', () => c.sidePanel.getOptions({})); else calls['sidePanel.getOptions'] = { ok: false, error: 'absent' }
          if (c.contextMenus) await tryCall('contextMenus.removeAll', () => c.contextMenus.removeAll()); else calls['contextMenus.removeAll'] = { ok: false, error: 'absent' }
          if (c.notifications) await tryCall('notifications.getAll', () => c.notifications.getAll()); else calls['notifications.getAll'] = { ok: false, error: 'absent' }
          if (c.commands) await tryCall('commands.getAll', () => c.commands.getAll()); else calls['commands.getAll'] = { ok: false, error: 'absent' }
          if (c.permissions) await tryCall('permissions.getAll', () => c.permissions.getAll()); else calls['permissions.getAll'] = { ok: false, error: 'absent' }
          if (c.webNavigation) await tryCall('webNavigation.getAllFrames', () => c.webNavigation.getAllFrames({ tabId: -1 })); else calls['webNavigation.getAllFrames'] = { ok: false, error: 'absent' }
          if (c.cookies) await tryCall('cookies.getAll', () => c.cookies.getAll({})); else calls['cookies.getAll'] = { ok: false, error: 'absent' }
          if (c.userScripts) await tryCall('userScripts.getScripts', () => c.userScripts.getScripts()); else calls['userScripts.getScripts'] = { ok: false, error: 'absent' }
          if (c.declarativeNetRequest) await tryCall('declarativeNetRequest.getDynamicRules', () => c.declarativeNetRequest.getDynamicRules()); else calls['declarativeNetRequest.getDynamicRules'] = { ok: false, error: 'absent' }
          if (c.action) await tryCall('action.getBadgeText', () => c.action.getBadgeText({})); else calls['action.getBadgeText'] = { ok: false, error: 'absent' }
          if (c.windows) await tryCall('windows.getAll', () => c.windows.getAll()); else calls['windows.getAll'] = { ok: false, error: 'absent' }
        }
        return { href: self.location.href, chromeType: typeof c, apis: c ? Object.keys(c).sort() : [], present, calls }
      },
      args: [NAMESPACES]
    })
  } catch (e) { result = { execThrew: String(e && e.message || e) } }
  send({ kind: 'introspect', result })
}
introspect()
