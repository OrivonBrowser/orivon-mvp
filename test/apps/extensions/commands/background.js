// Records every command it is told about in storage.session, newest last, with
// the tab it came with: the e2e test reads it back through rpc.js.
importScripts('rpc.js')

chrome.commands.onCommand.addListener(async (name, tab) => {
  const { log = [] } = await chrome.storage.session.get('log')
  log.push({ name, tabId: tab ? tab.id : null, hasUrl: Boolean(tab && tab.url) })
  await chrome.storage.session.set({ log })
})

chrome.commands.onChanged.addListener(async (change) => {
  const { changes = [] } = await chrome.storage.session.get('changes')
  changes.push(change)
  await chrome.storage.session.set({ changes })
})
