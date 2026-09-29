// Session-wide 'frame' preload. Item 6, second half: can a frame preload
// polyfill chrome.* on an extension's OWN pages (popup, options), the way
// the sw preload tries to on its service worker.
const { contextBridge } = require('electron')
try {
  if (typeof location !== 'undefined' && location.href.startsWith('chrome-extension://')) {
    contextBridge.executeInMainWorld({
      func: () => {
        const out = { ran: true, dnrPatched: false, sidePanelPatched: false }
        try {
          if (typeof chrome !== 'undefined') {
            if (chrome.declarativeNetRequest) { chrome.declarativeNetRequest.__probe = 1; out.dnrPatched = true }
            if (!chrome.sidePanel) { chrome.sidePanel = { __polyfilled: true }; out.sidePanelPatched = true }
          }
          window.__orivonFramePolyfill = out
        } catch (e) { window.__orivonFramePolyfillError = String(e && e.message || e) }
      }
    })
  }
} catch (e) {}
