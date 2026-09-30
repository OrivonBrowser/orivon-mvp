// Reports what this sandboxed document actually got, for the e2e test to
// read back through evaluateRetrying -- real Chrome gives it no chrome.*
// at all, an opaque origin, and no reach into a framing page's own DOM or
// chrome.* (UPSTREAM.md patches 37 and 40's own doc).
document.documentElement.dataset.hasChrome = String(typeof chrome !== 'undefined')
document.documentElement.dataset.hasTabs = String(typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined')
// location.origin keeps reporting the ordinary chrome-extension://<id>
// string even once this document is genuinely CSP-sandboxed (measured);
// window.origin is the one that actually reflects the opaque origin.
document.documentElement.dataset.origin = location.origin
document.documentElement.dataset.windowOrigin = String(window.origin)
document.documentElement.dataset.href = location.href

function describeErr (e) {
  return String(e && e.message ? e.message : e)
}

// The other framing direction (`open('/popup.html').chrome`, opening a
// non-sandbox page as a popup and reaching into IT) is not tested here:
// window.open() from an opaque-origin document is itself restricted the
// same way, and the page this would open (popup.html) does not exist in
// this fixture -- parent.chrome below is the direction UPSTREAM.md patch
// 40 was written for (a sandboxed iframe framed BY an extension page
// reaching UP into it), covered directly.
try {
  document.documentElement.dataset.parentChrome = String(typeof window.parent.chrome)
} catch (e) {
  document.documentElement.dataset.parentChrome = 'threw:' + describeErr(e)
}
try {
  // Any property read on a cross-origin Window is restricted to a small
  // safe list that does not include .document -- reading it at all should
  // throw once this document's own origin is opaque.
  document.documentElement.dataset.parentDocument = String(typeof window.parent.document)
} catch (e) {
  document.documentElement.dataset.parentDocument = 'threw:' + describeErr(e)
}

;(async () => {
  let outcome
  try {
    if (typeof chrome === 'undefined' || typeof chrome.tabs === 'undefined') {
      outcome = 'no-chrome-tabs'
    } else {
      const tabs = await chrome.tabs.query({})
      outcome = 'queried:' + tabs.length
    }
  } catch (e) {
    outcome = 'threw:' + describeErr(e)
  }
  document.documentElement.dataset.tabsQueryOutcome = outcome
})()

;(async () => {
  let outcome
  try {
    if (typeof chrome === 'undefined' || typeof chrome.storage === 'undefined') {
      outcome = 'no-chrome-storage'
    } else {
      await chrome.storage.local.set({ probe: 1 })
      outcome = 'set-ok'
    }
  } catch (e) {
    outcome = 'threw:' + describeErr(e)
  }
  document.documentElement.dataset.storageOutcome = outcome
})()

;(function () {
  let outcome
  try {
    if (typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined' || typeof chrome.runtime.connect === 'undefined') {
      outcome = 'no-chrome-runtime-connect'
    } else {
      chrome.runtime.connect()
      outcome = 'connected'
    }
  } catch (e) {
    outcome = 'threw:' + describeErr(e)
  }
  document.documentElement.dataset.runtimeConnectOutcome = outcome
})()
