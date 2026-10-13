// Each session keeps its own chrome.storage, so each copy of this extension names itself with an id of its own.
const ready = new Promise((resolve) => {
  chrome.storage.local.get('copy', (stored) => {
    if (typeof stored.copy === 'string') { resolve(stored.copy); return }
    const copy = Math.random().toString(36).slice(2, 10)
    chrome.storage.local.set({ copy }, () => { resolve(copy) })
  })
})

setInterval(async () => {
  const copy = await ready
  fetch(`${self.BEACON_URL}?copy=${copy}`, { cache: 'no-store' }).catch(() => {})
}, 250)
