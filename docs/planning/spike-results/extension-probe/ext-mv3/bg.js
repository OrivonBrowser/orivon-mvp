chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind !== 'inject') return
  const facts = { swOrivon: typeof globalThis.orivon, swOrivonSW: typeof globalThis.orivonSW, scripting: typeof chrome.scripting, tabs: typeof chrome.tabs, tabId: sender.tab?.id ?? null, apis: Object.keys(chrome).sort().join(',') }
  if (!chrome.scripting || sender.tab?.id == null) { sendResponse(facts); return }
  chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', func: () => { document.documentElement.dataset.scriptingMain = typeof window.orivon; return typeof window.orivon } })
    .then((r) => { facts.scriptingMain = JSON.stringify(r.map((x) => x.result)); sendResponse(facts) })
    .catch((e) => { facts.scriptingErr = String(e); sendResponse(facts) })
  return true
})
