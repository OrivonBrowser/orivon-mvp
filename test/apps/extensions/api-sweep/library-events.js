// Logs the bookmark and history events this worker receives, so a test reads what an extension is told.
// `__libraryEvents()` answers over rpc.js.
(function () {
  const log = []
  globalThis.__libraryEvents = function () { return log.slice() }
  const events = {
    bookmarks: ['onCreated', 'onRemoved', 'onChanged', 'onMoved'],
    history: ['onVisited', 'onVisitRemoved']
  }
  for (const namespace of Object.keys(events)) {
    const api = chrome[namespace]
    if (api === undefined) continue
    for (const name of events[namespace]) {
      api[name].addListener(function () { log.push({ event: namespace + '.' + name, args: Array.prototype.slice.call(arguments) }) })
    }
  }
})()
