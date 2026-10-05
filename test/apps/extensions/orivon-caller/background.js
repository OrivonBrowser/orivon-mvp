// Service worker: chrome.scripting.executeScript({ world: 'MAIN', func })
// on the tab when asked -- "asked" means this extension's own fixture
// origin has a tab open, which is all a real trigger needs to be for an
// e2e fixture (test/extensions/e2e-extensions-orivon-filter.test.ts's own server
// names the origin). `func` is serialised the same way installOrivon is
// (chrome.scripting's own contract): no free variables.
//
// Polls chrome.tabs.query() rather than subscribing to chrome.tabs.
// onUpdated: measured live against this repository's own shell (a
// WebContentsView-per-tab model, not a standard chrome.*-tabbed
// BrowserWindow) -- onUpdated's own listener never fired here even though
// chrome.tabs and chrome.scripting both exist and chrome.tabs.query()
// itself sees the tab. A query, unlike an event subscription, does not
// depend on that integration.
const injected = new Set()
async function poll () {
  let tabs = []
  try { tabs = await chrome.tabs.query({}) } catch (error) { tabs = [] }
  for (const tab of tabs) {
    if (typeof tab.url !== 'string' || !tab.url.includes('/orivon-fixture/')) continue
    const key = tab.id + '|' + tab.url
    if (injected.has(key)) continue
    injected.add(key)
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        (async () => {
          function outcomeOf (error) {
            return (error && typeof error === 'object' && typeof error.code === 'string') ? error.code : String(error)
          }
          try {
            await window.orivon.app.manifest()
            document.documentElement.setAttribute('data-orivon-scripting', 'allowed')
          } catch (error) {
            document.documentElement.setAttribute('data-orivon-scripting', outcomeOf(error))
          }
        })()
      }
    }).catch(() => {})
  }
  setTimeout(poll, 100)
}
void poll()
