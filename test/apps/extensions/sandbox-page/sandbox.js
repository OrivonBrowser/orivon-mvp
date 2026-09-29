// Reports what this sandboxed document actually got, for the e2e test to
// read back through evaluateRetrying -- real Chrome gives it no chrome.*
// at all, on purpose (UPSTREAM.md patch 37's own doc).
document.documentElement.dataset.hasChrome = String(typeof chrome !== 'undefined')
document.documentElement.dataset.hasTabs = String(typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined')

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
    outcome = 'threw:' + String(e && e.message ? e.message : e)
  }
  document.documentElement.dataset.tabsQueryOutcome = outcome
})()
