const d = document.documentElement.dataset
d.isoOrivon = typeof window.orivon
d.isoOrivonWp = typeof window.orivonWp
d.isoChromeRuntime = typeof chrome?.runtime?.id
const s = document.createElement('script')
s.textContent = "document.documentElement.dataset.inlineOrivon = typeof window.orivon"
document.documentElement.appendChild(s); s.remove()
const w = document.createElement('script')
w.src = chrome.runtime.getURL('war.js')
document.documentElement.appendChild(w)
chrome.runtime.sendMessage({ kind: 'inject' })
  .then((r) => { d.bgReply = JSON.stringify(r) })
  .catch((e) => { d.bgErr = String(e) })
