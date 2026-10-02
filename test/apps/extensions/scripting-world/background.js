// Registers one content script per world at run time, the way a content
// blocker registers its scriptlets, and reports what the browser kept.
async function register () {
  await chrome.scripting.unregisterContentScripts().catch(() => {})
  await chrome.scripting.registerContentScripts([
    { id: 'main-world', js: ['main-world.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false },
    { id: 'isolated-world', js: ['isolated-world.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'ISOLATED', persistAcrossSessions: false }
  ])
}
register().catch((error) => { self.__registerError = String(error) })
